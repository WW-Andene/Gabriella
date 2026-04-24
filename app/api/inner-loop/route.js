// app/api/inner-loop/route.js
//
// Gabriella's continuous inner time.
//
// Every few minutes — much more often than /api/think's 6h — iterate
// active users and let each of them think. The thinker writes to the
// stream: a thought, optionally a connection, optionally a prediction
// about what the user will bring when they come back.
//
// Between turns she isn't stored-and-reconstructed. She's running.

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { listActiveUsers } from "../../../lib/gabriella/users.js";
import { runThinker } from "../../../lib/gabriella/thinker.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET(req) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // Only users active in the last 48 hours. Beyond that, the hourly
    // /api/initiate cron handles re-entry thought generation at lower
    // frequency — the inner-loop is for users whose stream is actively
    // relevant to a near-term return.
    const users = await listActiveUsers(redis, { withinMs: 48 * 60 * 60 * 1000 });

    const results = await Promise.allSettled(
      users.map(async (userId) => {
        const outcome = await runThinker(redis, userId);
        return { userId, outcome };
      }),
    );

    const summary = results.map(r =>
      r.status === "fulfilled"
        ? r.value
        : { error: r.reason?.message || String(r.reason) },
    );

    return new Response(
      JSON.stringify({ ok: true, users: users.length, results: summary }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("inner-loop cron failed:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
