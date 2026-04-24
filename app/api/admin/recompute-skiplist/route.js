// app/api/admin/recompute-skiplist/route.js
//
// Forces recomputation of the empirical dead-block skip set (Step TT).
// Normally the engine refreshes it lazily on a 24h cadence; this route
// lets an admin kick it immediately after a deploy or after block
// schema changes.
//
// POST with { Authorization: Bearer <ADMIN_TOKEN> }.

export const runtime     = "nodejs";
export const maxDuration = 30;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../../lib/gabriella/users.js";
import { recomputeSkipList } from "../../../../lib/gabriella/deadBlockPrune.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function authed(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${token}` || req.headers.get("x-admin-token") === token;
}

export async function POST(req) {
  if (!authed(req)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }
  const userId = resolveUserId(req);
  const payload = await recomputeSkipList(redis, userId);
  return new Response(JSON.stringify({ ok: true, payload }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
