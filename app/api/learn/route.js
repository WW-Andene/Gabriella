// app/api/learn/route.js
//
// The weekly push + (optional) auto-finetune launch.
// Called by Vercel Cron (see vercel.json).
//
// Pipeline each run:
//   1. Build the CoT bundle from new gauntlet-accepted exchanges.
//   2. Upload to every configured provider (Together / Fireworks /
//      webhook), with Upstash archive as the always-on backup.
//   3. If AUTO_FINETUNE is enabled AND the Fireworks upload succeeded
//      AND enough new examples have accumulated AND enough days have
//      passed since the last fine-tune, launch an SFT job. The pending
//      job id is stashed in Redis; /api/learn/watch polls it and
//      activates the speaker when training completes.
//
// Auth: bearer CRON_SECRET when set.
//
//   GET  /api/learn          — run the full pipeline
//   POST /api/learn          — return upload / fine-tune history

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import {
  pushLearningBundle,
  getLearningHistory,
  maybeTriggerFineTune,
} from "../../../lib/gabriella/learning.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID      = "user_default";
const MIN_EXAMPLES = 10;

export async function GET(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  try {
    // 1 + 2. Upload.
    const push = await pushLearningBundle(redis, USER_ID, {
      minExamples: MIN_EXAMPLES,
    });

    // 3. Optional auto-finetune. Swallow errors here so the endpoint
    //    always returns the push result even if SFT kickoff failed.
    let fineTune = null;
    try {
      fineTune = await maybeTriggerFineTune(redis, USER_ID, push);
    } catch (err) {
      fineTune = { launched: false, error: err.message };
    }

    return json({ ok: true, push, fineTune });
  } catch (err) {
    console.error("Learn route failed:", err);
    return json({ ok: false, error: err.message }, 500);
  }
}

export async function POST(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  const url     = new URL(req.url);
  const limit   = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 20)));
  const history = await getLearningHistory(redis, USER_ID, { limit });

  return json({ ok: true, history });
}

// Auth accepted via either Authorization: Bearer header OR ?key=<CRON_SECRET>
// query param — the query form is for mobile browser convenience.
function authorized(req) {
  if (!process.env.CRON_SECRET) return true; // unset = open (dev mode)
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("key") === process.env.CRON_SECRET) return true;
  return false;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
