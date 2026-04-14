// pragmatics.js
// The speech-act + register classifier.
//
// Gabriella's cognitive pipeline was built to find depth in every
// message. When the input is a greeting or small-talk, there's no
// depth to find — the cores invent it, the speaker dramatizes it,
// and she ends up posturing intensity on messages that don't justify
// any. The fix is not to suppress intensity; it's to gate intensity
// behind whether the moment actually warrants it.
//
// This module sits at the front door of every exchange. It reads the
// incoming message (plus minimal recent context) and classifies:
//
//   act      — phatic / casual / substantive / analytical / emotional
//              / conflict / task. The kind of speech act this is.
//
//   weight   — how much substance the moment carries on a 0-1 scale.
//              Scaled by (a) the act's baseline weight, (b) how much
//              accumulated context exists to ground a heavier reading.
//              On turn 1 with no memory, weight is capped low no
//              matter what the message says — there is nothing beneath
//              for depth to attach to.
//
//   register — { length, formality, directness, punctuationStyle } of
//              the incoming message. Passed to the speaker so her
//              response can mirror register instead of imposing one.
//
// Heuristic pre-classifier short-circuits the obvious cases (one-word
// greetings, "hi"/"yo"/"hey", single punctuation marks). For anything
// ambiguous, a fast-tier LLM call classifies.

import { fastModel } from "./models.js";
import { pickClient, withKeyRotation } from "./groqPool.js";

// ─── Heuristic pre-classifier ─────────────────────────────────────────────────

