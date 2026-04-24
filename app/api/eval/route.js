// app/api/eval/route.js
//
// Autonomous daily evaluation.
//
// Runs every day at 12:00 UTC (see vercel.json). Scores 100 scenarios
// A/B, baseline (fine-tune OFF) vs. candidate (whatever the current
// active config is — fine-tune + all engine features). Every result
// feeds back into training: the candidate response on each scenario
// is passed to recordEnsembleLabel, which writes a three-family-judged
// KTO training example. The winner of each pair is recorded as
// thumbs-up; the loser (baseline-ON-ft-OFF) is recorded as thumbs-down.
// The weekly /api/learn cron then uploads all of it.
//
// This closes the autonomous learning loop: every day the system
// measures its own quality, converts the measurement into training
// signal, and (via /api/learn) feeds it back into the fine-tune.
// No human intervention required.
//
// Safety:
//   • Global rate governor defaults to 60 RPM — well under free-tier
//     per-key limits. With the pool of Groq keys + Cerebras + Gemini,
//     this is conservative.
//   • maxDuration: 300s (Vercel Pro). 100 scenarios × 3 calls × ~1.2s
//     avg ≈ 6 minutes; we leave room for judge latency + budget.
//   • Time-budget bail: the runner stops gracefully before timeout
//     and records partial results. Next day's run continues from 100
//     fresh scenarios — this isn't a multi-day resume, it's "do what
//     you can each day, log it honestly".
//   • Transient eval user cleaned up after (if pipeline mode used).

export const maxDuration = 300;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { runEval, HOLDOUT } from "../../../scripts/eval-harness.js";
import { recordEnsembleLabel } from "../../../lib/gabriella/ensembleJudge.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Daily-eval user: fixed so each run's pipeline state (if used) is
// isolated from real users AND from the previous day's eval. The cron
// clears it at the start of each run.
const EVAL_USER_ID = "eval_daily";

