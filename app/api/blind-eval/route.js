// app/api/blind-eval/route.js
//
// Blind human A/B eval endpoint.
//
//   GET  /api/blind-eval?action=next   → { pairId, scenario, a, b, swap }
//   GET  /api/blind-eval?action=stats  → aggregation + Wilson CI
//   POST /api/blind-eval               → record vote or submit pair
//     body: { action: "vote",   pairId, pick: "a"|"b"|"tie", swap }
//     body: { action: "submit", scenario, a, b }
//
// voterId is derived from the resolveUserId mechanism — the same
// cookie the chat route uses, so each browser session only votes
// once per pair.

export const runtime     = "nodejs";
export const maxDuration = 15;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import {
  nextPair,
  recordVote,
  submitPair,
  blindEvalStats,
} from "../../../lib/gabriella/blindEval.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET(req) {
  const url    = new URL(req.url);
  const action = url.searchParams.get("action") || "next";
  const voter  = resolveUserId(req);

  try {
    if (action === "stats") {
      const stats = await blindEvalStats(redis);
      return json({ ok: true, stats });
    }
    if (action === "next") {
      const pair = await nextPair(redis, voter);
      if (!pair) return json({ ok: true, done: true });
      return json({ ok: true, pair });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}

export async function POST(req) {
  const voter = resolveUserId(req);
  let body;
  try { body = await req.json(); } catch { body = {}; }
  const action = body?.action || "vote";

  try {
    if (action === "vote") {
      const ok = await recordVote(redis, {
        pairId:  body.pairId,
        voterId: voter,
        pick:    body.pick,
        swap:    !!body.swap,
      });
      return json({ ok });
    }
    if (action === "submit") {
      const pair = await submitPair(redis, {
        scenario: body.scenario,
        a:        body.a,
        b:        body.b,
      });
      if (!pair) return json({ ok: false, error: "invalid pair shape" }, 400);
      return json({ ok: true, pair });
    }
    return json({ ok: false, error: "unknown action" }, 400);
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
