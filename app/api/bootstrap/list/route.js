// app/api/bootstrap/list/route.js
//
// Diagnostic endpoint: lists every archive key visible in Upstash for a
// given userId. Use this when /api/bootstrap/push says "no archive found"
// to verify whether Upstash actually contains the data, and to grab the
// specific key to pass back via ?archive=<key>.
//
// Usage:
//   https://<your-app>.vercel.app/api/bootstrap/list?key=<CRON_SECRET>
//
// Optional: &userId=<id>  (default: user_default)

export const maxDuration = 30;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { listArchives } from "../../../../lib/gabriella/learning.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  const authHeader = req.headers.get("authorization");
  const authByHeader = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const authByQuery  = key && key === process.env.CRON_SECRET;

  if (!authByHeader && !authByQuery) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  const userId = url.searchParams.get("userId") || "user_default";

  try {
    // All archive keys for this user.
    const archiveKeys = await listArchives(redis, userId);

    // Also probe for a specific known key from earlier screenshots,
    // since that's the one the user most recently had.
    const probeKey = "user_default:learning:archive:bootstrap:1776212044670";
    const probeRaw = await redis.get(probeKey);
    const probeExists = probeRaw != null;

    // Sample one currently-known key to confirm read access works.
    let sampleRead = null;
    if (archiveKeys.length > 0) {
      const sampleVal = await redis.get(archiveKeys[0]);
      sampleRead = {
        key:       archiveKeys[0],
        bytes:     sampleVal ? String(sampleVal).length : 0,
        firstLine: sampleVal ? String(sampleVal).split("\n", 1)[0].slice(0, 160) : null,
      };
    }

    // Raw keyspace probe — list ANY key that mentions "archive".
    let rawScan = [];
    try {
      rawScan = await redis.keys("*archive*");
    } catch {}

    return json({
      ok:           true,
      userId,
      upstashUrl:   process.env.UPSTASH_REDIS_REST_URL ? "configured" : "MISSING",
      archiveKeys,
      archiveCount: archiveKeys.length,
      probe: {
        key:    probeKey,
        exists: probeExists,
        bytes:  probeExists ? String(probeRaw).length : 0,
      },
      sampleRead,
      rawArchiveScan: rawScan,
      hint: archiveKeys.length === 0
        ? "Upstash shows no archive keys. Either the Upstash URL on Vercel points at a different database than the one bootstrap wrote to, OR the archive was evicted / deleted. Check UPSTASH_REDIS_REST_URL in Vercel env."
        : null,
    });
  } catch (err) {
    return json({
      ok:    false,
      error: String(err.message || err),
    }, 500);
  }
}
