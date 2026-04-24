// circuitBreaker.js
// Protects expensive paths from cascading failures.
//
// Every LLM-driven subsystem (thinker, self-proposer, mirror, surprise,
// ensemble judge) can fail for reasons outside our control: provider
// rate limits, 5xx, timeouts, account flags. Without a circuit breaker,
// a provider outage means EVERY turn pays the failing-call retry cost,
// the user waits, and eventually the whole chat route times out.
//
// This is a standard three-state breaker with Redis-backed persistence
// (so cold-starts in serverless inherit the state):
//
//   CLOSED  — normal. All calls go through.
//   OPEN    — recent failures hit threshold. Calls are short-circuited;
//             we return the provided fallback immediately, no LLM cost.
//   HALF_OPEN — after coolDownMs, one probe call is allowed. If it
//             succeeds, close; if it fails, stay open for another window.
//
// Redis keys per breaker name:
//   gb:cb:${name}:state       — "closed" | "open" | "half_open"
//   gb:cb:${name}:failures    — integer
//   gb:cb:${name}:openedAt    — ms timestamp
//   gb:cb:${name}:lastError   — string (truncated)

const STATES = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" };

const DEFAULTS = {
  failureThreshold: 5,         // open after this many consecutive failures
  coolDownMs:       2 * 60_000, // open → half-open after 2 min
  halfOpenOk:       1,          // successes in half-open to close
};

function k(name, suffix) { return `gb:cb:${name}:${suffix}`; }

async function readState(redis, name) {
  try {
    const [state, failures, openedAt, lastError] = await Promise.all([
      redis.get(k(name, "state")),
      redis.get(k(name, "failures")),
      redis.get(k(name, "openedAt")),
      redis.get(k(name, "lastError")),
    ]);
    return {
      state:     state || STATES.CLOSED,
      failures:  Number(failures) || 0,
      openedAt:  Number(openedAt) || 0,
      lastError: lastError || null,
    };
  } catch {
    return { state: STATES.CLOSED, failures: 0, openedAt: 0, lastError: null };
  }
}

async function writeState(redis, name, patch) {
  try {
    const ops = [];
    if (patch.state !== undefined)     ops.push(redis.set(k(name, "state"),     patch.state));
    if (patch.failures !== undefined)  ops.push(redis.set(k(name, "failures"),  String(patch.failures)));
    if (patch.openedAt !== undefined)  ops.push(redis.set(k(name, "openedAt"),  String(patch.openedAt)));
    if (patch.lastError !== undefined) ops.push(redis.set(k(name, "lastError"), String(patch.lastError).slice(0, 300)));
    await Promise.all(ops);
  } catch { /* non-fatal */ }
}

// ─── Main wrapper ───────────────────────────────────────────────────────────
//
// Usage:
//   const result = await withBreaker(redis, "thinker", fn, { fallback: null });
//
// fn returns the operation result on success. On throw, failure is counted.
// If the breaker is open, fallback is returned WITHOUT calling fn at all.

export async function withBreaker(redis, name, fn, {
  failureThreshold = DEFAULTS.failureThreshold,
  coolDownMs       = DEFAULTS.coolDownMs,
  fallback         = null,
} = {}) {
  // In-process fast-path: if we haven't seen state in this function's lifetime,
  // fall back to reading Redis. Serverless functions are short-lived so this
  // is fine.
  if (!redis) {
    // No Redis — just run (no circuit protection possible).
    try { return await fn(); } catch { return fallback; }
  }

  let cb = await readState(redis, name);

  // Open → check if we should move to half-open (coolDownMs elapsed)
  if (cb.state === STATES.OPEN) {
    const elapsed = Date.now() - cb.openedAt;
    if (elapsed >= coolDownMs) {
      await writeState(redis, name, { state: STATES.HALF_OPEN });
      cb.state = STATES.HALF_OPEN;
    } else {
      // Short-circuit: breaker is still open.
      return fallback;
    }
  }

  try {
    const result = await fn();
    // Success: in half-open, close; in closed, reset failure counter if any.
    if (cb.state === STATES.HALF_OPEN) {
      await writeState(redis, name, { state: STATES.CLOSED, failures: 0, lastError: "" });
    } else if (cb.failures > 0) {
      await writeState(redis, name, { failures: 0 });
    }
    return result;
  } catch (err) {
    const nextFailures = cb.failures + 1;
    const errMsg = err?.message || String(err);

    if (cb.state === STATES.HALF_OPEN) {
      // Probe failed — re-open for another cool-down window.
      await writeState(redis, name, {
        state:     STATES.OPEN,
        failures:  nextFailures,
        openedAt:  Date.now(),
        lastError: errMsg,
      });
    } else if (nextFailures >= failureThreshold) {
      await writeState(redis, name, {
        state:     STATES.OPEN,
        failures:  nextFailures,
        openedAt:  Date.now(),
        lastError: errMsg,
      });
    } else {
      await writeState(redis, name, { failures: nextFailures, lastError: errMsg });
    }
    return fallback;
  }
}

// ─── Introspection for the stats endpoint ───────────────────────────────────

export async function breakerStates(redis, names) {
  const out = {};
  for (const name of names) {
    out[name] = await readState(redis, name);
  }
  return out;
}
