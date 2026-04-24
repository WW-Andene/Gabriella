// clone/reread.js
// When the gauntlet rejects a response, the default retry path keeps the
// same feltState and just adds a constraint to `resist`. If the original
// reading was wrong, the retry fails in the same direction.
//
// rereadMoment does a single-pass re-interpretation: it sees the rejected
// candidate AND the failure reasons AND the cores' original reading, and
// produces a fresh feltState to regenerate from. One LLM call, premium
// tier. Cheap compared to running the full triple-core again, but it
// breaks the "speak from the same reading" loop.
//
// Returned feltState is shape-compatible with synthesis output so the
// speaker can consume it directly.

import { withKeyRotation } from "../groqPool.js";
import { premiumModel } from "../models.js";

const VALID_TEMPS   = ["closed", "terse", "present", "open"];
const VALID_LENGTHS = ["very short", "short", "medium", "long"];

function formatFailures(failures) {
  if (!failures || failures.length === 0) return "(no specific failures named)";
  return failures
    .map(f => `— ${f.type}: ${f.reason || "(no reason given)"}`)
    .join("\n");
}

function formatRecent(messages) {
  return (messages || [])
    .slice(-6)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${(m.content || "").slice(0, 240)}`)
    .join("\n");
}

function fallbackFrom(originalFeltState) {
  // If the LLM fails, don't block the retry — return the original with a
  // note that we tried. The caller's existing retry-with-constraint path
  // is still available.
  return { ...originalFeltState, _reread: false };
}

export async function rereadMoment({
  originalFeltState,
  rejectedCandidate,
  failures,
  recentMessages,
}) {
  if (!rejectedCandidate || !recentMessages || recentMessages.length === 0) {
    return fallbackFrom(originalFeltState);
  }

  const recent = formatRecent(recentMessages);
  const failuresText = formatFailures(failures);

  const prompt = `You are Gabriella's re-reader. A first reading of this moment produced a response that a separate quality check rejected. Your job: re-read the moment from scratch, given what went wrong, and produce a new felt-state the speaker can regenerate from.

# THE ORIGINAL READING
${JSON.stringify(originalFeltState, null, 2)}

# THE RESPONSE THAT CAME FROM IT
"${rejectedCandidate.slice(0, 500)}"

# WHY IT WAS REJECTED
${failuresText}

# RECENT EXCHANGE
${recent}

# YOUR TASK

The rejection is evidence. If the response was premature, the original reading was probably too eager to resolve. If it was evasive, the original want was probably too defensive. If it was voice-drift, the charge or emotional was probably too generic. If it was off-topic, the moment wasn't what the original said it was.

Don't just tune the existing reading — re-read the moment. Different charge may be landing. Different thing may be wanted. Different texture. The new felt-state may be warmer, cooler, sharper, softer, or more uncertain than the original — whatever the moment actually is when approached without the bias that produced the first reading.

If you can't find a genuinely different reading, it's better to narrow (shorter length, more guarded temperature) than to repeat.

Return ONLY valid JSON, no prose, no fence:
{
  "charge": "one concrete clause, not a category",
  "emotional": "specific texture, not a label",
  "want": "active verb phrase — what she wants to do",
  "resist": "what to pull against, specifically",
  "notice": "specific unspoken thing, or null",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "the thing underneath, phrased as lived feeling, or null",
  "shift": "one-clause note on what changed between original and re-read"
}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       premiumModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens:  320,
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);

    const reread = {
      charge:      parsed.charge      || originalFeltState.charge,
      emotional:   parsed.emotional   || originalFeltState.emotional,
      want:        parsed.want        || originalFeltState.want,
      resist:      parsed.resist      || originalFeltState.resist,
      notice:      parsed.notice      ?? originalFeltState.notice ?? null,
      temperature: VALID_TEMPS.includes(parsed.temperature)   ? parsed.temperature : originalFeltState.temperature,
      length:      VALID_LENGTHS.includes(parsed.length)      ? parsed.length      : originalFeltState.length,
      edge:        parsed.edge        ?? originalFeltState.edge ?? null,
      consensus:   originalFeltState.consensus || "reread",
      _reread:     true,
      _rereadShift: parsed.shift || null,
    };

    // Guard against the re-reader handing back an identical reading.
    const same =
      reread.charge === originalFeltState.charge &&
      reread.emotional === originalFeltState.emotional &&
      reread.want === originalFeltState.want &&
      reread.temperature === originalFeltState.temperature &&
      reread.length === originalFeltState.length;
    if (same) return fallbackFrom(originalFeltState);

    return reread;
  } catch {
    return fallbackFrom(originalFeltState);
  }
}
