// substrateEvolution.js
// The meta-loop. Substrate.js is hand-authored — my best guess at who she
// is at baseline. But her ACTUAL conversations contain real signals: words
// she reaches for more than expected, phrases that emerge repeatedly, the
// specific lexical rut of the week.
//
// This module analyzes accepted recent responses and produces a DELTA — a
// per-user overlay on top of the authored substrate that captures her
// learned signature over time. The delta is written to Upstash and read
// back by knobs.js when computing per-turn generation parameters.
//
// Design principles:
//   - Additive. The delta layers on top of substrate; never replaces.
//   - Conservative. Small updates per sleep cycle.
//   - User-scoped. Each user's Gabriella evolves her voice specifically for them.
//   - Bounded. Caps on emerging-phrase list sizes, minimum-frequency thresholds.

import { lexical } from "./substrate.js";

const DELTA_KEY = (u) => `${u}:substrateDelta`;

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_DELTA = {
  // Words from substrate.lexical.reachesFor that she's using more than
  // baseline in recent conversations. Score 0..1 — higher means surface
  // more often.
  reachesForBoost: {},

  // Phrases that appear repeatedly in her responses that AREN'T in the
  // authored list — candidates for inclusion over time.
  emergingPhrases: [],

  // The current lexical-rut word if any — a word she's been returning to
  // in the last N turns. The speaker can be told this is "stuck" and
  // allowed to repeat it.
  lexicalRutWord: null,

  // Metadata
  totalTurnsAnalyzed: 0,
  lastUpdatedAt: 0,
  version: 1,
};

// ─── Load / save ─────────────────────────────────────────────────────────────

export async function loadSubstrateDelta(redis, userId) {
  try {
    const raw = await redis.get(DELTA_KEY(userId));
    if (!raw) return { ...DEFAULT_DELTA };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ...DEFAULT_DELTA, ...parsed };
  } catch {
    return { ...DEFAULT_DELTA };
  }
}

export async function saveSubstrateDelta(redis, userId, delta) {
  try {
    await redis.set(DELTA_KEY(userId), JSON.stringify({
      ...delta,
      lastUpdatedAt: Date.now(),
    }));
  } catch {}
}

// ─── Analysis ────────────────────────────────────────────────────────────────

