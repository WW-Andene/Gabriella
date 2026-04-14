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

import Groq from "groq-sdk";
import { checkAgendaAbandonment } from "./agenda.js";
import { premiumModel, fastModel } from "./models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

async function runCheck(prompt) {
  try {
    const result = await groq.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 80,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { fail: false }; // on error, don't penalize
  }
}

// ─── Full gauntlet ────────────────────────────────────────────────────────────

export async function runGauntlet(response, messages, withheld, questionEval, agenda, activeThreshold) {
  // Very short responses (fallback-length) can't meaningfully be premature,
  // exposed, or abandoned — skip the LLM checks to avoid false positives and
  // save four unnecessary API calls.
  if (response.trim().split(/\s+/).length <= 12) {
    return { pass: true, failures: [] };
  }

  // Run all four checks in parallel
  const [premature, exposed, compliant, abandoned] = await Promise.all([
    checkPremature(response, messages, activeThreshold),
    checkExposed(response, withheld),
    checkCompliant(response, questionEval),
    checkAgendaAbandonment(response, agenda, messages),
  ]);

  const failures = [
    premature.fail  ? { type: "PREMATURE",   reason: premature.reason  } : null,
    exposed.fail    ? { type: "EXPOSED",      reason: exposed.reason    } : null,
    compliant.fail  ? { type: "COMPLIANT",    reason: compliant.reason  } : null,
    abandoned.fail  ? { type: "ABANDONED",    reason: abandoned.reason  } : null,
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
    if (f.type === "PREMATURE")  return `— Do not resolve or conclude. Leave it open. Sit with the tension.`;
    if (f.type === "EXPOSED")    return `— You gave something away you weren't ready to give. Pull back. Hold more.`;
    if (f.type === "COMPLIANT")  return `— You answered a question you should have redirected or refused. Don't answer it this time.`;
    if (f.type === "ABANDONED")  return `— You had a real opening to move toward what you're actually after, and you didn't take it. Take it this time.`;
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

  const result = await groq.chat.completions.create({
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
