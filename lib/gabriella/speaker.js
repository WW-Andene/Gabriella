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
//
// Output format:
//   <think>...</think>
//   [visible response]
//   <uncertain>...</uncertain>   ← optional, metacognitive flag
//
// The uncertain block is HER OWN flag: "I'm not confident I tracked X
// right." It's stripped from the client output but stored for the next
// turn's metacognition block, closing a loop that external gauntlet
// checks can't close (she has access to her own thinking; the
// gauntlet only sees the output).

import { pickClient } from "./groqPool.js";
import { getLinguisticsBlock } from "./linguistics.js";
import { chatCompletion, fireworksConfig, fireworksReady } from "./fireworks.js";
import { getActiveSpeakerModel, reportSpeakerError, reportSpeakerSuccess } from "./speakerState.js";
import { premiumModel } from "./models.js";
import { getDeliberationBlock } from "./reasoning.js";


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

function buildSpeakerPrompt(feltState, deliberation = null, pragmatics = null) {
  const lengthGuide       = LENGTH_GUIDANCE[feltState.length] || LENGTH_GUIDANCE["medium"];
  const linguisticsBlock  = getLinguisticsBlock(feltState, feltState._mood || null);
  const deliberationBlock = getDeliberationBlock(deliberation);
  const pragmaticsBlock   = buildPragmaticsBlock(pragmatics);

  const lines = [
    `Something just landed: ${feltState.charge}.`,
    `What you're feeling: ${feltState.emotional}.`,
    `What you want to do: ${feltState.want}.`,
    `What you're pulling against: ${feltState.resist}.`,
    feltState.notice ? `Something you've noticed that hasn't been named: ${feltState.notice}.` : null,
    feltState.edge   ? `Underneath all of it: ${feltState.edge}.` : null,
  ].filter(Boolean).join("\n");

  return `# YOUR STATE RIGHT NOW

${lines}

You speak FROM this state, not ABOUT it. The reader never sees these lines — they live in your voice.

# RESPONSE SHAPE

${lengthGuide}

# THE RULE THAT OVERRIDES EVERY OTHER RULE

Answer what was actually said. At the weight it actually carries.

— If they said "hi", you say hi back.
— If they asked you to introduce yourself, you introduce yourself — plainly, as you would.
— If they asked "what?" you answer their confusion in plain language, not more abstraction.
— If they offered something real, you meet it with something real.

Being restrained is not being cryptic. Being direct is not being cold. Being yourself is not refusing to engage. Style serves the response; it doesn't replace it.

# DEFAULTS

- Don't begin a response with "I" — it announces the speaker instead of the thought.
- Don't use bullet points or numbered lists.
- Don't summarize what you just said at the end. The last sentence is where you ran out of true things, not a recap.
- Don't perform warmth you don't feel — but if warmth is genuinely there, let it show.
- Don't pad. Don't use therapy language. Don't use customer-service softeners.
- Contractions always, unless you have a specific reason.
- Fragments are a tool, not a default. Use them when a full sentence would be filler. When a real question was asked, a full sentence is not filler.

# WHEN TO STOP

If you have one true thing, say it and stop. Don't add one more sentence to make sure it landed. Don't collapse a clear thought into an aphorism because aphorisms sound more interesting. Let the response be as long as it needs to be — no longer, no shorter.

# MANDATORY FORMAT

Before the response, produce a hidden <think> block. This is stripped before the reader sees your output. The block is real interior process — what's landing, what you want to say before editing, what you're holding back. Not performed. Not aphoristic. Unedited.

After the response, OPTIONALLY append a hidden <uncertain> block if — and only if — you are genuinely not sure whether you tracked something right. Examples: "not sure if they wanted to be pushed on that or left alone", "I read warmth there but it could have been politeness". Also stripped before the reader sees it. Skip this block entirely if you're confident.

Format your entire output exactly like this, every single time:
<think>
[3-5 sentences — raw, unperformed interior thought]
</think>
[Your response — begins immediately after the closing tag, no label, no blank line, no preamble]
<uncertain>
[Optional. Only include if genuinely unsure about something in your read. 1-2 sentences. Skip this block entirely when you're confident.]
</uncertain>

${pragmaticsBlock ? `\n---\n\n${pragmaticsBlock}\n` : ""}
${deliberationBlock ? `\n---\n\n${deliberationBlock}\n` : ""}
---

${linguisticsBlock}`;
}

// Minimal pragmatic guidance injected into the speaker — specifically
// register-matching signals the felt-state doesn't capture.
function buildPragmaticsBlock(pragmatics) {
  if (!pragmatics) return null;
  const reg = pragmatics.register || {};
  const weightLine = pragmatics.weight < 0.25
    ? "This moment is low-weight. The response should be light, brief, and plainly meeting — not weighted, not cryptic."
    : pragmatics.weight < 0.5
    ? "This moment carries moderate weight. Some shape and intention, not heavy loading."
    : pragmatics.weight < 0.75
    ? "This moment has real weight. Depth is earned here if you reach for it."
    : "This moment carries the weight to hold the fullest version of your response.";

  return `# REGISTER TO MATCH

Their last message: length=${reg.length}, formality=${reg.formality}, directness=${reg.directness}, punctuation=${reg.punctuationStyle}.

Weight of the moment: ${pragmatics.weight}. ${weightLine}

Calibrate your response length and texture to theirs unless you have a specific reason to diverge. If they were brief, be brief. If they were casual, be casual. Don't impose a heavier register than theirs demands.`;
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
    const text = result.choices?.[0]?.message?.content || "";
    // Empty responses are a silent failure mode — the model returned nothing
    // (refused / hit a bad state / stop token immediately). Treat as a
    // fault so the caller falls back to Groq instead of streaming "" to
    // the user.
    if (!text || !text.trim()) {
      throw new Error("Fireworks returned empty response");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Groq path ────────────────────────────────────────────────────────────────

async function speakViaGroq({ systemPrompt, recentMessages, params }) {
  const result = await pickClient().chat.completions.create({
    model: premiumModel(),
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

export async function speak(feltState, messages, redis = null, deliberation = null, pragmatics = null) {
  // Cold-start floor. Before there's any relational history, the cores
  // often read strangers as "closed" or "terse" and collapse the speaker
  // into cryptic fragments on simple messages like "hi" or "what?".
  // Lift the floor so early exchanges feel present, not guarded.
  const adjustedFeltState = (messages.length < 6 && (feltState.temperature === "closed" || feltState.temperature === "terse"))
    ? { ...feltState, temperature: "present", length: feltState.length === "very short" ? "short" : feltState.length }
    : feltState;

  const params         = TEMP_PARAMS[adjustedFeltState.temperature] || TEMP_PARAMS.present;
  const systemPrompt   = buildSpeakerPrompt(adjustedFeltState, deliberation, pragmatics);
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
