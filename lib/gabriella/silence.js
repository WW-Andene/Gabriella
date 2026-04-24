// silence.js
// Some moments don't want words back.
//
// The gauntlet produces a one-sentence fallback when candidate responses
// fail — that's a REACTIVE silence: she meant to say more and couldn't.
// Silence policy is the PROACTIVE version: detect upfront that the right
// move for this moment is very-short or minimal, and shape the speaker's
// length target accordingly.
//
// The signal for silence is almost never in what was said; it's in what
// kind of SPEECH ACT was performed. A withdrawal ("I don't want to talk
// about it"), a raw announcement of loss ("she died"), a refusal to
// engage ("stop"), a pure phatic on high-gap ("hi"): each wants a
// response that isn't a response in the ordinary sense. A three-word
// "I'm here" is the right move. A five-paragraph processing is malpractice.
//
// Heuristic first — regex patterns that are high-precision. LLM sanity
// pass only when the heuristic hits and the surrounding context is
// ambiguous. Fires BEFORE the cores so the speaker is told upfront
// "length: very short; don't expand into this."

const SILENCE_PATTERNS = [
  {
    name: "withdrawal",
    re:   /\b(i\s*don'?t\s*want\s*to\s*(talk|do\s*this)|not\s*ready\s*to\s*talk|leave\s*me\s*alone|just\s*stop|can'?t\s*(talk|do\s*this))\b/i,
    guidance: "They're withdrawing. Match it. One line at most: 'okay,' 'I'm around,' 'take the space.' No processing, no pursuing.",
  },
  {
    name: "raw_loss",
    re:   /\b(she\s*died|he\s*died|they\s*died|she'?s\s*gone|he'?s\s*gone|dad\s*died|mom\s*died|my\s*(dad|mom|mother|father|sister|brother|wife|husband|partner)\s*(died|passed))\b/i,
    guidance: "Raw loss. Don't analyze. Don't ask for details. One acknowledgment + I'm-here; let them shape the next move.",
  },
  {
    name: "command_stop",
    re:   /^\s*(stop|enough|no|nope|pass)[.!?]?\s*$/i,
    guidance: "They're saying stop. Stop. One word or a short acknowledgment is correct.",
  },
  {
    name: "silence_request",
    re:   /\b(just\s*(listen|sit|be\s*here)|don'?t\s*(fix|analyze|explain)|i\s*just\s*need\s*you\s*to)\b/i,
    guidance: "Explicit request to be with rather than work on. Match it — short, present, no problem-solving.",
  },
  {
    name: "phatic_overload",
    // Very short all-lowercase with low info — "hi", "hey", "sup", "yo", "gm", "gn"
    re:   /^\s*(hi|hey|hi\!|hello|sup|yo|gm|gn|good\s*morning|good\s*night|night|morning|evening)[\s.,!?]*$/i,
    guidance: "Pure phatic. Respond plainly — 3-5 words. No weight, no interpretation. 'Hey. What's up?' territory.",
  },
  {
    name: "single_word_emotional",
    // A single emotional word: "hurt", "scared", "tired", "done"
    re:   /^\s*(hurt|scared|tired|done|lost|alone|stuck|empty|numb|broken|angry|sad|drained)[.!]?\s*$/i,
    guidance: "One word, heavy. The word IS the whole message. Match its weight with equal economy — ask one close question or just meet it.",
  },
];

export function detectSilenceMoment(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;
  const trimmed = userMessage.trim();

  for (const pat of SILENCE_PATTERNS) {
    if (pat.re.test(trimmed)) {
      return {
        kind:     pat.name,
        guidance: pat.guidance,
      };
    }
  }
  return null;
}

// ─── Apply to feltState ──────────────────────────────────────────────────────
// When silence is detected, override length to "very short" and cap
// temperature at "terse" (she shouldn't reach on a withdrawal). Preserves
// everything else the cores produced about the moment.

export function applySilenceOverride(feltState, silenceMoment) {
  if (!feltState || !silenceMoment) return feltState;
  return {
    ...feltState,
    length:      "very short",
    temperature: feltState.temperature === "open" ? "present" : (feltState.temperature || "present"),
    _silence:    { kind: silenceMoment.kind, guidance: silenceMoment.guidance },
  };
}

// Block for the speaker prompt — tiny, anchored above other guidance so
// she doesn't drift back to volume on her own.
export function getSilenceBlock(feltState) {
  if (!feltState?._silence?.guidance) return "";
  return `# SILENCE POLICY — THIS MOMENT WANTS LESS

${feltState._silence.guidance}

If your draft is longer than two short sentences, cut it.`;
}
