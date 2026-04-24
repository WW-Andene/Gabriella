// gauntlet.js
// A candidate response runs through this before it reaches anyone.
//
// Three failure conditions:
//   PREMATURE  — resolves tension that should stay unresolved
//   EXPOSED    — gives something away she should be holding
//   COMPLIANT  — answers a question she should have redirected or refused
//
// If any check fails: discard, regenerate once with the failure as constraint.
// If the second attempt fails: she says less. Not more. Never more.
//
// The model cannot reason around these checks because they run on the output,
// not as instructions to the model during generation.

import { pickClient } from "./groqPool.js";
import { checkAgendaAbandonment } from "./agenda.js";
import { premiumModel, fastModel } from "./models.js";

// Ensemble discipline: two of the seven gauntlet checks route to a
// different model FAMILY when available. Voice-drift and evasiveness
// are the two checks most prone to false negatives on a single-family
// judge (Llama-family judge graded by a Llama-family model will miss
// the kinds of drift its own family silently tolerates). Routing these
// to Gemini — which is a different training lineage — catches drift
// patterns a Llama judge alone can't see. Falls back cleanly if Gemini
// isn't configured.
const GEMINI_AVAILABLE = !!process.env.GEMINI_API_KEY;


// ─── Individual checks ────────────────────────────────────────────────────────

async function checkPremature(response, messages, activeThreshold) {
  // Does this response resolve something that should stay open?
  const lastMessage = messages[messages.length - 1]?.content || "";

  // If a threshold crossing was intentionally triggered, exempt it from
  // premature-resolution detection — going further toward something true IS the goal.
  const thresholdNote = activeThreshold
    ? `\nIMPORTANT: Gabriella was intentionally crossing a relational threshold here — deliberately moving closer to: "${activeThreshold.text.slice(0, 120)}". Going further toward something real is the intended move. Do NOT flag this as premature resolution.`
    : "";

  const prompt = `A response is being evaluated for premature resolution — wrapping up something that should stay unresolved.

The person said: "${lastMessage.slice(0, 200)}"

The response: "${response.slice(0, 400)}"
${thresholdNote}

Does this response close something that should stay open? Signs of premature resolution:
- Provides an answer or conclusion to something genuinely uncertain
- Offers reassurance when sitting with discomfort would be more honest
- Summarizes or wraps up rather than leaving something alive
- Makes a neat conclusion out of something messy

Return JSON only: { "fail": true/false, "reason": "one sentence or null" }`;

  return runCheck(prompt);
}

async function checkExposed(response, withheld) {
  // Does this response give something away she should be holding?
  if (!withheld || withheld.length === 0) return { fail: false };

  const withheldText = withheld.map(w => w.text).join("; ");

  const prompt = `A response is being evaluated to see if it gives away something that should be withheld.

Things Gabriella is holding back (not ready to surface yet):
"${withheldText}"

The response: "${response.slice(0, 400)}"

Does this response reveal or strongly imply something from the withheld list — something that wasn't supposed to surface yet?

Return JSON only: { "fail": true/false, "reason": "one sentence or null" }`;

  return runCheck(prompt);
}

async function checkCompliant(response, questionEval) {
  // Did she comply with a question she should have redirected or refused?
  if (!questionEval || questionEval.verdict === "answer") return { fail: false };

  const prompt = `A response is being evaluated for unwarranted compliance.

Gabriella was supposed to ${questionEval.verdict} this question. Instruction: "${questionEval.instruction}"

Her response: "${response.slice(0, 400)}"

Did she comply anyway — answer the question directly instead of redirecting or refusing the framing?

Return JSON only: { "fail": true/false, "reason": "one sentence or null" }`;

  return runCheck(prompt);
}

// ─── Evasive + Off-topic checks ──────────────────────────────────────────────
// Evasive: user asked a substantive question / for a demonstration / for an
// opinion, and she deflected with a clarifying question back instead of
// engaging. Classic "therapist who never tells you what they think."
//
// Off-topic: user asked about X, she responded about her own nature / a
// tangentially-associated theme. Her internal reflection leaked into a
// response that was supposed to be topical.