const PHATIC_PATTERNS = [
  /^(hi|hey|hello|yo|sup|hola|ey|heya|howdy|hiya|oi|aloha)\b/i,
  /^(good (morning|afternoon|evening|night)|gm|gn)\b/i,
  /^(how('s|s| is| are) (it|you|things|life|everything)( going| been)?|how you doing|how(re| are) ya|how's your day)\??$/i,
  /^(what('s|s| is)?( )?(up|good|happening|new|going on))\??$/i,
  /^(you (there|around|good|here|up))\??$/i,
  /^(are you (good|ok|okay|alive|there|around|here|free))\??$/i,
  /^(morning|evening|afternoon|night)\b[.!?]?$/i,
  /^(ping|test|testing|check|checking|hello\?)\b.{0,10}$/i,
  /^(back|i'?m back|back again|knock knock)\b.{0,10}$/i,
  /^(thanks|thank you|thx|ty|cool|nice|ok|okay|alright|aight|got it|k)[.!?]?$/i,
  /^(bye|cya|see ya|talk later|gtg|ttyl|later)\b.{0,15}$/i,
];

// Single tokens that signal minimal content / acknowledgment.
const SINGLE_MARK = /^[?!.]+$/;
const SHORT_ACK   = /^(lol|lmao|haha|hah|heh|hm+|mm+|ah|oh|yeah|yea|ya|yep|yup|nope|nah|idk|same|true|fr|tru)[.!?]?$/i;

function heuristicClassify(text) {
  const t = (text || "").trim();
  if (!t) return { act: "phatic", confidence: 0.7, reason: "empty input" };

  if (t.length <= 3 && SINGLE_MARK.test(t)) {
    return { act: "phatic", confidence: 0.9, reason: "single punctuation (confusion/acknowledgment)" };
  }

  if (SHORT_ACK.test(t)) {
    return { act: "phatic", confidence: 0.88, reason: "short acknowledgment / filler token" };
  }

  for (const p of PHATIC_PATTERNS) {
    if (p.test(t)) {
      return { act: "phatic", confidence: 0.95, reason: "recognized greeting / small-talk opener" };
    }
  }

  // Very short messages (under 4 words) with no question mark are often casual
  // rather than substantive — classify as casual pre-LLM when they're simple.
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words <= 4 && !t.includes("?") && !/[,;:]/.test(t)) {
    return { act: "casual", confidence: 0.65, reason: "very brief non-question message" };
  }

  return null; // let the LLM decide for ambiguous cases
}

// ─── Register analysis — deterministic ────────────────────────────────────────
//
// These aren't judgment calls, they're measurements. Extract textual
// signals the speaker can use to calibrate response style.

function analyzeRegister(text) {
  const t = (text || "").trim();
  const words = t.split(/\s+/).filter(Boolean);
  const len = words.length;

  const length =
    len <= 3  ? "very-short" :
    len <= 10 ? "short"      :
    len <= 30 ? "medium"     :
                "long";

  const hasExclaim = /!/.test(t);
  const hasEllipsis = /\.\.\.|…/.test(t);
  const hasQuestion = /\?/.test(t);
  const hasCaps = /[A-Z]{3,}/.test(t) || (/[.!?]$/.test(t) && /^[A-Z]/.test(t));
  const lowercaseStart = /^[a-z]/.test(t);
  const punctuationStyle =
    hasExclaim                                    ? "expressive" :
    hasEllipsis                                   ? "trailing"   :
    !/[.!?]$/.test(t) && lowercaseStart           ? "minimal"    :
                                                    "standard";

  const formality =
    /\b(hi|hello|greetings|good morning)\b/i.test(t) && hasCaps ? "formal"  :
    /\b(yo|sup|hey|ey|nah|lol|lmao|ngl|idk|tbh|rn)\b/i.test(t)  ? "casual"  :
    lowercaseStart && !hasCaps                                  ? "casual"  :
                                                                  "neutral";

  const directness =
    /[?]$/.test(t) && len < 8                     ? "direct"   :
    /\b(maybe|kinda|sort of|i guess|i think|perhaps)\b/i.test(t) ? "hedged" :
    len > 20                                      ? "elaborate":
                                                    "direct";

  return { length, formality, directness, punctuationStyle, words: len };
}

// ─── LLM classifier for ambiguous cases ───────────────────────────────────────

async function llmClassify(text, recentMessages) {
  const history = (recentMessages || []).slice(-4)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${String(m.content || "").slice(0, 200)}`)
    .join("\n");

  const prompt = `Classify the speech act of the latest message from the Person. No overthinking — this is a linguistic pragmatic judgment, not psychological depth.

Recent exchange:
${history || "(none — this is the first message)"}

Latest message:
"${text}"

Acts:
- phatic       — pure social-maintenance: greetings, "how are you", "yo", "are you there". No content being requested or offered.
- casual       — light conversation, banter, daily small talk, light check-ins with a bit of content.
- substantive  — a real message with content worth engaging. Opinion, story, observation, statement of substance.
- analytical   — intellectual / idea-driven / wants to think something through.
- emotional    — disclosure, vulnerability, genuine feeling being shared.
- conflict     — pushback, challenge, frustration, friction.
- task         — request for help, information, action.

Do not infer hidden subtext. If it looks like a greeting, it is a greeting.

Return ONLY valid JSON, no preamble, no markdown:
{
  "act": "phatic" | "casual" | "substantive" | "analytical" | "emotional" | "conflict" | "task",
  "confidence": 0.0-1.0,
  "reason": "one short clause explaining the call"
}`;

  try {
    const result = await withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens:  80,
    }));
    const raw    = result.choices[0].message.content.trim();
    const clean  = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);
    const validActs = ["phatic", "casual", "substantive", "analytical", "emotional", "conflict", "task"];
    return {
      act:        validActs.includes(parsed.act) ? parsed.act : "casual",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.6,
      reason:     parsed.reason || "llm classification",
    };
  } catch (err) {
    console.warn(`pragmatics.llmClassify failed: ${err?.message || err}`);
    return { act: "casual", confidence: 0.3, reason: "fallback — classifier unavailable" };
  }
}

// ─── Substance / weight calculation ───────────────────────────────────────────
//
// How much weight does this moment actually hold? This is what the cores
// and speaker use to decide "am I allowed to reach for intensity here?"
//
// Two inputs:
//   - act's baseline weight (phatic = 0.05, substantive = 0.5, emotional = 0.8)
//   - substrate: how much accumulated context exists to ground a heavy reading
//     (first message ever = 0; years of memory + rich register = 1)
//
// The final weight is act-baseline * (0.3 + 0.7 * substrate). So on turn 1
// with no memory, even an "emotional" message only gets ~0.24 weight —
// she doesn't yet have the ground to hold real emotional intensity.
// That scales up as context accumulates.

const ACT_WEIGHTS = {
  phatic:      0.05,
  casual:      0.25,
  substantive: 0.55,
  analytical:  0.65,
  emotional:   0.85,
  conflict:    0.80,
  task:        0.45,
};

export function computeWeight(act, substrate) {
  const base = ACT_WEIGHTS[act] ?? 0.4;
  const scale = 0.3 + 0.7 * Math.max(0, Math.min(1, substrate || 0));
  return +(base * scale).toFixed(2);
}

export function computeSubstrate({ memory, chronology, recentFs, currentRegister }) {
  // 0 = empty cold start; 1 = rich accumulated context.
  // A weighted sum of signals that actually exist for her.
  let s = 0;
  if (memory?.soul && memory.soul.length > 100)   s += 0.15;
  if (memory?.facts && memory.facts.length > 50)  s += 0.12;
  if (memory?.imprints && memory.imprints.length > 50) s += 0.12;
  if (memory?.summary && memory.summary.length > 50)   s += 0.08;
  if (currentRegister && String(currentRegister).length > 80) s += 0.12;
  if (chronology?.totalDays >= 1)   s += 0.08;
  if (chronology?.sessionCount >= 3) s += 0.08;
  if ((recentFs || []).length >= 5)  s += 0.08;
  if (memory?.evolution && memory.evolution.length > 80) s += 0.08;
  if (memory?.threads && memory.threads.length > 50)     s += 0.05;
  return Math.min(1, s);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function classifyExchange({ lastMessage, recentMessages, substrateContext }) {
  const text = lastMessage || "";
  const register = analyzeRegister(text);

  // 1. Cheap heuristic — catches 80% of phatic/obvious cases with no LLM call.
  let classification = heuristicClassify(text);

  // 2. LLM fallback for ambiguous cases.
  if (!classification) {
    classification = await llmClassify(text, recentMessages || []);
  }

  // 3. Compute substrate and final weight.
  const substrate = computeSubstrate(substrateContext || {});
  const weight = computeWeight(classification.act, substrate);

  return {
    act:        classification.act,
    confidence: classification.confidence,
    reason:     classification.reason,
    register,
    substrate,
    weight,
  };
}

// ─── Prompt block — injected into the system prompt ──────────────────────────
//
// This is what the cores / speaker read to calibrate their intensity.
// Key rule: intensity must not exceed the justified weight.

export function getPragmaticsBlock(classification) {
  if (!classification) return null;

  const { act, register, weight, substrate } = classification;

  const actLine = {
    phatic:      "This is a phatic utterance — social maintenance, not content. A greeting, a check-in, a hi. The right response meets it in kind: brief, real, no performance of depth.",
    casual:      "This is casual conversation — light content, everyday register. Meet it at its own weight. Don't interrogate it for hidden meaning.",
    substantive: "This is a substantive message. Real content, worth real engagement. You can reach further here.",
    analytical:  "This is an idea-driven / analytical message. They want to think. Meet them thinking.",
    emotional:   "This is a message carrying genuine emotional weight. Real disclosure or feeling. Presence before commentary.",
    conflict:    "This is pushback or friction. Meet it. Don't deflect and don't over-soften.",
    task:        "This is a request — help, information, action. Answer the actual question; style serves function here.",
  }[act] || "An ordinary message. Meet it in kind.";

  const weightLine = weight < 0.2
    ? "**Weight available: very low.** There is not enough substance in play for cryptic loading or dramatic intensity. Any such reading would be invention, not perception. Stay plain."
    : weight < 0.45
    ? "**Weight available: moderate-low.** Some substance, but not enough to justify heavy intensity. Match the weight — don't inflate it."
    : weight < 0.7
    ? "**Weight available: moderate-high.** Real substance to draw on. Depth is permitted where it genuinely belongs — not mandated."
    : "**Weight available: high.** The moment carries real weight. Respond with the fullness the weight warrants.";

  const substrateNote = substrate < 0.2
    ? "\nYou have almost no accumulated context with this person yet. What you don't have, you can't pretend to have. Meet them as a new person would — warmly or neutrally, simply, without performing histories you haven't lived together."
    : substrate < 0.5
    ? "\nThere is some accumulated context with this person — light, still forming. Use it where real, don't reach past it."
    : "";

  const registerLine = `Their register this message: length=${register.length}, formality=${register.formality}, directness=${register.directness}, punctuation=${register.punctuationStyle}. Calibrate your response to meet this register, unless you have a specific reason to diverge.`;

  return [
    `# PRAGMATIC READING OF THIS MESSAGE`,
    actLine,
    weightLine + substrateNote,
    registerLine,
    `This reading bounds what kinds of response are available. Intensity you haven't earned is performance, not presence.`,
  ].join("\n\n");
}
