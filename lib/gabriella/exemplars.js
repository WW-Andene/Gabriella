// exemplars.js
// In-context learning at inference time.
//
// The base model's voice is set at its weights. Fine-tuning shifts it
// slowly, expensively. But few-shot exemplars in the prompt shift it
// instantly, for free — the model pattern-matches the assistant turns
// in its context and generates in their register.
//
// For a fixed base model this is the single largest quality lever per
// unit cost. Published results routinely show 10-20% quality gains
// from 2-3 well-chosen exemplars versus zero-shot, and exemplars help
// most on PERSONA tasks — which is exactly what Gabriella is.
//
// Design: read the training_log (exchanges that already passed the
// gauntlet), filter to high-quality turns, score each by token-overlap
// with the current user message, return top-2 as (userMsg, response)
// pairs. Fast, deterministic, no embedding call, no LLM call. Cached
// in-process for a short window to avoid re-reading Redis every turn.

import { readTrainingLog } from "./logger.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map();  // userId → { at, log }

// ─── Tokenization for overlap scoring ───────────────────────────────────────

const STOP = new Set([
  "the","a","an","and","or","but","if","then","to","of","in","on","at","for","with",
  "is","are","was","were","be","been","being","have","has","had","do","does","did",
  "i","you","he","she","it","we","they","me","him","her","us","them","my","your",
  "his","hers","its","our","their","this","that","these","those","so","too","very",
  "just","not","no","yes","as","by","from","up","down","out","about","into","over",
  "can","could","would","should","will","would","might","may",
]);

function tokens(s) {
  if (!s) return [];
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP.has(w));
}

function jaccard(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Quality filter ─────────────────────────────────────────────────────────
// Not every logged exchange is worth exemplifying. We want turns where:
//   - response length is in the Gabriella sweet spot (~80-800 chars)
//   - innerThought exists (signals triple-core ran, not fast-path)
//   - feltState has a temperature set (signals genuine cognition)
//   - response doesn't start with "I" (her soft rule)
//   - response isn't a one-line fallback

function isHighQuality(entry) {
  if (!entry || !entry.response) return false;
  const r = String(entry.response).trim();
  if (r.length < 80 || r.length > 800) return false;
  if (!entry.innerThought) return false;                           // fast-path turns have null
  if (!entry.feltState || !entry.feltState.temperature) return false;
  if (/^[Ii]\b/.test(r)) return false;                              // starts with "I"
  if (r.split(/\s+/).length < 12) return false;                     // too short to teach voice
  return true;
}

// ─── Find exemplars ─────────────────────────────────────────────────────────

export async function findExemplars(redis, userId, currentMoment, {
  k          = 2,
  minScore   = 0.05,        // Jaccard threshold — below this, nothing meaningful overlapped
  poolSize   = 120,          // max training log entries to scan
} = {}) {
  if (!currentMoment || currentMoment.trim().length < 8) return [];

  // Cache the filtered log per user for 60s — avoids scanning on every turn
  // in a fast back-and-forth.
  let cached = cache.get(userId);
  if (!cached || Date.now() - cached.at > CACHE_TTL_MS) {
    const log = await readTrainingLog(redis, userId, poolSize).catch(() => []);
    const filtered = log.filter(isHighQuality);
    cached = { at: Date.now(), log: filtered };
    cache.set(userId, cached);
  }

  const queryTokens = tokens(currentMoment);
  if (queryTokens.length === 0) return [];

  const scored = [];
  for (const entry of cached.log) {
    // Score is max of jaccard(query, last user msg in entry) and a smaller
    // weight on jaccard(query, response). Matching on the user side is more
    // predictive of "this is a similar moment."
    const lastUser = [...(entry.messages || [])].reverse().find(m => m.role === "user");
    if (!lastUser) continue;

    const userScore = jaccard(queryTokens, tokens(lastUser.content));
    const respScore = jaccard(queryTokens, tokens(entry.response));
    const score = userScore * 0.8 + respScore * 0.2;

    if (score < minScore) continue;
    scored.push({
      score,
      userMsg:  lastUser.content,
      response: entry.response,
      timestamp: entry.timestamp || 0,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  // De-dupe very-similar exemplars (same context produces nearly identical
  // scores; we want variety).
  const chosen = [];
  for (const s of scored) {
    if (chosen.length >= k) break;
    const dup = chosen.some(c =>
      jaccard(tokens(c.userMsg), tokens(s.userMsg)) > 0.6,
    );
    if (!dup) chosen.push(s);
  }
  return chosen;
}

// ─── Render exemplars as assistant-turn few-shot messages ────────────────────
// Injected into the speaker's message array BEFORE the current user message,
// as: [exemplar user, exemplar assistant, exemplar user, exemplar assistant,
//      ...current recent messages...]
// This is the classic few-shot ICL pattern. The base model pattern-matches
// on the assistant turns and generates in their register.

export function exemplarsToMessages(exemplars) {
  if (!exemplars || exemplars.length === 0) return [];
  const out = [];
  for (const ex of exemplars) {
    if (!ex.userMsg || !ex.response) continue;
    out.push({ role: "user",      content: ex.userMsg.slice(0, 500) });
    out.push({ role: "assistant", content: ex.response.slice(0, 800) });
  }
  return out;
}
