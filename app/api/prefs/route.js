// app/api/prefs/route.js
// GET  — returns current user prefs
// POST — { variant?, customAnchor? } — updates prefs, returns updated state

export const runtime     = "nodejs";
export const maxDuration = 10;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import { loadUserPrefs, saveUserPrefs, VALID_VARIANTS } from "../../../lib/gabriella/userPrefs.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET(req) {
  const userId = resolveUserId(req);
  const prefs = await loadUserPrefs(redis, userId);
  return new Response(JSON.stringify({
    ok: true, userId, prefs, validVariants: VALID_VARIANTS,
  }), { headers: { "Content-Type": "application/json" } });
}

export async function POST(req) {
  const userId = resolveUserId(req);
  try {
    const body = await req.json().catch(() => ({}));
    const { variant, customAnchor } = body || {};
    const current = await loadUserPrefs(redis, userId);
    const next = {
      variant:      variant != null ? variant : current.variant,
      customAnchor: customAnchor !== undefined
        ? (customAnchor === null ? null : String(customAnchor))
        : current.customAnchor,
    };
    const saved = await saveUserPrefs(redis, userId, next);
    return new Response(JSON.stringify({ ok: true, prefs: saved }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
