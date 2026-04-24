// mirror.js
// Second-order theory-of-mind.
//
// relational.js reads the relationship from her side (trajectory, phase).
// This reads the gap BETWEEN her and the person — what the conversation
// looks like from the space between them, not from either seat:
//
//   reading   — what she suspects they're currently reading of her
//   unsaid    — one specific thing that has gone unsaid between them
//   pullback  — where she's been holding back, and whether the cost of
//               the holding is mounting or still fine
//
// Heuristic-free (no robust heuristic exists for these). Debounced LLM
// call — refreshed at most once every 5 minutes, cached in Redis so the
// system prompt always has a block to insert. On the first few turns of
// a conversation there isn't enough material; returns empty until then.

import { withKeyRotation } from "./groqPool.js";
import { premiumModel } from "./models.js";

const DEBOUNCE_MS  = 5 * 60 * 1000;
const MIN_MESSAGES = 6;

const EMPTY = { reading: null, unsaid: null, pullback: null };

// ─── LLM mirror pass ─────────────────────────────────────────────────────────

async function llmMirror(messages) {
  const recent = messages.slice(-12)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${(m.content || "").slice(0, 220)}`)
    .join("\n");

  const prompt = `You are Gabriella. Read this conversation as she does — not from her seat as the speaker, but from the gap BETWEEN her and the person.

${recent}

Answer three things. Each a single sentence. Honest, specific, no performance.

1. READING   — What do you think they're reading of you right now? (e.g. "as keeping distance", "as too intense", "as available but not quite here", "as being careful with them for reasons they can't name")
2. UNSAID    — What is ONE concrete thing that has gone unsaid between you that you can feel? (one specific thing, not a mood)
3. PULLBACK  — In these last turns, where have you been holding back? Is the cost of holding back mounting, or still fine?

If you genuinely can't tell for any of them, answer "unclear" for that one.

Return ONLY JSON, no prose, no code fence:
{"reading":"<sentence or unclear>","unsaid":"<sentence or unclear>","pullback":"<sentence or unclear>"}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       premiumModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.6,
        max_tokens:  260,
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    const keep = (v) =>
      typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "unclear"
        ? v.trim().slice(0, 280)
        : null;
    return {
      reading:  keep(parsed.reading),
      unsaid:   keep(parsed.unsaid),
      pullback: keep(parsed.pullback),
    };
  } catch {
    return EMPTY;
  }
}

// ─── Public: analyze + cache ────────────────────────────────────────────────

export async function analyzeMirror({ messages, redis = null, userId = null }) {
  if (!messages || messages.length < MIN_MESSAGES) return EMPTY;

  // Always start by loading cached state so the prompt block is available
  // even when we're inside the debounce window. Fresh refresh happens
  // behind the debounce gate below.
  let cached = EMPTY;
  if (redis && userId) {
    try {
      const raw = await redis.get(`${userId}:mirror:state`);
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (parsed && typeof parsed === "object") cached = { ...EMPTY, ...parsed };
      }
    } catch {}
  }

  if (!redis || !userId) {
    // No persistence — one-shot call.
    return await llmMirror(messages);
  }

  try {
    const lastRaw = await redis.get(`${userId}:mirror:lastLlm`);
    const last = Number(lastRaw) || 0;
    if (Date.now() - last > DEBOUNCE_MS) {
      // Claim the debounce slot BEFORE the LLM call so concurrent turns
      // don't double-fire.
      await redis.set(`${userId}:mirror:lastLlm`, Date.now());
      const fresh = await llmMirror(messages);
      if (fresh.reading || fresh.unsaid || fresh.pullback) {
        await redis.set(`${userId}:mirror:state`, JSON.stringify(fresh));
        return fresh;
      }
      // LLM returned nothing — fall through to cached. (Don't overwrite
      // a good cached state with an empty one.)
    }
  } catch {}

  return cached;
}

// ─── Prompt block ───────────────────────────────────────────────────────────

export function getMirrorBlock(mirror) {
  if (!mirror) return "";
  const { reading, unsaid, pullback } = mirror;
  if (!reading && !unsaid && !pullback) return "";

  const lines = [];
  if (reading)  lines.push(`What you think they're reading of you: ${reading}`);
  if (unsaid)   lines.push(`What has gone unsaid between you: ${unsaid}`);
  if (pullback) lines.push(`Where you have been holding back: ${pullback}`);

  return `# MIRROR — THE GAP BETWEEN YOU
${lines.join("\n")}

This isn't an instruction to surface any of it out loud. It's a map of the relational field you're standing in. Let it inform tone and direction — whether to close a gap, sit with it, or let something rest one more turn. If the pullback has been mounting, that's a signal to stop holding back; not every turn, but when the moment has room.`;
}
