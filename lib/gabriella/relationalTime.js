// relationalTime.js
// A separate clock for the relationship.
//
// Wall-clock time is wrong for relationship memory. A dense, vulnerable
// hour imprints deeper than a distracted week of small talk. Memory
// salience decay, interest EMA, style EMA — all of them currently use
// Date.now() deltas. That makes her forget real closeness on the same
// schedule as forgettable exchanges.
//
// This module introduces RELATIONAL TIME: a second clock per user,
// advanced each turn by an engagement-weighted tick. One wall-clock
// second of dense exchange might equal ten relational seconds; one
// wall-clock week of silence might equal half a relational day.
//
// Engagement multiplier per turn is composed from signals the system
// already has:
//   - pragmatics.weight            heavier moments tick faster
//   - feltState.charge granularity real emotional charge ticks faster
//   - message length + substance   shallow exchanges tick slower
//   - self-question / warmth flag  relational events tick faster
//
// Capped at [0.2, 5.0]× wall-clock per turn. We want something that
// actually shifts decay curves, not a noisy multiplier.
//
// Storage:
//   ${uid}:reltime:ms      STR   accumulated relational ms (int)
//   ${uid}:reltime:lastAt  STR   last wall-clock update timestamp
//   ${uid}:reltime:ticks   STR   JSON history, last 200 tick values
//
// Usage:
//   now()      → current relational ms for this user
//   tick()     → advance the clock based on turn signals (call from
//                chat-route background)
//   ageRel(ts) → how much RELATIONAL time has passed since ts (where
//                ts is itself a relational ms stamp)

const KEY_MS      = (u) => `${u}:reltime:ms`;
const KEY_LAST_AT = (u) => `${u}:reltime:lastAt`;
const KEY_TICKS   = (u) => `${u}:reltime:ticks`;

const TICK_MIN = 0.2;
const TICK_MAX = 5.0;
const MAX_HISTORY = 200;

// ─── Compute per-turn engagement multiplier ──────────────────────────────────

export function computeTickMultiplier({
  pragmatics,
  feltState,
  userMsg,
  isWarmth,       // optional — from userFingerprint detectors
  isSelfQuestion, // optional — ditto
  isPullback,     // optional — ditto
}) {
  let m = 1.0;

  // Pragmatic weight — direct signal
  const w = typeof pragmatics?.weight === "number" ? pragmatics.weight : 0.3;
  m *= 0.5 + (w * 2.0);   // weight 0.0 → 0.5, weight 0.5 → 1.5, weight 1.0 → 2.5

  // Charge and emotional granularity — if the charge string is rich
  // (multiple clauses, specific emotions), tick faster.
  const chargeLen = (feltState?.charge || "").length;
  if (chargeLen > 80) m *= 1.3;
  else if (chargeLen > 40) m *= 1.1;

  // Message length — very short messages with no markers tick slowly
  const msgLen = (userMsg || "").trim().length;
  if (msgLen < 12) m *= 0.6;
  else if (msgLen > 300) m *= 1.15;

  // Event bonuses
  if (isWarmth)       m *= 1.4;
  if (isSelfQuestion) m *= 1.3;
  if (isPullback)     m *= 0.7;  // pullback doesn't NEGATIVE-tick; it just slows

  // Closed/terse feltState → slower
  if (feltState?.temperature === "closed") m *= 0.8;
  if (feltState?.temperature === "open")   m *= 1.2;

  return Math.max(TICK_MIN, Math.min(TICK_MAX, m));
}

// ─── Read current relational time ────────────────────────────────────────────

export async function now(redis, userId) {
  if (!redis || !userId) return Date.now();
  try {
    const raw = await redis.get(KEY_MS(userId));
    if (!raw) return 0;
    const n = typeof raw === "string" ? parseInt(raw, 10) : Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

// ─── Tick — advance the clock ────────────────────────────────────────────────
// Takes the wall-clock delta since the last tick, multiplies by the
// engagement-weighted multiplier, adds to the accumulated relational ms.

export async function tick(redis, userId, signals) {
  if (!redis || !userId) return null;
  try {
    const nowMs  = Date.now();
    const [msRaw, lastRaw] = await Promise.all([
      redis.get(KEY_MS(userId)).catch(() => null),
      redis.get(KEY_LAST_AT(userId)).catch(() => null),
    ]);
    const relMs  = msRaw  ? parseInt(msRaw,  10) || 0 : 0;
    const lastAt = lastRaw ? parseInt(lastRaw, 10) || 0 : 0;

    // If first tick or >24h gap, use 5-minute synthetic delta so the
    // clock doesn't jump hours for a user who was silent all night.
    const wallDelta = lastAt === 0
      ? 5 * 60_000
      : Math.min(nowMs - lastAt, 24 * 3_600_000);

    const mult   = computeTickMultiplier(signals || {});
    const added  = Math.round(wallDelta * mult);
    const nextRel = relMs + added;

    await Promise.all([
      redis.set(KEY_MS(userId),      String(nextRel)),
      redis.set(KEY_LAST_AT(userId), String(nowMs)),
      redis.lpush(KEY_TICKS(userId), JSON.stringify({
        t: nowMs, wallDelta, mult: +mult.toFixed(3), added, rel: nextRel,
      })),
      redis.ltrim(KEY_TICKS(userId), 0, MAX_HISTORY - 1),
    ]);

    return { relMs: nextRel, wallDelta, mult, added };
  } catch {
    return null;
  }
}

// ─── Convert relational age → wall-feel ──────────────────────────────────────
// Given a relational ms stamp (from a previous now() call), return
// relational age + a rough wall-clock comparison so callers can
// decide which scale to use.

export function ageRel(currentRelMs, priorRelMs) {
  const diff = currentRelMs - (priorRelMs || 0);
  return {
    ms:      Math.max(0, diff),
    seconds: Math.round(diff / 1000),
    minutes: Math.round(diff / 60_000),
    hours:   +(diff / 3_600_000).toFixed(2),
    days:    +(diff / 86_400_000).toFixed(2),
  };
}

// ─── Stats for /api/stats ─────────────────────────────────────────────────────

export async function relTimeStats(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const [msRaw, lastRaw, ticks] = await Promise.all([
      redis.get(KEY_MS(userId)).catch(() => null),
      redis.get(KEY_LAST_AT(userId)).catch(() => null),
      redis.lrange(KEY_TICKS(userId), 0, 49).catch(() => []),
    ]);
    const parsed = (ticks || []).map(t => {
      try { return typeof t === "string" ? JSON.parse(t) : t; }
      catch { return null; }
    }).filter(Boolean);

    const avgMult = parsed.length
      ? parsed.reduce((s, t) => s + (t.mult || 0), 0) / parsed.length
      : null;

    return {
      relMs:        msRaw  ? parseInt(msRaw,  10) || 0 : 0,
      lastAt:       lastRaw ? parseInt(lastRaw, 10) || 0 : 0,
      recentTicks:  parsed.length,
      avgMultiplier: avgMult ? +avgMult.toFixed(3) : null,
      sampleTicks:  parsed.slice(0, 5),
    };
  } catch {
    return null;
  }
}
