// speakerState.js
// Runtime state for the speaker provider switch.
//
// Two pieces of state, both live in Redis so they survive restarts and
// stay consistent across serverless invocations:
//
//   {userId}:speaker:activeModel   — model id to call via Fireworks, or
//                                    absent to use Groq.
//   {userId}:speaker:errorStreak   — consecutive Fireworks failures.
//                                    When this hits BREAKER_THRESHOLD the
//                                    active model is cleared and logged.
//
// The speaker reads activeModel on every request (with a 60s in-process
// cache) and reports success / failure. The watch endpoint writes
// activeModel after a successful fine-tune + deployment.

const USER_ID          = "user_default";
const BREAKER_THRESHOLD = 5;

function K(userId) {
  return {
    active:      `${userId}:speaker:activeModel`,
    streak:      `${userId}:speaker:errorStreak`,
    lastError:   `${userId}:speaker:lastError`,
    activatedAt: `${userId}:speaker:activatedAt`,
    brokenAt:    `${userId}:speaker:brokenAt`,
  };
}

// ─── Active model ─────────────────────────────────────────────────────────────

export async function getActiveSpeakerModel(redis, userId = USER_ID) {
  const raw = await redis.get(K(userId).active);
  if (!raw) return null;
  return String(raw);
}

export async function setActiveSpeakerModel(redis, model, userId = USER_ID) {
  const keys = K(userId);
  await Promise.all([
    redis.set(keys.active,      model),
    redis.set(keys.activatedAt, Date.now()),
    redis.del(keys.streak),
    redis.del(keys.lastError),
    redis.del(keys.brokenAt),
  ]);
}

export async function clearActiveSpeakerModel(redis, reason, userId = USER_ID) {
  const keys = K(userId);
  await Promise.all([
    redis.del(keys.active),
    redis.set(keys.brokenAt,  Date.now()),
    redis.set(keys.lastError, reason || "cleared"),
  ]);
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────

export async function reportSpeakerSuccess(redis, userId = USER_ID) {
  await redis.del(K(userId).streak);
}

// Returns true if the breaker tripped (active model cleared).
export async function reportSpeakerError(redis, errorMsg, userId = USER_ID) {
  const keys     = K(userId);
  const streak   = Number(await redis.incr(keys.streak)) || 0;
  await redis.set(keys.lastError, String(errorMsg || "unknown").slice(0, 300));

  if (streak >= BREAKER_THRESHOLD) {
    await clearActiveSpeakerModel(redis, `breaker: ${streak} consecutive errors`, userId);
    return true;
  }
  return false;
}

// ─── Introspection (used by the watch endpoint to report status) ──────────────

export async function loadSpeakerStatus(redis, userId = USER_ID) {
  const keys = K(userId);
  const [active, streakRaw, lastError, activatedAtRaw, brokenAtRaw] = await Promise.all([
    redis.get(keys.active),
    redis.get(keys.streak),
    redis.get(keys.lastError),
    redis.get(keys.activatedAt),
    redis.get(keys.brokenAt),
  ]);

  return {
    activeModel: active ? String(active) : null,
    errorStreak: streakRaw ? Number(streakRaw) : 0,
    lastError:   lastError ? String(lastError) : null,
    activatedAt: activatedAtRaw ? Number(activatedAtRaw) : null,
    brokenAt:    brokenAtRaw    ? Number(brokenAtRaw)    : null,
  };
}
