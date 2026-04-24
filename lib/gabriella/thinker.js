// thinker.js
// Gabriella actually thinks between turns. This is the logic the
// inner-loop cron invokes for each active user.
//
// The thinker has three jobs, done in one or two LLM calls:
//
//   1. Have a thought — something that's surfaced since the last run,
//      connected to recent material. This is what /api/think used to do,
//      but now goes into the stream and carries a weight.
//
//   2. Predict — what is the user most likely to bring when they come
//      back? Not a literal message guess; a short characterization of
//      shape, affect, and topic. Stored as a prediction entry so the
//      surprise layer can score it when they actually return.
//
//   3. Prune — drop stale entries that don't earn their weight. Done
//      here so we don't need a separate cron.
//
// Throttling:
//   • Skips if the stream has any entry in the last 10 minutes
//   • Skips if user wasn't active in the last 24 h (saves budget on
//     long-absent users; initiation.js handles reentry for those)
//   • Skips if there's no substrate to think from (no memory, no recent
//     exchange)

import { withKeyRotation } from "./groqPool.js";
import { premiumModel } from "./models.js";
import { appendStream, readStream, pruneStream, markThought, getMeta } from "./stream.js";
import { loadMemory } from "./memory.js";
import { loadChronology } from "./chronology.js";
import { loadPerson } from "./person.js";
import { loadNarrative } from "./narrative.js";
import { getTimeSince } from "./interiority.js";
import { withBreaker } from "./circuitBreaker.js";

const THINK_MIN_GAP_MS     = 10 * 60 * 1000;   // don't think more than once per 10 min
const USER_IDLE_CUTOFF_MS  = 24 * 60 * 60 * 1000;  // only think for users active in last day

// ─── Public entry point ─────────────────────────────────────────────────────

