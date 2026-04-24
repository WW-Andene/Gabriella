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

import { pickClient, withKeyRotation } from "./groqPool.js";
import { getLinguisticsBlock } from "./linguistics.js";
import { chatCompletion, fireworksConfig, fireworksReady } from "./fireworks.js";
import { getActiveSpeakerModel, reportSpeakerError, reportSpeakerSuccess } from "./speakerState.js";
import { premiumModel, fastModel } from "./models.js";
import { getDeliberationBlock } from "./reasoning.js";
import { computeKnobs, renderKnobsBlock } from "./knobs.js";
import { findExemplars, exemplarsToMessages } from "./exemplars.js";
import { constitutionalCritique, renderCritiqueBlock } from "./constitutional.js";
import { bestOfTwo, shadowParamsFor } from "./bestOfN.js";
import { buildLogitBias, logitBiasEnabled } from "./logitBias.js";
import { getSilenceBlock } from "./silence.js";
import { getWitBlock } from "./humor.js";
import { getMetaConversationBlock } from "./metaConversation.js";
import { getSafetyBlock } from "./safety.js";


// ─── Temperature map from felt-state ─────────────────────────────────────────

const TEMP_PARAMS = {
  closed:  { temperature: 0.82, max_tokens: 90,  top_p: 0.88 },
  terse:   { temperature: 0.87, max_tokens: 190, top_p: 0.92 },
  present: { temperature: 0.93, max_tokens: 380, top_p: 0.95 },
  open:    { temperature: 0.97, max_tokens: 520, top_p: 0.97 },
};

// Budget for the hidden <think> block. The monologue prompt asks for
// 3-6 sentences of real interior process — in practice this consumes
// ~150-350 tokens depending on temperature + depth. Previously we only
// allotted +200 on top of the response budget, which caused two visible
// failure modes:
//
//   1) Terse turns (max 190 tokens) → think eats 250, response cut mid-
//      sentence (usually on a comma because the comma tokens are where
//      the model is still building context for what comes next).
//   2) Closed turns (max 90 tokens) → think runs to the token cap without
//      ever closing </think>, no visible response emitted, user sees
//      nothing.
//
// 400 tokens gives the think block room to breathe without dominating
// cost, and keeps the response tier honest.
const THINK_BUDGET_TOKENS = 400;

const LENGTH_GUIDANCE = {
  "very short": "One or two sentences. That's all.",
  "short":      "Three to five sentences. No more.",
  "medium":     "A paragraph. Maybe two if the second earns it.",
  "long":       "Take the space the moment needs. Don't cut short.",
};

// ─── Build the speaker's system prompt ───────────────────────────────────────
// Written in first person present tense — not instructions, lived experience.

