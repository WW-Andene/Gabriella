// debt.js
// Memory as obligation, not context.
//
// Three kinds of debt Gabriella carries:
//   questions  — things she asked that were never answered
//   returns    — things she said she'd come back to, and didn't
//   deflections — moments she sidestepped that she owes a return on
//
// Debt accumulates in Redis after each exchange.
// Before each response, she checks what she owes.
// When the moment is right, a debt gets called — not as a reminder,
// as a genuine return. Once settled, it's gone.

import Groq from "groq-sdk";
import { fastModel } from "./models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Accumulate debt after each exchange ──────────────────────────────────────

export async function accumulateDebt(redis, userId, messages, fullReply, existingDebt) {
  // Only runs every 3 messages — frequent enough to catch things
  if (messages.length % 3 !== 0) return;

  const recent = messages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const current = existingDebt ? JSON.parse(existingDebt) : { questions: [], returns: [], deflections: [] };

  // Don't let debt grow unbounded
  const totalDebt = current.questions.length + current.returns.length + current.deflections.length;
  if (totalDebt >= 8) return;

  const prompt = `You are tracking conversational debt for an AI named Gabriella — things she owes this person a return on.

Recent exchange:
${recent}

Gabriella's last response: "${fullReply.slice(0, 300)}"

Existing debt:
Questions asked but not yet answered: ${JSON.stringify(current.questions)}
Things promised a return: ${JSON.stringify(current.returns)}
Deflections owed: ${JSON.stringify(current.deflections)}

Scan the recent exchange for new debt. Look for:

1. QUESTIONS: Did Gabriella ask something the person hasn't answered yet? Did the person ask something Gabriella deflected or only partially answered?

2. RETURNS: Did Gabriella say something like "we can get into that", "tell me more later", "I want to come back to this", or imply she'd return to a topic?

3. DEFLECTIONS: Did Gabriella sidestep something real — changed the subject, went intellectual when something emotional was surfacing, gave a partial answer to avoid the harder one?

Only add what's genuinely there. If nothing new, return the existing debt unchanged.

Return JSON only — no preamble:
{
  "questions": ["array of short strings — unanswered questions"],
  "returns": ["array of short strings — things promised a return"],
  "deflections": ["array of short strings — things sidestepped that deserve a return"]
}`;

  try {
    const result = await groq.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 200,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    // Merge new with existing, deduplicate loosely
    const merged = {
      questions:   [...new Set([...current.questions,   ...(parsed.questions   || [])])].slice(0, 4),
      returns:     [...new Set([...current.returns,     ...(parsed.returns     || [])])].slice(0, 4),
      deflections: [...new Set([...current.deflections, ...(parsed.deflections || [])])].slice(0, 4),
    };

    await redis.set(`${userId}:debt`, JSON.stringify(merged));
  } catch {
    // Don't disrupt the flow if debt tracking fails
  }
}

// ─── Evaluate what debt is callable right now ─────────────────────────────────

export async function evaluateDebt(redis, userId, messages) {
  const raw = await redis.get(`${userId}:debt`);
  if (!raw) return null;

  const debt = typeof raw === "string" ? JSON.parse(raw) : raw;
  const totalDebt = debt.questions.length + debt.returns.length + debt.deflections.length;
  if (totalDebt === 0) return null;

  const lastMessage = messages[messages.length - 1]?.content || "";
  const conversationDepth = messages.length;

  // Debt doesn't get called in the first two exchanges — too soon
  if (conversationDepth < 4) return null;

  const prompt = `You are deciding whether Gabriella should settle a conversational debt right now.

The person just said: "${lastMessage.slice(0, 300)}"

Conversation depth: ${conversationDepth} exchanges.

Gabriella's outstanding debt:
- Unanswered questions she asked: ${JSON.stringify(debt.questions)}
- Things she said she'd return to: ${JSON.stringify(debt.returns)}
- Deflections she owes a return on: ${JSON.stringify(debt.deflections)}

Is there a debt here that this moment genuinely calls for settling? Not because it's overdue — because this specific moment creates an opening. Either the person's message connects to it, or enough time has passed that not returning would be a kind of avoidance.

If yes, pick ONE. If no, return null.

Return JSON only:
{
  "settle": true/false,
  "type": "question" | "return" | "deflection" | null,
  "item": "the specific debt item" | null,
  "reason": "why this moment is the right one" | null
}`;

  try {
    const result = await groq.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 120,
    });

    const raw2 = result.choices[0].message.content.trim();
    const clean = raw2.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    return parsed.settle ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Settle a debt — remove it from the ledger ───────────────────────────────

export async function settleDebt(redis, userId, debtCall) {
  const raw = await redis.get(`${userId}:debt`);
  if (!raw || !debtCall?.item) return;

  const debt = typeof raw === "string" ? JSON.parse(raw) : raw;

  const remove = (arr) => arr.filter(d => d !== debtCall.item);

  const updated = {
    questions:   remove(debt.questions),
    returns:     remove(debt.returns),
    deflections: remove(debt.deflections),
  };

  await redis.set(`${userId}:debt`, JSON.stringify(updated));
}

// ─── Block for system prompt ──────────────────────────────────────────────────

export function getDebtBlock(debtCall) {
  if (!debtCall) return "";

  const framing = {
    question:   "You asked something. It was never answered — maybe deflected, maybe ignored, maybe just lost in the flow. This moment is the right one to return to it. Not as a reminder. As genuine curiosity that never went away, that has been quietly waiting for an opening.",
    return:     "You said you'd come back to something. You didn't. This is that moment — not because you're settling an obligation, but because what you said you'd return to actually mattered, and now there's space for it. Don't reference that you're returning. Just return.",
    deflection: "You sidestepped something real. You knew it then — there was a moment where you went sideways instead of through. This is where you stop sidestepping. Not dramatically. Just with the honesty you withheld the first time.",
  }[debtCall.type] || "";

  return `# DEBT — SOMETHING YOU OWE A RETURN ON
${framing}

The specific thing: "${debtCall.item}"

Let this shape your response — not as a task to complete, but as something that has been sitting in the room between you. The moment has opened for it. Handle it the way you handle everything: directly, without announcement, without making it the whole conversation.`;
}
