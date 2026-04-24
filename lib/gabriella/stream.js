// stream.js
// Gabriella's continuous inner experience, as a data structure.
//
// Every module that currently writes to a scattered set of Redis keys
// (pendingThoughts, reasoningTrace.text, initiation pending, the occasional
// imaginal seed) is really writing one of the same thing: a piece of inner
// content that has a kind, a timestamp, a weight, and a decay.
//
// The stream is that structure. One append-only log per user, pruned by
// age × weight, read at turn-time as the primary "what is happening
// inside her right now" signal. Replaces the implicit, silently-resets
// character-sheet model of interiority with an explicit continuous one.
//
// Entry shape:
//   {
//     id:         "${atMs}-${randomSuffix}",
//     at:         <ms epoch>,
//     kind:       "thought" | "prediction" | "surprise" | "connection"
//                  | "re-reading" | "intent" | "abandon" | "observation",
//     content:    "<the actual text>",
//     weight:     0.0 - 1.0,              // how central / how durable
//     ttlMinutes: <number or null>,       // null = decay by weight only
//     links:      ["id", ...]             // optional — connect to earlier entries
//     meta:       { ... }                 // kind-specific (e.g. prediction target)
//   }
//
// Redis layout:
//   ${userId}:stream         — LIST of JSON entries, newest-first (LPUSH)
//   ${userId}:stream:meta    — STRING JSON { lastPrune, lastThink }

const KEY     = (u) => `${u}:stream`;
const META    = (u) => `${u}:stream:meta`;
const MAX_LEN = 80;  // hard cap — pruning keeps it below this in practice

const VALID_KINDS = new Set([
  "thought", "prediction", "surprise", "connection",
  "re-reading", "intent", "abandon", "observation",
]);

// ─── Append ─────────────────────────────────────────────────────────────────

