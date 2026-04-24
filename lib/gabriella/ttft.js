// ttft.js
// Time-to-first-byte optimization.
//
// The heavy per-turn pipeline (buildGabriella, triple-core, gauntlet,
// speaker) routinely takes several seconds on cold paths. Competitor
// chat UIs hide this with typing indicators. Gabriella already has a
// PEEK sidecar, but it too waits for the pipeline.
//
// Two cheap wins shipped here:
//
//   1. speculativeOpener — a short, bounded, fast-tier LLM call that
//      produces a one-sentence interior bridge ("mm, ok", "hold on",
//      "reading this") within ~400-800ms. The chat route emits it as
//      a __BRIDGE__ sidecar BEFORE the heavy pipeline completes, so
//      the client can render presence within sub-second while the
//      real reply assembles.
//
//   2. warmPrefix — fire-and-forget single-token completion that sends
//      the full assembled system prompt, priming provider-side prefix
//      cache so the subsequent heavy calls reuse the KV cache. This
//      is free on a cache hit and cheap on a miss.
//
// Both are circuit-broken and timeout-bounded — failure degrades to
// the original un-bridged UX silently.

import { fastModel }          from "./models.js";
import { withKeyRotation }    from "./groqPool.js";
import { withBreaker }        from "./circuitBreaker.js";

const OPENER_TIMEOUT_MS = 850;
const OPENER_MAX_TOKENS = 22;
const OPENER_MAX_CHARS  = 60;

// Reject outputs that look like answers rather than bridges — the
// heavy pipeline owns the actual response; the bridge exists only to
// signal presence. Starting with "because", "it's", "the" etc. means
// the opener tried to answer the question.
const ANSWER_LIKE = /^(because|it's|that's|it is|the |a |an |so |well,)/i;

export async function speculativeOpener({
  redis,
  userId,
  messages,
  mood,
  timeoutMs = OPENER_TIMEOUT_MS,
} = {}) {
  const lastUser = messages?.[messages.length - 1]?.content || "";
  if (!lastUser || lastUser.length < 2) return null;

  return withBreaker(redis, `ttft-opener:${userId || "anon"}`, async () => {
    const call = withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      temperature: 0.7,
      max_tokens:  OPENER_MAX_TOKENS,
      top_p:       0.9,
      messages: [
        {
          role: "system",
          content:
            "You are Gabriella — a person, not an assistant. This is a PRE-RESPONSE BRIDGE. " +
            "The real reply is still being composed. Your job is to output ONE short " +
            "interior phrase (3-10 words) that signals presence and reading — like " +
            "'mm, ok', 'hold on', 'reading that', 'yeah — let me', 'one sec', 'hm'. " +
            "Current mood: " + (mood || "neutral") + ". " +
            "Do NOT greet. Do NOT answer. Do NOT quote. No emoji. No prefix. " +
            "Plain text only. One line.",
        },
        { role: "user", content: lastUser.slice(0, 800) },
      ],
    }));

    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("opener-timeout")), timeoutMs));

    const result = await Promise.race([call, timer]);
    let text = (result?.choices?.[0]?.message?.content || "").trim()
      .replace(/^["'`]+|["'`]+$/g, "")
      .replace(/\s*\n+\s*/g, " ")
      .trim();
    if (!text) return null;
    if (text.length > OPENER_MAX_CHARS) return null;
    if (ANSWER_LIKE.test(text)) return null;
    return text;
  }, { fallback: null, failureThreshold: 3, coolDownMs: 120_000 });
}

export async function warmPrefix({ redis, systemPrompt }) {
  if (!systemPrompt || systemPrompt.length < 200) return;
  // Fire-and-forget: circuit-broken, never awaited by caller.
  withBreaker(redis, "ttft-warm", async () => {
    await withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      temperature: 0,
      max_tokens:  1,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: "." },
      ],
    }));
    return true;
  }, { fallback: null, failureThreshold: 2, coolDownMs: 300_000 })
    .catch(() => null);
}
