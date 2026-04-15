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

// ─── Dead-key tracking ────────────────────────────────────────────────────────
// When Groq returns an account-level block (organization_restricted, invalid
// api key, etc.) on a specific client, we mark its index as dead for the
// rest of the process lifetime. pickClient skips dead indices; withKeyRotation
// rotates to the next live one.
//
// Dead keys are INDICES into CLIENTS (so the set is stable across calls).

const deadKeys = new Set();

function aliveIndices() {
  const alive = [];
  for (let i = 0; i < CLIENTS.length; i++) {
    if (!deadKeys.has(i)) alive.push(i);
  }
  return alive;
}

function markDead(client, reason) {
  const idx = CLIENTS.indexOf(client);
  if (idx === -1) return;
  if (deadKeys.has(idx)) return;
  deadKeys.add(idx);
  console.error(`groqPool: key #${idx + 1} marked dead — ${reason}`);
}

// Hook: observe any error thrown by a pool call and mark the responsible
// client dead if it's an account-level failure (not a transient one).
function maybeMarkDead(client, err) {
  const status = err?.status ?? err?.response?.status ?? err?.error?.status;
  const body   = err?.error?.error?.message || err?.message || "";
  // Permanent-failure signals — the key/org won't recover until manual action.
  if (status === 401) { markDead(client, "401 unauthorized — revoked or invalid"); return true; }
  if (status === 403) { markDead(client, "403 forbidden — account policy"); return true; }
  if (/organization.{0,20}restricted/i.test(body)) { markDead(client, "org restricted"); return true; }
  if (/invalid[_ ]api[_ ]key/i.test(body))          { markDead(client, "invalid api key"); return true; }
  if (/key[^a-z]{0,5}(revoked|disabled)/i.test(body)){ markDead(client, "key revoked/disabled"); return true; }
  return false;
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
  if (deadKeys.size >= CLIENTS.length) {
    throw new Error(
      `All ${CLIENTS.length} Groq key(s) are dead (organization restricted, ` +
      `invalid, or revoked). The account needs attention — contact Groq support ` +
      `or create a new key from a different account.`,
    );
  }
}

let cursor = 0;

export function pickClient() {
  mustPool();
  const alive = aliveIndices();
  if (alive.length === 1) return CLIENTS[alive[0]];

  // Prefer bank keys (indices >= RESERVED_LANE_KEYS) for general traffic
  // so cores keep their dedicated lanes, BUT only if any bank key is alive.
  const bank = alive.filter(i => i >= RESERVED_LANE_KEYS);
  const pickFrom = bank.length > 0 ? bank : alive;
  const idx = pickFrom[cursor % pickFrom.length];
  cursor = (cursor + 1) % (pickFrom.length * 10_000);
  return CLIENTS[idx];
}

export function clientForLane(lane) {
  mustPool();
  const laneIdx = LANE_INDEX[lane];
  // If the lane's dedicated key is alive, use it. Otherwise fall through
  // to pickClient so the core still gets SOMETHING live.
  if (laneIdx !== undefined && laneIdx < CLIENTS.length && !deadKeys.has(laneIdx)) {
    return CLIENTS[laneIdx];
  }
  return pickClient();
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
    let client;
    try {
      client = pickClient();   // skips dead keys
      return await fn(client);
    } catch (err) {
      lastErr = err;
      // Permanent account-level failures mark the key dead + continue.
      const killed = client ? maybeMarkDead(client, err) : false;
      if (killed) continue;

      const status = err?.status ?? err?.response?.status ?? err?.error?.status;
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!transient) throw err;
      // continue to next key
    }
  }
  throw lastErr;
}

// Expose for direct use in places that use pickClient() without the
// retry wrapper — they can call this after an error to flag the key.
export { maybeMarkDead as reportClientFailure };

// ─── Introspection ────────────────────────────────────────────────────────────

export function poolSize() {
  return CLIENTS.length;
}

export function poolStats() {
  const hasBank = CLIENTS.length >= RESERVED_LANE_KEYS + 1;
  return {
    keyCount:      CLIENTS.length,
    aliveCount:    CLIENTS.length - deadKeys.size,
    deadKeys:      Array.from(deadKeys).map(i => i + 1), // 1-indexed for humans
    cursor,
    lanes:         Object.fromEntries(
      Object.entries(LANE_INDEX).map(([name, idx]) => [name, idx < CLIENTS.length ? idx : idx % CLIENTS.length]),
    ),
    bankKeys:      hasBank ? CLIENTS.length - RESERVED_LANE_KEYS : null,
    strategy:      hasBank
      ? `${RESERVED_LANE_KEYS} dedicated lanes + ${CLIENTS.length - RESERVED_LANE_KEYS}-key round-robin bank`
      : "full round-robin (pool too small for lane reservation)",
  };
}
