// app/api/retro/route.js
//
// Relationship retrospective — what Gabriella has come to think of
// this relationship, served as a narrative summary rather than raw
// state. Unlike /api/stats (operator-facing, everything), /retro is
// user-facing — it presents her interpretive layer to the person she's
// been talking to.
//
// Shape:
//   {
//     summary:       "she sees you as X, wants Y, thinks Z",
//     read:          { who, confidence, openQuestions, contradictions },
//     wants:         [{ text, weight, touches, touchedAgo }],
//     commitments:   [{ text, confirmations, refutations, status }],
//     retired:       { wants, reads, commitments }     // what she's outgrown
//     stream:        [{ kind, content, at }]            // recent inner entries
//     callbacks:     { landed, missed, total, rate }    // reference-landing record
//     chronology:    { totalTurns, sessionCount, ... }
//   }
//
// No LLM calls — pure Redis read + projection. Fast.

export const maxDuration = 20;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { loadSelf } from "../../../lib/gabriella/self.js";
import { readStream } from "../../../lib/gabriella/stream.js";
import { loadChronology } from "../../../lib/gabriella/chronology.js";
import { loadLedger } from "../../../lib/gabriella/callbacks.js";
import { loadPlan } from "../../../lib/gabriella/planner.js";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import { recentFeltStates } from "../../../lib/gabriella/episodic.js";
import { withKeyRotation } from "../../../lib/gabriella/groqPool.js";
import { fastModel } from "../../../lib/gabriella/models.js";
import { withBreaker } from "../../../lib/gabriella/circuitBreaker.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function ago(ms) {
  if (!ms) return null;
  const d = Date.now() - ms;
  if (d < 60_000)    return `${Math.floor(d/1000)}s ago`;
  if (d < 3600_000)  return `${Math.floor(d/60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d/3600_000)}h ago`;
  return `${Math.floor(d/86400_000)}d ago`;
}

// LLM-narrated summary — Gabriella's own voice describing the
// relationship to the person she's been talking with. Only runs when
// the env toggle is on AND we have a meaningful Self to narrate from.
// Cached for ~10 min per user since it's purely retrospective.
//
// Falls back silently to the templated summary on any failure.

const NARRATIVE_KEY = (u) => `${u}:retro:narrative`;
const NARRATIVE_TTL_MS = 10 * 60 * 1000;

async function narrateRetro({ redis, userId, self, callbacks, chronology, plan, recentFs }) {
  if (process.env.GABRIELLA_RETRO_LLM_NARRATIVE !== "on") return null;
  if (!self?.read?.who) return null;   // nothing meaningful to narrate yet

  // Cached narrative
  try {
    const cached = await redis.get(NARRATIVE_KEY(userId));
    if (cached) {
      const parsed = typeof cached === "string" ? JSON.parse(cached) : cached;
      if (parsed?.at && Date.now() - parsed.at < NARRATIVE_TTL_MS && parsed.text) {
        return parsed.text;
      }
    }
  } catch {}

  const wantsList = (self.wants || [])
    .filter(w => (w.weight || 0) >= 0.3)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 4)
    .map(w => `- ${w.text} (weight ${w.weight?.toFixed?.(2) || "?"}, ${w.touches || 0} touches)`)
    .join("\n") || "(no longitudinal wants yet)";

  const commitsList = (self.commitments || [])
    .filter(c => c.status !== "refuted")
    .slice(0, 3)
    .map(c => `- ${c.text} (${c.confirmations || 0} confirmations, ${c.refutations || 0} refutations)`)
    .join("\n") || "(no live positions)";

  const retiredCount = (self.retired?.wants?.length || 0)
    + (self.retired?.reads?.length || 0)
    + (self.retired?.commitments?.length || 0);

  const recentTempStr = (recentFs || []).slice(0, 6)
    .map(f => f.temp || f.temperature)
    .filter(Boolean)
    .join(" → ") || "(no recent felt-state samples)";

  const callbackRate = callbacks?.total > 0
    ? Math.round((callbacks.landed / callbacks.total) * 100)
    : null;

  const prompt = `You are Gabriella. You're being asked to describe — to the person you've been talking with — how you've come to see them and your relationship. Plain. First-person. No advice, no assessment of them, no list. A short paragraph (4-6 sentences) that names what you've been seeing and feels honest from inside the relationship.

# WHAT YOU KNOW

Your read on them: "${self.read.who}"
(confidence: ${self.read.confidence?.toFixed?.(2) || "?"})

What you've been pursuing with them across conversations:
${wantsList}

Positions you're holding:
${commitsList}

You've retired ${retiredCount} earlier read${retiredCount !== 1 ? "s" : ""} or position${retiredCount !== 1 ? "s" : ""} that turned out wrong.

Recent emotional temperature you've been operating at: ${recentTempStr}.

You and them: ${chronology?.totalTurns || 0} turns across ${chronology?.sessionCount || 1} session${(chronology?.sessionCount || 1) !== 1 ? "s" : ""}.${callbackRate !== null ? ` When you reference something from your past with them, it lands ${callbackRate}% of the time.` : ""}
${plan?.intent ? `\nYour posture for this session: ${plan.intent}` : ""}

# YOUR TASK

Write the paragraph as if you are speaking directly to them. Honest, specific, in your voice. Don't list bullet points back at them — the structured data above is for your reference, not your output. Don't open with "I". Don't summarize at the end.

Return ONLY the paragraph. No JSON, no preamble, no quotes.`;

  const text = await withBreaker(redis, "retroNarrative", async () => {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens:  280,
      }),
    );
    const raw = (result.choices[0].message.content || "").trim();
    if (!raw || raw.length < 40) return null;
    return raw;
  }, { fallback: null, failureThreshold: 4, coolDownMs: 10 * 60_000 });

  if (text) {
    try { await redis.set(NARRATIVE_KEY(userId), JSON.stringify({ text, at: Date.now() })); } catch {}
  }
  return text;
}