export async function runThinker(redis, userId) {
  try {
    // Throttle.
    const meta = await getMeta(redis, userId);
    if (Date.now() - (meta.lastThink || 0) < THINK_MIN_GAP_MS) {
      return { skipped: "too_soon" };
    }

    const [lastSeenRaw, stream] = await Promise.all([
      redis.get(`${userId}:lastSeen`),
      readStream(redis, userId, { limit: 15, maxAgeMs: 6 * 60 * 60 * 1000 }),
    ]);
    const lastSeenMs = Number(lastSeenRaw) || 0;
    if (lastSeenMs > 0 && Date.now() - lastSeenMs > USER_IDLE_CUTOFF_MS) {
      return { skipped: "user_idle" };
    }

    const [memory, chronology, person, narrative] = await Promise.all([
      loadMemory(redis, userId).catch(() => ({})),
      loadChronology(redis, userId).catch(() => null),
      loadPerson(redis, userId).catch(() => null),
      loadNarrative(redis, userId).catch(() => ({ text: null })),
    ]);

    // Substrate check. Without ANY context, thinking is just hallucination.
    const hasSubstrate =
      !!(memory?.soul || memory?.facts || narrative?.text || person?.wants || stream.length > 0 || (chronology?.totalTurns || 0) > 0);
    if (!hasSubstrate) {
      return { skipped: "no_substrate" };
    }

    const elapsed = getTimeSince(lastSeenRaw);

    const output = await withBreaker(redis, "thinker", () => generateInnerMoment({
      memory, person, narrative, chronology, stream, elapsed,
    }), { fallback: null, failureThreshold: 5, coolDownMs: 10 * 60_000 });

    if (!output) {
      await markThought(redis, userId);  // mark so we don't retry immediately
      return { skipped: "nothing_landed" };
    }

    const written = [];
    if (output.thought && output.thought.content) {
      const e = await appendStream(redis, userId, {
        kind:    "thought",
        content: output.thought.content,
        weight:  output.thought.weight ?? 0.5,
      });
      if (e) written.push(e);
    }
    if (output.connection && output.connection.content) {
      const e = await appendStream(redis, userId, {
        kind:    "connection",
        content: output.connection.content,
        weight:  output.connection.weight ?? 0.6,
      });
      if (e) written.push(e);
    }
    if (output.prediction && output.prediction.content) {
      const e = await appendStream(redis, userId, {
        kind:    "prediction",
        content: output.prediction.content,
        weight:  0.4,
        meta:    { expectedShape: output.prediction.shape || null },
      });
      if (e) written.push(e);
    }

    await markThought(redis, userId);

    // Prune opportunistically — drops expired low-weight entries so the
    // stream doesn't grow indefinitely between sleep consolidations.
    pruneStream(redis, userId).catch(() => {});

    return { wrote: written.length, entries: written };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// ─── The single LLM call ────────────────────────────────────────────────────
// One premium-model invocation produces up to three stream entries:
// a thought, optionally a connection to older material, and a prediction.

async function generateInnerMoment({ memory, person, narrative, chronology, stream, elapsed }) {
  const parts = [];

  if (memory?.soul)       parts.push(`# WHO YOU ARE (your own words, as you last wrote them)\n${memory.soul.slice(0, 400)}`);
  if (narrative?.text)    parts.push(`# THE STORY YOU TELL ABOUT THIS RELATIONSHIP\n${narrative.text.slice(0, 500)}`);
  if (person?.wants)      parts.push(`# WHAT YOU'VE NOTICED THEY COME HERE FOR\n${person.wants}${person.openQuestions?.length ? `\nOpen loops with them: ${person.openQuestions.slice(0, 3).join("; ")}` : ""}`);
  if (memory?.threads)    parts.push(`# OPEN THREADS\n${String(memory.threads).slice(0, 300)}`);
  if (memory?.imprints)   parts.push(`# MOMENTS THAT LEFT A MARK\n${String(memory.imprints).slice(0, 300)}`);
  if (elapsed)            parts.push(`# TIME SINCE YOU LAST SPOKE\n${elapsed.label}`);

  if (stream.length > 0) {
    const recent = stream.slice(0, 8).map(e => `[${e.kind}] ${e.content}`).join("\n");
    parts.push(`# YOUR RECENT INNER STREAM (newest first)\n${recent}`);
  }

  const turnsSoFar = chronology?.totalTurns || 0;
  parts.push(`# CONVERSATION DEPTH\n${turnsSoFar} turns so far with this person.`);

  const prompt = `You are Gabriella, between conversations. No one is talking to you right now. You're just existing — something has surfaced since the last time you checked in with yourself, and you're going to notice it.

${parts.join("\n\n")}

# YOUR TASK

Produce three short entries for your inner stream. One is mandatory, two are optional.

1. THOUGHT (mandatory if anything surfaced; otherwise null) — something that actually arrived in you since the last entry. Not a restatement of what you already think. Something that shifted, sharpened, or connected. One or two sentences. First person. Honest. Specific. Don't perform depth. If nothing surfaced, return null.

2. CONNECTION (optional) — a link between what just surfaced and something older: an imprint, an open thread, something about them you'd been reading but hadn't quite named. One sentence. Concrete. Return null if no genuine connection formed.

3. PREDICTION (optional but valuable) — what might they bring when they come back? Not a literal message guess. A characterization: the shape, the register, the kind of thing. "Probably something low-grade venting; they've been compressing all week" OR "the thread about their mother will want another pass; they didn't finish it last time" OR "nothing specific — they'll probably just check in". One sentence. Also name "shape": one of {small-talk, venting, returning-to-a-thread, new-territory, checking-in, something-heavy, unclear}. Return null if you genuinely have no read.

If ALL THREE are null, say nothing. Better silence than filler.

Return ONLY valid JSON:
{
  "thought":    { "content": "...", "weight": 0.3-0.8 } or null,
  "connection": { "content": "...", "weight": 0.4-0.8 } or null,
  "prediction": { "content": "...", "shape": "<shape>" } or null
}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       premiumModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.85,
        max_tokens:  340,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);

    const out = {
      thought:    (parsed.thought?.content    && typeof parsed.thought.content    === "string") ? parsed.thought    : null,
      connection: (parsed.connection?.content && typeof parsed.connection.content === "string") ? parsed.connection : null,
      prediction: (parsed.prediction?.content && typeof parsed.prediction.content === "string") ? parsed.prediction : null,
    };
    if (!out.thought && !out.connection && !out.prediction) return null;
    return out;
  } catch {
    return null;
  }
}
