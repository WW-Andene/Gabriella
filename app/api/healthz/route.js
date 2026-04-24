// app/api/healthz/route.js
//
// Plain-text uptime endpoint for monitoring tools that want a
// cheap GET without parsing JSON or hitting the heavier /api/stats.
//
// Returns "ok" with 200 when:
//   • Redis is reachable (one-round-trip scratch key)
//   • At least one LLM provider is alive in the pool
//
// Returns "degraded" with 200 when:
//   • Redis is reachable BUT no LLM providers alive (chat is
//     unavailable but the app is structurally up)
//
// Returns "down" with 503 when:
//   • Redis is unreachable
//
// No auth. No per-user state. No caches. Meant for frequent polling
// from uptime checkers. ≤100ms cold, ≤5ms warm.

export const runtime     = "nodejs";
export const maxDuration = 10;

import { Redis } from "@upstash/redis";
import { poolStats } from "../../../lib/gabriella/groqPool.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET() {
  let redisOk = false;
  let poolAlive = 0;

  try {
    await redis.set("healthz:ping", "1", { ex: 30 });
    const got = await redis.get("healthz:ping");
    redisOk = got === "1";
  } catch {
    redisOk = false;
  }

  try {
    const stats = poolStats();
    poolAlive = stats.aliveCount || 0;
  } catch {
    poolAlive = 0;
  }

  if (!redisOk) {
    return new Response("down\nredis: unreachable\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  if (poolAlive === 0) {
    return new Response("degraded\nredis: ok\npool: no live providers\n", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(`ok\nredis: ok\npool: ${poolAlive} alive\n`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
