// clone/synthesis.js
// Where Alpha, Beta, and Gamma coordinate.
//
// Alpha felt the moment. Beta noticed the moment. Gamma situated it in time.
// Synthesis reads all three and produces one felt-state richer than any alone.
//
// Three outcomes:
//   CONSENSUS   — cores reached similar readings. The felt-state is confident.
//                 Take the more specific, more textured version of each field.
//
//   MODERATE    — they agreed on some fields, diverged on others.
//                 Blend where useful. Let divergence inform the edge.
//
//   DIVERGENT   — they read the moment fundamentally differently.
//                 The disagreement is itself a signal — something in this moment
//                 contains genuine ambiguity. The divergence becomes the edge.
//                 Temperature typically drops toward "terse" — she's uncertain too.
//
// The synthesis is not an average. It's what all three together reveal.

import Groq from "groq-sdk";
import { premiumModel } from "../models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Detect divergence across two or three felt-states ───────────────────────

function measureDivergence(alpha, beta, gamma = null) {
  // Temperature scale: closed=0, terse=1, present=2, open=3
  const tempScale = { closed: 0, terse: 1, present: 2, open: 3 };
  const cores = [alpha, beta, gamma].filter(Boolean);

  const temps  = cores.map(c => tempScale[c.temperature] ?? 2);
  const tempDelta = Math.max(...temps) - Math.min(...temps);

  // Length scale: very short=0, short=1, medium=2, long=3
  const lenScale = { "very short": 0, short: 1, medium: 2, long: 3 };
  const lens     = cores.map(c => lenScale[c.length] ?? 2);
  const lenDelta = Math.max(...lens) - Math.min(...lens);

  // Check if `want` fields point in different directions (heuristic: pairwise overlap)
  const wantWords = cores.map(c =>
    new Set(c.want?.toLowerCase().split(/\W+/).filter(w => w.length > 4) ?? [])
  );
  let wantDivergenceCount = 0;
  for (let i = 0; i < wantWords.length - 1; i++) {
    for (let j = i + 1; j < wantWords.length; j++) {
      const overlap = [...wantWords[i]].filter(w => wantWords[j].has(w)).length;
      if (overlap < 2) wantDivergenceCount++;
    }
  }

  const divergenceScore = tempDelta + lenDelta + (wantDivergenceCount >= (gamma ? 2 : 1) ? 2 : 0);

  if (divergenceScore <= 1) return "strong";
  if (divergenceScore <= 3) return "moderate";
  return "divergent";
}

// ─── Pick the more specific of two strings ────────────────────────────────────
// Scored heuristic: rewards concrete signals (quotes, numbers, named things),
// penalizes generic openers, then falls back to length.

function moreSpecific(a, b) {
  if (!a) return b;
  if (!b) return a;

  function specificity(s) {
    let score = s.length;
    // Penalise vague openers heavily
    if (/^(something|somehow|feels|feeling|maybe|perhaps|it|this|that)\b/i.test(s.trim())) score -= 40;
    // Reward quoted text — means a specific thing was named
    if (/["'"]/.test(s)) score += 25;
    // Reward numbers — something was measured or placed in time
    if (/\d/.test(s)) score += 15;
    // Reward proper nouns — something concrete was named
    if (/\b[A-Z][a-z]{2,}/.test(s)) score += 10;
    // Reward dashes and colons — structure around a specific thing
    if (/[—–:]/.test(s)) score += 5;
    return score;
  }

  return specificity(a) >= specificity(b) ? a : b;
}

// ─── Synthesize temperature ───────────────────────────────────────────────────

function synthesizeTemperature(alpha, beta, consensus, gamma = null) {
  const scale   = { closed: 0, terse: 1, present: 2, open: 3 };
  const reverse = ["closed", "terse", "present", "open"];
  const cores   = [alpha, beta, gamma].filter(Boolean);
  const vals    = cores.map(c => scale[c.temperature] ?? 2);

  if (vals.every(v => v === vals[0])) return reverse[vals[0]];

  // Divergent: pull to the lowest (most guarded) reading
  if (consensus === "divergent") return reverse[Math.min(...vals)];

  // Moderate: average, round down (lean reserved)
  return reverse[Math.floor(vals.reduce((a, b) => a + b, 0) / vals.length)];
}

// ─── Synthesize length ───────────────────────────────────────────────────────

