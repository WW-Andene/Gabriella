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

import { lexical, texting } from "./substrate.js";

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

// ─── Transform: apply texting register ──────────────────────────────────────
// Gated by knobs.textingRegister computed upstream. The transforms here
// translate a fully-formed, typed response into her texting voice when
// the register calls for it. Conservative — only applies swaps in
// texting.shortenings (hand-curated) and never touches proper-noun
// regions it can't safely detect. Doesn't strip things that would
// change meaning.
//
// Behavior per register:
//   typed         — no transforms
//   textedLight   — rare: drop trailing period on a single-token ack
//                   ("okay" / "yeah" / "sure"); no shortenings; caps stay.
//   textedCasual  — lowercase most sentence starts (not acronyms /
//                   proper nouns heuristically); apply a SUBSET of her
//                   shortenings; drop periods on short (≤ 20 char)
//                   bubble-sends; keep em-dash.
//   textedTired   — all of the above plus: "I " → "i " self-reference,
//                   apply the full shortenings set, fragments OK (no
//                   transform needed — the model produced them).

const ACK_TOKENS = /^(okay|yeah|sure|ok|right|mhm|mm|fine|cool|got it|agreed)[.]?$/i;

// Which shortenings get applied in each register. Keep the list small
// for textedCasual — only the ones that wouldn't surprise.
const CASUAL_SHORTENINGS = {
  "probably":   "probs",
  "definitely": "def",
  "though":     "tho",
  "because":    "cause",
  "okay":       "ok",
};

// textedTired additionally applies a few more — more fragmented language
// is allowed when she's genuinely depleted.
const TIRED_EXTRA = {
  "I don't know": "idk",
  "to be honest": "honestly",  // already a preferred form
};

// Lowercase the first letter of each sentence EXCEPT when the word is
// obviously a proper noun (all-caps acronym, or single-letter "I" in
// certain contexts — but in textedTired "I" becomes "i" too).
function lowercaseSentenceStarts(text, { lowerI = false } = {}) {
  // Match sentence-starts: beginning of string OR after .!? + whitespace.
  // Capture the first word so we can skip if it's all-caps (acronym).
  return text.replace(/(^|[.!?]\s+)([A-Z][a-z]*)/g, (match, lead, word) => {
    // Skip if word looks like an acronym (>1 char, all-upper would not have
    // matched [a-z]* tail so this only catches single-upper + lower pattern)
    // Skip "I" as self-reference unless lowerI
    if (word === "I" && !lowerI) return match;
    // Skip proper nouns we recognize — too risky to detect broadly; use
    // a small stoplist of common proper-noun starts that sometimes appear.
    // Everything else → lowercase first char.
    return lead + word[0].toLowerCase() + word.slice(1);
  });
}

// Heuristic: detect proper-noun-looking tokens we should NOT lowercase
// mid-sentence. We run lowercaseSentenceStarts only on SENTENCE BEGINNINGS
// so mid-sentence capitalization is preserved automatically — meaning
// we don't need a proper-noun list for mid-sentence. The only risk is a
// proper noun *at* the sentence start (e.g., "Paris is beautiful.").
// We accept that small cost — she'd in practice still lowercase that in
// actual texting. Only acronyms (JFK, NYC) deserve protection, so:
function preserveAcronymStarts(text) {
  // Capitalize back any word at a sentence start that is entirely
  // uppercase letters (acronym). The previous pass would have lowered
  // the leading letter. Check for 2+ uppercase pattern BEFORE lowering
  // would happen — we handle that in the main function instead.
  return text;  // no-op; the main fn has a check
}

function applyShortenings(text, dict) {
  let result = text;
  for (const [from, to] of Object.entries(dict)) {
    // Whole-word case-insensitive replace. Preserve sentence-start cap only
    // if the source was capitalized AND we're still in a register that caps.
    const pattern = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    result = result.replace(pattern, (match) => {
      const wasCapped = /^[A-Z]/.test(match);
      if (wasCapped) return to[0].toUpperCase() + to.slice(1);
      return to;
    });
  }
  return result;
}

// Drop the trailing period if the entire response is a single short
// ack-like fragment. Texting register treats period-as-weight: adding
// one to "ok." signals edge or finality.
function dropAckPeriod(text, aggressive = false) {
  const trimmed = text.trim();
  if (aggressive) {
    // textedTired: drop trailing period if text is ≤ 20 chars and has no
    // comma/semicolon (i.e., it's a single-clause short send).
    if (trimmed.length <= 20 && /[a-z]\.$/i.test(trimmed) && !/[;,]/.test(trimmed)) {
      return text.replace(/\.(\s*)$/, "$1");
    }
    return text;
  }
  // textedCasual + Light: only drop if the WHOLE text is one ack token.
  if (ACK_TOKENS.test(trimmed.replace(/\.$/, ""))) {
    return text.replace(/\.(\s*)$/, "$1");
  }
  return text;
}

// Lowercase "I" as self-reference (not "I'd"-in-all-contexts — still
// probably fine, but be careful: only when standalone or with common
// contractions).
function lowercaseSelfReferenceI(text) {
  return text
    .replace(/\bI\b/g, "i")
    .replace(/\bI'(m|ll|d|ve|re)\b/g, (m, tail) => "i'" + tail);
}

export function applyTextingRegister(text, knobs) {
  if (!text || !knobs) return text;
  const reg = knobs.textingRegister;
  if (!reg || reg === "typed") return text;

  let result = text;

  if (reg === "textedLight") {
    // Very light touch — only drop the period on a bare ack.
    result = dropAckPeriod(result, false);
    return result;
  }

  if (reg === "textedCasual" || reg === "textedTired") {
    // Lowercase sentence starts (preserving acronyms at sentence start).
    result = result.replace(/(^|[.!?]\s+)([A-Z][A-Za-z]*)/g, (m, lead, word) => {
      // Acronym (2+ consecutive uppercase): preserve.
      if (/^[A-Z]{2,}/.test(word)) return m;
      // Single letter "I" handled separately.
      if (word === "I") return m;
      return lead + word[0].toLowerCase() + word.slice(1);
    });

    // Apply her casual shortenings.
    result = applyShortenings(result, CASUAL_SHORTENINGS);

    // Drop ack periods.
    result = dropAckPeriod(result, false);
  }

  if (reg === "textedTired") {
    // Lowercase "I" self-reference FIRST — so subsequent shortenings don't
    // re-capitalize based on the original "I" leading char. ("I don't know"
    // becomes "i don't know", then the idk shortening sees lowercase and
    // stays lowercase.)
    result = lowercaseSelfReferenceI(result);
    // Additional shortenings.
    result = applyShortenings(result, TIRED_EXTRA);
    // More aggressive ack-period drop.
    result = dropAckPeriod(result, true);
  }

  return result;
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
  // Phase 6.3: texting-register transforms run LATE — after structural
  // fixes (fixStartsWithI already committed "I" → clause-moved form where
  // it applied) but before normalize. Gated on knobs.textingRegister.
  result = applyTextingRegister(result, knobs);
  result = normalizeSpacing(result);

  return safetyCheck(original, result);
}
