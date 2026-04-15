// debugLog.js
// Redis-backed debug log buffer.
//
// Serverless functions have no shared memory, so we persist logs into
// Upstash Redis where the /dev dashboard can read them back. Writes
// are fire-and-forget (never block the thing that triggered them).
//
// Each entry:
//   { t: <ms>, level: "error"|"warn"|"info", source: "chat", message, detail }
//
// Capped at 500 entries via LTRIM. Auto-expires keys after 7 days.

const KEY = "gabriella:debugLog";
const MAX = 500;
const TTL_SECONDS = 7 * 24 * 60 * 60;

// Lazy-load so this module can be imported from anywhere without an
// immediate Redis connection.
let redisP = null;
async function getRedis() {
  if (!redisP) {
    redisP = (async () => {
      if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
        return null;
      }
      const { Redis } = await import("@upstash/redis");
      return new Redis({
        url:   process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      });
    })();
  }
  return redisP;
}

function serializeDetail(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 2000);
  if (value instanceof Error) {
    return {
      message: value.message,
      stack:   value.stack?.split("\n").slice(0, 8).join("\n"),
      name:    value.name,
      ...(value.status  ? { status:  value.status  } : {}),
      ...(value.body    ? { body:    String(value.body).slice(0, 400) } : {}),
      ...(value.url     ? { url:     value.url     } : {}),
    };
  }
  try {
    const str = JSON.stringify(value);
    return str.length > 2000 ? JSON.parse(str.slice(0, 2000) + '"}') : value;
  } catch {
    return String(value).slice(0, 2000);
  }
}

export async function debugLog(level, source, message, detail = null) {
  try {
    const redis = await getRedis();
    if (!redis) return;
    const entry = {
      t:        Date.now(),
      level,
      source,
      message:  String(message).slice(0, 500),
      detail:   serializeDetail(detail),
    };
    await redis.lpush(KEY, JSON.stringify(entry));
    await redis.ltrim(KEY, 0, MAX - 1);
    await redis.expire(KEY, TTL_SECONDS);
  } catch {
    // Never let logging failures propagate.
  }
}

export const logError = (source, message, detail) => debugLog("error", source, message, detail);
export const logWarn  = (source, message, detail) => debugLog("warn",  source, message, detail);
export const logInfo  = (source, message, detail) => debugLog("info",  source, message, detail);

export async function readDebugLog(limit = 100) {
  const redis = await getRedis();
  if (!redis) return [];
  try {
    const raw = await redis.lrange(KEY, 0, Math.max(1, Math.min(MAX, limit)) - 1);
    return (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return { t: 0, level: "error", message: "unparseable", source: "_parser", raw: r }; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function clearDebugLog() {
  const redis = await getRedis();
  if (!redis) return;
  try { await redis.del(KEY); } catch {}
}
