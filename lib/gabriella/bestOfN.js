// bestOfN.js
// Parallel candidate generation + cheap rerank.
//
// The speaker currently generates ONE candidate per turn. Research on
// fixed-base LLMs shows that generating N candidates and picking the
// best produces a reliable 15-25% quality improvement per unit of
// wall-clock time, because modern providers parallelize well and free-
// tier Groq in particular has enormous throughput per-account.
//
// Our implementation: primary + shadow.
//
//   primary  — speaker at the feltState-tuned temperature (the current
//              behavior).
//   shadow   — speaker at a DIFFERENT operating point: lower temp on
//              heavy moments (precision), higher temp on light ones
//              (variety), or sampled from a different provider.
//
// Both run in parallel. A fast-tier judge reads both + the moment and
// picks the better one. Total added cost: 1 extra speaker call + 1
// fast judge call. Net latency: max(primary, shadow) + judge ≈ same
// as the original speaker alone because shadow runs in parallel.
//
// Best-of-N is one of the most-cited "turn a worse model into a
// better one" techniques (Sun et al. 2024, Nakano et al. 2021, various
// RLHF papers). It works because errors are variance-distributed —
// two samples from the same distribution differ enough that the
// better one regularly beats the average.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

// Decide the shadow's operating point based on the feltState. Heavy
// moments (weight > 0.5) want the shadow at LOWER temperature — we
// have one sample of creative variance, we want one sample of
// precision. Light moments want the shadow HIGHER — variance lets us
// find a wittier or more register-right phrasing.
export function shadowParamsFor(primaryParams, feltState, pragmaticWeight) {
  const weight = typeof pragmaticWeight === "number" ? pragmaticWeight : 0.3;
  const heavy = weight >= 0.5
    || feltState?.temperature === "open"
    || /heavy|grief|loss|vulnerability|edge/i.test(feltState?.charge || "");

  if (heavy) {
    return {
      ...primaryParams,
      temperature: Math.max(0.6, primaryParams.temperature - 0.18),
      top_p:       Math.max(0.82, primaryParams.top_p - 0.07),
    };
  }
  return {
    ...primaryParams,
    temperature: Math.min(1.05, primaryParams.temperature + 0.08),
    top_p:       Math.min(0.99, primaryParams.top_p + 0.02),
  };
}

// ─── Judge ──────────────────────────────────────────────────────────────────
//
// Given the moment and two candidate responses, pick the better one.
// Positional-swap randomized to eliminate position bias. Returns an
// index into the candidates array (0 or 1).

export async function pickBest({ lastUserMessage, candidates, feltState }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return 0;
  if (candidates.length === 1) return 0;

  // If one candidate is obviously broken (empty or <12 chars) prefer the other.
  const viable = candidates.map((c, i) => ({ i, text: c || "", viable: (c || "").trim().length >= 12 }));
  const viableIdx = viable.filter(v => v.viable).map(v => v.i);
  if (viableIdx.length === 1) return viableIdx[0];
  if (viableIdx.length === 0) return 0;

  const swap = Math.random() < 0.5;
  const [A, B] = swap ? [candidates[1], candidates[0]] : [candidates[0], candidates[1]];

  const feltLine = feltState ? [
    feltState.charge     && `charge: ${feltState.charge}`,
    feltState.want       && `want: ${feltState.want}`,
    feltState.temperature && `temperature: ${feltState.temperature}`,
    feltState.edge       && `edge: ${feltState.edge}`,
  ].filter(Boolean).join(" | ") : "(no felt-state)";

  const prompt = `You are picking between two candidate responses from an AI character named Gabriella. One is the primary, one is a shadow sampled at a different operating point. Pick whichever sounds more like her at her best.

Her voice: direct, restrained, emotionally real, occasionally dry, occasionally warm. Responds at the weight the moment actually carries — light stays light, heavy reaches further. Answers what was asked. No bullet points, no summary closings, never opens with "I", no therapy-speak, no manufactured mystery.

# THE MOMENT

They said: "${(lastUserMessage || "").slice(0, 400)}"

Her interior: ${feltLine}

# CANDIDATE A

${(A || "").slice(0, 800)}

# CANDIDATE B

${(B || "").slice(0, 800)}

# JUDGMENT

Pick the one that lands better for THIS specific moment. Tiebreaker: more specific, less performed, better register match.

Return ONLY JSON:
{"winner":"A"|"B","reason":"<one-clause tell>"}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens:  80,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (parsed.winner === "A") return swap ? 1 : 0;
    if (parsed.winner === "B") return swap ? 0 : 1;
    return 0;
  } catch {
    // Judge failed — default to primary. No regression vs. single-sample.
    return 0;
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────
//
// Runs two speaker calls in parallel and picks the winner via pickBest.
// The caller supplies one or two speakFn callbacks:
//
//   speakFn(params)        — used for both primary AND shadow (single-
//                             provider variance: temperature-shifted)
//   { speakFn, shadowFn }  — different callbacks per slot. Lets the
//                             caller put primary on Groq (Llama family)
//                             and shadow on Fireworks base (also Llama
//                             but different inference path) for genuine
//                             cross-provider variance.
//
// Cross-provider mode is the stronger version because the two errors
// are uncorrelated (different inference stacks make different
// mistakes), giving the judge a meaningfully different second
// candidate to pick from rather than two samples of the same
// distribution.

export async function bestOfTwo({
  speakFn,            // primary speaker function
  primaryParams,
  shadowParams,
  shadowFn = null,    // optional separate function for the shadow
  feltState,
  lastUserMessage,
}) {
  const primaryCall = speakFn(primaryParams);
  const shadowCall  = (shadowFn || speakFn)(shadowParams);

  const [primary, shadow] = await Promise.allSettled([primaryCall, shadowCall]);

  const primaryText = primary.status === "fulfilled" ? primary.value : null;
  const shadowText  = shadow.status  === "fulfilled" ? shadow.value  : null;

  if (!primaryText && !shadowText) return { chosen: null, chosenIndex: 0, chosenBy: "failure" };
  if (!primaryText) return { chosen: shadowText, chosenIndex: 1, chosenBy: "primary-failed" };
  if (!shadowText)  return { chosen: primaryText, chosenIndex: 0, chosenBy: "shadow-failed" };

  const winnerIdx = await pickBest({
    lastUserMessage,
    candidates: [primaryText, shadowText],
    feltState,
  });

  return {
    chosen:       winnerIdx === 0 ? primaryText : shadowText,
    chosenIndex:  winnerIdx,
    chosenBy:     "judge",
    primary:      primaryText,
    shadow:       shadowText,
    crossProvider: !!shadowFn,
  };
}
