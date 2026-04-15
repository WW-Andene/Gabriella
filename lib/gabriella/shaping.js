// shaping.js
// Post-generation shaping pass. The transforms in this file run AFTER the
// model produces a response — they modify the visible output before it
// streams to the user, to:
//
//   1. Strip things prompts can't reliably prevent (summary endings,
//      "I"-openers, banned phrase tells)
//   2. Apply knob-aware adjustments (word-family swaps, occasional
//      disfluency injection, consistency)
//
// Principles:
//   - CONSERVATIVE. When in doubt, don't change. Leave the model's voice.
//   - REVERSIBLE-feeling. Output should still sound like the model's
//     response, just slightly more her.
//   - SAFE. Never mangle grammar or strip meaning. Better to skip a
//     transform than apply it badly.
//
// The pipeline runs as a sequence of transforms, each of which returns
// the (possibly modified) text. Order matters — some transforms set
// up conditions that others check.

import { lexical } from "./substrate.js";

// ─── Transform: strip summary/wrap-up endings ────────────────────────────────
// The model sometimes ends with "Does that make sense?" or "I hope that
// helps." despite the identity block forbidding it. Catch what leaks through.

const SUMMARY_ENDING_PATTERNS = [
  /\s+does that (make sense|resonate|help|work|land)[?.!]?\s*$/i,
  /\s+(I hope (that|this) (helps|makes sense)|hope that helps)[?.!]?\s*$/i,
  /\s+(let me know (if|what)|feel free to)[^.!?]*[?.!]?\s*$/i,
  /\s+(what do you think|how does that sound|how does that feel)[?.!]?\s*$/i,
  /\s+(make sense|right)\?\s*$/i,
];

export function stripSummaryEnding(text) {
  let result = text;
  for (const pat of SUMMARY_ENDING_PATTERNS) {
    result = result.replace(pat, "");
  }
  // Clean up if the strip left a trailing period.
  result = result.replace(/\s+\.\s*$/, ".");
  return result.trimEnd();
}

// ─── Transform: fix "starts with I" ──────────────────────────────────────────
// Her identity block forbids starting a response with "I". Instead of
// regenerating, try a small rewrite that's usually safe.

