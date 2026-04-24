// userRead.js
// Unified user-model read.
//
// person.js, narrative.js, userFingerprint.js, userPrefs.js, and
// identity-hooks.js all expose independent load-* functions that
// engine.js fires in parallel every turn. Each does its own Redis
// round-trip, its own JSON parse, its own defaulting. The cognition
// layer then reads each one individually and often misses
// cross-references (what a narrative calls 'the sister' may be a
// graph node with a fingerprint-warm valence and a person-model
// knownFact — none of which talks to the others).
//
// This module ships ONE call that returns a coherent UserRead:
//
//   {
//     person:       <person.js model>,
//     narrative:    <narrative.js text + meta>,
//     fingerprint:  <userFingerprint.js>,
//     prefs:        <userPrefs.js>,
//     identity:     <identity-hooks.js>,
//     // Derived, cross-module inferences:
//     stance:       "opening" | "testing" | "trusting" | "closed" | "unknown",
//     topInterests: [ { topic, score, valence } ],
//     heatmap:      { warmthRate, pullbackRate, selfQRate },
//     turnCount:    number,
//   }
//
// The derived fields are computed ONCE here so callers stop
// recomputing them. Saves dozens of lines of duplicated logic across
// turn.js, speaker.js, generation.js, and the planner.
//
// This is pure consolidation — every value it returns already existed;
// they just lived in seven different places.

import { loadPerson }          from "./person.js";
import { loadNarrative }       from "./narrative.js";
import { loadFingerprint,
         topInterests }        from "./userFingerprint.js";
import { loadUserPrefs }       from "./userPrefs.js";
import { loadIdentity }        from "./identity-hooks.js";

// ─── Main read ────────────────────────────────────────────────────────────────

export async function loadUserRead(redis, userId) {
  if (!redis || !userId) {
    return {
      person: null, narrative: null, fingerprint: null,
      prefs: { variant: "standard", customAnchor: null, setAt: 0 },
      identity: {},
      stance: "unknown",
      topInterests: [],
      heatmap: { warmthRate: 0, pullbackRate: 0, selfQRate: 0 },
      turnCount: 0,
    };
  }

  const [person, narrative, fingerprint, prefs, identity] = await Promise.all([
    loadPerson(redis, userId).catch(() => null),
    loadNarrative(redis, userId).catch(() => null),
    loadFingerprint(redis, userId).catch(() => null),
    loadUserPrefs(redis, userId).catch(() => ({ variant: "standard", customAnchor: null, setAt: 0 })),
    loadIdentity(redis, userId).catch(() => ({})),
  ]);

  // Derive stance from the fingerprint's warmth vs pullback event
  // rates. Needs >= 5 turns of data before committing to a label.
  const turnCount = fingerprint?.turnCount || 0;
  const warmth    = (fingerprint?.warmth   || []).length;
  const pullback  = (fingerprint?.pullback || []).length;
  const selfQs    = (fingerprint?.selfQs   || []).length;

  const warmthRate   = turnCount > 0 ? warmth   / turnCount : 0;
  const pullbackRate = turnCount > 0 ? pullback / turnCount : 0;
  const selfQRate    = turnCount > 0 ? selfQs   / turnCount : 0;

  let stance = "unknown";
  if (turnCount >= 5) {
    if (pullbackRate >= 0.25 && warmthRate < 0.1) stance = "closed";
    else if (selfQRate    >= 0.2  && warmthRate >= 0.15) stance = "trusting";
    else if (warmthRate   >= 0.15 && selfQRate  >= 0.1)  stance = "opening";
    else if (pullbackRate >= 0.15 && selfQRate  >= 0.15) stance = "testing";
    else                                                  stance = "neutral";
  }

  return {
    person, narrative, fingerprint, prefs, identity,
    stance,
    topInterests: topInterests(fingerprint, 5),
    heatmap: {
      warmthRate:   +warmthRate.toFixed(3),
      pullbackRate: +pullbackRate.toFixed(3),
      selfQRate:    +selfQRate.toFixed(3),
    },
    turnCount,
  };
}

// ─── Helper — compact, one-line stance description ───────────────────────────
// Useful for embedding in prompts or logs without rendering the full
// UserRead object.

export function describeStance(userRead) {
  if (!userRead) return null;
  const { stance, turnCount, heatmap, topInterests: ti } = userRead;
  if (stance === "unknown") return null;
  const topLabel = ti && ti[0] ? ti[0].topic : null;
  const parts = [
    `stance=${stance}`,
    `turns=${turnCount}`,
    `warmth=${(heatmap.warmthRate * 100).toFixed(0)}%`,
    `pullback=${(heatmap.pullbackRate * 100).toFixed(0)}%`,
    topLabel ? `top="${topLabel}"` : null,
  ].filter(Boolean);
  return parts.join(" ");
}
