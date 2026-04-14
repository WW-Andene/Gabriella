// users.js
// Multi-user keying — resolve a user id from the request and keep a
// registry of known ids so the background crons (think, sleep, learn,
// initiate) can iterate them.
//
// Resolution priority:
//   1. X-Gabriella-User header   — explicit opt-in from the client
//   2. gabriella_user cookie     — persistent per-browser id
//   3. derived from IP + UA      — soft-deterministic fallback
//   4. "user_default"            — backstop for single-user deployments
//
// All user-scoped Redis keys already use `{userId}:...` namespacing.
// This module just centralizes which id gets passed in.

const DEFAULT_USER = "user_default";
const USERS_SET_KEY = "gabriella:users:known";
const USER_LASTSEEN_KEY = (u) => `gabriella:users:${u}:lastSeen`;

// ─── Resolve userId from request ─────────────────────────────────────────────

export function resolveUserId(req, { fallbackSalt = "default" } = {}) {
  if (!req || typeof req.headers?.get !== "function") return DEFAULT_USER;

  // 1. Explicit header wins.
  const hdr = req.headers.get("x-gabriella-user");
  if (hdr) return normalize(hdr);

  // 2. Cookie fallback.
  const cookie = req.headers.get("cookie") || "";
  const cookieMatch = cookie.match(/gabriella_user=([^;]+)/);
  if (cookieMatch) return normalize(decodeURIComponent(cookieMatch[1]));

  // 3. Derived from IP + UA — soft-deterministic so the same browser on
  //    the same network gets the same id. Not auth, just continuity.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || req.headers.get("x-real-ip")
    || "";
  const ua = req.headers.get("user-agent") || "";
  if (ip || ua) return "u_" + hash16(`${ip}|${ua}|${fallbackSalt}`);

  return DEFAULT_USER;
}

function normalize(id) {
  const cleaned = String(id).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64);
  return cleaned.length >= 3 ? cleaned : DEFAULT_USER;
}

// Cheap deterministic 16-char hex — FNV-1a 64-bit is plenty for this.
function hash16(s) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0xdeadbeef | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, "0");
  return (hex(h1) + hex(h2)).slice(0, 16);
}

// ─── Registry — known users (so crons can iterate) ──────────────────────────

export async function registerUser(redis, userId) {
  try {
    await Promise.all([
      redis.sadd(USERS_SET_KEY, userId),
      redis.set(USER_LASTSEEN_KEY(userId), Date.now()),
    ]);
  } catch {}
}

export async function listUsers(redis) {
  try {
    const members = await redis.smembers(USERS_SET_KEY);
    return Array.isArray(members) && members.length > 0 ? members : [DEFAULT_USER];
  } catch {
    return [DEFAULT_USER];
  }
}

export async function listActiveUsers(redis, { withinMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const all = await listUsers(redis);
  const now = Date.now();
  const checks = await Promise.all(all.map(async (uid) => {
    try {
      const ts = Number(await redis.get(USER_LASTSEEN_KEY(uid))) || 0;
      return (now - ts) < withinMs ? uid : null;
    } catch {
      return uid;
    }
  }));
  return checks.filter(Boolean);
}

export { DEFAULT_USER };