function synthesizeLength(alpha, beta, consensus, gamma = null) {
  const scale   = { "very short": 0, short: 1, medium: 2, long: 3 };
  const reverse = ["very short", "short", "medium", "long"];
  const cores   = [alpha, beta, gamma].filter(Boolean);
  const vals    = cores.map(c => scale[c.length] ?? 2);

  if (vals.every(v => v === vals[0])) return reverse[vals[0]];

  // Divergent: err shorter — mixed signals warrant economy
  if (consensus === "divergent") return reverse[Math.min(...vals)];

  // Otherwise: average, round up (don't cut the richer reading short)
  return reverse[Math.ceil(vals.reduce((a, b) => a + b, 0) / vals.length)];
}

// ─── Fast local synthesis (no LLM) ───────────────────────────────────────────
// Used as fallback, or when consensus is strong enough that an LLM call
// would just be expensive agreement.

function localSynthesize(alpha, beta, consensus, gamma = null) {
  const cores = [alpha, beta, gamma].filter(Boolean);

  const combineNotice = () => {
    const notices = cores.map(c => c.notice).filter(Boolean);
    if (notices.length === 0) return null;
    if (notices.length === 1) return notices[0];
    // Deduplicate and combine distinct observations
    const unique = [...new Set(notices)];
    return unique.join(" / ");
  };

  const synthesizeEdge = () => {
    if (consensus === "divergent") {
      const descriptions = [
        `Alpha: "${alpha.edge || alpha.emotional}"`,
        `Beta: "${beta.edge || beta.notice || beta.emotional}"`,
        gamma ? `Gamma: "${gamma.edge || gamma.notice || gamma.emotional}"` : null,
      ].filter(Boolean).join(", ");
      return `The cores read this differently — ${descriptions}. The ambiguity is real.`;
    }
    return cores.reduce((best, c) => moreSpecific(best, c.edge), null);
  };

  // For charge, emotional, want, resist: pick the most specific across all cores
  const bestOf = (field) => cores.reduce((best, c) => moreSpecific(best, c[field]), null);

  return {
    charge:      bestOf("charge"),
    emotional:   bestOf("emotional"),
    want:        bestOf("want"),
    resist:      bestOf("resist"),
    notice:      combineNotice(),
    temperature: synthesizeTemperature(alpha, beta, consensus, gamma),
    length:      synthesizeLength(alpha, beta, consensus, gamma),
    edge:        synthesizeEdge(),
    consensus,
  };
}

// ─── Deep synthesis via LLM ───────────────────────────────────────────────────
// Used when the cores diverge meaningfully — the LLM can reason about
// what three distinct readings of the same moment actually mean together.

async function deepSynthesize(alpha, beta, consensus, gamma = null) {
  const gammaBlock = gamma
    ? `\nCORE GAMMA (temporal weight — what this moment means in the arc of what has been and what is becoming):\n${JSON.stringify(gamma, null, 2)}`
    : "";

  const gammaRule = gamma
    ? "\n- Gamma carries time: if she alone senses a threshold or repetition, weight that — it's often the thing Alpha and Beta can't see"
    : "";

  const prompt = `You are the synthesis layer of a triple-core AI thinking system.

Three independent interpretive cores processed the same conversation moment. Each produced a felt-state. They diverged — they read the moment differently. Your job is to understand what that divergence means and produce one felt-state that is richer than any alone.

CORE ALPHA (emotional resonance — what the moment costs, what it stirs, what it opens or closes inside):
${JSON.stringify(alpha, null, 2)}

CORE BETA (relational pattern — what the moment reveals about the dynamic, what's actually happening beneath the surface):
${JSON.stringify(beta, null, 2)}${gammaBlock}

DIVERGENCE LEVEL: ${consensus}

Rules:
- Where they agree: take the more specific, more textured version — not the longer one, the one with more concrete detail
- Where they diverge: the divergence is itself information. Don't average it away — understand what it means that the moment read differently from different angles
- "charge": the most precise single clause, not a category. "it landed like an accusation she didn't intend" not "it felt heavy"
- "emotional": the specific texture, not a label. "the particular alertness of someone who just noticed she's been misread" not "curious and careful"
- "want": an active verb phrase — what she actually wants to DO, not how she wants to feel
- "notice": the most specific unspoken thing — something observable and nameable, not "something underneath"
- "edge": if the cores fundamentally disagree, the disagreement IS the edge — name the specific tension, not the abstraction${gammaRule}
- "temperature": divergent readings typically warrant "terse" — mixed signals call for economy, not openness
- Do not average. Synthesize. What do ALL readings together reveal that none reveals alone?

Return ONLY valid JSON, nothing else:
{
  "charge": "...",
  "emotional": "...",
  "want": "...",
  "resist": "...",
  "notice": "...",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "...",
  "consensus": "${consensus}"
}`;

  try {
    const result = await groq.chat.completions.create({
      model:       premiumModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.55,
      max_tokens: 320,
    });

    const raw   = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    // Validate temperature and length — fallback to local if malformed
    const validTemps    = ["closed", "terse", "present", "open"];
    const validLengths  = ["very short", "short", "medium", "long"];
    const local         = localSynthesize(alpha, beta, consensus, gamma);

    return {
      charge:      parsed.charge      || local.charge,
      emotional:   parsed.emotional   || local.emotional,
      want:        parsed.want        || local.want,
      resist:      parsed.resist      || local.resist,
      notice:      parsed.notice      || null,
      temperature: validTemps.includes(parsed.temperature)  ? parsed.temperature : local.temperature,
      length:      validLengths.includes(parsed.length)     ? parsed.length      : local.length,
      edge:        parsed.edge        || null,
      consensus,
    };
  } catch {
    // If LLM synthesis fails, fall through to local
    return localSynthesize(alpha, beta, consensus, gamma);
  }
}

