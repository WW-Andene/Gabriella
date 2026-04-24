// callAudit.js
// Per-turn LLM call ledger — lets the operator see exactly how many
// calls are firing, which provider, which model, and (approximate)
// token counts. Even on free tier this matters for:
//
//   • spotting runaway loops (e.g. a cron that re-retries forever)
//   • comparing cost distribution across providers to decide which
//     to prioritize / request paid-tier from first
//   • proving to an evaluator that the system's LLM budget is bounded
//     and accounted
//
// Implementation: a shared singleton that every provider adapter can
// call with its call result. The adapter sees the OpenAI-compat
// response which includes `usage: { prompt_tokens, completion_tokens,
// total_tokens }` on most providers. When missing, we estimate from
// char counts / 4 as a rough proxy.

const KEY_LEDGER   = (u = "_global") => `calls:ledger:${u}`;
const KEY_DAILY    = (u = "_global", day) => `calls:daily:${u}:${day}`;
const MAX_LEDGER   = 2000;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

let redisRef = null;
export function bindAuditRedis(redis) {
  // Called once at module load from wherever Redis is already constructed.
  // Lets us record calls without every call site having to import + pass Redis.
  redisRef = redis;
}

// Estimate tokens when usage not reported — Llama-family BPE averages ~3.8
// chars/token on English prose. Use /4 as a conservative round.
function estimateTokens(text) {
  if (!text || typeof text !== "string") return 0;
  return Math.ceil(text.length / 4);
}

export async function recordCall({
  provider,        // "groq" | "cerebras" | "gemini" | "fireworks"
  model,           // model id
  usage,           // { prompt_tokens, completion_tokens } if reported
  promptChars,     // fallback for providers that don't report usage
  completionChars, // fallback
  userId = "_global",
  label = null,    // e.g. "speaker" | "gauntlet:voiceDrift" | "thinker"
}) {
  if (!redisRef) return;

  const promptTokens = usage?.prompt_tokens     ?? estimateTokens(promptChars ?? "");
  const completionTokens = usage?.completion_tokens ?? estimateTokens(completionChars ?? "");
  const totalTokens = promptTokens + completionTokens;

  const entry = {
    at:        Date.now(),
    provider:  provider || "unknown",
    model:     model || "unknown",
    label:     label,
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: !usage,
  };

  try {
    await redisRef.lpush(KEY_LEDGER(userId), JSON.stringify(entry));
    await redisRef.ltrim(KEY_LEDGER(userId), 0, MAX_LEDGER - 1);

    // Daily rollup — sum per provider for fast /stats rendering.
    const day = todayKey();
    const rollupKey = KEY_DAILY(userId, day);
    const rawExisting = await redisRef.get(rollupKey);
    const rollup = rawExisting
      ? (typeof rawExisting === "string" ? JSON.parse(rawExisting) : rawExisting)
      : { day, calls: 0, totalTokens: 0, byProvider: {} };
    rollup.calls = (rollup.calls || 0) + 1;
    rollup.totalTokens = (rollup.totalTokens || 0) + totalTokens;
    if (!rollup.byProvider[entry.provider]) rollup.byProvider[entry.provider] = { calls: 0, tokens: 0 };
    rollup.byProvider[entry.provider].calls++;
    rollup.byProvider[entry.provider].tokens += totalTokens;
    await redisRef.set(rollupKey, JSON.stringify(rollup));
    // 14-day retention for rollups
    await redisRef.expire(rollupKey, 14 * 24 * 60 * 60).catch(() => {});
  } catch { /* never fatal — audit is observational */ }
}

// ─── Read for /stats ───────────────────────────────────────────────────────

export async function loadAuditStats(redis, userId = "_global") {
  try {
    const day = todayKey();
    const [todayRaw, recentRaw] = await Promise.all([
      redis.get(KEY_DAILY(userId, day)),
      redis.lrange(KEY_LEDGER(userId), 0, 49),
    ]);
    const todayRollup = todayRaw
      ? (typeof todayRaw === "string" ? JSON.parse(todayRaw) : todayRaw)
      : { day, calls: 0, totalTokens: 0, byProvider: {} };
    const recent = (recentRaw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
    // Last-hour window stats
    const hourAgo = Date.now() - 3600_000;
    const lastHour = recent.filter(e => e.at > hourAgo);
    const lastHourTokens = lastHour.reduce((s, e) => s + (e.totalTokens || 0), 0);

    return {
      today:         todayRollup,
      recentCount:   recent.length,
      lastHourCalls: lastHour.length,
      lastHourTokens,
      lastCall:      recent[0] || null,
    };
  } catch {
    return { today: { day: todayKey(), calls: 0, totalTokens: 0, byProvider: {} }, recentCount: 0, lastHourCalls: 0, lastHourTokens: 0, lastCall: null };
  }
}