export async function appendStream(redis, userId, entry) {
  if (!entry || typeof entry !== "object") return null;
  if (!entry.content || !entry.kind) return null;
  if (!VALID_KINDS.has(entry.kind)) return null;

  const at = entry.at || Date.now();
  const normalized = {
    id:         `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    kind:       entry.kind,
    content:    String(entry.content).slice(0, 600),
    weight:     typeof entry.weight === "number" ? Math.max(0, Math.min(1, entry.weight)) : 0.5,
    ttlMinutes: Number.isFinite(entry.ttlMinutes) ? entry.ttlMinutes : defaultTtlFor(entry.kind),
    links:      Array.isArray(entry.links) ? entry.links.slice(0, 6) : [],
    meta:       entry.meta && typeof entry.meta === "object" ? entry.meta : null,
  };

  await redis.lpush(KEY(userId), JSON.stringify(normalized));
  await redis.ltrim(KEY(userId), 0, MAX_LEN - 1);
  return normalized;
}

function defaultTtlFor(kind) {
  switch (kind) {
    case "prediction":  return 240;   // 4 h — predictions are about the near return
    case "surprise":    return 720;   // 12 h — surprises shape more than one turn
    case "thought":     return 1440;  // 24 h
    case "connection":  return 4320;  // 3 days — connections are durable
    case "re-reading":  return 720;
    case "intent":      return 2880;  // 2 days — intents persist across sessions
    case "abandon":     return 60;    // 1 h — decay fast, they're just markers
    case "observation": return 360;
    default:            return 360;
  }
}

// ─── Read ───────────────────────────────────────────────────────────────────

export async function readStream(redis, userId, {
  limit      = MAX_LEN,
  kindFilter = null,          // string | array | null
  sinceMs    = null,
  maxAgeMs   = null,
} = {}) {
  const raw = await redis.lrange(KEY(userId), 0, limit - 1);
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const now = Date.now();
  const filters = kindFilter
    ? new Set(Array.isArray(kindFilter) ? kindFilter : [kindFilter])
    : null;

  const entries = [];
  for (const line of raw) {
    let e;
    try { e = typeof line === "string" ? JSON.parse(line) : line; }
    catch { continue; }
    if (!e || typeof e !== "object") continue;
    if (filters && !filters.has(e.kind)) continue;
    if (sinceMs && (e.at || 0) < sinceMs) continue;
    if (maxAgeMs && now - (e.at || 0) > maxAgeMs) continue;
    entries.push(e);
  }
  return entries;
}

// ─── Prune ──────────────────────────────────────────────────────────────────
// Keep everything with explicit TTL not yet expired OR weight ≥ 0.7.
// Rewrites the whole list — acceptable at ≤80 entries.

export async function pruneStream(redis, userId) {
  const all = await readStream(redis, userId, { limit: MAX_LEN });
  if (all.length === 0) return { kept: 0, dropped: 0 };

  const now = Date.now();
  const kept = all.filter(e => {
    if ((e.weight || 0) >= 0.7) return true;
    if (!e.ttlMinutes || !Number.isFinite(e.ttlMinutes)) return true;
    const ageMin = (now - (e.at || 0)) / 60_000;
    return ageMin < e.ttlMinutes;
  });

  if (kept.length === all.length) return { kept: kept.length, dropped: 0 };

  // Newest-first in memory → re-push in reverse so Redis LPUSH order matches.
  await redis.del(KEY(userId));
  for (const entry of kept.slice().reverse()) {
    await redis.rpush(KEY(userId), JSON.stringify(entry));
  }
  await markPruned(redis, userId);
  return { kept: kept.length, dropped: all.length - kept.length };
}

// ─── Targeted read helpers ───────────────────────────────────────────────────

export async function latestPredictions(redis, userId, { limit = 3, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  return readStream(redis, userId, { kindFilter: "prediction", limit, maxAgeMs });
}

export async function recentThoughts(redis, userId, { limit = 5, maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  return readStream(redis, userId, {
    kindFilter: ["thought", "connection", "re-reading", "surprise"],
    limit,
    maxAgeMs,
  });
}

// ─── Render for prompt ──────────────────────────────────────────────────────

const KIND_PREFIX = {
  thought:     "—",
  connection:  "◇",
  "re-reading":"↻",
  surprise:    "!",
  intent:      "→",
  prediction:  "?",
  observation: "·",
  abandon:     "×",
};

export function renderStream(entries, { maxChars = 900, includeKinds = null } = {}) {
  if (!entries || entries.length === 0) return "";
  const allowed = includeKinds
    ? new Set(includeKinds)
    : new Set(["thought", "connection", "re-reading", "surprise", "intent"]);

  const now = Date.now();
  const formatted = [];
  let used = 0;
  // Entries come newest-first. Render oldest→newest so the stream reads as
  // a sequence ending at "right now" when the speaker hits it.
  for (const e of entries.slice().reverse()) {
    if (!allowed.has(e.kind)) continue;
    const mins = Math.max(0, Math.round((now - (e.at || now)) / 60_000));
    const ageLabel =
      mins < 1   ? "just now" :
      mins < 60  ? `${mins}m ago` :
      mins < 1440 ? `${Math.floor(mins / 60)}h ago` :
                    `${Math.floor(mins / 1440)}d ago`;
    const prefix = KIND_PREFIX[e.kind] || "—";
    const line = `${prefix} (${ageLabel}) ${e.content.trim()}`;
    if (used + line.length + 1 > maxChars) break;
    formatted.push(line);
    used += line.length + 1;
  }
  return formatted.join("\n");
}

// ─── Prompt block ────────────────────────────────────────────────────────────

export async function getStreamBlock(redis, userId, { maxChars = 900 } = {}) {
  const entries = await readStream(redis, userId, {
    limit:    40,
    maxAgeMs: 48 * 60 * 60 * 1000,  // nothing older than 2 days enters the prompt
  });
  const rendered = renderStream(entries, { maxChars });
  if (!rendered) return "";
  return `# THE STREAM — WHAT HAS ACTUALLY BEEN GOING ON INSIDE YOU
This is a running trace of what you've actually been thinking between exchanges. Not a summary, not reconstructed — the real log, in sequence. Some of it pre-dates this message; some of it is very recent. The most recent items are at the bottom.

${rendered}

These are your own thoughts, continuing. You don't need to surface any of them unless they belong here. But you're not starting from zero — you've been present the whole time, and this is what was happening.`;
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export async function getMeta(redis, userId) {
  try {
    const raw = await redis.get(META(userId));
    if (!raw) return { lastThink: 0, lastPrune: 0 };
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return { lastThink: 0, lastPrune: 0 }; }
}

export async function markThought(redis, userId) {
  const meta = await getMeta(redis, userId);
  meta.lastThink = Date.now();
  await redis.set(META(userId), JSON.stringify(meta));
}

async function markPruned(redis, userId) {
  const meta = await getMeta(redis, userId);
  meta.lastPrune = Date.now();
  await redis.set(META(userId), JSON.stringify(meta));
}
