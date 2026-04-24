// turnShape.js
// Single source of truth for per-turn routing.
//
// The cognition/speak/gauntlet pipeline has historically had fixed
// shape — every turn runs triple-core, every turn runs the full
// gauntlet, every turn of sufficient weight runs the rollout. That's
// what "bolted, not integrated" looked like: new signals informed the
// prompt but never routed the pipeline.
//
// turnShape computes ONCE from all the read-layer signals and returns
// a structured routing object. Downstream modules (turn.js, speaker,
// gauntlet, bestOfN) consume it instead of re-deriving decisions.
//
// Routing knobs produced:
//
//   cognitionPath: "triple" | "unified" | "lean"
//       "triple"   — heavy moment, divergent read, active tension, or
//                    testing stance. The perspective splits are worth
//                    the cost.
//       "lean"     — trusting stance + medium-or-lighter weight +
//                    stable mood. One pass is enough.
//       "unified"  — env flag or pool dead (degraded).
//
//   gauntletMode:  "full" | "lean" | "skip"
//       "skip"     — trusting stance + low pragmatic weight, no
//                    provocation/correction markers. Already-good
//                    responses don't need 7 checks.
//       "lean"     — 3 critical checks only (premature, exposed,
//                    voice-drift).
//       "full"     — default for heavy, testing, closed, correction.
//
//   rolloutPolicy: { enabled, threshold, depth }
//       enabled    — run counterfactual rollout at all this turn?
//       threshold  — min overall trajectory score to accept chosen
//                    candidate. Higher on heavy + testing; lower
//                    on trusting.
//       depth      — 1 (current: simulate turn+1 only). Reserved for
//                    multi-depth extensions.
//
//   adaptSignals: bundle of userRead + styleOutcomes for Step VV's
//                 adaptiveParams. Computed once here, threaded through
//                 so speaker doesn't re-fetch.
//
//   activeTension: the dialectical tension most relevant to this
//                  moment's topic (if any). Raised to cognition so
//                  she can speak FROM the tension instead of ignoring
//                  it.

import { unifiedCognition }   from "./models.js";
import { poolStats }          from "./groqPool.js";
import { loadUserRead }       from "./userRead.js";
import { loadStyleOutcomes }  from "./learningLoop.js";
import { loadTensions }       from "./dialectical.js";

// ─── Heuristic markers on the user's latest message ──────────────────────────
// Zero-LLM. Used to override routing decisions when the message itself
// is signal-rich enough that we should not skip / reduce.

const PROVOCATION_MARKERS = [
  /\b(do you actually|are you just|are you really|pretending|fake|lying)\b/i,
  /\b(bullshit|bs|cut the)\b/i,
];
const CORRECTION_MARKERS = [
  /\b(no\.|wrong|incorrect|that'?s not|you'?re wrong)\b/i,
  /\bwhy (did|would|do) you/i,
];
const HEAVY_MARKERS = [
  /\b(scared|afraid|hurt|hurting|grief|grieving|lost|trapped|alone|lonely|dying|suicidal|empty|numb|ashamed|broken)\b/i,
  /\b(i (just|can't|don't know|need|feel like))\b/i,
];

function detectMessageMarkers(userMsg) {
  const t = String(userMsg || "");
  return {
    provocation: PROVOCATION_MARKERS.some(r => r.test(t)),
    correction:  CORRECTION_MARKERS.some(r => r.test(t)),
    heavy:       HEAVY_MARKERS.some(r => r.test(t)),
  };
}

// ─── Active tension matcher ──────────────────────────────────────────────────
// Given the tension list + the current message, find the most relevant
// tension (topic overlap via case-insensitive substring).

function matchActiveTension(tensions, userMsg) {
  if (!tensions || tensions.length === 0 || !userMsg) return null;
  const text = String(userMsg).toLowerCase();
  for (const t of tensions) {
    const topic = String(t.topic || "").toLowerCase().trim();
    if (topic && topic.length >= 3 && text.includes(topic)) return t;
  }
  return null;
}

// ─── Main computation ────────────────────────────────────────────────────────

