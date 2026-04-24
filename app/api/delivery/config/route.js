// app/api/delivery/config/route.js
// Per-user delivery config. Lets the owner configure / inspect the
// webhook URL, enabled flag, cooldown window, and quiet hours for
// asynchronous push delivery. No authentication enforced here beyond
// the CRON_SECRET bearer — wire tighter auth if deploying to a multi-
// tenant environment.

export const runtime = "nodejs";

import { Redis } from "@upstash/redis";
import {
  loadDeliveryConfig,
  saveDeliveryConfig,
  loadDeliveryLog,
} from "../../../../lib/gabriella/delivery.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function authed(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;   // dev mode — no secret, allow
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export async function GET(req) {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId) return json({ ok: false, error: "missing userId" }, 400);

  const [config, log] = await Promise.all([
    loadDeliveryConfig(redis, userId),
    loadDeliveryLog(redis, userId),
  ]);

  // Redact the webhook URL a bit for display (keep origin only).
  let displayConfig = null;
  if (config) {
    displayConfig = {
      enabled:    config.enabled,
      webhookUrl: config.webhookUrl ? redactUrl(config.webhookUrl) : "",
      minGapMs:   config.minGapMs,
      quietHours: config.quietHours,
    };
  }
  return json({ ok: true, userId, config: displayConfig, recentLog: log.slice(0, 10) });
}

export async function POST(req) {
  if (!authed(req)) return new Response("Unauthorized", { status: 401 });
  let body;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "invalid json" }, 400); }

  const userId = body?.userId;
  if (!userId) return json({ ok: false, error: "missing userId" }, 400);

  const config = body?.config;
  if (!config || typeof config !== "object") {
    return json({ ok: false, error: "missing config" }, 400);
  }

  if (config.webhookUrl && !/^https:\/\//.test(config.webhookUrl)) {
    return json({ ok: false, error: "webhook must be https" }, 400);
  }

  await saveDeliveryConfig(redis, userId, config);
  return json({ ok: true, userId });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname ? "/…" : ""}`;
  } catch {
    return "";
  }
}
