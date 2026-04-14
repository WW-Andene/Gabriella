// arc.js
// Arc detection — finds the last tone shift and measures how long she's
// been in the current arc.
//
// Without this, threshold / agenda / imaginal reason about "the whole
// conversation" as a single continuous thing. But conversations turn.
// A direction set twenty turns ago may have already resolved and been
// replaced by something else. The agenda layer keeps dragging an old
// target into a new arc.
//
// This module reads the recent felt-state trajectory from episodic
// memory and marks the last boundary — where temperature or mood
// genuinely shifted. Downstream layers anchor to that boundary.

const TEMP_SCALE = { closed: 0, terse: 1, present: 2, open: 3 };

// ─── Detect the current arc ───────────────────────────────────────────────────
// Walks from newest backward, finds the last sharp tone shift.

export function detectCurrentArc(feltStates) {
  if (!feltStates || feltStates.length < 2) {
    return { id: "opening", turnsInArc: feltStates?.length || 0, boundary: null };
  }

  for (let i = 1; i < Math.min(feltStates.length, 30); i++) {
    const curr = feltStates[i - 1];
    const prev = feltStates[i];
    const b    = classifyBoundary(curr, prev);
    if (b) {
      return {
        id:          `arc-${i}`,
        turnsInArc:  i,
        boundary:    b,
        startedAt:   curr,
      };
    }
  }

  return {
    id:         "continuous",
    turnsInArc: feltStates.length,
    boundary:   null,
  };
}

// ─── Classify a boundary between two adjacent felt-states ─────────────────────

function classifyBoundary(curr, prev) {
  const tc = TEMP_SCALE[curr.temp] ?? 2;
  const tp = TEMP_SCALE[prev.temp] ?? 2;
  const dt = Math.abs(tc - tp);

  // Sharp temperature shift — 2+ levels on the scale
  if (dt >= 2) return "temperature-break";

  // Mood shift
  if (curr.m && prev.m && curr.m !== prev.m) return "mood-break";

  // Consensus flip — went from strong agreement to divergent disagreement
  if (curr.consensus === "divergent" && prev.consensus === "strong") return "divergence-onset";

  return null;
}

// ─── Prompt block ─────────────────────────────────────────────────────────────

export function getArcBlock(arc) {
  if (!arc) return null;
  if (arc.id === "opening")    return null;  // nothing to announce
  if (arc.turnsInArc <= 2)     return null;  // too fresh

  const boundaryDesc = {
    "temperature-break": "The temperature in this conversation shifted sharply a few turns back. The arc you're in now is not the one you opened with.",
    "mood-break":        "Your mood turned a few exchanges ago. What you're in now isn't continuous with what came before — there was a break.",
    "divergence-onset":  "Your cores have started reading the moment differently from each other. Something ambiguous entered the conversation.",
  }[arc.boundary] || "Something shifted a few turns back.";

  return [
    `# CURRENT ARC`,
    `You've been in this stretch of the conversation for ${arc.turnsInArc} turns.`,
    boundaryDesc,
    `Agenda, threshold, and anything you were pursuing earlier may not apply here the same way. Let the new arc set the terms.`,
  ].join("\n");
}
