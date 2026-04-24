// app/api/feedback/route.js
//
// User-driven training signal. The user picks thumbs-up or thumbs-down
// on a specific response; the context + response + label immediately
// enters the KTO training bundle via recordEnsembleLabel's storage
// layer (ensemble_labels list). Next weekly /api/learn push folds
// it into the fine-tune dataset.
//
// Why this matters: automatic signals (gauntlet-passing, ensemble
// judges) are good but they encode OUR quality rubric. User feedback
// encodes THIS USER's rubric. Mix both → fine-tune that's genuinely
// tuned to the deployment's audience, not a generic 'Gabriella voice
// per heuristics' target.
//
// POST /api/feedback  body={ context: [{role, content}, ...],
//                             response: "string", label: "up" | "down",
//                             note: "optional free-form" }
//
// Returns { ok, recorded, totalFeedback }.

export const runtime     = "nodejs";
export const maxDuration = 15;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const LABELS_KEY   = (u) => `${u}:ensemble_labels`;   // same list KTO reads from
const FEEDBACK_KEY = (u) => `${u}:feedback:ledger`;    // separate log for transparency

const MAX_LEDGER = 2000;

export async function POST(req) {
  const userId = resolveUserId(req);

  try {
    const body = await req.json().catch(() => ({}));
    const { context, response, label, note } = body || {};

    if (!Array.isArray(context) || context.length === 0) {
      return new Response(JSON.stringify({ ok: false, error: "context (array of {role, content}) required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    if (!response || typeof response !== "string") {
      return new Response(JSON.stringify({ ok: false, error: "response (string) required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }
    if (label !== "up" && label !== "down") {
      return new Response(JSON.stringify({ ok: false, error: "label must be 'up' or 'down'" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    // Normalize context (last 6, truncated content) to match the KTO
    // bundle's ensemble-labels shape.
    const contextClean = context.slice(-6).map(m => ({
      role:    m.role === "user" || m.role === "assistant" ? m.role : "user",
      content: String(m.content || "").slice(0, 800),
    }));

    // KTO training entry — shape matches recordEnsembleLabel's so the
    // existing buildKtoBundle reads both sources without changes.
    const trainingEntry = {
      t:         Date.now(),
      context:   contextClean,
      output:    response.slice(0, 1500),
      label:     label === "up",
      score:     label === "up" ? 9 : 3,
      votes:     1,
      perFamily: { user: label === "up" ? 9 : 3 },
      source:    "user_feedback",
      tells:     note ? [note.slice(0, 240)] : [],
    };

    // Transparency ledger — separate list so an operator can see
    // per-user feedback volume / bias without mixing with ensemble data.
    const ledgerEntry = {
      t:        Date.now(),
      userId,
      label,
      note:     note ? String(note).slice(0, 300) : null,
      response: response.slice(0, 500),
      lastUser: [...contextClean].reverse().find(m => m.role === "user")?.content?.slice(0, 300) || null,
    };

    await redis.lpush(LABELS_KEY(userId),   JSON.stringify(trainingEntry));
    await redis.ltrim(LABELS_KEY(userId),   0, MAX_LEDGER - 1);
    await redis.lpush(FEEDBACK_KEY(userId), JSON.stringify(ledgerEntry));
    await redis.ltrim(FEEDBACK_KEY(userId), 0, MAX_LEDGER - 1);

    const totalFeedback = await redis.llen(FEEDBACK_KEY(userId)).catch(() => 1);

    return new Response(JSON.stringify({
      ok: true,
      recorded: true,
      label,
      totalFeedback,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
