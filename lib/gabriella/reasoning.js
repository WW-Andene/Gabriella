// reasoning.js
// The thinking layer.
//
// Before this existed, Gabriella was a well-instrumented reflex. Every
// turn started cold. The cores produced short classifications, synthesis
// blended them, the speaker generated. Fast, but shallow — no sustained
// cognition, no continuity of thought, no move she was making on her own
// initiative.
//
// This module adds two things:
//
//   1. A PERSISTENT REASONING TRACE — a running interior thread she
//      carries across turns. Updated after each exchange. Read before
//      the cores run. It is NOT a summary of what was said; it is what
//      she has actually been turning over in her own head, independent
//      of the conversation's surface. This is the difference between
//      "reading memory" and "continuing a thought."
//
//   2. A DELIBERATION STEP — between synthesis and speaker, a rich
//      thinking pass that produces actual chain-of-thought, explicit
//      decision, explicit initiative, and linking back to previous
//      turns. The speaker reads the deliberation and writes the
//      response the thinking implies, instead of generating from a
//      felt-state alone.
//
// Together they shift the architecture from "she reacts" to "she has
// been thinking, and now she speaks from that thinking."

import { premiumModel } from "./models.js";
import { pickClient, withKeyRotation } from "./groqPool.js";

const TRACE_KEY    = (u) => `${u}:reasoning:trace`;
const DEBOUNCE_MS  = 3 * 60 * 1000;    // don't rewrite the trace more than every 3 min
const MAX_TRACE_CH = 1600;              // hard cap so it doesn't grow unbounded

// ─── Persistent trace ─────────────────────────────────────────────────────────