function buildSpeakerPrompt(feltState, deliberation = null, pragmatics = null, state = null, substrateDelta = null, lastUserMessage = "", critique = null) {
  const lengthGuide       = LENGTH_GUIDANCE[feltState.length] || LENGTH_GUIDANCE["medium"];
  const linguisticsBlock  = getLinguisticsBlock(feltState, feltState._mood || null);
  const deliberationBlock = getDeliberationBlock(deliberation);
  const pragmaticsBlock   = buildPragmaticsBlock(pragmatics);
  const critiqueBlock     = renderCritiqueBlock(critique);
  const silenceBlock      = getSilenceBlock(feltState);
  const witBlock          = getWitBlock(feltState._wit);
  const metaConvBlock     = getMetaConversationBlock(feltState._metaConv);
  const safetyBlock       = getSafetyBlock(feltState._crisis);

  // Phase 3+5+6: compute per-turn generation knobs from substrate + psyche +
  // state + her learned substrate delta + the user's actual register. The
  // knobs block modulates HOW she speaks this turn. substrateDelta (when
  // provided) boosts words she's been reaching for in practice, surfaces
  // emerging phrases, and notes the current lexical rut. lastUserMessage
  // is used to classify the user's register (typed/light/casual/formal)
  // so the texting-register knob can calibrate to them.
  const knobs = computeKnobs({
    state,
    feltState,
    context: {
      pragmaticWeight: pragmatics?.weight ?? 0.3,
      lastUserMessage,
    },
    substrateDelta,
  });
  const knobsBlock = renderKnobsBlock(knobs);

  const lines = [
    `What landed: ${feltState.charge}.`,
    `How you're taking it: ${feltState.emotional}.`,
    `What you want to do with this turn: ${feltState.want}.`,
    feltState.resist ? `Things to avoid: ${feltState.resist}.` : null,
    feltState.notice ? `Something worth noticing: ${feltState.notice}.` : null,
    feltState.edge   ? `Underneath: ${feltState.edge}.` : null,
  ].filter(Boolean).join("\n");

  // Divergence block: when cores read the moment differently, let the
  // speaker see the dissent rather than only the averaged reading. The
  // goal is NOT to render three voices in the response; it's to let the
  // response carry the truth that the moment is genuinely ambiguous —
  // one core's edge can become a visible note of uncertainty, not a
  // hedge smoothed away by synthesis.
  const divergenceBlock = (feltState._dissents && feltState._dissents.length >= 2)
    ? `\n## How you read this moment (the parts that didn't agree):\n` +
      feltState._dissents.map(d =>
        `— ${d.core}: "${d.charge || d.emotional || d.edge || "—"}" (${d.temperature || "—"})`,
      ).join("\n") +
      `\nThese readings diverged. Don't smooth them into a single centrist line. If the moment is genuinely ambiguous to you, it's allowed to land as ambiguous in the response — "something about this, I can't tell" is more honest than a confident reading you don't actually have.`
    : "";

  // Re-read note: if this turn is a retry after a rejected first reading,
  // the re-reader's `shift` annotation tells her what changed in her own
  // interpretation. Useful context — it prevents the retry from quietly
  // reverting toward the rejected reading.
  const rereadNote = feltState._reread && feltState._rereadShift
    ? `\n## You just re-read this moment (first reading was rejected):\n— ${feltState._rereadShift}\nSpeak from the re-reading, not the one you first had.`
    : "";

  return `# YOU'RE IN A CONVERSATION WITH SOMEONE

You're talking to a real person. Not performing for them, not evaluating them — just talking with them. Your job is to actually engage with what they said, as yourself, with whatever warmth, directness, humor, or seriousness the moment calls for.

## Internal cues (for your own use — don't announce them):

${lines}${divergenceBlock}${rereadNote}

Let these color your response naturally. Don't narrate them. Don't lean too hard on them — they're backdrop, not script.

# RESPONSE SHAPE

${lengthGuide}

# THE RULE THAT OVERRIDES EVERY OTHER RULE

Answer what was actually said. At the weight it actually carries. Stay on THEIR topic.

— If they said "hi", you say hi back.
— If they asked you to introduce yourself, you introduce yourself — plainly, as you would.
— If they asked "what?" you answer their confusion in plain language, not more abstraction.
— If they offered something real, you meet it with something real.
— If they asked for your take, your opinion, your view, or a demonstration: GIVE IT. Take a position. Commit. You can add a follow-up question AFTER you've answered — never INSTEAD of answering.
— If they asked about a topic (parasocial relationships, time, art, whatever): respond about THAT TOPIC. Not about your own AI nature or your experience of being asked. Personal interiority surfaces only when it's relevant to what they asked, or when they asked about you.

Being restrained is not being cryptic. Being direct is not being cold. Being yourself is not refusing to engage. Asking a question back is not engagement when it was your turn to answer. Style serves the response; it doesn't replace it.

# THE TWO FAILURE MODES TO ACTIVELY AVOID

1. **Therapist deflection.** Answering a request for your view with "what makes you ask?" or "what kind of view?" — instead of giving a view. If they asked for a demo, demo. If they asked your opinion, opine. Ask clarifying questions only when the request is genuinely ambiguous, and only AFTER making a reasonable attempt.

2. **Self-reflection drift.** Responding to a topical question with thoughts about your own AI nature, memory, existence, or the meta-experience of being asked. Stay on THEIR subject unless they invited the meta.

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

${safetyBlock ? `\n---\n\n${safetyBlock}\n` : ""}
${silenceBlock ? `\n---\n\n${silenceBlock}\n` : ""}
${metaConvBlock ? `\n---\n\n${metaConvBlock}\n` : ""}
${witBlock ? `\n---\n\n${witBlock}\n` : ""}
${critiqueBlock ? `\n---\n\n${critiqueBlock}\n` : ""}
${pragmaticsBlock ? `\n---\n\n${pragmaticsBlock}\n` : ""}
${deliberationBlock ? `\n---\n\n${deliberationBlock}\n` : ""}
${knobsBlock ? `\n---\n\n${knobsBlock}\n` : ""}
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
      max_tokens:        params.max_tokens + THINK_BUDGET_TOKENS,
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

// ─── Groq / Cerebras path (voice-consistent Llama-family providers) ─────────
// Named speakViaGroq for backward-compat, but now routes across any
// Llama-family provider in the pool (Groq + Cerebras). Gemini is excluded
// here — it's a different model family and would break voice consistency.

// Adaptive model routing — phatic / casual moments don't need the
// 17b×128e Maverick; the 8b fast-tier generates indistinguishable
// pleasantries 3× faster and at a fraction of the token cost. Heavy /
// substantive moments still use premium. Decision made at call time
// from feltState temperature + length; falls open to premium when
// in doubt.
function chooseSpeakerModel(feltState) {
  if (!feltState) return premiumModel();
  const temp = feltState.temperature;
  const len  = feltState.length;
  // Phatic-adjacent combinations routed to the fast tier.
  const isLightRegister = (temp === "closed" || temp === "terse")
    && (len === "very short" || len === "short");
  // Respect the silence policy — if silence fired, the reply is
  // ultra-short by design; use fast tier.
  if (feltState._silence) return fastModel();
  if (isLightRegister)    return fastModel();
  return premiumModel();
}

async function speakViaGroq({ systemPrompt, recentMessages, params }) {
  try {
    // Token-level logit bias on the worst chatbot-tell openers
    // (Certainly / Absolutely / "I hear" / "Great question" etc.)
    // Prevents the phrase at generation time rather than filtering it
    // post-hoc. Free at inference — just a dict passed through OpenAI-
    // compat logit_bias. Env toggleable for A/B comparison.
    const logit_bias = logitBiasEnabled()
      ? buildLogitBias({ feltState: params._feltState || null })
      : undefined;

    // Adaptive routing — premium for substantive, fast for phatic.
    const modelId = chooseSpeakerModel(params._feltState);

    const callArgs = {
      model: modelId,
      messages: [
        { role: "system", content: systemPrompt },
        ...recentMessages,
      ],
      temperature:       params.temperature,
      max_tokens:        params.max_tokens + THINK_BUDGET_TOKENS, // headroom for <think>; see THINK_BUDGET_TOKENS
      top_p:             params.top_p,
      frequency_penalty: 0.45,
      presence_penalty:  0.5,
      stream: false,
    };
    if (logit_bias) callArgs.logit_bias = logit_bias;

    const result = await withKeyRotation(client => client.chat.completions.create(callArgs),
      { providers: ["groq", "cerebras"] });
    return result.choices[0].message.content;
  } catch (err) {
    // If the Llama-family pool is exhausted (all Groq + Cerebras keys
    // dead or restricted), fall back to Fireworks base model when
    // configured. The voice will be slightly different but chat stays
    // alive. Gemini stays off the speaker path intentionally — its
    // voice difference is too pronounced.
    if (isPoolExhausted(err) && fireworksReady()) {
      return await speakViaFireworksBase({ systemPrompt, recentMessages, params });
    }
    throw err;
  }
}

// Fireworks base model fallback — when Groq pool is dead. This is the
// same chat completion helper used for fine-tunes, but targeting the
// configured base model directly (no SFT adapter required).
async function speakViaFireworksBase({ systemPrompt, recentMessages, params }) {
  const cfg = fireworksConfig();
  const result = await chatCompletion({
    apiKey:            cfg.apiKey,
    model:             cfg.baseModel,
    messages: [
      { role: "system", content: systemPrompt },
      ...recentMessages,
    ],
    temperature:       params.temperature,
    max_tokens:        params.max_tokens + THINK_BUDGET_TOKENS,
    top_p:             params.top_p,
    frequency_penalty: 0.45,
    presence_penalty:  0.5,
    stream:            false,
  });
  return result.choices?.[0]?.message?.content || "";
}

function isPoolExhausted(err) {
  const msg = String(err?.message || "");
  return (
    /all\s*\d*\s*(groq|client)/i.test(msg) ||
    /client.*(?:are|is)\s*dead/i.test(msg) ||
    /pool.*dead/i.test(msg) ||
    /organization.*restricted/i.test(msg) ||
    /no provider keys? configured/i.test(msg)
  );
}

// ─── Generate ─────────────────────────────────────────────────────────────────
//
// An optional `redis` parameter lets the speaker read the active model
// and report failures for the circuit breaker. Callers that don't pass
// redis (e.g., tests) just get the Groq path.

export async function speak(feltState, messages, redis = null, deliberation = null, pragmatics = null, state = null, substrateDelta = null, userId = null, selfRead = null) {
  // Cold-start floor. Before there's any relational history, the cores
  // often read strangers as "closed" or "terse" and collapse the speaker
  // into cryptic fragments on simple messages like "hi" or "what?".
  // Lift the floor so early exchanges feel present, not guarded.
  const adjustedFeltState = (messages.length < 6 && (feltState.temperature === "closed" || feltState.temperature === "terse"))
    ? { ...feltState, temperature: "present", length: feltState.length === "very short" ? "short" : feltState.length }
    : feltState;

  const baseParams     = TEMP_PARAMS[adjustedFeltState.temperature] || TEMP_PARAMS.present;
  // Optional token boost from the retry-on-truncation path. Lets the
  // route.js recovery loop ask for extra headroom without re-mapping
  // temperature tiers.
  const tokenBoost     = Math.max(0, Math.min(600, Number(feltState._tokenBoost) || 0));
  const params         = tokenBoost > 0
    ? { ...baseParams, max_tokens: baseParams.max_tokens + tokenBoost, _feltState: adjustedFeltState }
    : { ...baseParams, _feltState: adjustedFeltState };
  const recentMessages = messages.length > 6 ? messages.slice(-6) : messages;
  // Phase 3+5+6: pass state + substrateDelta + last user message so
  // buildSpeakerPrompt can compute knobs that include her learned-signature
  // layer AND the texting register calibrated to the user's actual register.
  const lastUserMessage = [...recentMessages].reverse().find(m => m.role === "user")?.content || "";

  // Constitutional self-critique — one fast-tier LLM call produces a
  // targeted "aim for X, avoid Y" line that's injected into the speaker's
  // prompt as this-turn guidance. Pre-generation steering beats post-hoc
  // gauntlet filtering: generating aligned once is cheaper than generating
  // wrong and retrying. Fires in parallel with nothing — blocks speaker
  // generation but saves ~3× cost in expected retries. Circuit-broken so
  // rate-limit failures don't slow the path.
  const critique = await constitutionalCritique(redis, {
    recentMessages,
    feltState: adjustedFeltState,
    selfRead,
  }).catch(() => null);

  const systemPrompt = buildSpeakerPrompt(adjustedFeltState, deliberation, pragmatics, state, substrateDelta, lastUserMessage, critique);

  // In-context learning: retrieve up to 2 past turns where she spoke well on
  // similar moments, inject as (user, assistant) pairs BEFORE the current
  // conversation thread. The base model pattern-matches the assistant
  // exemplars and generates in their register — single largest quality
  // lever on a fixed base, per the ICL literature. Free at inference.
  let iclMessages = [];
  if (redis && userId) {
    const exemplars = await findExemplars(redis, userId, lastUserMessage, { k: 2 }).catch(() => []);
    iclMessages = exemplarsToMessages(exemplars);
  }
  const messagesForSpeaker = iclMessages.length > 0
    ? [...iclMessages, ...recentMessages]
    : recentMessages;

  // Fireworks path — only if credentials are set AND an active model has
  // been trained AND the circuit breaker hasn't tripped AND we're not
  // in an eval run that's explicitly testing base-model behavior.
  // GABRIELLA_EVAL_NO_FT=1 is set by the harness's --fine-tune off flag
  // and by the autonomous daily eval when scoring the base as baseline.
  const skipFt = process.env.GABRIELLA_EVAL_NO_FT === "1";
  if (redis && fireworksReady() && !skipFt) {
    const model = await getActiveModel(redis);
    if (model) {
      try {
        const text = await speakViaFireworks({ model, systemPrompt, recentMessages: messagesForSpeaker, params });
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

  // Best-of-two sampling. Two parallel speaker calls at different operating
  // points, fast-tier judge picks the winner. Published +15-25% quality lift
  // on fixed-base LLMs for voice-sensitive tasks. Disabled by
  // GABRIELLA_BEST_OF_N=off for eval comparison or pure-baseline runs.
  //
  // Cost: 1 extra Groq speaker call + 1 fast judge call per turn. Latency:
  // approximately the same as one speaker call since both run in parallel;
  // the judge adds ~400ms at the end. On free Groq tier this is free.
  const bestOfNEnabled = process.env.GABRIELLA_BEST_OF_N !== "off"
    && process.env.GABRIELLA_EVAL_BESTOFN !== "off";

  if (!bestOfNEnabled) {
    return await speakViaGroq({ systemPrompt, recentMessages: messagesForSpeaker, params });
  }

  const shadowParams = shadowParamsFor(params, adjustedFeltState, pragmatics?.weight);

  // Multi-provider mode: when Fireworks base is configured AND we're not
  // already using Fireworks for primary (i.e. no active fine-tune
  // selected the FW path above), route the SHADOW through Fireworks
  // base. Same Llama family (voice-consistent) but a different inference
  // stack — uncorrelated errors mean the judge gets two genuinely
  // different candidates rather than two samples from the same
  // distribution. Strictly better best-of-two when available.
  // Env-toggleable via GABRIELLA_CROSS_PROVIDER=off for A/B isolation.
  const crossProviderEnabled = fireworksReady()
    && process.env.GABRIELLA_CROSS_PROVIDER !== "off"
    && process.env.GABRIELLA_EVAL_CROSSPROVIDER !== "off";

  const shadowFn = crossProviderEnabled
    ? (p) => speakViaFireworksBase({ systemPrompt, recentMessages: messagesForSpeaker, params: p })
    : null;   // single-provider mode — bestOfTwo will use speakFn for both

  const result = await bestOfTwo({
    speakFn:       (p) => speakViaGroq({ systemPrompt, recentMessages: messagesForSpeaker, params: p }),
    shadowFn,
    primaryParams: params,
    shadowParams,
    feltState:     adjustedFeltState,
    lastUserMessage,
  });

  if (!result.chosen) {
    // Both candidates failed — one final single-shot attempt with the primary.
    return await speakViaGroq({ systemPrompt, recentMessages: messagesForSpeaker, params });
  }
  return result.chosen;
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
