// app/api/dialectical/route.js
//
// Manual trigger for the weekly dialectical audit. Calling this GET
// runs runDialecticalAudit(redis, userId) and returns the found
// tensions. POSTing with { run: true } is equivalent but can be
// scheduled via Vercel cron.
//
// The audit is also safe to invoke on demand — it only runs the LLM
// call when at least 10 positions have been recorded, and the
// circuit breaker throttles repeated runs.

export const runtime     = "nodejs";
export const maxDuration = 60;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import { runDialecticalAudit, dialecticalStats } from "../../../lib/gabriella/dialectical.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET(req) {
  const userId = resolveUserId(req);
  const url    = new URL(req.url);
  const run    = url.searchParams.get("run") === "1";

  if (run) {
    const result = await runDialecticalAudit(redis, userId);
    return json({ ok: true, result });
  }
  const stats = await dialecticalStats(redis, userId);
  return json({ ok: true, stats });
}

export async function POST(req) {
  const userId = resolveUserId(req);
  let body; try { body = await req.json(); } catch { body = {}; }
  if (body?.run) {
    const result = await runDialecticalAudit(redis, userId);
    return json({ ok: true, result });
  }
  return json({ ok: false, error: "pass { run: true } to trigger" }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
