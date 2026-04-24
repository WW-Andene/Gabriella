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
    const [self, stream, chronology, callbacks, plan] = await Promise.all([
      loadSelf(redis, userId),
      readStream(redis, userId, { limit: 15 }).catch(() => []),
      loadChronology(redis, userId).catch(() => null),
      loadLedger(redis, userId).catch(() => ({ landed: 0, missed: 0, total: 0 })),
      loadPlan(redis, userId).catch(() => null),
    ]);

    const rate = callbacks.total > 0
      ? +(callbacks.landed / callbacks.total).toFixed(2)
      : null;

    const payload = {
      ok:       true,
      userId,
      generatedAt: Date.now(),

      summary: summarizeInPlainEnglish({ self, callbacks, chronology, plan }),

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
