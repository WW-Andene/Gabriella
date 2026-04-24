// userMood.js
// Separate model of the USER's affective state over recent turns.
//
// The Sovereign Self's read captures how Gabriella understands them
// (fast-moving, narrative). The Mirror captures what she thinks they
// see of HER. This module is a third thing: a text-feature based
// trajectory of the user's OWN emotional state as expressed in their
// messages — zero LLM calls, all text signals.
//
// Purpose: give her a structured awareness of how they've been
// feeling over the last N turns, separately from her relational
// read. When their mood has been declining for 5 turns, she should
// know — and not confuse the declining trajectory with her own read
// drift.
//
// Signal sources per message (all regex / text math):
//   • distress keywords     — exhausted / lost / hopeless / stuck ...
//   • positive keywords     — good / happy / relieved / proud ...
//   • intensifiers          — really / so / very / literally (magnifier)
//   • sentence length       — very short often = withdrawn or strained
//   • question marks        — many = uncertain / seeking
//   • caps ratio            — high = agitation
//   • exclamations          — positive or negative intensity
//   • first-person-neg      — "I can't / I don't / I'm not" frequency
//
// Per-message score ~−1..+1 (rough). Rolling window of 8.
// Trend computed as slope of last N scores.
//
// Fires always, cheap. Surfaces as prompt block when trend is
// significantly non-flat.

const WINDOW_KEY = (u) => `${u}:userMood:window`;
const WINDOW = 8;

const DISTRESS_WORDS = new Set([
  "exhausted", "tired", "lost", "hopeless", "stuck", "drained", "broken",
  "alone", "lonely", "empty", "numb", "scared", "afraid", "anxious", "panic",
  "dying", "done", "overwhelmed", "stressed", "furious", "devastated",
  "crushed", "terrible", "awful", "horrible", "miserable", "depressed",
  "sad", "hurt", "hurting", "grief", "grieving", "miss", "missing",
]);

const POSITIVE_WORDS = new Set([
  "good", "great", "happy", "excited", "thrilled", "proud", "grateful",
  "thankful", "relieved", "better", "alright", "okay", "fine", "wonderful",
  "amazing", "love", "loved", "content", "glad", "pleased", "joy", "joyful",
  "hope", "hopeful", "lucky",
]);

function tokenize(text) {
  if (!text) return [];
  return String(text).toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/).filter(Boolean);
}

function scoreMessage(text) {
  if (!text || typeof text !== "string") return 0;
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;

  let score = 0;
  let distressCount = 0, positiveCount = 0;
  let firstPersonNeg = 0;
  let intensifiers = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (DISTRESS_WORDS.has(t)) { distressCount++; }
    if (POSITIVE_WORDS.has(t)) { positiveCount++; }
    if (t === "really" || t === "very" || t === "so" || t === "literally" || t === "actually") intensifiers++;
    if ((t === "i'm" || t === "im") && i + 1 < tokens.length) {
      if (tokens[i + 1] === "not" || tokens[i + 1] === "so" || tokens[i + 1] === "just") firstPersonNeg++;
    }
    if (t === "can't" || t === "cant" || t === "don't" || t === "dont") firstPersonNeg++;
  }

  // Weight by distinctive vs filler
  const len = tokens.length;
  score += (positiveCount - distressCount) * 0.35;
  score += (intensifiers > 2) ? -0.1 : 0;   // heavy intensifiers skew negative
  score -= firstPersonNeg * 0.12;

  // Punctuation / length signals
  const caps = (text.match(/[A-Z]/g) || []).length;
  const capsRatio = caps / Math.max(1, text.length);
  if (capsRatio > 0.15 && text.length > 20) score -= 0.15;   // AGITATED REGISTER

  const qs = (text.match(/\?/g) || []).length;
  if (qs >= 2) score -= 0.05;

  if (len < 4) score -= 0.05;                   // very-short often withdrawn
  if (text.includes("!")) score += positiveCount > 0 ? 0.1 : -0.05;

  // Clamp
  return Math.max(-1, Math.min(1, score));
}

// ─── Record + trend ────────────────────────────────────────────────────────

export async function recordUserMessage(redis, userId, text) {
  const s = scoreMessage(text);
  const entry = JSON.stringify({ at: Date.now(), score: +s.toFixed(3) });
  try {
    await redis.lpush(WINDOW_KEY(userId), entry);
    await redis.ltrim(WINDOW_KEY(userId), 0, WINDOW - 1);
  } catch {}
  return s;
}

export async function loadUserMoodTrajectory(redis, userId) {
  try {
    const raw = await redis.lrange(WINDOW_KEY(userId), 0, WINDOW - 1);
    const entries = (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
    return entries.reverse();   // chronological
  } catch { return []; }
}

function computeTrend(entries) {
  if (!entries || entries.length < 3) return null;
  // Linear regression slope on (index, score)
  const n = entries.length;
  const xs = entries.map((_, i) => i);
  const ys = entries.map(e => e.score || 0);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, denom = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    denom += (xs[i] - meanX) ** 2;
  }
  const slope = denom === 0 ? 0 : num / denom;
  return { slope: +slope.toFixed(3), meanScore: +meanY.toFixed(3), n };
}

// ─── Prompt block ──────────────────────────────────────────────────────────

export async function renderUserMoodBlock(redis, userId) {
  const entries = await loadUserMoodTrajectory(redis, userId);
  const trend = computeTrend(entries);
  if (!trend) return "";

  const { slope, meanScore, n } = trend;

  // Only render when meaningfully non-flat
  if (Math.abs(slope) < 0.03 && Math.abs(meanScore) < 0.15) return "";

  const direction =
    slope > 0.1 ? "lifting"
    : slope > 0.03 ? "gently lifting"
    : slope < -0.1 ? "dropping"
    : slope < -0.03 ? "gently dropping"
    : "flat";

  const level =
    meanScore > 0.25 ? "bright"
    : meanScore > 0.05 ? "okay"
    : meanScore > -0.05 ? "neutral"
    : meanScore > -0.25 ? "low"
    : "heavy";

  return `# THEIR MOOD TRAJECTORY (their own affect, not your read of them)

Over the last ${n} of their messages, their register has been ${level} with a ${direction} trend.

This is observation of WHAT THEY SAID, not interpretation of what it meant. Don't confuse a dropping trajectory with their relationship to you — it could be anything; they just had a rough day / week. Honor the signal: when mood is dropping, be a quieter presence; when lifting, meet the lift without immediately pulling it back down by chasing depth.`;
}
