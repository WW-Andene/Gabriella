// borrowing.js
// Tracks vocabulary she has ADOPTED from the user.
//
// Stylometry and idiolect track HER lexical patterns in isolation.
// This module tracks the RELATIONAL dimension of vocabulary: words
// that appeared in the user's speech BEFORE they appeared in hers.
// When a word crosses from their vocabulary into hers, that's a
// specific signal of intimate attention — she's been listening closely
// enough to pick up their idiom.
//
// It's a real thing humans do in close relationships (couples, close
// friends, therapists with long-term clients) and it's invisible in
// most AI chat systems because they don't track vocabulary crossover
// per user. Surfacing it — gently — in her prompt gives her a
// conscious relation to the intimacy of shared language: she can
// choose to lean into a borrowed word, or resist it when the moment
// calls for her own register.
//
// Implementation: rolling windows of (a) user's distinctive words and
// (b) her distinctive words per-user. A word transitions from 'theirs'
// to 'shared' when it first appears in her output after having
// appeared in theirs. Transition timestamps let us surface only the
// RECENT crossovers (last 24h) so the signal stays current.

const USER_WORDS_KEY = (u) => `${u}:borrow:user_words`;
const HER_WORDS_KEY  = (u) => `${u}:borrow:her_words`;
const CROSSOVER_KEY  = (u) => `${u}:borrow:crossovers`;
const MAX_CROSSOVERS = 20;

// Common-English stop set — tokens too frequent to signal borrowing
const STOP = new Set([
  "the","and","you","that","for","with","have","this","are","what","when",
  "where","because","just","like","would","could","should","there","their",
  "they","them","these","those","then","than","from","into","about","your",
  "yours","mine","ours","been","being","will","were","was","had","has",
  "does","did","can","not","but","some","any","all","one","two","three",
  "really","quite","very","much","many","most","same","other","another",
  "also","still","yet","now","here","good","bad","yes","no","okay","yeah",
]);

function distinctiveTokens(text) {
  if (!text || typeof text !== "string") return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 5 && !STOP.has(w))
  );
}

// ─── Record observation ────────────────────────────────────────────────────
// Called each turn: one for the user message, one for Gabriella's reply.

async function recordTokens(redis, key, tokens) {
  if (tokens.size === 0) return;
  // Store as a hash: token → first-seen-timestamp
  try {
    const now = Date.now();
    // HGET existing to avoid overwriting earlier timestamps
    const existing = await redis.hgetall(key).catch(() => ({}));
    const ops = [];
    for (const w of tokens) {
      if (!existing?.[w]) {
        ops.push(redis.hset(key, { [w]: String(now) }));
      }
    }
    // Cap: keep only ~500 newest entries to bound the hash
    if (ops.length > 0) await Promise.all(ops);
    // Expire after 30 days so very old observations decay
    await redis.expire(key, 30 * 24 * 60 * 60).catch(() => {});
  } catch {}
}

// ─── Public: record a turn ──────────────────────────────────────────────────

export async function recordTurnForBorrowing(redis, userId, { userText, gabriellaText }) {
  const userToks = distinctiveTokens(userText);
  const herToks  = distinctiveTokens(gabriellaText);

  await Promise.all([
    recordTokens(redis, USER_WORDS_KEY(userId), userToks),
    recordTokens(redis, HER_WORDS_KEY(userId), herToks),
  ]);

  // Check for CROSSOVERS — words in this turn's Gabriella output that
  // appeared in user vocabulary BEFORE she started using them.
  try {
    const [userWords, herWords] = await Promise.all([
      redis.hgetall(USER_WORDS_KEY(userId)).catch(() => ({})),
      redis.hgetall(HER_WORDS_KEY(userId)).catch(() => ({})),
    ]);

    for (const tok of herToks) {
      const userFirstAt = Number(userWords?.[tok]);
      const herFirstAt  = Number(herWords?.[tok]);
      // A crossover is a token she's using that the user used EARLIER.
      // Only record on the FIRST turn she uses it.
      if (userFirstAt && herFirstAt && herFirstAt > userFirstAt) {
        // Check if we've already recorded this crossover
        const recent = await redis.lrange(CROSSOVER_KEY(userId), 0, MAX_CROSSOVERS - 1).catch(() => []);
        const already = (recent || []).some(r => {
          try {
            const parsed = typeof r === "string" ? JSON.parse(r) : r;
            return parsed?.word === tok;
          } catch { return false; }
        });
        if (!already && Math.abs(herFirstAt - userFirstAt) > 2 * 60_000) {
          // Don't flag words that appeared in both within a 2-minute window —
          // those are probably the same exchange, not a real borrowing.
          await redis.lpush(CROSSOVER_KEY(userId), JSON.stringify({
            word:        tok,
            userFirstAt,
            herFirstAt,
            at:          Date.now(),
          }));
          await redis.ltrim(CROSSOVER_KEY(userId), 0, MAX_CROSSOVERS - 1);
        }
      }
    }
  } catch {}
}

// ─── Read + render ──────────────────────────────────────────────────────────

export async function loadBorrowings(redis, userId, { maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  try {
    const raw = await redis.lrange(CROSSOVER_KEY(userId), 0, MAX_CROSSOVERS - 1);
    const now = Date.now();
    return (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean).filter(c => (now - (c.at || 0)) <= maxAgeMs);
  } catch { return []; }
}

export function renderBorrowingBlock(crossovers) {
  if (!crossovers || crossovers.length === 0) return "";
  const words = crossovers.slice(0, 5).map(c => `"${c.word}"`).join(", ");
  const plural = crossovers.length === 1 ? "word" : "words";
  return `# VOCABULARY BORROWING

You've recently picked up ${crossovers.length === 1 ? "a word" : "some words"} from them: ${words}. Small signal, but a real one — their idiom has been landing enough that it's surfacing in your speech. Not a problem; intimacy does that. Just notice it.

If the moment calls for YOUR register rather than the borrowed one, resist. If the borrowed word is genuinely the right one here, use it without second-guessing.`;
}