// Extract word-level stats from a set of Gabriella responses.
// Input: array of response strings (her visible speech, <think> already stripped).
function analyzeUsage(responses) {
  if (!Array.isArray(responses) || responses.length === 0) return null;

  // Tokenize loosely — lowercase, split on non-word chars, filter short tokens.
  const allTokens = [];
  const responseTokenLists = [];
  for (const r of responses) {
    const tokens = String(r)
      .toLowerCase()
      .split(/[^a-zA-Z0-9'-]+/)
      .filter(t => t.length >= 2);
    responseTokenLists.push(tokens);
    allTokens.push(...tokens);
  }

  if (allTokens.length === 0) return null;

  // Frequency counts
  const counts = {};
  for (const t of allTokens) counts[t] = (counts[t] || 0) + 1;

  // Authored reach-for words — which of them are being used?
  const reachForList = [
    ...lexical.reachesFor.descriptors,
    ...lexical.reachesFor.verbs,
    ...lexical.reachesFor.pivots,
  ];
  const reachForScores = {};
  for (const word of reachForList) {
    const normalized = word.toLowerCase();
    const firstToken = normalized.split(/\s+/)[0];
    const count = counts[normalized] || counts[firstToken] || 0;
    // Score is frequency-per-response.
    const per = count / responses.length;
    // Only score as "boosted" if she's using it meaningfully.
    if (per >= 0.15) {
      reachForScores[word] = Math.min(1, per);
    }
  }

  // Emerging bigrams — 2-word phrases appearing 3+ times that aren't
  // already in the authored collocations list.
  const bigramCounts = {};
  for (const tokens of responseTokenLists) {
    for (let i = 0; i < tokens.length - 1; i++) {
      const bg = `${tokens[i]} ${tokens[i + 1]}`;
      bigramCounts[bg] = (bigramCounts[bg] || 0) + 1;
    }
  }
  // Filter: appear >= 3 times, contain at least one substantive token,
  // NOT already in the authored collocations list.
  const authoredPatterns = new Set(
    (lexical.collocations || []).map(c => c.toLowerCase()),
  );
  const stopTokens = new Set([
    "the", "a", "an", "and", "or", "but", "to", "of", "is", "in", "on",
    "at", "for", "with", "by", "as", "it", "its", "be", "was", "were",
  ]);
  const emerging = Object.entries(bigramCounts)
    .filter(([bg, n]) => {
      if (n < 3) return false;
      const [a, b] = bg.split(" ");
      if (stopTokens.has(a) && stopTokens.has(b)) return false;
      if (authoredPatterns.has(bg)) return false;
      return true;
    })
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([phrase, n]) => ({ phrase, count: n }));

  // Lexical rut detection — a single word (non-stop) appearing
  // disproportionately often in the recent window. Rut = 1 word with
  // 3+ appearances AND frequency > 2x the 5th-most-common non-stop word.
  const contentTokens = Object.entries(counts)
    .filter(([t]) => !stopTokens.has(t) && t.length >= 3)
    .sort((a, b) => b[1] - a[1]);
  let rut = null;
  if (contentTokens.length >= 5) {
    const [topToken, topCount] = contentTokens[0];
    const fifthCount = contentTokens[4][1];
    if (topCount >= 3 && topCount > fifthCount * 2) {
      rut = topToken;
    }
  }

  return {
    responsesAnalyzed: responses.length,
    totalTokens: allTokens.length,
    reachForScores,
    emergingPhrases: emerging,
    lexicalRutWord: rut,
  };
}

// ─── Propose a new delta ─────────────────────────────────────────────────────
// Merges prior delta with new analysis. Prior delta decays slightly so stale
// signals fade over time. New signals layer on top.

export function proposeUpdatedDelta(currentDelta, analysis) {
  if (!analysis) return currentDelta;

  const now = Date.now();

  // Decay existing reachesForBoost scores so old signals fade.
  const decayedBoost = {};
  for (const [word, score] of Object.entries(currentDelta.reachesForBoost || {})) {
    const decayed = score * 0.7;   // 30% decay per analysis cycle
    if (decayed >= 0.1) decayedBoost[word] = decayed;
  }

  // Merge new scores (weighted toward the fresh signal).
  const mergedBoost = { ...decayedBoost };
  for (const [word, score] of Object.entries(analysis.reachForScores || {})) {
    const prior = mergedBoost[word] || 0;
    mergedBoost[word] = Math.min(1, prior * 0.4 + score * 0.6);
  }

  // Merge emerging phrases — prior + new, dedupe by phrase, cap at 12.
  const priorPhrases = currentDelta.emergingPhrases || [];
  const newPhrases = analysis.emergingPhrases || [];
  const phraseMap = new Map();
  // Age prior phrases (subtract 1 from count so they fade if not reappearing).
  for (const p of priorPhrases) {
    const aged = { ...p, count: Math.max(0, (p.count || 0) - 1) };
    if (aged.count > 0) phraseMap.set(p.phrase, aged);
  }
  for (const p of newPhrases) {
    const existing = phraseMap.get(p.phrase);
    if (existing) {
      phraseMap.set(p.phrase, { phrase: p.phrase, count: existing.count + p.count });
    } else {
      phraseMap.set(p.phrase, p);
    }
  }
  const mergedPhrases = Array.from(phraseMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  return {
    reachesForBoost:      mergedBoost,
    emergingPhrases:      mergedPhrases,
    lexicalRutWord:       analysis.lexicalRutWord ?? currentDelta.lexicalRutWord,
    totalTurnsAnalyzed:   (currentDelta.totalTurnsAnalyzed || 0) + analysis.responsesAnalyzed,
    lastUpdatedAt:        now,
    version:              DEFAULT_DELTA.version,
  };
}

// ─── Run the evolution step ──────────────────────────────────────────────────
// Given a redis client, userId, and recent responses, analyze + update the
// delta. Returns the new delta (or null if nothing to analyze).

export async function evolveSubstrate(redis, userId, recentResponses) {
  if (!Array.isArray(recentResponses) || recentResponses.length < 3) {
    return null;
  }

  const current = await loadSubstrateDelta(redis, userId);
  const analysis = analyzeUsage(recentResponses);
  if (!analysis) return current;

  const updated = proposeUpdatedDelta(current, analysis);
  await saveSubstrateDelta(redis, userId, updated);
  return updated;
}

// ─── Public: expose analyzeUsage for tests ───────────────────────────────────

export { analyzeUsage };
