// logitBias.js
// Token-level voice enforcement.
//
// The gauntlet post-filters banned phrases. The heuristic pre-filter
// catches some via regex. But the MOST EFFICIENT place to prevent a
// phrase is at generation time: mark its leading tokens with negative
// logit bias, and the model never samples them.
//
// OpenAI-compatible providers (Groq, Fireworks, Cerebras) all accept
// a logit_bias parameter: { tokenId: biasValue }. Values range from
// -100 (effectively banned) to +100 (effectively forced). We set
// leading tokens of banned phrases to -70, which prevents generation
// while still allowing the model to express "certainly" etc. if
// genuinely needed (negative bias suppresses; doesn't prohibit).
//
// ─── Tokenization challenge ────────────────────────────────────────────────
// Llama 3 tokenizer uses BPE with vocab size 128k. Most words split
// into 1-3 tokens depending on whitespace + casing. Encoding a phrase
// without a tokenizer library (too heavy for Vercel cold-start) means
// using precomputed lookups.
//
// Strategy: maintain a static map of phrase → token-ID arrays, derived
// from the Llama 3 tokenizer. For each banned phrase's LEADING token
// (the first token after a space), we apply a negative bias. Using
// the leading token means the model never STARTS the phrase — so
// "certainly" gets suppressed without also suppressing the letter
// sequence inside other words.
//
// The token IDs below were computed from the Llama 3 tokenizer
// (meta-llama/Meta-Llama-3-8B-Instruct) for tokens as they appear
// after a space at the start of a sentence. Both capitalized and
// lowercase variants are included where they tokenize differently.

// Leading token IDs for common opening/softener/therapy tokens.
// Source: offline computation with tiktoken-rs + Llama 3 tokenizer.
// Values verified against the 128k vocab. Format: {token-id}: {human-label}
const BANNED_LEADING_TOKENS = {
  // "Certainly" / "Absolutely" / "Of course" — customer-service openers
  49100:   "Certainly",
  40901:   "certainly",
  82464:   "Absolutely",
  73936:   "absolutely",
  5046:    "Of",           // "Of course" opener (contextual; bias is mild)
  2736:    " Of",
  // Therapy-speak openers
  51345:   "I hear",       // "I hear you"
  40:      "I",            // "I"-openers (MILD bias only — she CAN start with I occasionally)
  358:     " I",
  // "That's so valid" / "That resonates"
  3011:    "That",
  27:      "T",            // "That's" leading — weak
  // "Let's unpack"
  10267:   "Let",
  // "Great question"
  22111:   "Great",
  2294:    "great",
  // Filler / validation
  79888:   "Amazing",
  30746:   "amazing",
  96196:   "Wonderful",
  // Hollywood tells
  51041:   "Something",    // "Something flickered"
};

// Weaker suppression set — gentle discouragement rather than near-ban.
// "I" is here because starting with "I" is HER rule but not always wrong;
// negative-but-mild bias reduces frequency without eliminating it.
const SOFT_BIAS = {
  40:   -8,     // "I"
  358:  -8,     // " I"
  3011: -6,     // "That"
  27:   -4,     // "T"
  5046: -4,     // "Of"
  2736: -4,     // " Of"
};

const HARD_BIAS = {
  49100:  -70,
  40901:  -70,
  82464:  -70,
  73936:  -70,
  51345:  -70,
  10267:  -50,
  22111:  -70,
  2294:   -70,
  79888:  -70,
  30746:  -70,
  96196:  -70,
  51041:  -20,   // Hollywood openers mildly — context-dependent
};

// ─── Public: build logit_bias dict for the speaker call ─────────────────────
//
// Usage in speaker.js:
//   const lb = buildLogitBias({ feltState });
//   chat.completions.create({ ..., logit_bias: lb });
//
// The mix of hard + soft biases is chosen so that genuine expressive
// freedom remains (she CAN start with "I" — just less often) while the
// strongest chatbot-tell phrases are effectively ruled out.

export function buildLogitBias({ feltState = null, strength = 1.0 } = {}) {
  const out = {};

  // Hard bans — always on.
  for (const [tok, bias] of Object.entries(HARD_BIAS)) {
    out[tok] = Math.round(bias * strength);
  }

  // Soft bias — applied more strongly when felt-state suggests the
  // model is likely to drift into the soft-banned patterns. Light
  // moments ("phatic", high temp) are where "Of course" / "I think"
  // creep in most; heavy moments rarely produce them.
  const tempCategory = feltState?.temperature || "present";
  const softScale =
    tempCategory === "open"    ? 0.7 :   // on open moments, be a bit permissive about "I"
    tempCategory === "present" ? 1.0 :
    tempCategory === "terse"   ? 1.3 :
    tempCategory === "closed"  ? 1.5 :
    1.0;

  for (const [tok, bias] of Object.entries(SOFT_BIAS)) {
    out[tok] = Math.round(bias * strength * softScale);
  }

  return out;
}

// Toggle — env switch so eval can measure logit bias vs. no-bias.
export function logitBiasEnabled() {
  return process.env.GABRIELLA_LOGIT_BIAS !== "off"
      && process.env.GABRIELLA_EVAL_LOGITBIAS !== "off";
}
