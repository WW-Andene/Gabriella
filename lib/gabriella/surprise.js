// surprise.js
// When the thinker writes a prediction to the stream, it's a bet: she
// expects the user to come back with something of a given shape. When
// the user actually speaks, we score that bet and append the result to
// the stream. Surprise is the raw signal of "this broke the model I
// was running of you."
//
// Cheap: one fast-tier LLM call, only when there IS a live prediction
// and the user has been away long enough for the prediction to mean
// something (i.e. not inside the same active session).

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { latestPredictions, appendStream } from "./stream.js";

const PREDICTION_MAX_AGE_MS   = 6 * 60 * 60 * 1000;   // don't score predictions older than 6h
const MIN_GAP_FOR_SCORING_MS  = 15 * 60 * 1000;       // only score if the gap is ≥15 min

// ─── Evaluate whether the last predictions were right ───────────────────────

export async function evaluatePredictions(redis, userId, {
  lastUserMessage,
  gapSinceLastTurnMs = 0,
}) {
  if (!lastUserMessage || lastUserMessage.length < 2) return { skipped: "no_message" };
  if (gapSinceLastTurnMs < MIN_GAP_FOR_SCORING_MS) return { skipped: "gap_too_short" };

  const predictions = await latestPredictions(redis, userId, {
    limit:    3,
    maxAgeMs: PREDICTION_MAX_AGE_MS,
  }).catch(() => []);
  if (predictions.length === 0) return { skipped: "no_predictions" };

  const predictionsText = predictions
    .map((p, i) => `${i + 1}. ${p.content}${p.meta?.expectedShape ? `  [shape: ${p.meta.expectedShape}]` : ""}`)
    .join("\n");

  const prompt = `Gabriella made these predictions about what her conversation partner would bring when they came back:

${predictionsText}

They have now come back, and they said:
"${lastUserMessage.slice(0, 500)}"

Score, in a single sentence each:
- verdict: one of "confirmed" | "partial" | "off" | "surprising"
    confirmed:  they did roughly what was predicted
    partial:    shape matched but content was different, or vice versa
    off:        her prediction didn't fit — they brought something else
    surprising: her prediction was wrong in a way that actually says something about them (not just random miss)
- delta: ONE sentence, first person, describing what's different between what she expected and what actually arrived. If verdict is "confirmed", return null for delta.
- weight: 0.2-0.9. How much this should inform how she reads the next turn. "Surprising" is usually 0.6-0.9; "confirmed" is 0.2-0.3; "off" or "partial" around 0.4-0.6.

Return ONLY JSON:
{"verdict":"<one>","delta":"<one sentence or null>","weight":<number>}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens:  160,
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);

    const verdict = ["confirmed", "partial", "off", "surprising"].includes(parsed.verdict)
      ? parsed.verdict
      : null;
    if (!verdict) return { skipped: "unparseable" };

    // Only write a stream entry when there's something to say about it —
    // "confirmed" with no delta is a non-event.
    if (verdict === "confirmed" && !parsed.delta) {
      return { verdict, wrote: false };
    }

    const weight = typeof parsed.weight === "number"
      ? Math.max(0.2, Math.min(0.95, parsed.weight))
      : (verdict === "surprising" ? 0.75 : verdict === "off" ? 0.55 : 0.4);

    const content = verdict === "confirmed"
      ? `What arrived matched what I expected — ${parsed.delta || "shape held"}.`
      : verdict === "partial"
      ? `Half-right — ${parsed.delta}`
      : verdict === "off"
      ? `What I expected isn't what came — ${parsed.delta}`
      : `This wasn't the shape I was running for them — ${parsed.delta}`;

    await appendStream(redis, userId, {
      kind:       "surprise",
      content,
      weight,
      meta:       { verdict },
      links:      predictions.map(p => p.id).filter(Boolean),
    }).catch(() => null);

    return { verdict, weight, delta: parsed.delta, wrote: true };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