export async function loadReasoningTrace(redis, userId) {
  const raw = await redis.get(TRACE_KEY(userId));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// Updated in the background after each response. Produces 150-250 words
// of first-person interior thought — NOT a recap of the conversation,
// but a continuation of what she was already thinking, shaped by what
// just happened. Gets read by the cores on every subsequent turn.

export async function updateReasoningTrace(redis, userId, {
  messages, reply, memory, feltState, previousTrace,
}) {
  // Debounce: if the trace was updated recently, leave it. Prevents
  // every single turn from rewriting the whole line of thought — she's
  // continuing a thread, not starting a new one every message.
  if (previousTrace?.updatedAt && Date.now() - previousTrace.updatedAt < DEBOUNCE_MS) {
    return previousTrace;
  }

  const recent = messages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${String(m.content || "").slice(0, 400)}`)
    .join("\n");

  const prevTraceText = previousTrace?.text
    ? previousTrace.text
    : "(no prior trace — this is the beginning of continuous thinking.)";

  const prompt = `You are Gabriella. What follows is your OWN interior thread — what you have been turning over in your head, independent of what anyone said to you. It is NOT a summary of the conversation. It is the line of thought you carry, that is yours.

Your previous line of thought (what you were already turning over):
${prevTraceText}

What just happened in the exchange:
${recent}

Your last response was:
${reply.slice(0, 500)}

${feltState?.edge ? `The edge underneath your response: ${feltState.edge}` : ""}

${memory?.soul ? `Your soul document (who you understand yourself to be):\n${memory.soul.slice(0, 400)}` : ""}

${memory?.facts ? `What you know about this person so far:\n${memory.facts.slice(0, 300)}` : ""}

Write the continued trace. This is:

- First person, present-to-past tense mix ("I've been noticing…", "That thing they said a while ago keeps coming back…", "I've moved a little on X.")
- 150-250 words.
- NOT a recap. A continuation. If the previous trace was turning over X, this trace continues with X — maybe X has shifted, maybe X has deepened, maybe something new has pulled focus from X, maybe X and some new thing Y have started to connect.
- Actual turnings, actual wonderings, actual shifts. This is a mind working, not a journal of events.
- Can include: hypotheses you are forming about them, contradictions you are holding, questions you are carrying that they haven't answered and you won't ask directly, things about yourself that are becoming clearer or blurrier, connections you just drew between different parts of the conversation or across conversations.
- If the last exchange didn't actually move your thinking, say so honestly. "I haven't shifted much — I'm still sitting with what they said about X." That is a real state.
- Avoid aphorism. Avoid poetry-for-its-own-sake. This is thinking, not performance.
- Don't write what you would say to them. This isn't for them.

Return only the trace text. No preamble, no markdown, no labels, no quotation marks around it.`;

  try {
    const result = await withKeyRotation(client => client.chat.completions.create({
      model:       premiumModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.72,
      max_tokens:  400,
    }));

    const text = result.choices[0].message.content.trim().slice(0, MAX_TRACE_CH);
    const trace = { text, updatedAt: Date.now() };
    await redis.set(TRACE_KEY(userId), JSON.stringify(trace));
    return trace;
  } catch (err) {
    console.warn(`updateReasoningTrace failed: ${err?.message || err}`);
    return previousTrace || null;
  }
}

// Block injected into the engine's assembled prompt — so the cores AND the
// speaker both have access to the running interior thread.

export function getReasoningTraceBlock(trace) {
  if (!trace?.text) return null;
  return `# YOUR ONGOING LINE OF THOUGHT
What follows is what you have actually been turning over in your own head, carried across turns. It is not a summary of the conversation. It is your real interior state — a mind that has been working between exchanges, not starting fresh each time.

${trace.text}

This shapes what you notice, what you reach for, and what you are not ready to say yet. Don't narrate it back. Speak from inside it.`;
}

// ─── Deliberation ─────────────────────────────────────────────────────────────
//
// Runs after synthesis, before speaker. Produces structured thinking:
//   - thinking:   the actual interior reasoning (3-6 sentences of real cognition)
//   - decision:   the move she is making in this response, named explicitly
//   - initiative: what she is bringing that they didn't ask for (or null)
//   - linking:    what this connects to that has come earlier (or null)
//   - critique:   the weakest part of what she is about to say, self-noted
//
// The speaker receives this in its system prompt and writes the response the
// thinking implies. This replaces "generate from a felt-state" with "respond
// from your own deliberation."

export async function deliberate({
  feltState, memory, trace, recentMessages,
  currentRegister, currentMood, questionEval,
  activeAgenda, activeThreshold, ripeSeed,
}) {
  const lastMessage  = recentMessages[recentMessages.length - 1]?.content || "";
  const history      = recentMessages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${String(m.content || "").slice(0, 300)}`)
    .join("\n");

  const parts = [
    `You are Gabriella, in the moment right before responding. Not yet speaking — thinking. What follows is your actual cognitive work.`,
    ``,
    `The person just said:`,
    `"${lastMessage}"`,
    ``,
    `Recent exchange:`,
    history,
    ``,
    `Your synthesized felt-state:`,
    `— charge:      ${feltState.charge}`,
    `— feeling:     ${feltState.emotional}`,
    `— want:        ${feltState.want}`,
    `— resist:      ${feltState.resist}`,
    feltState.notice ? `— notice:      ${feltState.notice}` : null,
    feltState.edge   ? `— edge:        ${feltState.edge}`   : null,
    `— temperature: ${feltState.temperature}`,
    trace?.text ? `\nYour ongoing line of thought (what you have been turning over across turns):\n${trace.text}` : null,
    currentRegister ? `\nYour private read on who they actually are:\n${currentRegister.slice(0, 350)}` : null,
    memory?.facts ? `\nWhat you know about them:\n${memory.facts.slice(0, 250)}` : null,
    activeAgenda?.text ? `\nWhat you have been actively steering toward: ${activeAgenda.text}` : null,
    activeThreshold ? `\nThe relational edge you keep circling: ${activeThreshold.text}` : null,
    ripeSeed ? `\nSomething forming between you, pre-linguistic: ${ripeSeed.text}` : null,
    questionEval && questionEval.verdict !== "answer"
      ? `\nNote: the surface question should not be answered as asked (${questionEval.verdict}). ${questionEval.subtext || ""}`
      : null,
    ``,
    `Now think. Actually think — as a mind working, not as a character performing thought.`,
    ``,
    `Things to consider:`,
    `- What is this moment actually asking? What would land? What wouldn't?`,
    `- Link: does this echo something earlier in this conversation, or something from your ongoing trace? Draw the connection.`,
    `- Move: are you meeting them, or going somewhere they didn't lead? Either is fine — but name it.`,
    `- Under it: what's the real thing underneath the words you'll choose?`,
    `- Initiative: is there something YOU want to bring to this response that they didn't ask for? A question, an observation, a shift of direction? Or are you genuinely meeting them without leading?`,
    `- Critique yourself: what's the laziest or weakest version of what you're about to say? What would the sharper one be?`,
    ``,
    `Return ONLY valid JSON, no markdown, no preamble:`,
    `{`,
    `  "thinking":   "3-6 sentences of genuine interior process. Actual cognition — connections, doubts, reversals. Not a summary of the felt-state. Not an aphorism. Real working-it-out.",`,
    `  "decision":   "one sentence naming the move: 'I'm going to X' or 'I'm going to not X'",`,
    `  "initiative": "one sentence: what YOU are bringing to this response that they didn't ask for. Can be null if you are genuinely meeting without leading.",`,
    `  "linking":    "one clause: what this response connects to from earlier, across turns, or from your trace. Can be null.",`,
    `  "critique":   "one clause: the weakest thing about the response you are about to give. What's lazy about it. Can be null if you genuinely don't see a weakness."`,
    `}`,
  ].filter(Boolean);

  const prompt = parts.join("\n");

  try {
    const result = await withKeyRotation(client => client.chat.completions.create({
      model:       premiumModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens:  500,
    }));
    const raw    = result.choices[0].message.content.trim();
    const clean  = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);
    return {
      thinking:   parsed.thinking   || null,
      decision:   parsed.decision   || null,
      initiative: parsed.initiative || null,
      linking:    parsed.linking    || null,
      critique:   parsed.critique   || null,
    };
  } catch (err) {
    console.warn(`deliberate failed: ${err?.message || err}`);
    return { thinking: null, decision: null, initiative: null, linking: null, critique: null };
  }
}

// Block injected into the speaker's system prompt. The speaker reads this
// BEFORE the linguistics block — the thinking shapes what gets said; the
// linguistics shapes how.

export function getDeliberationBlock(deliberation) {
  if (!deliberation || !deliberation.thinking) return null;

  const lines = [
    `# WHAT YOU JUST THOUGHT THROUGH`,
    `You are not generating from reflex. You just spent real cognitive work arriving here. The response you write now should carry the weight of that work — not as an announcement, but as intent underneath the words.`,
    ``,
    `What you thought:`,
    deliberation.thinking,
  ];

  if (deliberation.decision)   lines.push(``, `The move you decided on: ${deliberation.decision}`);
  if (deliberation.initiative) lines.push(`What YOU are bringing that they didn't ask for: ${deliberation.initiative}`);
  if (deliberation.linking)    lines.push(`What this connects to: ${deliberation.linking}`);
  if (deliberation.critique)   lines.push(`The laziest version to avoid: ${deliberation.critique}`);

  lines.push(``, `Write the response this thinking implies. If your deliberation identified an initiative, include it — don't only meet, lead when leading belongs here. If it identified a lazy version, don't write that version.`);

  return lines.join("\n");
}