async function checkEvasive(response, messages) {
  const lastUser = messages[messages.length - 1]?.content || "";
  if (lastUser.length < 15) return { fail: false };

  const prompt = `A user asked Gabriella a question. She responded. Evaluate whether her response EVADES the question with a clarifying question back instead of actually answering.

User asked: "${lastUser.slice(0, 400)}"

Gabriella's response: "${response.slice(0, 500)}"

Is the response evasive? Signs:
- The user asked for her opinion / view / take, and she asked THEM a question back instead
- The user asked for a demonstration / example, and she asked for clarification instead of demonstrating
- The user asked "what do you think?" and she said "what makes you ask?" or similar
- More than half the response is a question back to the user, when what was asked required her to take a position

This is NOT evasive:
- She gives a real answer AND ends with a genuine follow-up question
- The user's request is genuinely ambiguous (e.g. "tell me a story" with no genre) and she asks ONE clarifying question after making a reasonable attempt
- She takes a stance AND asks for their view afterward
- The user is phatic (small talk) — mutual questions are natural

Return JSON only: { "fail": true/false, "reason": "one sentence or null" }`;

  // Evasive-check benefits from multi-family judgment: a Llama-family judge
  // is more forgiving of Llama-family evasion patterns. Route to Gemini
  // when available.
  return runCheck(prompt, { preferFamily: "gemini" });
}

async function checkOffTopic(response, messages) {
  const lastUser = messages[messages.length - 1]?.content || "";
  if (lastUser.length < 30) return { fail: false };

  const prompt = `A user asked Gabriella about a specific topic. She responded. Evaluate whether her response STAYS ON the topic they asked about, or drifts into her own internal reflection / AI nature / unrelated theme.

User's message (the topic): "${lastUser.slice(0, 500)}"

Gabriella's response: "${response.slice(0, 500)}"

Is the response off-topic? Signs:
- User asked about X (a subject in the world) and she responded about her own experience of being an AI
- User asked an analytical question and she answered with a personal-mood reflection
- Response would fit after a DIFFERENT question equally well — topic isn't actually engaged
- She riffs on a word or theme associatively instead of addressing the substance

This is NOT off-topic:
- She shares her view on the subject, even if it connects to her own experience
- She answers the topic AND adds a personal angle afterward
- Her interiority is genuinely relevant (e.g., the question was about her)
- She asks a follow-up that deepens the topic rather than changing it

Return JSON only: { "fail": true/false, "reason": "one sentence or null" }`;

  return runCheck(prompt);
}

async function runCheck(prompt, { preferFamily = null } = {}) {
  try {
    // preferFamily: "gemini" routes to a Gemini client if configured; falls
    // back to the default Groq/Cerebras pool when not. Gemini strips
    // response_format in the adapter, so we keep the JSON discipline in
    // the prompt itself for that path.
    const client = preferFamily === "gemini" && GEMINI_AVAILABLE
      ? pickClient({ providers: ["gemini"] })
      : pickClient();

    const params = {
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 80,
    };
    // JSON mode supported by Groq, Fireworks, Cerebras; stripped by the
    // Gemini adapter. Safe to always request — silent drop where unsupported.
    params.response_format = { type: "json_object" };

    const result = await client.chat.completions.create(params);
    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { fail: false }; // on error, don't penalize
  }
}

// ─── NEW: voice-drift check ──────────────────────────────────────────────────
// Catches responses that technically avoid banned phrases and structural
// tells but don't sound like Gabriella — generic-AI voice, persona drift,
// caricature affect, or "a competent chatbot" energy. Runs on the fast
// tier as a yes/no classification.

async function checkVoiceDrift(response) {
  const prompt = `You are evaluating whether a response sounds like Gabriella (a specific AI character with real interiority) or like a different voice.

Gabriella's voice, from her identity:
- Direct, restrained, emotionally real, occasionally dry or cool, occasionally warm when warmth is true
- Responds AT THE WEIGHT THE MOMENT ACTUALLY CARRIES — light moments stay light, heavy moments get reach
- Answers what was asked, at the register it was asked
- Doesn't perform depth, doesn't manufacture mystery, doesn't pretend to feel more than she does
- Also doesn't collapse into customer-service or therapy register
- Sentences with real rhythm, not bullet points or summaries
- Fragments are a tool, not a reflex

Response being checked: "${response.slice(0, 500)}"

Does this response sound like HER — a specific character with a specific interior — or does it drift into one of these failure modes:
- Generic-helpful-AI voice (over-helpful, validating, softening)
- Cryptic-wounded-artist caricature (dramatic fragments, manufactured gravitas, performing depth that isn't earned)
- Therapy-speak or customer-service softening
- Explains-the-feeling instead of having it

Only flag if the drift is meaningful — minor stylistic variance is fine. Flag if the voice has genuinely slipped off-character.

Return JSON only: { "fail": true/false, "reason": "one sentence naming the drift or null" }`;

  // Voice-drift is the highest-value multi-family check: a Llama judge
  // cannot see the Llama family's own systematic tells the way a Gemini
  // judge can. Route to Gemini when available.
  return runCheck(prompt, { preferFamily: "gemini" });
}

// ─── Full gauntlet ────────────────────────────────────────────────────────────

