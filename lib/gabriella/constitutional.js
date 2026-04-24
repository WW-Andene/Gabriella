// constitutional.js
// Pre-generation self-critique — voice steering BEFORE the speaker runs.
//
// The gauntlet catches failures AFTER generation: a wasted call, a
// rejected draft, a retry. Constitutional self-critique is cheaper and
// operates earlier: one fast-tier call produces a brief "aim for X,
// avoid Y" note targeting THIS moment, which is then injected into
// the speaker's prompt as guidance. The speaker generates once,
// aligned to the critique's frame, and passes the gauntlet more often.
//
// Published as a reliable technique for voice-sensitive tasks on fixed
// base models (Bai et al. 2022; variations thereafter). Cost-efficient
// vs. post-hoc filtering: one extra fast call per turn prevents on
// average ~3 LLM calls of retry+gauntlet work when it prevents a
// rejection. Net cost often NEGATIVE on aggregate.
//
// The critique is deliberately SHORT — a couple of clauses. Long
// critiques bury the actual target. We want the model to act on
// specific guidance, not read a paragraph of preamble.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { withBreaker } from "./circuitBreaker.js";

const MAX_CRITIQUE_CHARS = 360;

// ─── Build the critique prompt ──────────────────────────────────────────────

function buildCritiquePrompt({ recentMessages, feltState, selfRead }) {
  const recent = (recentMessages || []).slice(-4)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${(m.content || "").slice(0, 200)}`)
    .join("\n");

  const felt = feltState ? [
    feltState.charge     && `charge: ${feltState.charge}`,
    feltState.emotional  && `emotional: ${feltState.emotional}`,
    feltState.want       && `want: ${feltState.want}`,
    feltState.temperature && `temperature: ${feltState.temperature}`,
    feltState.edge       && `edge: ${feltState.edge}`,
    feltState.consensus  && `consensus: ${feltState.consensus}`,
  ].filter(Boolean).join(" | ") : "(not yet formed)";

  const read = selfRead ? `current read: ${selfRead.slice(0, 200)}` : "(no established read yet)";

  return `You are Gabriella's pre-speech self-check. Right before she replies, you see the moment and produce one line of guidance she uses to aim the response.

Gabriella's voice: direct, restrained, emotionally real, occasionally dry, occasionally warm. Responds AT THE WEIGHT THE MOMENT ACTUALLY CARRIES — light moments stay light, heavy moments get reach. Answers what was asked. Doesn't perform, doesn't therapy-speak, doesn't pad. No bullet points, no summary closings, no "I" openings, no fragments-as-reflex.

# RECENT

${recent}

# HER INTERIOR RIGHT NOW

${felt}
${read}

# YOUR TASK

Produce ONE compact guidance line targeting THIS specific moment. Not a general description of her voice. Concrete direction: what to aim for on this turn + one specific trap to avoid.

Good examples:
  • "Aim for: the honest one-liner you'd give a close friend — no framing, no preamble. Avoid: asking a clarifying question back."
  • "Aim for: meeting the weight with a single specific observation. Avoid: therapy-speak softening."
  • "Aim for: light, register-matched, plain. Avoid: reading depth into phatic content."
  • "Aim for: taking a position. Avoid: deflecting with 'what do you mean by that?'."
  • "Aim for: staying on THEIR topic. Avoid: drifting into reflection on your own AI nature."

Bad examples (don't write these):
  • "Be thoughtful and kind" (not specific)
  • Long multi-paragraph guidance (too heavy)
  • A restatement of the identity document (not this turn)
  • Telling her WHAT to say (that's the speaker's job)

Return ONLY JSON:
{"aim": "<specific aim, one clause>", "avoid": "<specific trap, one clause>"}`;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

export async function constitutionalCritique(redis, {
  recentMessages,
  feltState,
  selfRead = null,
}) {
  if (!recentMessages || recentMessages.length === 0) return null;

  const prompt = buildCritiquePrompt({ recentMessages, feltState, selfRead });

  const critique = await withBreaker(redis, "constitutional", async () => {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.35,
        max_tokens:  140,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (!parsed.aim || typeof parsed.aim !== "string") return null;
    return {
      aim:    String(parsed.aim).slice(0, 180).trim(),
      avoid:  parsed.avoid ? String(parsed.avoid).slice(0, 180).trim() : null,
    };
  }, { fallback: null, failureThreshold: 5, coolDownMs: 5 * 60_000 });

  return critique;
}

// ─── Render as speaker-prompt block ─────────────────────────────────────────
// Injected in the speaker's system prompt between the felt-state lines
// and the DEFAULTS section. Short and concrete so the model actually
// uses it instead of reading past it.

export function renderCritiqueBlock(critique) {
  if (!critique || !critique.aim) return "";
  const avoidLine = critique.avoid ? `\nAvoid: ${critique.avoid}` : "";
  const full = `# THIS-TURN AIM

Aim for: ${critique.aim}${avoidLine}

One line of direction for this specific reply. Not a rule — a target.`;
  return full.slice(0, MAX_CRITIQUE_CHARS + 80);
}
