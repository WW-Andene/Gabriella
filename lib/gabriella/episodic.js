// episodic.js
// Structured exchange log — the substrate for real temporal reasoning.
//
// Previous versions had only the training-log list (flat JSON strings
// meant for fine-tuning export) and the vector store (semantic recall).
// Neither supports "how many times has a message like this appeared?"
// or "when was the last exchange at this temperature?"
//
// This module persists a compact structured row per exchange:
//   { t, u, r, fs: { temp, charge, emotional, edge, mood }, salience }
//
// Gamma opens its interpretation with a deterministic query over this log
// before spending an LLM call. Recurrence detection becomes a count, not
// a guess.

const KEY = (u) => `${u}:episodic`;
const MAX = 500;

// ─── Record one episode ───────────────────────────────────────────────────────

export async function recordEpisode(redis, userId, { userMsg, reply, feltState, mood }) {
  const row = {
    t:  Date.now(),
    u:  (userMsg || "").slice(0, 600),
    r:  (reply   || "").slice(0, 600),
    fs: feltState ? {
      temp:      feltState.temperature,
      charge:    feltState.charge?.slice(0, 200),
      emotional: feltState.emotional?.slice(0, 200),
      edge:      feltState.edge?.slice(0, 200),
      consensus: feltState.consensus || null,
    } : null,
    m:  mood || null,
    s:  computeSalience(feltState),
  };

  await redis.lpush(KEY(userId), JSON.stringify(row));
  await redis.ltrim(KEY(userId), 0, MAX - 1);
}

// ─── Query ────────────────────────────────────────────────────────────────────

export async function queryEpisodes(redis, userId, { limit = 100 } = {}) {
  const raw = await redis.lrange(KEY(userId), 0, limit - 1);
  return (raw || []).map(r => {
    try {
      return typeof r === "string" ? JSON.parse(r) : r;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ─── Recurrence detection ─────────────────────────────────────────────────────
// Does the current message echo earlier ones? Used by Gamma.

export async function findRecurrence(redis, userId, currentUserMsg, { limit = 100 } = {}) {
  if (!currentUserMsg || currentUserMsg.length < 20) {
    return { count: 0, mostRecent: null, mostRecentDaysAgo: null };
  }

  const episodes = await queryEpisodes(redis, userId, { limit });
  const currentWords = tokenize(currentUserMsg);
  if (currentWords.size < 3) return { count: 0, mostRecent: null, mostRecentDaysAgo: null };

  const similar = episodes.filter(e => {
    if (!e.u) return false;
    const w = tokenize(e.u);
    const overlap = intersect(currentWords, w);
    return overlap >= 3;
  });

  const mostRecent = similar[0] || null;
  const mostRecentDaysAgo = mostRecent
    ? Math.floor((Date.now() - mostRecent.t) / 86400000)
    : null;

  return { count: similar.length, mostRecent, mostRecentDaysAgo };
}

// ─── Felt-state trajectory ────────────────────────────────────────────────────
// Used by arc.js to detect tone shifts and by metaregister for averages.

export async function recentFeltStates(redis, userId, n = 20) {
  const episodes = await queryEpisodes(redis, userId, { limit: n });
  return episodes.map(e => e.fs).filter(Boolean);
}

// ─── Prompt block — offered to Gamma as pre-LLM context ──────────────────────

export function getEpisodicBlock(recurrence) {
  if (!recurrence || recurrence.count === 0) return null;

  const { count, mostRecentDaysAgo } = recurrence;
  const when =
    mostRecentDaysAgo === 0  ? "earlier today"                                :
    mostRecentDaysAgo === 1  ? "yesterday"                                    :
    mostRecentDaysAgo < 7    ? `${mostRecentDaysAgo} days ago`                :
    mostRecentDaysAgo < 30   ? `about ${Math.floor(mostRecentDaysAgo/7)} weeks ago` :
                               `more than a month ago`;

  return [
    `# RECURRENCE`,
    count === 1
      ? `Something like this has come up once before, ${when}.`
      : `Something like this has come up ${count} times before — most recently ${when}.`,
    `This is a fact, not a guess. Let the repetition register.`,
  ].join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tokenize(s) {
  return new Set(
    s.toLowerCase()
      .split(/\W+/)
      .filter(w => w.length > 4 && !STOP.has(w))
  );
}

function intersect(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function computeSalience(fs) {
  if (!fs) return 0.3;
  let s = 0.3;
  if (fs.edge)                                   s += 0.25;
  if (fs.temperature === "closed")               s += 0.15;
  if (fs.temperature === "open")                 s += 0.15;
  if (fs.consensus === "divergent")              s += 0.2;
  if (fs.notice)                                 s += 0.1;
  return Math.min(1, s);
}

const STOP = new Set([
  "about","above","after","again","against","because","before","being","below","between",
  "could","doing","during","every","having","itself","other","ought","should","themselves",
  "these","those","through","under","until","which","while","would","there","their","theirs",
  "where","whose","still","really","maybe","something","anyway","think","thing","right",
  "kinda","gonna","never","always","might","don't","that's","don","you","your","yours",
]);