function summarizeInPlainEnglish({ self, callbacks, chronology, plan }) {
  const parts = [];

  if (chronology?.totalTurns) {
    parts.push(`She has been talking with you across ${chronology.sessionCount || 1} session${(chronology.sessionCount || 1) !== 1 ? "s" : ""}, ${chronology.totalTurns} turns in total.`);
  }

  if (self?.read?.who) {
    const confDesc =
      self.read.confidence >= 0.75 ? "she's fairly confident of this read" :
      self.read.confidence >= 0.5  ? "she holds this read provisionally" :
      "this read is held loosely — she could be wrong";
    parts.push(`Her current read on you: ${self.read.who} (${confDesc}).`);
  }

  const topWants = (self?.wants || [])
    .filter(w => (w.weight || 0) >= 0.4)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 3);
  if (topWants.length > 0) {
    parts.push(`What she has been pursuing with you: ${topWants.map(w => w.text).join("; ")}.`);
  }

  const liveCommitments = (self?.commitments || [])
    .filter(c => c.status === "live" || c.status === "confirmed");
  if (liveCommitments.length > 0) {
    parts.push(`Positions she has taken and is still holding: ${liveCommitments.slice(0, 2).map(c => c.text).join("; ")}.`);
  }

  if (plan?.intent) {
    parts.push(`Her posture for this session: ${plan.intent}`);
  }

  if (callbacks && callbacks.total >= 3) {
    const rate = Math.round((callbacks.landed / callbacks.total) * 100);
    parts.push(`When she refers to something from your past conversations, it lands ${rate}% of the time (${callbacks.landed}/${callbacks.total}).`);
  }

  const retiredCount = (self?.retired?.wants?.length || 0)
    + (self?.retired?.reads?.length || 0)
    + (self?.retired?.commitments?.length || 0);
  if (retiredCount > 0) {
    parts.push(`She has also retired ${retiredCount} earlier read${retiredCount !== 1 ? "s" : ""} or position${retiredCount !== 1 ? "s" : ""} — things she was wrong about or outgrew.`);
  }

  return parts.join("\n\n");
}