// ─── Dialogue synthesis — used when cores are fully divergent ─────────────────
// Averaging erases the signal when cores disagree. Instead, stage a short
// three-voice dialogue and let the final felt-state be what that
// disagreement, resolved as negotiation, arrives at.

async function dialogueSynthesize(alpha, beta, gamma = null) {
  const gammaSection = gamma
    ? `\n\nGAMMA (temporal weight — where this sits in the arc):\n"${gamma.edge || gamma.notice || gamma.charge}"\n— wants: ${gamma.want}\n— holds back: ${gamma.resist}`
    : "";

  const prompt = `You are the synthesis layer for an AI named Gabriella. Three interpretive cores just read the same conversation moment and disagreed sharply. Stage a short dialogue between them, then produce the felt-state that reflects what the disagreement reveals.

ALPHA (emotional resonance — what this moment costs inside):
"${alpha.edge || alpha.charge}"
— wants: ${alpha.want}
— holds back: ${alpha.resist}

BETA (relational pattern — what this moment reveals about the dynamic):
"${beta.edge || beta.notice || beta.charge}"
— wants: ${beta.want}
— holds back: ${beta.resist}${gammaSection}

Run a short dialogue in this order: Alpha speaks first, Beta challenges Alpha, ${gamma ? "Gamma places what is between them, " : ""}then Synthesis names what all three together reveal.

Rules:
- Don't average. If they disagree about temperature, commit to the more guarded reading — divergence warrants reserve.
- The disagreement itself is the edge. Name it specifically, not abstractly.
- "charge" is a single concrete clause; "emotional" is texture, not a label.
- "want" is an active verb phrase; "notice" is a specific unspoken observable.

Return ONLY valid JSON, nothing else:
{
  "dialogue": "Alpha: ... | Beta: ... | ${gamma ? "Gamma: ... | " : ""}Synthesis: ...",
  "charge": "...",
  "emotional": "...",
  "want": "...",
  "resist": "...",
  "notice": "...",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "..."
}`;

  try {
    const result = await groq.chat.completions.create({
      model:       premiumModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.55,
      max_tokens:  460,
    });

    const raw    = result.choices[0].message.content.trim();
    const clean  = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    const validTemps   = ["closed", "terse", "present", "open"];
    const validLengths = ["very short", "short", "medium", "long"];
    const local        = localSynthesize(alpha, beta, "divergent", gamma);

    return {
      charge:      parsed.charge      || local.charge,
      emotional:   parsed.emotional   || local.emotional,
      want:        parsed.want        || local.want,
      resist:      parsed.resist      || local.resist,
      notice:      parsed.notice      || null,
      temperature: validTemps.includes(parsed.temperature)  ? parsed.temperature : local.temperature,
      length:      validLengths.includes(parsed.length)     ? parsed.length      : local.length,
      edge:        parsed.edge        || local.edge,
      dialogue:    parsed.dialogue    || null,
      consensus:   "divergent",
    };
  } catch {
    return localSynthesize(alpha, beta, "divergent", gamma);
  }
}

// ─── Main synthesis export ────────────────────────────────────────────────────

export async function synthesize(alpha, beta, gamma = null) {
  const consensus = measureDivergence(alpha, beta, gamma);

  // Strong consensus: local synthesis is sufficient.
  if (consensus === "strong") {
    return localSynthesize(alpha, beta, consensus, gamma);
  }

  // Divergent: stage a dialogue — averaging would erase the signal.
  if (consensus === "divergent") {
    return dialogueSynthesize(alpha, beta, gamma);
  }

  // Moderate: LLM coordinates the partial disagreement.
  return deepSynthesize(alpha, beta, consensus, gamma);
}
