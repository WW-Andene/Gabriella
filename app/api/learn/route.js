// app/api/learn/route.js
//
// The weekly push. Called by Vercel Cron (see vercel.json).
//
// Reads the training log from Redis, filters gauntlet-accepted exchanges,
// formats them as chain-of-thought JSONL, and uploads to whichever
// fine-tune provider you've configured via env var:
//
//   • TOGETHER_API_KEY       → uploads to Together AI
//   • FIREWORKS_API_KEY      → uploads to Fireworks AI (needs FIREWORKS_ACCOUNT_ID)
//   • LEARNING_WEBHOOK_URL   → POSTs the JSONL to any URL you control
//
// If none are set, the bundle is archived to Upstash so data is preserved
// until you pick a provider. Each run is recorded under
// `{userId}:learning:history` with what was uploaded and where.
//
// Auth: same bearer-token pattern as /api/think and /api/sleep. Without
// CRON_SECRET set the endpoint is open (dev-friendly); with it set the
// endpoint requires the header.

import { Redis } from "@upstash/redis";
import { pushLearningBundle, getLearningHistory } from "../../../lib/gabriella/learning.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID      = "user_default";
const MIN_EXAMPLES = 10; // don't bother provider before there's real data

export async function GET(req) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const result = await pushLearningBundle(redis, USER_ID, {
      minExamples: MIN_EXAMPLES,
    });

    return new Response(JSON.stringify({ ok: true, ...result }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Learn route failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Also expose a GET for history inspection when called with ?history=1
// (so you can see what has been pushed without another endpoint).
export async function POST(req) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url     = new URL(req.url);
  const limit   = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 20)));
  const history = await getLearningHistory(redis, USER_ID, { limit });

  return new Response(JSON.stringify({ ok: true, history }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
