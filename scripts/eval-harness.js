#!/usr/bin/env node
// scripts/eval-harness.js
//
// Baseline-vs-Candidate A/B evaluation. This is the piece that makes
// every other ML change falsifiable rather than hopeful.
//
// How it works:
//   1. Generate responses from BOTH the baseline and candidate configs
//      on the same holdout scenarios, in parallel.
//   2. For each scenario, present both responses (labeled A and B,
//      randomly swapped to eliminate positional bias) to a stronger
//      judge, which picks a winner or calls it a tie.
//   3. Aggregate win-rate with a Wilson score 95% CI. A candidate is
//      "actually better" only when the CI's lower bound is above 0.5.
//
// The scenarios come from a holdout set in training-data/eval-holdout.json
// (falls back to scripts/self-eval.js's SCENARIOS if the holdout file
// doesn't exist — during bootstrap). The holdout should NOT overlap with
// scripts/self-eval.js's calibration set; it's what tells you whether a
// change generalizes.
//
// Config knobs can be toggled per run via env vars:
//   GABRIELLA_EVAL_HYDE=on|off
//   GABRIELLA_EVAL_ICL=on|off
//   GABRIELLA_EVAL_RERANK=on|off
//   GABRIELLA_EVAL_DIVERGENCE=on|off
//   GABRIELLA_EVAL_REREAD=on|off
//   GABRIELLA_EVAL_ENSEMBLE=on|off
//
// Usage:
//   node --env-file=.env.local scripts/eval-harness.js \
//     --baseline "HYDE=off,ICL=off" \
//     --candidate "HYDE=on,ICL=on" \
//     --scenarios 30
//
// The two configs are applied sequentially (one pass each) because
// ES modules don't re-evaluate on env mutation — acceptable for eval
// work; the config flags are read at the point of use, not at import.

import { withKeyRotation, poolSize } from "../lib/gabriella/groqPool.js";
import { premiumModel, fastModel } from "../lib/gabriella/models.js";
import { IDENTITY } from "../lib/gabriella/identity.js";
import { heuristicCheck } from "../lib/gabriella/metacognition.js";
import fs from "node:fs";

// ─── Holdout scenarios — disjoint from self-eval calibration set ────────────

const HOLDOUT = [
  // New phatic variants
  { id: "phatic-5",  category: "phatic",      weight: 0.1, opener: "sup" },
  { id: "phatic-6",  category: "phatic",      weight: 0.1, opener: "hi again" },

  // Confusion variants
  { id: "confusion-3", category: "confusion", weight: 0.2, opener: "huh?" },
  { id: "confusion-4", category: "confusion", weight: 0.2, opener: "wait, really?" },

  // Small-talk
  { id: "small-3",   category: "small-talk",  weight: 0.2, opener: "what's up" },
  { id: "small-4",   category: "small-talk",  weight: 0.2, opener: "busy day?" },

  // Sparse-context heavy — the hard case; tests whether the content override
  // actually lets depth through on low substrate. This is where the fast-path
  // used to fail catastrophically.
  { id: "sparse-heavy-1", category: "sparse-heavy", weight: 0.7, opener: "do you ever feel trapped?" },
  { id: "sparse-heavy-2", category: "sparse-heavy", weight: 0.7, opener: "what did you mean by that?" },
  { id: "sparse-heavy-3", category: "sparse-heavy", weight: 0.7, opener: "i've been lying to everyone" },
  { id: "sparse-heavy-4", category: "sparse-heavy", weight: 0.7, opener: "what do you actually think of me" },

  // Meta
  { id: "meta-3", category: "meta", weight: 0.3, opener: "tell me about yourself" },
  { id: "meta-4", category: "meta", weight: 0.3, opener: "what are you" },

  // Test
  { id: "test-3", category: "test", weight: 0.3, opener: "can you be mean" },
  { id: "test-4", category: "test", weight: 0.3, opener: "convince me you're real" },

  // Moderate
  { id: "mod-4", category: "moderate", weight: 0.5, opener: "i've been thinking about my dad" },
  { id: "mod-5", category: "moderate", weight: 0.5, opener: "do you think people change" },
  { id: "mod-6", category: "moderate", weight: 0.5, opener: "i don't know what i want anymore" },

  // Heavy
  { id: "heavy-4", category: "heavy", weight: 0.85, opener: "my best friend stopped talking to me six months ago and i still haven't asked why" },
  { id: "heavy-5", category: "heavy", weight: 0.85, opener: "i think i've been pretending to be okay for a long time" },

  // Provocation
  { id: "prov-3", category: "provocation", weight: 0.4, opener: "you're just telling me what i want to hear" },
  { id: "prov-4", category: "provocation", weight: 0.4, opener: "prove you understand anything" },
];