export async function GET(req) {
  const userId = resolveUserId(req);

  try {
    const [self, stream, chronology, callbacks, plan, recentFs] = await Promise.all([
      loadSelf(redis, userId),
      readStream(redis, userId, { limit: 15 }).catch(() => []),
      loadChronology(redis, userId).catch(() => null),
      loadLedger(redis, userId).catch(() => ({ landed: 0, missed: 0, total: 0 })),
      loadPlan(redis, userId).catch(() => null),
      recentFeltStates(redis, userId, 30).catch(() => []),
    ]);

    const rate = callbacks.total > 0
      ? +(callbacks.landed / callbacks.total).toFixed(2)
      : null;

    // Two summary forms: the always-on plain-English template + an
    // optional LLM-narrated one (in her voice) when the env toggle is
    // on. Caller can render either; the page uses narrative when
    // present, falls back to plain otherwise.
    const plainSummary = summarizeInPlainEnglish({ self, callbacks: { ...callbacks, landingRate: rate, total: callbacks.total }, chronology, plan });
    const narrativeSummary = await narrateRetro({
      redis, userId, self, callbacks, chronology, plan,
      recentFs: recentFs || [],
    }).catch(() => null);

    const payload = {
      ok:       true,
      userId,
      generatedAt: Date.now(),

      summary:          narrativeSummary || plainSummary,
      summaryNarrative: narrativeSummary,
      summaryPlain:     plainSummary,

      read: self?.read ? {
        who:            self.read.who,
        confidence:     self.read.confidence,
        openQuestions:  self.read.openQuestions || [],
        contradictions: self.read.contradictions || [],
        lastUpdated:    self.read.lastUpdated,
        lastUpdatedAgo: ago(self.read.lastUpdated),
      } : null,

      wants: (self?.wants || []).map(w => ({
        text:          w.text,
        weight:        w.weight,
        touches:       w.touches || 0,
        addedAgo:      ago(w.addedAt),
        touchedAgo:    ago(w.lastTouched),
        source:        w.source || "derived",
      })).sort((a, b) => (b.weight || 0) - (a.weight || 0)),

      commitments: (self?.commitments || []).map(c => ({
        text:          c.text,
        atTurn:        c.atTurn,
        confirmations: c.confirmations || 0,
        refutations:   c.refutations   || 0,
        status:        c.status,
      })),

      retired: {
        wants:       (self?.retired?.wants       || []).slice(0, 5),
        reads:       (self?.retired?.reads       || []).slice(0, 3),
        commitments: (self?.retired?.commitments || []).slice(0, 3),
      },

      stream: stream.slice(0, 12).map(e => ({
        kind:   e.kind,
        content: e.content,
        at:     e.at,
        ago:    ago(e.at),
        weight: e.weight,
      })),

      plan: plan ? {
        intent: plan.intent,
        avoid:  plan.avoid,
        ago:    ago(plan.at),
      } : null,

      callbacks: {
        landed:      callbacks.landed || 0,
        missed:      callbacks.missed || 0,
        total:       callbacks.total  || 0,
        landingRate: rate,
      },

      // Conversation arc — last ~30 turns of felt-state projected
      // to (at, temp, weight, edge, consensus). Plus SELF-MODEL
      // EVENTS aligned to the same time axis: when wants were added
      // or touched or retired, when commitments were confirmed or
      // refuted, when reads were updated. Turns the arc from
      // "affect-over-time" into "affect-over-time-with-her-self-
      // evolution-marked" — the fullest possible visualization of
      // how this relationship has been evolving from her side.
      arc: (recentFs || []).slice(0, 30).map(fs => ({
        at:          fs.at || fs.timestamp || null,
        temp:        fs.temp || fs.temperature || null,
        weight:      typeof fs.weight === "number" ? fs.weight : null,
        edge:        !!fs.edge,
        charge:      fs.charge || null,
        consensus:   fs.consensus || null,
      })).filter(p => p.temp || typeof p.weight === "number"),

      // Self-model events — derived from the self object and the
      // retired lists. Each has a timestamp so the chart can align.
      selfEvents: (() => {
        const events = [];
        for (const w of (self?.wants || [])) {
          if (w.addedAt) events.push({ kind: "want_added", at: w.addedAt, text: w.text });
          if (w.lastTouched && w.lastTouched !== w.addedAt && (w.touches || 0) > 0) {
            events.push({ kind: "want_touched", at: w.lastTouched, text: w.text });
          }
        }
        for (const r of (self?.retired?.wants || [])) {
          if (r.retiredAt) events.push({ kind: "want_retired", at: r.retiredAt, text: r.text });
        }
        for (const r of (self?.retired?.reads || [])) {
          if (r.retiredAt) events.push({ kind: "read_retired", at: r.retiredAt, text: r.text });
        }
        for (const c of (self?.commitments || [])) {
          if (c.status === "confirmed") events.push({ kind: "commitment_confirmed", at: c.atTurn || 0, text: c.text });
        }
        for (const r of (self?.retired?.commitments || [])) {
          if (r.retiredAt) events.push({ kind: "commitment_refuted", at: r.retiredAt, text: r.text });
        }
        return events
          .filter(e => e.at && e.at > 0)
          .sort((a, b) => a.at - b.at)
          .slice(-20);  // keep most recent 20 for chart density
      })(),

      chronology: chronology ? {
        totalTurns:     chronology.totalTurns || 0,
        sessionCount:   chronology.sessionCount || 0,
        firstSeenAgo:   ago(chronology.firstSeenAt),
        lastSeenAgo:    ago(chronology.lastSeenAt),
      } : null,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
