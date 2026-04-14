// groqPool.js
// Multi-key Groq client pool.
//
// Gabriella fires 20+ Groq calls per exchange. A single free-tier
// account saturates quickly. With multiple keys configured, the pool
// spreads the load across accounts so the triple-core runs genuinely
// in parallel — each core gets its own account's RPM/TPM budget —
// and the rest of the pipeline round-robins across all configured keys.
//
// Keys are read from env on module load:
//
//   GROQ_API_KEY        — required (key 1)
//   GROQ_API_KEY_2      — optional (key 2)
//   GROQ_API_KEY_3      — optional (key 3)
//   GROQ_API_KEY_4..10  — optional (more keys, same pattern)
//
// Two access patterns:
//
//   pickClient()              round-robin across all keys
//                             — use for speaker, synthesis, gauntlet,
//                               evaluators, memory rewrites, etc.
//
//   clientForLane("alpha")    dedicated key per named lane
//                             — use for the triple-core so Alpha,
//                               Beta, Gamma each run on their own
//                               account and don't compete for TPM.
//
//   withKeyRotation(fn)       auto-retry wrapper — on 429 or 503,
//                             rotate to the next key and try again.
//                             Hides transient rate limits from the
//                             rest of the pipeline.

import Groq from "groq-sdk";

// ─── Parse keys from env ──────────────────────────────────────────────────────

function parseKeys(env = process.env) {
  const keys = [];
  if (env.GROQ_API_KEY) keys.push(env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

const KEYS    = parseKeys();
const CLIENTS = KEYS.map(key => new Groq({ apiKey: key }));

if (CLIENTS.length === 0) {
  // Keep the module loadable — callers will fail when they actually try
  // to use a client. This avoids crashing unrelated imports during build.
  console.warn("groqPool: no GROQ_API_KEY configured");
}

// ─── Lane-dedicated clients ───────────────────────────────────────────────────
// The triple-core benefits from each lane having its own account so
// their parallel calls don't compete for one key's TPM budget.
//
// If fewer keys are configured than lanes, lanes collapse onto the
// available keys modulo the pool size — behaviour gracefully degrades
// to round-robin.

const LANE_INDEX = {
  alpha: 0,
  beta:  1,
  gamma: 2,
};

const RESERVED_LANE_KEYS = Object.keys(LANE_INDEX).length;

function mustPool() {
  if (CLIENTS.length === 0) {
    throw new Error("No GROQ_API_KEY configured — set at least one in env.");
  }
}

// Round-robin cursor. When the pool has more keys than dedicated lanes,
// the round-robin pool EXCLUDES lane-reserved keys so cores always have
// their budget available. When pool is small (< 3 keys), everything
// rotates together.

let cursor = 0;

export function pickClient() {
  mustPool();
  if (CLIENTS.length === 1) return CLIENTS[0];

  // With ≥ 4 keys, cores reserve 0/1/2 and everything else rotates across
  // indices 3..N-1. That leaves 5 keys in the round-robin bank with 8 keys,
  // meaning speaker + synthesis + gauntlet + memory-writes etc. don't
  // interfere with cores. With < 4 keys, fall back to rotating across all.
  if (CLIENTS.length >= RESERVED_LANE_KEYS + 1) {
    const bankSize = CLIENTS.length - RESERVED_LANE_KEYS;
    const idx = RESERVED_LANE_KEYS + (cursor % bankSize);
    cursor = (cursor + 1) % (bankSize * 10_000);
    return CLIENTS[idx];
  }

  const idx = cursor % CLIENTS.length;
  cursor = (cursor + 1) % (CLIENTS.length * 10_000);
  return CLIENTS[idx];
}

export function clientForLane(lane) {
  mustPool();
  const idx = LANE_INDEX[lane];
  if (idx === undefined) return pickClient();
  return CLIENTS[idx % CLIENTS.length];
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────
// `fn` receives a client. If the call throws a rate-limit or transient
// error, we rotate to the next key and try again up to poolSize()+1
// attempts. Any other error propagates immediately.

export async function withKeyRotation(fn, { maxAttempts } = {}) {
  mustPool();
  const attempts = Math.max(1, Math.min(maxAttempts ?? CLIENTS.length + 1, CLIENTS.length * 2));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(pickClient());
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status ?? err?.error?.status;
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!transient) throw err;
      // continue to next key
    }
  }
  throw lastErr;
}

// ─── Introspection ────────────────────────────────────────────────────────────

export function poolSize() {
  return CLIENTS.length;
}

export function poolStats() {
  const hasBank = CLIENTS.length >= RESERVED_LANE_KEYS + 1;
  return {
    keyCount:     CLIENTS.length,
    cursor,
    lanes:        Object.fromEntries(
      Object.entries(LANE_INDEX).map(([name, idx]) => [name, idx < CLIENTS.length ? idx : idx % CLIENTS.length]),
    ),
    bankKeys:     hasBank ? CLIENTS.length - RESERVED_LANE_KEYS : null,
    strategy:     hasBank
      ? `${RESERVED_LANE_KEYS} dedicated lanes + ${CLIENTS.length - RESERVED_LANE_KEYS}-key round-robin bank`
      : "full round-robin (pool too small for lane reservation)",
  };
}