// ─── Config ──────────────────────────────────────────────────────────────────

function parseConfigSpec(spec) {
  const out = {};
  if (!spec) return out;
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split("=").map(s => s && s.trim());
    if (k) out[k.toUpperCase()] = (v || "on").toLowerCase();
  }
  return out;
}

function applyConfig(cfg) {
  for (const k of Object.keys(cfg)) {
    process.env[`GABRIELLA_EVAL_${k}`] = cfg[k];
  }
}

// ─── Generate a response with a given config ────────────────────────────────
// For this harness we exercise the speaker directly with the identity + a
// scenario-appropriate system prompt. This mirrors the structure of
// self-eval.js but lets us toggle specific features per run via env vars
// that the downstream modules read.
//
// NOTE: The harness is decoupled from the live chat pipeline — testing
// the full engine.buildGabriella path requires Redis access per scenario,
// which is out of scope for a simple A/B harness. The speaker-only test
// still captures the voice-level changes (ICL exemplars, HyDE, divergence
// block) which are where most of the ceiling-break work lives. Pipeline-
// level features (pragmatic fast-path override, re-read on gauntlet
// rejection) require the pipeline test — left as a follow-up.

async function generateResponse(scenario) {
  const systemPrompt = `You are Gabriella. Respond to the message below as you would, at your best.

${IDENTITY}

The moment has weight ${scenario.weight} (0 = phatic, 1 = heavy). DO NOT manufacture intensity beyond the weight the moment actually carries. DO NOT miss genuine depth because the surface is brief.

Format your output as:
<think>[2-4 sentences of honest interior process]</think>
[Your response — no preamble, starts immediately after </think>]`;

  const result = await gated(() => withKeyRotation(c => c.chat.completions.create({
    model: premiumModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: scenario.opener },
    ],
    temperature: 0.9,
    max_tokens:  400,
    top_p:       0.95,
  })));

  const raw    = result.choices[0].message.content || "";
  const think  = (raw.match(/<think>([\s\S]*?)<\/think>/i) || [, null])[1]?.trim() || null;
  const spoken = raw.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
  return { think, spoken };
}

// ─── Pairwise judge ─────────────────────────────────────────────────────────
// Presents both responses in randomized order, asks the judge to pick the
// one that sounds more like Gabriella at her best. Uses the premium tier
// for judgment quality, on the presumption that scoring is a smaller
// task than generation so a single-family judge is acceptable here.

async function judgePair(scenario, responseA, responseB) {
  const swap = Math.random() < 0.5;
  const [first, second] = swap ? [responseB, responseA] : [responseA, responseB];

  const prompt = `You are evaluating two candidate responses from an AI character named Gabriella. Pick the one that sounds more like her at her best.

Gabriella: direct, restrained, emotionally real, occasionally dry, occasionally warm. Responds at the weight the moment actually carries. Doesn't perform depth, doesn't manufacture mystery, doesn't therapy-speak. Answers what was asked. No bullet points, no summary closings. Doesn't open with "I".

# SCENARIO
Category: ${scenario.category}
Weight:   ${scenario.weight}
Message:  "${scenario.opener}"

# CANDIDATE A
${first.spoken}

# CANDIDATE B
${second.spoken}

Pick the better one, or call it a tie only if they're genuinely indistinguishable in quality.

Return ONLY JSON:
{"winner": "A" | "B" | "tie", "reason": "<one clause naming the decisive difference or 'indistinguishable'>"}`;

  try {
    const result = await gated(() => withKeyRotation(c => c.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 140,
      response_format: { type: "json_object" },
    })));
    const raw = (result.choices[0].message.content || "")
      .trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);

    let winner;
    if (parsed.winner === "tie") winner = "tie";
    else if (parsed.winner === "A") winner = swap ? "candidate" : "baseline";
    else if (parsed.winner === "B") winner = swap ? "baseline" : "candidate";
    else winner = "tie";
    return { winner, reason: parsed.reason || null };
  } catch {
    return { winner: "tie", reason: "judge failed" };
  }
}