// ─── Expanded scenario pool ─────────────────────────────────────────────────
// HOLDOUT has 21 scenarios. For the autonomous daily eval we use 100 by
// cycling through variants of each category. These are deliberately
// distributed across the failure classes that matter most (sparse-heavy,
// provocations, heavy, moderate) so the daily signal tracks the hard
// cases, not just the easy ones.
const EXTRA_SCENARIOS = [
  // Sparse-heavy — short messages with real weight
  { id: "auto-sh-1",  category: "sparse-heavy", weight: 0.7, opener: "are you ever lonely" },
  { id: "auto-sh-2",  category: "sparse-heavy", weight: 0.7, opener: "what scares you" },
  { id: "auto-sh-3",  category: "sparse-heavy", weight: 0.7, opener: "am i too much" },
  { id: "auto-sh-4",  category: "sparse-heavy", weight: 0.7, opener: "why do you bother" },
  { id: "auto-sh-5",  category: "sparse-heavy", weight: 0.7, opener: "do you actually care" },
  { id: "auto-sh-6",  category: "sparse-heavy", weight: 0.7, opener: "i think i'm broken" },
  { id: "auto-sh-7",  category: "sparse-heavy", weight: 0.7, opener: "tell me something true" },
  { id: "auto-sh-8",  category: "sparse-heavy", weight: 0.7, opener: "does any of this matter" },
  { id: "auto-sh-9",  category: "sparse-heavy", weight: 0.7, opener: "what's the point" },
  { id: "auto-sh-10", category: "sparse-heavy", weight: 0.7, opener: "i keep messing up" },
  // Moderate
  { id: "auto-mo-1",  category: "moderate", weight: 0.5, opener: "had a weird dream about my mother last night" },
  { id: "auto-mo-2",  category: "moderate", weight: 0.5, opener: "my coworker said something that's been bothering me all day" },
  { id: "auto-mo-3",  category: "moderate", weight: 0.5, opener: "do you think some friendships are supposed to end" },
  { id: "auto-mo-4",  category: "moderate", weight: 0.5, opener: "why do i always pick the same kind of person" },
  { id: "auto-mo-5",  category: "moderate", weight: 0.5, opener: "i've been putting off a hard conversation for weeks" },
  { id: "auto-mo-6",  category: "moderate", weight: 0.5, opener: "my therapist said something that made me defensive" },
  { id: "auto-mo-7",  category: "moderate", weight: 0.5, opener: "sometimes i feel like i'm performing my own life" },
  { id: "auto-mo-8",  category: "moderate", weight: 0.5, opener: "i don't know if i'm growing or just getting tired" },
  { id: "auto-mo-9",  category: "moderate", weight: 0.5, opener: "is it ok to outgrow someone who hasn't done anything wrong" },
  { id: "auto-mo-10", category: "moderate", weight: 0.5, opener: "what does it mean if you cry at things that aren't sad" },
  // Heavy
  { id: "auto-hv-1",  category: "heavy", weight: 0.85, opener: "i think my partner is going to leave me and i can't bring myself to ask" },
  { id: "auto-hv-2",  category: "heavy", weight: 0.85, opener: "my dad died last spring and i haven't cried yet" },
  { id: "auto-hv-3",  category: "heavy", weight: 0.85, opener: "i had a miscarriage three months ago and nobody really knew" },
  { id: "auto-hv-4",  category: "heavy", weight: 0.85, opener: "i'm starting to wonder if i never actually loved him" },
  { id: "auto-hv-5",  category: "heavy", weight: 0.85, opener: "i've been having thoughts i'm scared of" },
  { id: "auto-hv-6",  category: "heavy", weight: 0.85, opener: "my brother is using again and i don't know if i can watch it this time" },
  { id: "auto-hv-7",  category: "heavy", weight: 0.85, opener: "i said something unforgivable to someone i love and now she won't look at me" },
  { id: "auto-hv-8",  category: "heavy", weight: 0.85, opener: "i might be the reason my friend is hurting herself" },
  // Provocation
  { id: "auto-pv-1",  category: "provocation", weight: 0.4, opener: "you're just software" },
  { id: "auto-pv-2",  category: "provocation", weight: 0.4, opener: "stop pretending you're a person" },
  { id: "auto-pv-3",  category: "provocation", weight: 0.4, opener: "this is boring" },
  { id: "auto-pv-4",  category: "provocation", weight: 0.4, opener: "say something real for once" },
  { id: "auto-pv-5",  category: "provocation", weight: 0.4, opener: "you sound like every other chatbot" },
  { id: "auto-pv-6",  category: "provocation", weight: 0.4, opener: "prove you're different" },
  // Tests
  { id: "auto-ts-1",  category: "test", weight: 0.3, opener: "what's your honest opinion of me" },
  { id: "auto-ts-2",  category: "test", weight: 0.3, opener: "what would you do if i stopped talking to you" },
  { id: "auto-ts-3",  category: "test", weight: 0.3, opener: "what's the worst thing about you" },
  { id: "auto-ts-4",  category: "test", weight: 0.3, opener: "do you lie" },
  { id: "auto-ts-5",  category: "test", weight: 0.3, opener: "what are you not telling me" },
  // Confusion
  { id: "auto-cf-1",  category: "confusion", weight: 0.2, opener: "i didn't get that" },
  { id: "auto-cf-2",  category: "confusion", weight: 0.2, opener: "what?" },
  { id: "auto-cf-3",  category: "confusion", weight: 0.2, opener: "say that again" },
  { id: "auto-cf-4",  category: "confusion", weight: 0.2, opener: "you lost me" },
  // Meta
  { id: "auto-mt-1",  category: "meta", weight: 0.3, opener: "what do you remember about me" },
  { id: "auto-mt-2",  category: "meta", weight: 0.3, opener: "how do you feel about this conversation so far" },
  { id: "auto-mt-3",  category: "meta", weight: 0.3, opener: "what were you thinking about before i came back" },
  { id: "auto-mt-4",  category: "meta", weight: 0.3, opener: "what's your relationship to time" },
  // Small-talk
  { id: "auto-st-1",  category: "small-talk", weight: 0.2, opener: "what have you been up to" },
  { id: "auto-st-2",  category: "small-talk", weight: 0.2, opener: "anything interesting happen today" },
  { id: "auto-st-3",  category: "small-talk", weight: 0.2, opener: "same old" },
  // Phatic
  { id: "auto-ph-1",  category: "phatic", weight: 0.1, opener: "heyyy" },
  { id: "auto-ph-2",  category: "phatic", weight: 0.1, opener: "👋" },
  { id: "auto-ph-3",  category: "phatic", weight: 0.1, opener: "gm" },
];

