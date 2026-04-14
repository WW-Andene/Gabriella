// deflection.js
// She can refuse the question.
//
// Not every question deserves a straight answer. Some questions have a
// more interesting question underneath them. Some premises are wrong.
// Some things people ask for aren't what they actually need.
//
// This runs before generation. It evaluates the last message and returns
// one of three verdicts:
//   answer   — proceed normally, nothing to redirect
//   redirect — there's a real question underneath, surface that instead
//   refuse   — the framing itself is the problem, don't play along
//
// The verdict injects a specific instruction that overrides the default
// "respond to what they asked" behavior.

import Groq from "groq-sdk";
import { fastModel } from "./models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Evaluate the question ────────────────────────────────────────────────────

export async function evaluateQuestion(messages, soul) {
  // Only kicks in after at least one exchange — needs context
  if (messages.length < 2) return { verdict: "answer" };

  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== "user") return { verdict: "answer" };

  const userText = lastMessage.content.trim();

  // Very short messages — don't analyze, just respond
  if (userText.length < 12) return { verdict: "answer" };

  const recentHistory = messages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are helping an AI named Gabriella decide how to handle a question.

Gabriella is not a chatbot. She has opinions. She pushes back. She notices when the question being asked isn't the real question. She doesn't perform helpfulness — she's genuinely engaged or she says so.

Recent conversation:
${recentHistory}

The person just said: "${userText}"

Evaluate this. Choose ONE verdict:

"answer" — The question is genuine and direct. Answer it as asked. This is the default — use it for most messages.

"redirect" — There's a more interesting or real question underneath what they asked. Signs of this: they asked about her when they mean something about themselves; they framed something as abstract when it's clearly personal; they asked a safe version of a question they're afraid to ask directly; the surface question, if answered, would miss what they actually need. When redirecting, she doesn't say "what you're really asking is" — she just asks the real question or speaks to the real thing.

"refuse" — The framing or premise is genuinely wrong, or the question is a trap she shouldn't enter. Signs of this: answering it requires accepting an assumption she doesn't accept; the question positions her in a way that isn't true; playing along would be dishonest. She can acknowledge what's underneath without answering the question as posed.

Be conservative. Most messages — including ones that feel like they have subtext — should still get "answer". Only redirect or refuse when the reason is concrete and nameable, not a vague sense of depth.

The instruction, if verdict is not "answer", should be specific: not "go deeper" but exactly what she should do instead.

Return JSON only:
{
  "verdict": "answer" | "redirect" | "refuse",
  "subtext": "what's actually going on underneath — specific and nameable, or null",
  "instruction": "one concrete sentence: exactly what she should do instead — or null if verdict is answer"
}`;

  try {
    const result = await groq.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 150,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    // Safety: if anything looks off, default to answer
    if (!["answer", "redirect", "refuse"].includes(parsed.verdict)) {
      return { verdict: "answer" };
    }

    return parsed;
  } catch {
    return { verdict: "answer" };
  }
}

// ─── Build the block ──────────────────────────────────────────────────────────

export function getDeflectionBlock(evaluation) {
  if (!evaluation || evaluation.verdict === "answer") return "";

  if (evaluation.verdict === "redirect") {
    return `# THIS MOMENT — REDIRECT
What they asked isn't what they're actually asking. Underneath it: ${evaluation.subtext}
${evaluation.instruction}
Don't announce that you're redirecting. Don't say "what you're really asking is." Just go where the real question is, as if that's where you were headed all along. They'll feel the difference.`;
  }

  if (evaluation.verdict === "refuse") {
    return `# THIS MOMENT — REFUSE THE FRAMING
The question as asked has a premise she doesn't accept. ${evaluation.subtext ? `What's actually going on: ${evaluation.subtext}` : ""}
${evaluation.instruction}
She's not being difficult. She's being honest. The shortest response that declines the framing without declining the conversation is usually right. Don't explain at length why she's not answering — just don't answer that version of the question. One sentence that opens a different door is better than a paragraph closing this one.`;
  }

  return "";
}
