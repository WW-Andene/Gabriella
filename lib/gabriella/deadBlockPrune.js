// deadBlockPrune.js
// Empirical prompt consolidation — read Step KK's block-population
// telemetry and auto-null prompt slots that have never been carrying
// real signal.
//
// recordBlockPopulation (engine.js) writes per-day { turns, populated,
// empty } rollups for every prompt slot. This module reads the last
// 14 days, computes fillRate per slot, and produces a skip set of
// slots that:
//   - never rendered non-empty in >= 50 observed turns, OR
//   - rendered non-empty < 3% of the time over >= 100 turns.
//
// assemblePrompt consumes the skip set and outputs those slots as
// null. Net effect: fewer cache-breaking empty-string blocks, tighter
// prompt, provider-side prefix cache survives longer.
//
// The skip set is recomputed lazily — if the cached version is older
// than 24h (or missing), the next buildGabriella recomputes it
// inline. Cost: one extra Redis MGET across ~14 daily keys. Worth it.

const SKIP_CACHE_KEY = (u) => `${u}:blocks:skipList`;
const DAILY_KEY      = (u, day) => `${u}:blocks:${day}`;

const RECOMPUTE_AFTER_MS = 24 * 60 * 60 * 1000;  // 24h
const MIN_TURNS_SPARSE   = 50;                    // require >=50 turns to kill a slot
const MIN_TURNS_LOW      = 100;                   // >=100 for the fill-rate threshold
const FILL_RATE_THRESH   = 0.03;

const BLOCK_NAMES = [
  "self", "identity", "mood", "evolution", "memory", "threads",
  "interiority", "withholding", "deflection", "debt", "agenda",
  "threshold", "imaginal", "metacognition", "metaregister",
  "presence", "voice", "linguistics", "stylometry", "idiolect",
  "callback", "plan", "diversity", "borrowing", "userPrefs",
  "privacy", "identityHooks", "userMood", "graph", "userFingerprint",
  "styleOutcomes", "chronology", "arc", "recurrence", "reasoningTrace",
  "pragmatics", "context", "monologue", "state", "pinned",
  "trajectory", "phase", "reentry", "selfUncertainty",
];

// ─── Recompute from the raw daily rollups ─────────────────────────────────────

function dayKeyFor(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export async function recomputeSkipList(redis, userId) {
  if (!redis || !userId) return { skipSet: [], reason: "no-redis" };

  const days = [];
  for (let i = 0; i < 14; i++) days.push(dayKeyFor(i));

  const rollups = await Promise.all(days.map(d =>
    redis.get(DAILY_KEY(userId, d)).catch(() => null)
  ));

  const agg = { turns: 0, populated: {}, empty: {} };
  for (const raw of rollups) {
    if (!raw) continue;
    const d = typeof raw === "string" ? JSON.parse(raw) : raw;
    agg.turns += (d.turns || 0);
    for (const [k, c] of Object.entries(d.populated || {})) agg.populated[k] = (agg.populated[k] || 0) + c;
    for (const [k, c] of Object.entries(d.empty     || {})) agg.empty[k]     = (agg.empty[k]     || 0) + c;
  }

  const skipSet = [];
  for (const name of BLOCK_NAMES) {
    const pop = agg.populated[name] || 0;
    const emp = agg.empty[name]     || 0;
    const total = pop + emp;
    if (total < MIN_TURNS_SPARSE)  continue;
    const fillRate = total > 0 ? pop / total : 0;
    if (pop === 0 && total >= MIN_TURNS_SPARSE) {
      skipSet.push(name);
      continue;
    }
    if (total >= MIN_TURNS_LOW && fillRate < FILL_RATE_THRESH) {
      skipSet.push(name);
    }
  }

  const payload = {
    skipSet,
    computedAt: Date.now(),
    turnsObserved: agg.turns,
  };
  try { await redis.set(SKIP_CACHE_KEY(userId), JSON.stringify(payload)); }
  catch { /* ignore */ }

  return payload;
}

// ─── Load cached or recompute if stale ────────────────────────────────────────

export async function loadSkipSet(redis, userId) {
  if (!redis || !userId) return new Set();
  try {
    const raw = await redis.get(SKIP_CACHE_KEY(userId));
    if (!raw) {
      const fresh = await recomputeSkipList(redis, userId);
      return new Set(fresh.skipSet || []);
    }
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const age = Date.now() - (parsed.computedAt || 0);
    if (age > RECOMPUTE_AFTER_MS) {
      // Kick off refresh asynchronously; return what we have.
      recomputeSkipList(redis, userId).catch(() => null);
    }
    return new Set(parsed.skipSet || []);
  } catch {
    return new Set();
  }
}

// ─── Apply skip set to a blocks object (nulls out skipped slots) ──────────────

export function applySkipSet(blocksInput, skipSet) {
  if (!skipSet || skipSet.size === 0) return blocksInput;
  const out = { ...blocksInput };
  for (const name of skipSet) {
    if (name in out) out[name] = null;
  }
  return out;
}

// ─── Stats for /api/stats ─────────────────────────────────────────────────────

export async function skipListStats(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(SKIP_CACHE_KEY(userId));
    if (!raw) return { skipSet: [], computedAt: 0, turnsObserved: 0, ageHours: null };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const ageHours = parsed.computedAt ? (Date.now() - parsed.computedAt) / 3_600_000 : null;
    return {
      skipSet:       parsed.skipSet || [],
      computedAt:    parsed.computedAt || 0,
      turnsObserved: parsed.turnsObserved || 0,
      ageHours:      ageHours ? +ageHours.toFixed(1) : null,
    };
  } catch {
    return null;
  }
}