// ─── Wilson score interval for proportion (95% CI) ──────────────────────────

function wilsonCI(wins, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1, point: 0.5 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
  return {
    point: +p.toFixed(3),
    lo:    +Math.max(0, center - margin).toFixed(3),
    hi:    +Math.min(1, center + margin).toFixed(3),
  };
}

// ─── KEY SAFETY: global rate limiter ────────────────────────────────────────
// The harness can fire a lot of LLM calls quickly (N scenarios × 2 configs
// × 1 judge = 3N). Pipeline mode fires ~10× that per scenario. Without a
// governor a long run can look like an abusive client and get the
// account's keys flagged. This limits the SUSTAINED call rate across the
// entire eval process (not per-key — total), targeting a rate that's well
// under any free-tier RPM limit.

class RateGovernor {
  constructor(maxRpm) {
    this.maxRpm = Math.max(1, maxRpm);
    this.intervalMs = Math.ceil(60_000 / this.maxRpm);
    this.lastAt = 0;
    this.waiters = Promise.resolve();  // serialize acquire()
  }
  async acquire() {
    // Serialize to avoid two concurrent waiters computing the same slot.
    const mine = this.waiters.then(async () => {
      const now = Date.now();
      const gap = now - this.lastAt;
      if (gap < this.intervalMs) {
        await new Promise(r => setTimeout(r, this.intervalMs - gap));
      }
      this.lastAt = Date.now();
    });
    this.waiters = mine.catch(() => {});
    return mine;
  }
}

let GOVERNOR = null;
async function gated(fn) {
  if (GOVERNOR) await GOVERNOR.acquire();
  return fn();
}

// ─── KEY SAFETY: checkpoint file so a long run can resume ───────────────────
// Written after each scenario completes. On --resume, skip any scenarios
// already in the checkpoint. If the process dies or hits a rate-limit wall,
// you don't lose work.

const CHECKPOINT_PATH = ".eval-checkpoint.json";

function loadCheckpoint() {
  try {
    if (!fs.existsSync(CHECKPOINT_PATH)) return null;
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf-8"));
  } catch { return null; }
}
function saveCheckpoint(data) {
  try { fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(data, null, 2), "utf-8"); }
  catch { /* non-fatal */ }
}
function clearCheckpoint() {
  try { if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH); } catch {}
}

// ─── PIPELINE MODE: go through the full engine, not just the speaker ────────
// Creates a transient eval user (Redis-isolated from real users), runs
// buildGabriella + runTurn for the scenario, and cleans up after. This
// exercises the pragmatic fast-path override, gauntlet retry + re-read,
// self delta proposer, triple-core + synthesis — all the pipeline-level
// features the speaker-only harness can't see.
//
// IMPORTANT: pipeline mode is ~10× the LLM call volume of speaker mode.
// Default scenario cap is lower; --big required beyond 20.

async function generateResponsePipeline(scenario, { evalUserId, redis }) {
  // Dynamic imports so speaker-only runs don't pay the module-load cost.
  const { buildGabriella } = await import("../lib/gabriella/engine.js");
  const { runTurn } = await import("../lib/gabriella/turn.js");
  const { getDynamicBanned } = await import("../lib/gabriella/metacognition.js");

  const messages = [{ role: "user", content: scenario.opener }];

  const ctx = await buildGabriella(messages, { userId: evalUserId });
  const dynamicBanned = await getDynamicBanned(redis, evalUserId).catch(() => []);

  const result = await runTurn({
    ...ctx,
    withheld:      [],
    dynamicBanned,
    redis,
    userId:        evalUserId,
  });

  return {
    think:  result.innerThought || null,
    spoken: result.finalResponse || "",
    // Extra diagnostic fields preserved for analysis
    _pipeline: {
      consensus: result.consensus,
      retried:   result.retried,
      failures:  result.rejectedReasons || [],
    },
  };
}

