// app/api/fireworks/config/route.js
//
// Browser-hittable configuration endpoint for fine-tune hyperparameters.
//
// Read:
//   GET  /api/fireworks/config?key=<CRON_SECRET>
//
// Change (GET for mobile convenience — any query except `key` is treated
// as a field to set). Example:
//   GET  /api/fireworks/config?key=<SECRET>&epochs=5&loraRank=32
//
// Reset a field (falls back to env var or hardcoded default):
//   GET  /api/fireworks/config?key=<SECRET>&epochs=default
//
// Wipe ALL overrides:
//   GET  /api/fireworks/config?key=<SECRET>&reset=1
//
// POST with a JSON body works too:
//   POST /api/fireworks/config  Authorization: Bearer <SECRET>
//   Body: { "epochs": 5, "loraRank": 32, "learningRate": 0.00005 }
//
// Priority at fine-tune launch time:
//   CLI/query param > upstash override > env var > hardcoded default

export const maxDuration = 15;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import {
  loadFinetuneConfig,
  updateFinetuneConfig,
  getFinetuneConfigSchema,
} from "../../../../lib/gabriella/finetuneConfig.js";

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

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("key") === process.env.CRON_SECRET) return true;
  return false;
}

const FIELD_NAMES = new Set(Object.keys(getFinetuneConfigSchema()));

export async function GET(req) {
  if (!authorized(req)) {
    return json({ ok: false, error: "Unauthorized. Append ?key=<CRON_SECRET> to the URL." }, 401);
  }

  const url = new URL(req.url);
  const params = url.searchParams;

  try {
    // Reset path — wipe all overrides.
    if (params.get("reset") === "1" || params.get("reset") === "true") {
      await redis.del("gabriella:finetuneConfig");
      const { config, sources } = await loadFinetuneConfig(redis);
      return json({
        ok:       true,
        action:   "reset",
        config,
        sources,
        message:  "All upstash overrides cleared. Values now come from env/defaults.",
      });
    }

    // Collect any field query-params → treat as updates.
    const patch = {};
    for (const [k, v] of params.entries()) {
      if (k === "key" || k === "reset") continue;
      if (FIELD_NAMES.has(k)) patch[k] = v;
    }

    if (Object.keys(patch).length > 0) {
      await updateFinetuneConfig(redis, patch);
      const { config, sources } = await loadFinetuneConfig(redis);
      return json({
        ok:       true,
        action:   "updated",
        patched:  patch,
        config,
        sources,
        schema:   getFinetuneConfigSchema(),
        message:  "Next fine-tune launch will use these values.",
      });
    }

    // Plain read.
    const { config, sources } = await loadFinetuneConfig(redis);
    return json({
      ok:      true,
      action:  "read",
      config,
      sources,
      schema:  getFinetuneConfigSchema(),
      hint:
        "To change a value: append e.g. &epochs=5 to this URL.\n" +
        "To reset a single field to env/default: &epochs=default\n" +
        "To wipe all overrides: &reset=1",
    });
  } catch (err) {
    return json({
      ok:    false,
      error: err.message || String(err),
    }, 500);
  }
}

export async function POST(req) {
  if (!authorized(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let patch = {};
  try {
    patch = await req.json();
  } catch {
    return json({ ok: false, error: "POST body must be JSON." }, 400);
  }

  // Filter to known fields only.
  const filtered = {};
  for (const [k, v] of Object.entries(patch)) {
    if (FIELD_NAMES.has(k)) filtered[k] = v;
  }

  await updateFinetuneConfig(redis, filtered);
  const { config, sources } = await loadFinetuneConfig(redis);
  return json({ ok: true, action: "updated", patched: filtered, config, sources });
}
