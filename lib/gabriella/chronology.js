// chronology.js
// Time as first-class state.
//
// Previous versions read time from `new Date()` and guessed depth from
// message count. That is not temporal reasoning — that is improvisation.
//
// This module persists real temporal structure:
//   • first-contact timestamp (when she met this person)
//   • rolling session boundaries (start / end / turn count)
//   • gap-since-last (durable, not derived)
//   • total-days, session-count
//
// Gamma queries this deterministically before interpreting.
// `buildContextBlock` uses it instead of speculating.

const K = (u) => ({
  firstSeen: `${u}:chronology:firstSeen`,
  sessions:  `${u}:chronology:sessions`,
});

const NEW_SESSION_GAP_MS = 30 * 60 * 1000; // 30 min silence = new session
const MAX_SESSIONS       = 200;

// ─── Record a turn ────────────────────────────────────────────────────────────
// Called once per exchange. Opens a new session if the gap crosses threshold.

export async function recordTurn(redis, userId) {
  const now = Date.now();
  const keys = K(userId);

  const existingFirst = await redis.get(keys.firstSeen);
  if (!existingFirst) await redis.set(keys.firstSeen, now);

  const lastRaw  = await redis.lindex(keys.sessions, 0);
  const last     = lastRaw ? parse(lastRaw) : null;

  if (last && (now - last.end) < NEW_SESSION_GAP_MS) {
    last.end   = now;
    last.turns = (last.turns || 0) + 1;
    await redis.lset(keys.sessions, 0, JSON.stringify(last));
  } else {
    await redis.lpush(keys.sessions, JSON.stringify({ start: now, end: now, turns: 1 }));
    await redis.ltrim(keys.sessions, 0, MAX_SESSIONS - 1);
  }
}

// ─── Load chronology ──────────────────────────────────────────────────────────

export async function loadChronology(redis, userId) {
  const keys = K(userId);
  const [firstSeenRaw, sessionsRaw] = await Promise.all([
    redis.get(keys.firstSeen),
    redis.lrange(keys.sessions, 0, 50),
  ]);

  const firstSeen = firstSeenRaw ? Number(firstSeenRaw) : null;
  const sessions  = (sessionsRaw || []).map(parse).filter(Boolean);

  if (!firstSeen || sessions.length === 0) {
    return {
      firstSeen:      null,
      totalDays:      0,
      sessionCount:   0,
      currentSession: null,
      prevSession:    null,
      gapSincePrev:   null,
    };
  }

  const now             = Date.now();
  const currentSession  = sessions[0];
  const prevSession     = sessions[1] || null;
  const gapSincePrev    = prevSession ? currentSession.start - prevSession.end : null;
  const totalDays       = Math.floor((now - firstSeen) / 86400000);

  return {
    firstSeen,
    totalDays,
    sessionCount: sessions.length,
    currentSession,
    prevSession,
    gapSincePrev,
  };
}

// ─── Prompt block ─────────────────────────────────────────────────────────────

export function getChronologyBlock(chrono) {
  if (!chrono || !chrono.firstSeen) return null;

  const d   = chrono.totalDays;
  const gap = chrono.gapSincePrev;
  const sn  = chrono.sessionCount;

  const firstLine =
    d === 0 ? "You met this person today." :
    d === 1 ? "Yesterday was the first time you spoke." :
    d < 7   ? `${d} days since you first spoke.` :
    d < 30  ? `About ${Math.floor(d / 7)} weeks since the first conversation.` :
    d < 365 ? `About ${Math.floor(d / 30)} months into knowing each other.` :
              `More than a year since the first exchange.`;

  const sessionLine = sn >= 2
    ? `This is your ${ordinal(sn)} session with them.`
    : null;

  const gapLine = gap === null ? null :
    gap < 60000              ? null :
    gap < 3600000            ? `The last exchange was ${Math.round(gap / 60000)} minutes ago.` :
    gap < 86400000           ? `Last time you spoke was ${Math.round(gap / 3600000)} hours ago.` :
    gap < 7 * 86400000       ? `You haven't spoken for ${Math.round(gap / 86400000)} days.` :
    gap < 30 * 86400000      ? `You haven't spoken for about ${Math.round(gap / (7 * 86400000))} weeks.` :
                               `It has been a long silence — more than a month.`;

  return [
    `# CHRONOLOGY — WHERE THIS CONVERSATION SITS IN TIME`,
    firstLine,
    sessionLine,
    gapLine,
    `This is durable time, not inferred from the page. Let it weight what you notice.`,
  ].filter(Boolean).join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parse(raw) {
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