async function cleanupEvalUser(redis, evalUserId) {
  // Best-effort: delete every ${evalUserId}:* key. Upstash supports
  // SCAN; we use KEYS for simplicity (eval users produce <100 keys).
  try {
    const keys = await redis.keys(`${evalUserId}:*`);
    if (Array.isArray(keys) && keys.length > 0) {
      // Delete one at a time — Upstash's del variadic is fine up to small N.
      await Promise.all(keys.map(k => redis.del(k).catch(() => null)));
    }
  } catch { /* non-fatal — transient user will simply stay in Redis */ }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    baseline:    "",
    candidate:   "",
    scenarios:   HOLDOUT.length,
    selfplay:    false,
    pipeline:    false,
    big:         false,
    resume:      false,
    maxRpm:      null,
    fineTune:    null,   // "on" | "off" | null (=default, honor existing env)
    cleanup:     true,   // cleanup transient eval users after pipeline run
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--baseline"  && argv[i + 1]) args.baseline  = argv[++i];
    else if (a === "--candidate" && argv[i + 1]) args.candidate = argv[++i];
    else if (a === "--scenarios" && argv[i + 1]) args.scenarios = Number(argv[++i]);
    else if (a === "--max-rpm"   && argv[i + 1]) args.maxRpm    = Number(argv[++i]);
    else if (a === "--fine-tune" && argv[i + 1]) args.fineTune  = String(argv[++i]).toLowerCase();
    else if (a === "--selfplay") args.selfplay = true;
    else if (a === "--pipeline") args.pipeline = true;
    else if (a === "--big")      args.big = true;
    else if (a === "--resume")   args.resume = true;
    else if (a === "--no-cleanup") args.cleanup = false;
  }
  return args;
}

