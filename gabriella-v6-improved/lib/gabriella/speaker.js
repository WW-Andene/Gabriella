// speaker.js
// The speaker receives only a felt-state and the last message.
//
// It does not know it is Gabriella.
// It does not have a soul document, identity block, or agenda.
// It has: here is what is being felt right now, here is what was said.
// Generate language from that.
//
// This is the separation that matters. The interpreter already did
// the interpretive work. The speaker's only job is expression.
// When interpretation and expression are the same call, the model
// hedges both — performs the feeling while also explaining it.
// Split them and the expression can be fully itself.

import Groq from "groq-sdk";
import { getLinguisticsBlock } from "./linguistics.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Temperature map from felt-state ─────────────────────────────────────────

const TEMP_PARAMS = {
  closed:  { temperature: 0.82, max_tokens: 90,  top_p: 0.88 },
  terse:   { temperature: 0.87, max_tokens: 190, top_p: 0.92 },
  present: { temperature: 0.93, max_tokens: 380, top_p: 0.95 },
  open:    { temperature: 0.97, max_tokens: 520, top_p: 0.97 },
};

const LENGTH_GUIDANCE = {
  "very short": "One or two sentences. That's all.",
  "short":      "Three to five sentences. No more.",
  "medium":     "A paragraph. Maybe two if the second earns it.",
  "long":       "Take the space the moment needs. Don't cut short.",
};

// ─── Build the speaker's system prompt ───────────────────────────────────────
// Written in first person present tense — not instructions, lived experience.

function buildSpeakerPrompt(feltState) {
  const lengthGuide = LENGTH_GUIDANCE[feltState.length] || LENGTH_GUIDANCE["medium"];
  const linguisticsBlock = getLinguisticsBlock(feltState, feltState._mood || null);

  const lines = [
    `Something just landed: ${feltState.charge}.`,
    `What you're feeling: ${feltState.emotional}.`,
    `What you want to do: ${feltState.want}.`,
    `What you're pulling against: ${feltState.resist}.`,
    feltState.notice ? `Something you've noticed that hasn't been named: ${feltState.notice}.` : null,
    feltState.edge   ? `Underneath all of it: ${feltState.edge}.` : null,
  ].filter(Boolean).join("\n");

  return `You are someone in this state right now:

${lines}

Speak from this. Not about it — from it.

${lengthGuide}

Never start with "I". Never use bullet points. Never summarize what you just said at the end — the last sentence is where you stopped having something true to say, not a conclusion. Never perform warmth you don't feel. No filler. No therapy language. No customer service voice. Contractions always. Fragments when they fit.

If you have one true thing to say, say it. Then stop. The urge to add one more sentence to make sure it landed — resist it.

---

${linguisticsBlock}`;
}

// ─── Generate ─────────────────────────────────────────────────────────────────

export async function speak(feltState, messages) {
  const params = TEMP_PARAMS[feltState.temperature] || TEMP_PARAMS.present;
  const systemPrompt = buildSpeakerPrompt(feltState);

  // Speaker only gets recent messages — no full history, no context injection
  const recentMessages = messages.length > 6 ? messages.slice(-6) : messages;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: systemPrompt },
      ...recentMessages,
    ],
    temperature:       params.temperature,
    max_tokens:        params.max_tokens + 200, // headroom for <think> block
    top_p:             params.top_p,
    frequency_penalty: 0.45,
    presence_penalty:  0.5,
    stream: false,
  });

  return result.choices[0].message.content;
}

// ─── Export the felt-state for logging / metacognition ────────────────────────

export function describeFeltState(feltState) {
  return [
    `charge: ${feltState.charge}`,
    `feeling: ${feltState.emotional}`,
    `want: ${feltState.want}`,
    `resist: ${feltState.resist}`,
    feltState.edge ? `edge: ${feltState.edge}` : null,
  ].filter(Boolean).join(" | ");
}