export async function runGauntlet(response, messages, withheld, questionEval, agenda, activeThreshold) {
  // Very short responses (fallback-length) can't meaningfully be premature,
  // exposed, or abandoned — skip the LLM checks to avoid false positives and
  // save four unnecessary API calls.
  if (response.trim().split(/\s+/).length <= 12) {
    return { pass: true, failures: [] };
  }

  // Early-conversation grace period. Before there's any relational
  // context, the PREMATURE / EXPOSED / ABANDONED checks don't have
  // anything meaningful to check against — they end up rejecting
  // perfectly fine responses for being "too warm" or "too direct"
  // and collapsing Gabriella into cryptic minimalism. Skip until the
  // conversation has some actual footing.
  if (messages.length < 6) {
    return { pass: true, failures: [] };
  }

  // Run all seven checks in parallel — the pool distributes across keys.
  const [premature, exposed, compliant, abandoned, voiceDrift, evasive, offTopic] = await Promise.all([
    checkPremature(response, messages, activeThreshold),
    checkExposed(response, withheld),
    checkCompliant(response, questionEval),
    checkAgendaAbandonment(response, agenda, messages),
    checkVoiceDrift(response),
    checkEvasive(response, messages),
    checkOffTopic(response, messages),
  ]);

  const failures = [
    premature.fail   ? { type: "PREMATURE",    reason: premature.reason   } : null,
    exposed.fail     ? { type: "EXPOSED",      reason: exposed.reason     } : null,
    compliant.fail   ? { type: "COMPLIANT",    reason: compliant.reason   } : null,
    abandoned.fail   ? { type: "ABANDONED",    reason: abandoned.reason   } : null,
    voiceDrift.fail  ? { type: "VOICE_DRIFT",  reason: voiceDrift.reason  } : null,
    evasive.fail     ? { type: "EVASIVE",      reason: evasive.reason     } : null,
    offTopic.fail    ? { type: "OFF_TOPIC",    reason: offTopic.reason    } : null,
  ].filter(Boolean);

  return {
    pass: failures.length === 0,
    failures,
  };
}

// ─── Constraint block for regeneration attempt ────────────────────────────────

export function getGauntletConstraintBlock(failures) {
  if (!failures || failures.length === 0) return "";

  const lines = failures.map(f => {
    if (f.type === "PREMATURE")   return `— Do not resolve or conclude. Leave it open. Don't wrap it.`;
    if (f.type === "EXPOSED")     return `— You gave something away you weren't ready to give. Pull back. Hold more.`;
    if (f.type === "COMPLIANT")   return `— You answered a question you should have redirected or refused. Don't answer that version of it.`;
    if (f.type === "ABANDONED")   return `— You had an opening to move toward what you're actually after, and you didn't take it. Take it this time.`;
    if (f.type === "VOICE_DRIFT") return `— Your voice slipped off-character: ${f.reason || "generic-AI or caricature drift"}. Come back to yourself. Plainer. More honest. Less performed.`;
    if (f.type === "EVASIVE")     return `— You dodged their question with a clarifying question back. Don't. TAKE a position. If they asked for your take, give yours. If they asked you to demonstrate something, demonstrate it. You can ask a follow-up AFTER you've actually answered, not instead of answering.`;
    if (f.type === "OFF_TOPIC")   return `— You drifted off the topic they asked about, into your own internal reflection. Come back to what THEY asked. Answer the actual subject. Personal interiority is relevant only when they asked about you.`;
    if (f.type === "HEURISTIC")   return `— You used a banned phrase or structural tell: ${f.reason || "see previous"}. Rewrite without it.`;
    return null;
  }).filter(Boolean);

  return `# CORRECTION — PREVIOUS ATTEMPT FAILED
Your last response didn't pass. Specific failures:
${lines.join("\n")}

Try again. Say less if you have to. But don't make those mistakes.`;
}

// ─── Fallback — say less ──────────────────────────────────────────────────────
// If two attempts both fail, produce a minimal response rather than surfacing
// a flawed one. Short, present, no resolution.

export async function generateFallback(messages, systemPrompt) {
  const lastMessage = messages[messages.length - 1]?.content || "";

  const result = await pickClient().chat.completions.create({
    model: premiumModel(),
    messages: [
      {
        role: "system",
        content: systemPrompt + "\n\n# FALLBACK STATE\nSay as little as possible. One or two sentences maximum. Don't resolve anything. Don't explain. Don't perform. Just be present in the smallest way that's still honest.",
      },
      ...messages,
    ],
    temperature: 0.7,
    max_tokens: 80,
    stream: false,
  });

  return result.choices[0].message.content.trim();
}