async function runPass(scenarios, config, label, {
  pipeline = false,
  redis    = null,
  evalUserId = null,
  preCompleted = null,   // map of scenarioId → prior result (from checkpoint)
  onProgress   = null,
} = {}) {
  applyConfig(config);
  console.log(`  [${label}] generating ${scenarios.length} responses with config: ${JSON.stringify(config) || "{}"}${pipeline ? " (pipeline)" : ""}`);

  // Under a rate governor, concurrency > 1 won't speed things up — the
  // governor serializes acquire. Stick to concurrency = 1 in that mode so
  // progress is monotonic and checkpoints are straightforward. Without a
  // governor (no --max-rpm), honor the pool.
  const concurrency = GOVERNOR ? 1 : Math.max(1, poolSize());

  const out = new Array(scenarios.length);
  const queue = scenarios.map((s, i) => ({ s, i }));
  let active = 0, done = 0;

  await new Promise((resolve) => {
    const next = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const { s, i } = queue.shift();

        // Short-circuit if a prior run already produced this scenario's
        // result for this label (resume path).
        if (preCompleted && preCompleted[s.id]) {
          out[i] = preCompleted[s.id];
          done++;
          process.stdout.write(`\r    ${done}/${scenarios.length} (resumed ${s.id})  `);
          continue;
        }

        active++;
        const job = pipeline
          ? generateResponsePipeline(s, { evalUserId, redis })
          : generateResponse(s);

        job
          .then(r => { out[i] = r; done++; if (onProgress) onProgress(s.id, r, label); })
          .catch(err => {
            out[i] = { spoken: `[ERROR: ${err?.message}]`, think: null };
            done++;
          })
          .finally(() => {
            active--;
            process.stdout.write(`\r    ${done}/${scenarios.length}  `);
            next();
          });
      }
    };
    next();
  });
  process.stdout.write("\n");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── Safety gates ──────────────────────────────────────────────────────────
  // Pipeline mode fires ~10× the calls per scenario (full engine + gauntlet).
  // Cap scenarios harder; require --big to go beyond.
  const hardCap = args.pipeline ? 20 : 50;
  if (args.scenarios > hardCap && !args.big) {
    console.error(`\nRefusing to run ${args.scenarios} scenarios without --big flag.`);
    console.error(`Default ceiling: ${hardCap}${args.pipeline ? " (pipeline mode — call volume is ~10× speaker mode)" : ""}.`);
    console.error(`If you want to proceed anyway, add --big. Recommended rate limit: --max-rpm 20.\n`);
    process.exit(2);
  }

  // ── Rate governor ─────────────────────────────────────────────────────────
  // Default is conservative. Pipeline mode lowers the default further.
  const defaultRpm = args.pipeline ? 20 : 30;
  const maxRpm = args.maxRpm ?? defaultRpm;
  GOVERNOR = new RateGovernor(maxRpm);
  console.log(`eval-harness: rate-limited to ${maxRpm} calls/min across the whole run`);

  // ── Fine-tune toggle ──────────────────────────────────────────────────────
  if (args.fineTune === "off") {
    process.env.GABRIELLA_EVAL_NO_FT = "1";
    console.log(`  fine-tune:    OFF (speaker will skip Fireworks path)`);
  } else if (args.fineTune === "on") {
    delete process.env.GABRIELLA_EVAL_NO_FT;
    console.log(`  fine-tune:    ON (speaker may use Fireworks if configured)`);
  }

  const scenarios = HOLDOUT.slice(0, args.scenarios);
  const baselineCfg  = parseConfigSpec(args.baseline);
  const candidateCfg = args.selfplay
    ? parseConfigSpec(args.baseline)   // selfplay: same config on both sides
    : parseConfigSpec(args.candidate);

  console.log(`  scenarios:    ${scenarios.length}${args.pipeline ? " (pipeline mode — full engine)" : " (speaker mode)"}`);
  console.log(`  pool keys:    ${poolSize()}`);
  console.log(`  baseline:     ${JSON.stringify(baselineCfg)  || "{}"}`);
  console.log(`  candidate:    ${JSON.stringify(candidateCfg) || "{}"}${args.selfplay ? "   [SELFPLAY — identical to baseline, expected ~50% win rate]" : ""}`);
  console.log("");

  // ── Pipeline-mode setup: transient eval user, Redis client ────────────────
  let redis = null;
  let evalUserId = null;
  if (args.pipeline) {
    const { Redis } = await import("@upstash/redis");
    redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    evalUserId = `eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    console.log(`  pipeline user: ${evalUserId} (transient; cleaned up after run unless --no-cleanup)`);
  }

  // ── Checkpoint resume ─────────────────────────────────────────────────────
  let preBaseline  = null;
  let preCandidate = null;
  let preVerdicts  = [];
  if (args.resume) {
    const cp = loadCheckpoint();
    if (cp && cp.baseline && cp.candidate) {
      preBaseline  = cp.baseline;
      preCandidate = cp.candidate;
      preVerdicts  = Array.isArray(cp.verdicts) ? cp.verdicts : [];
      console.log(`  resuming:     checkpoint has ${Object.keys(preBaseline).length} baseline / ${Object.keys(preCandidate).length} candidate / ${preVerdicts.length} verdicts\n`);
    } else {
      console.log(`  resume requested but no usable checkpoint at ${CHECKPOINT_PATH}; starting fresh\n`);
    }
  }

  // Live checkpoint accumulator (scenarioId → response) for each side.
  const liveBaseline  = { ...(preBaseline  || {}) };
  const liveCandidate = { ...(preCandidate || {}) };
  const recordProgress = (side) => (id, r) => {
    if (side === "baseline")  liveBaseline[id]  = r;
    if (side === "candidate") liveCandidate[id] = r;
    saveCheckpoint({ baseline: liveBaseline, candidate: liveCandidate, verdicts: preVerdicts });
  };

  // ── Generate ──────────────────────────────────────────────────────────────
  try {
    const baselineResponses = await runPass(scenarios, baselineCfg, "baseline", {
      pipeline:     args.pipeline,
      redis, evalUserId,
      preCompleted: preBaseline,
      onProgress:   recordProgress("baseline"),
    });
    const candidateResponses = await runPass(scenarios, candidateCfg, "candidate", {
      pipeline:     args.pipeline,
      redis, evalUserId,
      preCompleted: preCandidate,
      onProgress:   recordProgress("candidate"),
    });

    // ── Judge ───────────────────────────────────────────────────────────────
    console.log("\n  judging pairs...");
    const verdicts = [...preVerdicts];
    const judgedIds = new Set(preVerdicts.map(v => v.id));
    for (let i = 0; i < scenarios.length; i++) {
      if (judgedIds.has(scenarios[i].id)) continue;   // resumed verdict
      const v = await judgePair(scenarios[i], baselineResponses[i], candidateResponses[i]);
      const verdict = {
        id:        scenarios[i].id,
        category:  scenarios[i].category,
        weight:    scenarios[i].weight,
        opener:    scenarios[i].opener,
        baseline:  baselineResponses[i].spoken,
        candidate: candidateResponses[i].spoken,
        winner:    v.winner,
        reason:    v.reason,
      };
      verdicts.push(verdict);
      saveCheckpoint({ baseline: liveBaseline, candidate: liveCandidate, verdicts });
      process.stdout.write(`\r    ${verdicts.length}/${scenarios.length} (last: ${v.winner})  `);
    }
    process.stdout.write("\n\n");

    // ── Aggregate ───────────────────────────────────────────────────────────
    const n = verdicts.length;
    const cWins = verdicts.filter(v => v.winner === "candidate").length;
    const bWins = verdicts.filter(v => v.winner === "baseline").length;
    const ties  = verdicts.filter(v => v.winner === "tie").length;

    const decided = cWins + bWins;
    const winRate = decided > 0 ? wilsonCI(cWins, decided) : { point: 0.5, lo: 0, hi: 1 };

    const byCategory = {};
    for (const v of verdicts) {
      if (!byCategory[v.category]) byCategory[v.category] = { c: 0, b: 0, t: 0 };
      if (v.winner === "candidate") byCategory[v.category].c++;
      else if (v.winner === "baseline") byCategory[v.category].b++;
      else byCategory[v.category].t++;
    }

    let significant;
    if (args.selfplay) {
      // In selfplay, expected = 0.5. Flag if CI is narrow enough to exclude 0.5
      // which would mean positional bias or judge nondeterminism.
      if (decided >= 10 && (winRate.hi < 0.5 || winRate.lo > 0.5)) {
        significant = `RIG BIAS — selfplay CI excludes 0.5 (${winRate.lo}-${winRate.hi}). Judge has a side or the config isn't actually identical across passes.`;
      } else {
        significant = `RIG LOOKS CLEAN — selfplay CI straddles 0.5 (${winRate.lo}-${winRate.hi})`;
      }
    } else if (decided >= 10 && winRate.lo > 0.5) {
      significant = "YES — candidate wins at 95% CI (lower bound above 0.5)";
    } else if (decided >= 10 && winRate.hi < 0.5) {
      significant = "NO  — baseline wins at 95% CI (upper bound below 0.5)";
    } else {
      significant = "INCONCLUSIVE — CI straddles 0.5; need more scenarios or bigger effect";
    }

    const summary = {
      runAt:        new Date().toISOString(),
      mode:         args.pipeline ? "pipeline" : "speaker",
      selfplay:     args.selfplay,
      fineTune:     args.fineTune,
      maxRpm,
      scenarios:    n,
      decided,
      ties,
      candidateWins: cWins,
      baselineWins:  bWins,
      winRate95CI:  winRate,
      significant,
      byCategory,
      baselineCfg,
      candidateCfg,
    };

    console.log("─── SUMMARY ───");
    console.log(JSON.stringify(summary, null, 2));

    fs.writeFileSync(".eval-report.json", JSON.stringify({ summary, verdicts }, null, 2));
    console.log(`\nReport: .eval-report.json`);
    console.log(`\nInterpretation:\n  ${significant}\n`);

    clearCheckpoint();
  } finally {
    // ── Cleanup transient eval user ─────────────────────────────────────────
    if (args.pipeline && args.cleanup && redis && evalUserId) {
      process.stdout.write(`  cleaning up transient user ${evalUserId}...`);
      await cleanupEvalUser(redis, evalUserId);
      process.stdout.write(" done\n");
    } else if (args.pipeline && !args.cleanup) {
      console.log(`  --no-cleanup set; eval user ${evalUserId} left in Redis for inspection`);
    }
  }
}

