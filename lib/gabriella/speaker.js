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
import { chatCompletion, fireworksConfig, fireworksReady } from "./fireworks.js";
import { getActiveSpeakerModel, reportSpeakerError, reportSpeakerSuccess } from "./speakerState.js";

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

Before speaking, work through your actual state in a hidden block. This is mandatory — it will be stripped before the person ever sees it.

Format your entire output exactly like this, every single time:
<think>
[3-5 sentences — raw, unperformed: what's actually landing? what do you want to say before you edit it? what are you holding back and why? don't craft, just think]
</think>
[Your response — begins immediately after the closing tag, no label, no blank line, no preamble]

---

${linguisticsBlock}`;
}

// ─── Provider routing ─────────────────────────────────────────────────────────
//
// The speaker tries the Fireworks fine-tune first (if one has been
// trained and activated), then automatically falls back to Groq if
// anything goes wrong. Two guardrails prevent Gabriella from getting
// stuck with a broken fine-tune:
//
//   • Per-call timeout — inference that takes too long falls back.
//   • Circuit breaker  — too many consecutive failures deactivate the
//                         fine-tune entirely so the next conversation
//                         returns to Groq immediately. The watch
//                         endpoint re-activates it if a newer model
//                         arrives, or you can manually re-enable.
//
// The fallback is invisible to the user: the client always gets a
// response, even if the fine-tune is misbehaving.

const FIREWORKS_TIMEOUT_MS = 20_000;

// Tiny in-process cache of the active model — avoids a Redis hit on
// every request without meaningfully staling things. 60s is plenty.
let cachedActive = { model: null, at: 0 };
const ACTIVE_CACHE_MS = 60_000;

async function getActiveModel(redis) {
  if (Date.now() - cachedActive.at < ACTIVE_CACHE_MS) return cachedActive.model;
  const model = await getActiveSpeakerModel(redis).catch(() => null);
  cachedActive = { model, at: Date.now() };
  return model;
}

function invalidateActiveCache() {
  cachedActive = { model: null, at: 0 };
}

// ─── Fireworks path ───────────────────────────────────────────────────────────

async function speakViaFireworks({ model, systemPrompt, recentMessages, params }) {
  const cfg = fireworksConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIREWORKS_TIMEOUT_MS);

  try {
    const result = await chatCompletion({
      apiKey:            cfg.apiKey,
      model,
      messages: [
        { role: "system", content: systemPrompt },
        ...recentMessages,
      ],
      temperature:       params.temperature,
      max_tokens:        params.max_tokens + 200,
      top_p:             params.top_p,
      frequency_penalty: 0.45,
      presence_penalty:  0.5,
      stream:            false,
      signal:            controller.signal,
    });
    return result.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

// ─── Groq path ────────────────────────────────────────────────────────────────

async function speakViaGroq({ systemPrompt, recentMessages, params }) {
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

// ─── Generate ─────────────────────────────────────────────────────────────────
//
// An optional `redis` parameter lets the speaker read the active model
// and report failures for the circuit breaker. Callers that don't pass
// redis (e.g., tests) just get the Groq path.

export async function speak(feltState, messages, redis = null) {
  const params         = TEMP_PARAMS[feltState.temperature] || TEMP_PARAMS.present;
  const systemPrompt   = buildSpeakerPrompt(feltState);
  const recentMessages = messages.length > 6 ? messages.slice(-6) : messages;

  // Fireworks path — only if credentials are set AND an active model has
  // been trained AND the circuit breaker hasn't tripped.
  if (redis && fireworksReady()) {
    const model = await getActiveModel(redis);
    if (model) {
      try {
        const text = await speakViaFireworks({ model, systemPrompt, recentMessages, params });
        await reportSpeakerSuccess(redis).catch(() => {});
        return text;
      } catch (err) {
        const breakerTripped = await reportSpeakerError(redis, err?.message || String(err))
          .catch(() => false);
        if (breakerTripped) {
          console.error(`Speaker circuit breaker tripped — fine-tune deactivated (${err?.message || err})`);
          invalidateActiveCache();
        } else {
          console.error(`Speaker Fireworks call failed, falling back to Groq: ${err?.message || err}`);
        }
        // Fall through to Groq
      }
    }
  }

  return await speakViaGroq({ systemPrompt, recentMessages, params });
}

// Allow the watch endpoint to bust the cache after activating a new model.
export { invalidateActiveCache as invalidateActiveSpeakerCache };

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
