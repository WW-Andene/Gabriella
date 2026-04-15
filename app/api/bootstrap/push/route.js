// app/api/bootstrap/push/route.js
//
// Browser-hittable endpoint to push an archived bootstrap bundle to
// Fireworks. Bypasses the codespace entirely: the training data is
// already in Upstash from the last `npm run run-everything`; this
// endpoint reads it back and uploads via the (current) signed-URL
// Fireworks flow.
//
// Usage (from any browser, including phone):
//
//   https://<your-app>.vercel.app/api/bootstrap/push?key=<CRON_SECRET>
//
// Optional:
//   &archive=<explicit-archive-key>    # default: latest bootstrap archive
//   &userId=<userId>                   # default: user_default
//
// Returns JSON with success/failure details. Bookmark the URL on your
// phone and just reload it whenever you want to retry the push.

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import {
  findLatestArchiveKey,
  readArchivedBundle,
  uploadToFireworks,
} from "../../../../lib/gabriella/learning.js";

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

  // Auth. Support both Authorization header and ?key=... query param
  // (the latter is for easy mobile browser use).
  const authHeader = req.headers.get("authorization");
  const authByHeader = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const authByQuery  = key && key === process.env.CRON_SECRET;

  if (!authByHeader && !authByQuery) {
    return json({ ok: false, error: "Unauthorized. Append ?key=<CRON_SECRET> to the URL." }, 401);
  }

  const userId = url.searchParams.get("userId") || "user_default";
  let archiveKey = url.searchParams.get("archive");

  try {
    if (!archiveKey) {
      archiveKey = await findLatestArchiveKey(redis, userId, "bootstrap");
      if (!archiveKey) {
        return json({
          ok:    false,
          error: `No bootstrap archive found under ${userId}. Run bootstrap generation first.`,
        }, 404);
      }
    }

    const { jsonl, meta, chunks } = await readArchivedBundle(redis, archiveKey);
    const lines = jsonl.split("\n").filter(l => l.trim()).length;

    // Sanity: refuse to push obviously wrong content.
    if (!jsonl || lines < 5) {
      return json({
        ok:    false,
        error: `Archive at ${archiveKey} has ${lines} line(s) — looks empty or corrupted.`,
      }, 400);
    }

    if (!process.env.FIREWORKS_API_KEY || !process.env.FIREWORKS_ACCOUNT_ID) {
      return json({
        ok:    false,
        error: "FIREWORKS_API_KEY + FIREWORKS_ACCOUNT_ID must be set on Vercel.",
      }, 500);
    }

    const filename = meta?.filename || `gabriella-bootstrap-${new Date().toISOString().slice(0, 10)}.jsonl`;

    try {
      const result = await uploadToFireworks(jsonl, process.env.FIREWORKS_API_KEY, {
        filename,
        accountId: process.env.FIREWORKS_ACCOUNT_ID,
      });

      return json({
        ok:         true,
        archiveKey,
        bytes:      jsonl.length,
        chunks,
        lines,
        filename,
        fireworks: {
          datasetId: result.datasetId,
          flow:      result.flow || "unknown",
          fileId:    result.fileId || null,
        },
        message: "Upload succeeded. The dataset is live on Fireworks and the next /api/learn run can train on it.",
      });
    } catch (fwErr) {
      return json({
        ok:         false,
        archiveKey,
        bytes:      jsonl.length,
        lines,
        filename,
        error:      String(fwErr.message || fwErr),
        note:       "Training data is still safe in Upstash. Fix the Fireworks config and hit this endpoint again.",
      }, 502);
    }
  } catch (err) {
    return json({
      ok:    false,
      error: String(err.message || err),
    }, 500);
  }
}