export function fixStartsWithI(text) {
  if (!text) return text;
  // "I think X" → "X, I think" — but only for simple "I VERB" openings.
  // Be VERY conservative: only rewrite the most common shapes.
  const mainClause = text.match(/^I'?m\s+([a-z])/);
  if (mainClause) {
    // "I'm tired" → "Tired, honestly" is too aggressive. Skip.
    return text;
  }
  // "I think that X" → "X, I think."   (short form only)
  const thinkPattern = /^I (think|mean|guess|wonder|don't know)\s+([a-z].{2,60}?)([.!?])/;
  const m = text.match(thinkPattern);
  if (m) {
    const verb = m[1];
    const body = m[2];
    const endPunct = m[3];
    // Capitalize body start
    const bodyCap = body[0].toUpperCase() + body.slice(1);
    const rewritten = `${bodyCap}, I ${verb}${endPunct}`;
    return text.replace(thinkPattern, rewritten);
  }
  // Otherwise leave the response — a flagged-but-unchanged response is
  // better than a mangled one.
  return text;
}

// ─── Transform: strip residual banned phrases ────────────────────────────────
// Catch the phrases that sometimes slip through when the gauntlet's
// heuristic doesn't fire on them.

const RESIDUAL_STRIPS = [
  // "Great question — " at start
  { pattern: /^(Great question[,!.\-—:\s]+)/i, replacement: "" },
  // "I totally understand" at start
  { pattern: /^(I totally (understand|get it)[,.\-—:\s]+)/i, replacement: "" },
  // Leading "That's a great/good/interesting question"
  { pattern: /^(That'?s (a |an )?(great|good|interesting|valid) question[,.\-—:\s]+)/i, replacement: "" },
  // Leading "As an AI"
  { pattern: /^(As an AI[,.\-—:\s]+)/i, replacement: "" },
  // "Thank you for sharing/asking"
  { pattern: /^(Thank you for (sharing|asking)[^.!?]*[.!\-—:\s]+)/i, replacement: "" },
];

export function stripResidualBannedPhrases(text) {
  let result = text;
  for (const { pattern, replacement } of RESIDUAL_STRIPS) {
    const before = result;
    result = result.replace(pattern, replacement);
    // If we stripped the opening, recapitalize the new first letter.
    if (result !== before && result.length > 0) {
      result = result[0].toUpperCase() + result.slice(1);
    }
  }
  return result;
}

// ─── Transform: word-family swaps ────────────────────────────────────────────
// When the model used a word from an avoided family AND there's a clear
// signature equivalent, swap. Only runs at moderate+ signatureDensity.
// Case-preserving where possible. Only touches whole words.

// Build a map from avoided word → preferred word. Just a few high-confidence
// swaps; resist the urge to do too much (e.g., "significant" → "matters"
// is risky because the part-of-speech might differ).

const SAFE_SWAPS = {
  // adverb/adjective → signature
  "truly":        "",       // strip, it's usually empty
  "indeed":       "",
  "certainly":    "",
  "absolutely":   "",
  "really really": "really",
  // verbs
  "ponder":       "turn over",
  "reflect on":   "turn over",
  "contemplate":  "turn over",
  "comprehend":   "get",
  "grasp":        "get",
  "articulate":   "say",
  // nouns
  "journey":      "",       // usually strippable in her context
};

export function applyWordFamilySwaps(text, knobs) {
  if (!knobs || knobs.signatureDensity < 0.5) return text;
  let result = text;
  for (const [from, to] of Object.entries(SAFE_SWAPS)) {
    const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    if (to === "") {
      // Remove the word + any adjacent extra space.
      result = result.replace(new RegExp(`\\s+\\b${from}\\b|\\b${from}\\b\\s+`, "gi"), " ");
    } else {
      result = result.replace(pattern, to);
    }
  }
  // Collapse any double spaces left by removals.
  result = result.replace(/\s{2,}/g, " ");
  return result;
}

// ─── Transform: occasional disfluency injection ──────────────────────────────
// At low polish / low-energy / quiet-part turns, inject at most ONE small
// disfluency marker. Extremely conservative — most turns don't need it,
// and bad injection hurts more than it helps.

export function maybeInjectDisfluency(text, knobs) {
  if (!knobs || knobs.disfluencyBudget < 0.07) return text;
  // Probabilistic — even when budget allows, only sometimes.
  if (Math.random() > knobs.disfluencyBudget * 5) return text;

  // Only inject if the response has at least 2 sentences.
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g);
  if (!sentences || sentences.length < 2) return text;

  // Insert one of the safer markers at the start of the second sentence.
  const markers = ["mm. ", "okay. ", "hm, "];
  const marker = markers[Math.floor(Math.random() * markers.length)];
  const firstEnd = text.search(/[.!?]\s+[A-Z]/);
  if (firstEnd < 0) return text;
  const insertAt = firstEnd + 2;  // after "." and space

  const next = text[insertAt];
  if (!next || !/[A-Z]/.test(next)) return text;
  // Lowercase the next sentence start since it now follows a marker.
  return text.slice(0, insertAt) + marker + next.toLowerCase() + text.slice(insertAt + 1);
}

// ─── Transform: normalize spacing ────────────────────────────────────────────
// Cleanup pass — collapse multiple spaces, trim, make sure response isn't
// empty.

export function normalizeSpacing(text) {
  if (!text) return text;
  return text
    .replace(/[ \t]{2,}/g, " ")       // double spaces / tabs
    .replace(/\s+([.!?,;:])/g, "$1")  // space-before-punctuation
    .replace(/\n{3,}/g, "\n\n")       // triple+ newlines
    .trim();
}

// ─── Safety check: response hasn't been destroyed ────────────────────────────
// If a transform has emptied or drastically shortened the text, fall back
// to the original.

export function safetyCheck(original, transformed) {
  if (!transformed || transformed.trim().length === 0) return original;
  // If transformed is less than 40% of original AND original wasn't tiny,
  // something went wrong — use original.
  if (original.trim().length > 40 && transformed.trim().length < original.trim().length * 0.4) {
    return original;
  }
  return transformed;
}

// ─── Master pipeline ─────────────────────────────────────────────────────────
// Runs transforms in order. Each step is optional; each has safety fallback.
// Returns the shaped text.

export function shape(text, knobs = null) {
  if (!text) return text;
  const original = text;

  let result = text;
  result = stripSummaryEnding(result);
  result = stripResidualBannedPhrases(result);
  result = fixStartsWithI(result);
  result = applyWordFamilySwaps(result, knobs);
  result = maybeInjectDisfluency(result, knobs);
  result = normalizeSpacing(result);

  return safetyCheck(original, result);
}