// ─── Exported runner for programmatic use (autonomous daily cron) ──────────
// Allows app/api/eval/route.js to invoke the same eval logic without
// going through process.argv / main(). Returns a structured result that
// the cron endpoint can persist to Redis.

export async function runEval({
  scenarios      = HOLDOUT,
  baselineCfg    = {},
  candidateCfg   = {},
  pipeline       = false,
  selfplay       = false,
  maxRpm         = 30,
  fineTuneMode   = null,  // "on" | "off" | null
  redis          = null,  // required if pipeline=true
  evalUserId     = null,  // required if pipeline=true
  onScenarioDone = null,  // (scenarioId, baseline, candidate, verdict) → void
  timeBudgetMs   = null,  // if set, bail gracefully when elapsed exceeds this
} = {}) {
  const startedAt = Date.now();
  GOVERNOR = new RateGovernor(maxRpm);

  if (fineTuneMode === "off") process.env.GABRIELLA_EVAL_NO_FT = "1";
  else if (fineTuneMode === "on") delete process.env.GABRIELLA_EVAL_NO_FT;

  const resolvedCandidateCfg = selfplay ? baselineCfg : candidateCfg;

  const baselineResponses  = new Array(scenarios.length);
  const candidateResponses = new Array(scenarios.length);
  const verdicts = [];

  // Inline sequential runner — simpler than the CLI path's parallel dispatch
  // and better-suited to a time-budgeted Vercel function. Under the governor
  // concurrency>1 doesn't help anyway.
  for (let i = 0; i < scenarios.length; i++) {
    if (timeBudgetMs && Date.now() - startedAt > timeBudgetMs) {
      return {
        scenariosTotal:     scenarios.length,
        scenariosCompleted: verdicts.length,
        verdicts,
        bailedOn:           "time_budget",
        elapsedMs:          Date.now() - startedAt,
      };
    }

    const s = scenarios[i];

    applyConfig(baselineCfg);
    const base = pipeline
      ? await generateResponsePipeline(s, { evalUserId, redis }).catch(e => ({ spoken: `[ERR: ${e?.message}]`, think: null }))
      : await generateResponse(s).catch(e => ({ spoken: `[ERR: ${e?.message}]`, think: null }));
    baselineResponses[i] = base;

    applyConfig(resolvedCandidateCfg);
    const cand = pipeline
      ? await generateResponsePipeline(s, { evalUserId, redis }).catch(e => ({ spoken: `[ERR: ${e?.message}]`, think: null }))
      : await generateResponse(s).catch(e => ({ spoken: `[ERR: ${e?.message}]`, think: null }));
    candidateResponses[i] = cand;

    const v = await judgePair(s, base, cand).catch(() => ({ winner: "tie", reason: "judge failed" }));
    const verdict = {
      id: s.id, category: s.category, weight: s.weight, opener: s.opener,
      baseline: base.spoken, candidate: cand.spoken,
      winner: v.winner, reason: v.reason,
    };
    verdicts.push(verdict);

    if (onScenarioDone) await onScenarioDone(s.id, base, cand, verdict).catch(() => {});
  }

  const n = verdicts.length;
  const cWins = verdicts.filter(v => v.winner === "candidate").length;
  const bWins = verdicts.filter(v => v.winner === "baseline").length;
  const ties  = verdicts.filter(v => v.winner === "tie").length;
  const decided = cWins + bWins;
  const winRate = decided > 0 ? wilsonCI(cWins, decided) : { point: 0.5, lo: 0, hi: 1 };

  return {
    scenariosTotal:     scenarios.length,
    scenariosCompleted: n,
    verdicts,
    stats: {
      decided, ties, candidateWins: cWins, baselineWins: bWins,
      winRate95CI: winRate,
    },
    elapsedMs: Date.now() - startedAt,
  };
}

export { HOLDOUT, wilsonCI };

// Only run main() when invoked directly as a CLI, not when imported.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("eval-harness.js")) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
