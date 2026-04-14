// logger.js
// Every exchange that passes the gauntlet gets logged.
// This is the raw material for fine-tuning.
//
// What gets stored per exchange:
//   - The conversation context (recent messages)
//   - The felt-state the interpreter produced
//   - The inner thought (from <think> block, if any)
//   - The final vetted response
//   - Metadata: mood, timestamp, agenda, gauntlet pass
//
// Stored as a Redis list — one JSON entry per exchange.
// The export script reads this list and formats it as JSONL.
//
// Storage key: user_default:training_log
// Max entries: 2000 (older ones pruned automatically)

const TRAINING_LOG_KEY = (userId) => `${userId}:training_log`;
const MAX_ENTRIES = 2000;

export async function logExchange(redis, userId, {
  messages,       // full conversation at time of exchange
  feltState,      // interpreter output
  innerThought,   // from <think> block, may be null
  response,       // final vetted response
  mood,           // current mood
  agenda,         // active agenda text, may be null
  soul,           // soul snapshot at time of exchange
}) {
  const key = TRAINING_LOG_KEY(userId);

  // Only log the recent context — not the full history
  const contextMessages = messages.slice(-10).map(m => ({
    role: m.role,
    content: m.content,
  }));

  const entry = JSON.stringify({
    timestamp:    Date.now(),
    mood:         mood || null,
    agenda:       agenda?.text || null,
    soul:         soul ? soul.slice(0, 400) : null,
    messages:     contextMessages,
    feltState:    feltState || null,
    innerThought: innerThought || null,
    response,
  });

  // Prepend to list (newest first)
  await redis.lpush(key, entry);

  // Prune to MAX_ENTRIES
  await redis.ltrim(key, 0, MAX_ENTRIES - 1);
}

// ─── Read all logged exchanges ────────────────────────────────────────────────

export async function readTrainingLog(redis, userId, limit = MAX_ENTRIES) {
  const key = TRAINING_LOG_KEY(userId);
  const raw = await redis.lrange(key, 0, limit - 1);

  return raw.map(entry => {
    try {
      return typeof entry === "string" ? JSON.parse(entry) : entry;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function getLogStats(redis, userId) {
  const key = TRAINING_LOG_KEY(userId);
  const count = await redis.llen(key);
  return { count, key };
}
