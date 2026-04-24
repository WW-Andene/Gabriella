// learningLoop.js
// Online closed learning loop — landed-vs-missed signal per style tag.
//
// We already log ensemble judge labels, gauntlet outcomes, user
// thumbs, contradictions, and callback landings. All of those feed
// OFFLINE training (KTO/DPO bundles flushed via /api/learn). None of
// them update the NEXT turn's behavior.
//
// This module closes the short loop. After each turn:
//   1. Tag the response with simple heuristic style tags (brief,
//      questioning, vulnerable, hedged, direct, reflective, playful,
//      silent-first...). No LLM call.
//   2. Compute an immediate outcome score from the signals already
//      available at turn end (gauntlet pass, ensemble score,
//      contradiction flag).
//   3. Update a per-tag exponential-moving-average of outcome.
//
// Before the next turn, the engine reads top-landing vs top-missing
// tags and surfaces them in the prompt. The speaker doesn't have to
// change — just being told "brief responses have been landing; long
// reflective ones have not" shifts the next generation.
//
// This is a light bandit / implicit-RLHF layer. No gradient updates,
// no training. Just empirical feedback from the running conversation
// into the next prompt.

const STYLE_EMA_KEY   = (u) => `${u}:style:ema`;
const STYLE_COUNT_KEY = (u) => `${u}:style:count`;

const EMA_ALPHA       = 0.15;  // 15% new, 85% history
const MIN_COUNT_SHOW  = 3;     // require at least 3 observations per tag before surfacing
const MAX_TAGS_SHOW   = 3;

// ─── Heuristic style tagging ──────────────────────────────────────────────────

export function tagResponse(text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const tags = new Set();

  const length = t.length;
  if (length <= 80)        tags.add("brief");
  else if (length <= 300)  tags.add("medium");
  else                     tags.add("long");

  if (/\?\s*$/.test(t))                                          tags.add("questioning");
  if (/^(i\b|i'm\b|i'd\b|i've\b|i'll\b)/i.test(t))              tags.add("first-person");
  if (/\b(remember|thought|felt|knew|wondered|used to)\b/i.test(t)) tags.add("reflective");
  if (/\b(maybe|perhaps|kind of|sort of|i think|probably|might)\b/i.test(t)) tags.add("hedged");
  if (/\b(scared|afraid|hurt|miss|longing|ashamed|tender|grief|fragile|exposed)\b/i.test(t)) tags.add("vulnerable");
  if (/—|lol|haha|ha\b/i.test(t))                                 tags.add("playful");
  if (/\bhold on\b|\bone sec\b|\bwait\b|\blet me\b/i.test(t))     tags.add("pausing");

  // Terseness + period (statement): "direct"
  if (length < 120 && /[\.]$/.test(t) && !/\?/.test(t))           tags.add("direct");

  return Array.from(tags);
}

// ─── Immediate outcome score ──────────────────────────────────────────────────
//
// 0.0 — 1.0. Built from signals available at turn end, WITHOUT waiting
// for the next user turn. Caller should pass whatever's known.

export function scoreOutcome({
  gauntletPass,
  ensembleScore,       // 0..10 or null
  contradiction,       // boolean
  retried,             // boolean — speaker had to regenerate
  rejectedBecause,     // string[] or null — reasons rejected candidate was dropped
}) {
  let score = 0.5;

  if (gauntletPass === true)  score += 0.2;
  if (gauntletPass === false) score -= 0.2;

  if (typeof ensembleScore === "number" && Number.isFinite(ensembleScore)) {
    const normalized = Math.max(0, Math.min(1, ensembleScore / 10));
    score = score * 0.6 + normalized * 0.4;
  }

  if (contradiction === true) score -= 0.25;
  if (retried === true)       score -= 0.05;
  if (Array.isArray(rejectedBecause) && rejectedBecause.length > 0) score -= 0.05;

  return Math.max(0, Math.min(1, score));
}

// ─── Record outcome to EMA ────────────────────────────────────────────────────

