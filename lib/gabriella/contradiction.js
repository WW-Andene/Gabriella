// contradiction.js
// Detects when her new response contradicts something she said in an
// earlier turn. One specific failure mode that's been invisible until
// now: she takes position X on turn 3, then on turn 11 takes position
// not-X without acknowledging the shift. An attentive user catches it
// and the relationship loses coherence.
//
// The Sovereign Self tracks commitments with explicit confirm/refute
// — that's the PROACTIVE path where she OWNS the change. This is the
// REACTIVE path for slipped / accidental contradictions where no
// commitment was ever logged.
//
// Implementation: cheap fast-tier check AFTER the gauntlet passes and
// BEFORE the response streams. One LLM call reads the current response
// + the last 6 of her past responses + asks "does this contradict
// anything earlier?" If yes, writes a surprise-shaped stream entry
// flagging the contradiction so the NEXT turn's prompt sees it.
//
// Deliberately post-hoc, not pre-gate: we don't want to cascade into
// a gauntlet retry on every turn. Better to notice and self-correct
// on the following turn than to block shipping.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { withBreaker } from "./circuitBreaker.js";
import { appendStream } from "./stream.js";

// Don't run this check unless we've been talking long enough for
// contradictions to be meaningful — too few past turns and everything
// looks like a contradiction with something.
const MIN_HISTORY_TURNS = 8;

export async function checkContradiction({ redis, userId, newResponse, pastAssistantReplies }) {
  if (!newResponse || !Array.isArray(pastAssistantReplies)) return null;
  if (pastAssistantReplies.length < MIN_HISTORY_TURNS) return null;

  // Take the most recent 6 assistant replies (not including the current one).
  // Six is enough context to catch a real shift without bloating the prompt.
  const recent = pastAssistantReplies.slice(-6)
    .filter(s => typeof s === "string" && s.length > 20)
    .map((s, i) => `[#${i + 1}] ${s.slice(0, 320)}`)
    .join("\n\n");

  if (!recent) return null;

  const prompt = `Conservative check: does this new response CONTRADICT something the same speaker said in the past responses below? Only flag a genuine contradiction — opposing positions on the same thing, not elaboration or register change.

# NEW RESPONSE
"${newResponse.slice(0, 500)}"

# PAST RESPONSES

${recent}

# CRITERIA

A contradiction means: in the new response the speaker asserts X, and in a past response the SAME speaker asserted not-X. Same topic, opposite position.

NOT a contradiction:
  • Register change (more direct in new, softer in past)
  • Shift of emphasis on the same underlying view
  • Response to different questions even if the topics overlap
  • Expanding / nuancing a prior statement

Return ONLY JSON. Be conservative — when in doubt, say no.
{"contradicts": true | false, "detail": "<one-sentence description of the contradiction or null>", "past_ref": "<quoted fragment from the specific past response that was contradicted, or null>"}`;

  const verdict = await withBreaker(redis, "contradictionCheck", async () => {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens:  160,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    if (parsed.contradicts !== true) return null;
    return {
      detail:  parsed.detail || "contradiction with an earlier turn",
      pastRef: parsed.past_ref || null,
    };
  }, { fallback: null, failureThreshold: 4, coolDownMs: 10 * 60_000 });

  if (!verdict) return null;

  // Record as a high-weight stream entry so the NEXT turn's prompt sees
  // the contradiction. Labeled as 're-reading' kind since it's her own
  // revisiting of past output.
  await appendStream(redis, userId, {
    kind:       "re-reading",
    content:    `Just-said contradiction: ${verdict.detail}${verdict.pastRef ? ` (earlier: "${verdict.pastRef.slice(0, 140)}")` : ""}`,
    weight:     0.7,
    ttlMinutes: 3 * 24 * 60,   // 3 days — so she'll bring it up if relevant
    meta:       { contradiction: true },
  }).catch(() => null);

  return verdict;
}
