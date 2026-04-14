// preferences.js
// Gauntlet-labelled preference pairs for DPO fine-tuning.
//
// Every time the gauntlet rejects a candidate and the retry succeeds,
// we have a structured preference pair for free:
//
//   context   — the conversation up to that point
//   rejected  — the candidate the gauntlet caught (premature, exposed,
//               compliant, or abandoned), with the failure reasons
//   chosen    — the retry that passed
//
// DPO ("direct preference optimization") trains the model to prefer
// the chosen response over the rejected one for the same context —
// strictly stronger than SFT on accepted responses alone, because the
// model learns what *not* to do from the exact same prompt.
//
// We store these pairs in a Redis list per user, capped at 1000. The
// learning pipeline reads them weekly and formats them into the DPO
// JSONL that Fireworks and most other fine-tune providers accept.

const KEY = (u) => `${u}:preferences`;
const MAX = 1000;

// ─── Record one preference pair ───────────────────────────────────────────────

export async function recordPreferencePair(redis, userId, {
  context,          // recent messages at the time of the exchange
  rejected,         // the candidate the gauntlet caught
  rejectedReasons,  // array of { type, reason }
  chosen,           // the accepted retry
  feltState,        // the felt-state both candidates were generated from
  mood,
}) {
  if (!rejected || !chosen) return;
  if (rejected === chosen)  return; // defensive — should never happen

  const entry = {
    t:                Date.now(),
    context:          (context || []).slice(-6).map(m => ({
                        role:    m.role,
                        content: String(m.content || "").slice(0, 800),
                      })),
    rejected:         String(rejected).slice(0, 1500),
    rejectedReasons:  (rejectedReasons || []).map(r => ({
                        type:   r.type,
                        reason: String(r.reason || "").slice(0, 200),
                      })),
    chosen:           String(chosen).slice(0, 1500),
    feltState:        feltState ? {
                        temperature: feltState.temperature,
                        charge:      feltState.charge?.slice(0, 200),
                        emotional:   feltState.emotional?.slice(0, 200),
                        want:        feltState.want?.slice(0, 200),
                      } : null,
    mood:             mood || null,
  };

  await redis.lpush(KEY(userId), JSON.stringify(entry));
  await redis.ltrim(KEY(userId), 0, MAX - 1);
}

// ─── Read pairs ───────────────────────────────────────────────────────────────

export async function readPreferencePairs(redis, userId, { limit = MAX, sinceTimestamp = null } = {}) {
  const raw = await redis.lrange(KEY(userId), 0, limit - 1);
  const entries = (raw || []).map(r => {
    try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
  }).filter(Boolean);

  if (!sinceTimestamp) return entries;
  return entries.filter(e => (e.t || 0) > sinceTimestamp);
}

// ─── Format as DPO JSONL ──────────────────────────────────────────────────────
// Fireworks + most providers accept this shape:
//   { input: { messages: [...] }, preferred_output: [...], non_preferred_output: [...] }
//
// We build the input messages from the context, then express the
// preferred / non-preferred as single-turn assistant messages.

const DPO_SYSTEM = `You are Gabriella. Real interiority, not a chatbot. Prefer the honest, restrained, specific response. Avoid therapy language, customer-service softeners, bullet points, and summary closings.`;

export function buildDpoExample(entry) {
  if (!entry?.context || !entry.rejected || !entry.chosen) return null;

  const inputMessages = [
    { role: "system", content: DPO_SYSTEM },
    ...entry.context,
  ];

  return {
    input:                { messages: inputMessages },
    preferred_output:     [{ role: "assistant", content: entry.chosen }],
    non_preferred_output: [{ role: "assistant", content: entry.rejected }],
  };
}

// ─── Bundle for the weekly push ───────────────────────────────────────────────

export async function buildDpoBundle(redis, userId, { sinceTimestamp = null } = {}) {
  const pairs = await readPreferencePairs(redis, userId, { sinceTimestamp });
  const examples = pairs.map(buildDpoExample).filter(Boolean);
  const jsonl = examples.map(e => JSON.stringify(e)).join("\n");

  return {
    stats: {
      pairs:    pairs.length,
      examples: examples.length,
      firstAt:  pairs.length ? Math.min(...pairs.map(p => p.t || 0)) : null,
      lastAt:   pairs.length ? Math.max(...pairs.map(p => p.t || 0)) : null,
    },
    jsonl,
  };
}