export async function recordStyleOutcome(redis, userId, { tags, score }) {
  if (!redis || !userId || !Array.isArray(tags) || tags.length === 0) return;
  if (!Number.isFinite(score)) return;

  const emaKey   = STYLE_EMA_KEY(userId);
  const countKey = STYLE_COUNT_KEY(userId);

  try {
    const [currentEmaRaw, currentCountRaw] = await Promise.all([
      redis.get(emaKey).catch(() => null),
      redis.get(countKey).catch(() => null),
    ]);
    const ema   = currentEmaRaw   ? (typeof currentEmaRaw   === "string" ? JSON.parse(currentEmaRaw)   : currentEmaRaw)   : {};
    const count = currentCountRaw ? (typeof currentCountRaw === "string" ? JSON.parse(currentCountRaw) : currentCountRaw) : {};

    for (const tag of tags) {
      const prev = typeof ema[tag] === "number" ? ema[tag] : null;
      ema[tag] = prev === null ? score : prev * (1 - EMA_ALPHA) + score * EMA_ALPHA;
      count[tag] = (count[tag] || 0) + 1;
    }

    await Promise.all([
      redis.set(emaKey, JSON.stringify(ema)),
      redis.set(countKey, JSON.stringify(count)),
    ]);
  } catch { /* ignore */ }
}

// ─── Load and sort outcomes ───────────────────────────────────────────────────

export async function loadStyleOutcomes(redis, userId) {
  if (!redis || !userId) return { landing: [], missing: [] };
  try {
    const [emaRaw, countRaw] = await Promise.all([
      redis.get(STYLE_EMA_KEY(userId)).catch(() => null),
      redis.get(STYLE_COUNT_KEY(userId)).catch(() => null),
    ]);
    const ema   = emaRaw   ? (typeof emaRaw   === "string" ? JSON.parse(emaRaw)   : emaRaw)   : {};
    const count = countRaw ? (typeof countRaw === "string" ? JSON.parse(countRaw) : countRaw) : {};

    const entries = Object.entries(ema)
      .filter(([tag]) => (count[tag] || 0) >= MIN_COUNT_SHOW)
      .map(([tag, score]) => ({ tag, score, count: count[tag] || 0 }));

    entries.sort((a, b) => b.score - a.score);
    return {
      landing: entries.slice(0, MAX_TAGS_SHOW),
      missing: entries.slice(-MAX_TAGS_SHOW).reverse(),
      totalTags: entries.length,
    };
  } catch {
    return { landing: [], missing: [] };
  }
}

// ─── Rendering — compact prompt block ─────────────────────────────────────────

export function renderStyleOutcomesBlock(outcomes) {
  if (!outcomes) return null;
  const { landing, missing } = outcomes;
  if (!landing.length && !missing.length) return null;
  // Avoid duplication when landing ≈ missing (happens with few tags).
  const landingTags = new Set(landing.map(x => x.tag));
  const distinctMissing = missing.filter(x => !landingTags.has(x.tag) && x.score < 0.5);

  const lines = ["# STYLE OUTCOMES — what's been landing here"];
  if (landing.length > 0) {
    const parts = landing.map(x => `${x.tag} (${(x.score * 100).toFixed(0)}%)`);
    lines.push("Landing: " + parts.join(", "));
  }
  if (distinctMissing.length > 0) {
    const parts = distinctMissing.map(x => `${x.tag} (${(x.score * 100).toFixed(0)}%)`);
    lines.push("Missing: " + parts.join(", "));
  }
  lines.push("");
  lines.push("This is feedback from what actually worked with THIS person. Lean into what's landing; don't keep reaching for what's missing. Not a rule — a nudge.");
  return lines.join("\n");
}

// ─── Summary for /api/stats ───────────────────────────────────────────────────

export async function learningLoopStats(redis, userId) {
  const o = await loadStyleOutcomes(redis, userId);
  return {
    landing: o.landing,
    missing: o.missing,
    totalTags: o.totalTags || 0,
  };
}