export async function computeTurnShape({
  redis,
  userId,
  pragmatics,
  messages,
  consensusFromCognition,   // optional: pass from cognition result if already computed
}) {
  const userMsg = messages?.[messages.length - 1]?.content || "";
  const markers = detectMessageMarkers(userMsg);
  const weight  = typeof pragmatics?.weight === "number" ? pragmatics.weight : 0.3;

  // Parallel-fetch read-layer signals. All are Redis reads with
  // in-module caching; cost is 3-5 quick round-trips, worth the
  // routing coherence.
  const [userRead, styleOutcomes, tensions] = await Promise.all([
    loadUserRead(redis, userId).catch(() => null),
    loadStyleOutcomes(redis, userId).catch(() => null),
    loadTensions(redis, userId).catch(() => []),
  ]);

  const stance       = userRead?.stance || "unknown";
  const turnCount    = userRead?.turnCount || 0;
  const activeTension = matchActiveTension(tensions, userMsg);

  // ── cognitionPath ──
  const poolLive = poolStats().aliveCount > 0;
  let cognitionPath;
  if (!poolLive || unifiedCognition()) {
    cognitionPath = "unified";
  } else if (
    weight >= 0.5 ||
    markers.heavy ||
    markers.provocation ||
    markers.correction ||
    activeTension ||
    stance === "testing" ||
    stance === "closed" ||
    (consensusFromCognition === "divergent")
  ) {
    cognitionPath = "triple";
  } else if (
    stance === "trusting" &&
    weight < 0.4 &&
    turnCount >= 10 &&
    !markers.heavy
  ) {
    cognitionPath = "lean";
  } else {
    // Default: keep triple-core until we have clear signal to lean —
    // perspective-splitting is the baseline, leaning is the earned
    // shortcut.
    cognitionPath = "triple";
  }

  // ── gauntletMode ──
  let gauntletMode;
  if (
    stance === "trusting" &&
    weight < 0.25 &&
    !markers.provocation &&
    !markers.correction &&
    !markers.heavy &&
    turnCount >= 20
  ) {
    gauntletMode = "skip";
  } else if (
    (stance === "trusting" || stance === "opening" || stance === "neutral") &&
    weight < 0.5 &&
    !markers.provocation &&
    !markers.correction
  ) {
    gauntletMode = "lean";
  } else {
    gauntletMode = "full";
  }

  // ── rolloutPolicy ──
  const rolloutEnabled =
    (weight >= 0.5 || markers.heavy || markers.correction || !!activeTension) &&
    stance !== "trusting";   // trusting users get the cheaper path

  const rolloutThreshold =
    (stance === "testing" || stance === "closed") ? 0.55 :
    markers.provocation || markers.correction       ? 0.6  :
    weight >= 0.75                                   ? 0.55 :
    0.5;

  return {
    // Routing decisions
    cognitionPath,
    gauntletMode,
    rolloutPolicy: {
      enabled:   rolloutEnabled,
      threshold: rolloutThreshold,
      depth:     1,
    },
    // Raw signal bundles (used by adaptiveParams, renderers, log)
    adaptSignals: {
      styleOutcomes,
      stance,
      heatmap:          userRead?.heatmap || null,
      rolloutConfidence: null,   // populated post-rollout in turn.js
    },
    activeTension,
    markers,
    weight,
    stance,
    turnCount,
    userRead,
  };
}

// ─── Explain — summarize routing for logs / stats ─────────────────────────────

export function explainShape(shape) {
  if (!shape) return null;
  const parts = [
    `cognition=${shape.cognitionPath}`,
    `gauntlet=${shape.gauntletMode}`,
    `rollout=${shape.rolloutPolicy?.enabled ? "on" : "off"}${shape.rolloutPolicy?.enabled ? `@${shape.rolloutPolicy.threshold}` : ""}`,
    `stance=${shape.stance}`,
    `w=${shape.weight?.toFixed(2)}`,
  ];
  if (shape.markers?.provocation) parts.push("provocation");
  if (shape.markers?.correction)  parts.push("correction");
  if (shape.markers?.heavy)       parts.push("heavy");
  if (shape.activeTension)        parts.push(`tension(${shape.activeTension.topic})`);
  return parts.join(" | ");
}