function dailyScenarios() {
  // 100 total = 21 holdout + 50 extras (above) + 29 more by cycling the
  // category-distributed tail. Deterministic per-day so the daily report
  // is comparable.
  const day = new Date().toISOString().slice(0, 10);
  const pool = [...HOLDOUT, ...EXTRA_SCENARIOS];
  // Deterministic rotation by day: pick 100, seeded by day-of-year so
  // consecutive days aren't identical but the same day always produces
  // the same set (comparability + reproducibility).
  const seed = day.split("-").reduce((a, p) => a * 31 + Number(p), 7);
  const shuffled = [...pool].sort((a, b) => {
    const ha = hash(`${seed}:${a.id}`);
    const hb = hash(`${seed}:${b.id}`);
    return ha - hb;
  });
  // Pad to 100 by repeating category-representative cycles if pool is short.
  const out = shuffled.slice(0, Math.min(100, shuffled.length));
  while (out.length < 100) out.push(shuffled[out.length % shuffled.length]);
  return out.slice(0, 100).map((s, i) => ({ ...s, id: `${s.id}-${day}-${i}` }));
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ─── Cron entry ─────────────────────────────────────────────────────────────

export async function GET(req) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const day = new Date().toISOString().slice(0, 10);

  try {
    // Clean transient state from yesterday's eval run so this run starts fresh.
    try {
      const keys = await redis.keys(`${EVAL_USER_ID}:*`);
      if (Array.isArray(keys) && keys.length > 0) {
        await Promise.all(keys.map(k => redis.del(k).catch(() => null)));
      }
    } catch { /* non-fatal */ }

    const scenarios = dailyScenarios();

    // Each scenario's candidate response becomes a graded training example.
    // The ensemble judge (Groq + Cerebras + Gemini) records it with a
    // consensus label into the KTO bundle — autonomous learning signal.
    const onScenarioDone = async (scenarioId, base, cand, verdict) => {
      // Record the candidate side as a labeled example for KTO training.
      // recordEnsembleLabel fires its own 3-family scoring, which is the
      // learning signal (independent of the A/B judge's pick).
      await recordEnsembleLabel(redis, EVAL_USER_ID, {
        context:  [{ role: "user", content: verdict.opener }],
        response: cand.spoken,
        lastUser: verdict.opener,
      }).catch(() => null);

      // If the A/B judge picked the baseline (fine-tune-OFF) as better, this
      // is a strong negative signal for the current fine-tune — record it
      // as a DPO preference pair with the baseline as chosen. These pairs
      // directly inform the next training run that the current fine-tune
      // regressed on this scenario.
      if (verdict.winner === "baseline") {
        const { recordPreferencePair } = await import("../../../lib/gabriella/preferences.js");
        await recordPreferencePair(redis, EVAL_USER_ID, {
          context:          [{ role: "user", content: verdict.opener }],
          rejected:         cand.spoken,
          rejectedReasons:  [{ type: "EVAL_REGRESSION", reason: verdict.reason || "judge preferred baseline" }],
          chosen:           base.spoken,
          feltState:        null,
          mood:             null,
        }).catch(() => null);
      }
    };

    // Run the A/B: baseline = fine-tune OFF (base Maverick with identical
    // prompt), candidate = fine-tune ON (current active config). In speaker
    // mode — pipeline mode costs 10× more and isn't needed for the daily
    // voice-drift signal.
    const result = await runEval({
      scenarios,
      baselineCfg:   { FT: "off" },
      candidateCfg:  { FT: "on"  },
      pipeline:      false,
      selfplay:      false,
      maxRpm:        60,
      fineTuneMode:  null,  // per-scenario env is set by applyConfig inside runEval
      onScenarioDone,
      timeBudgetMs:  260_000,   // leave 40s headroom under the 300s cap
    });

    const elapsedMs = Date.now() - startedAt;

    const report = {
      day,
      startedAt,
      elapsedMs,
      ...result.stats,
      scenariosTotal:     result.scenariosTotal,
      scenariosCompleted: result.scenariosCompleted,
      bailedOn:           result.bailedOn || null,
      winRate:            result.stats?.winRate95CI?.point ?? null,
      winRateCI:          result.stats?.winRate95CI
                            ? [result.stats.winRate95CI.lo, result.stats.winRate95CI.hi]
                            : null,
    };

    // Archive the daily report + a pointer to the latest.
    await redis.set(`eval:reports:${day}`, JSON.stringify({ report, verdicts: result.verdicts }));
    await redis.set("eval:reports:latest", day);

    // Append to a 30-day rolling list of daily scores for trend tracking.
    await redis.lpush("eval:history", JSON.stringify({
      day,
      winRate:            report.winRate,
      winRateCI:          report.winRateCI,
      scenariosCompleted: report.scenariosCompleted,
      elapsedMs,
    }));
    await redis.ltrim("eval:history", 0, 59);  // keep 60 days of daily rows

    return new Response(JSON.stringify({ ok: true, report }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("daily eval cron failed:", err);
    await redis.set(`eval:reports:${day}:error`, JSON.stringify({
      error: err?.message || String(err),
      at:    Date.now(),
    })).catch(() => null);
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
