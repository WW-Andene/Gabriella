// fragmenter.js
// Splits a vetted response into 1..N natural-send fragments and computes
// the inter-fragment pauses. Runs AFTER shape() and BEFORE streaming.
//
// Reference: substrate.texting.fragmentSends.
//   when: second thought genuinely arrived, sharpening, follow-up, emphasis
//   never: manufacture presence, simulate urgency, flood, serious moment
//   typical cadence: main → short aside, 2-8s apart
//
// Design:
//   - Default is no fragmenting. Only fragments when eligible AND a natural
//     break exists AND probability check passes. Most turns stay single-send.
//   - Eligibility gates on texting register (casual/light), pragmatic weight
//     (< 0.65), message length (> 140 chars), and NOT on protector part
//     (defensive mode stays brief, not scattered).
//   - Natural breaks:
//       A) Final sentence is short (≤ ~50 chars) AND prior text is long
//          enough to stand alone. The short closer becomes the aside.
//       B) A mid-response "actually," / "wait," / "also," / "and honestly,"
//          clause pivots to a new thought — split there.
//   - Pauses: 1.5-5s between fragments, scaled by social comfort + fragment
//     length. Capped to keep total function time safe.

const FRAGMENT_PROBABILITY = 0.35;   // even when eligible, most turns stay whole
const MIN_TEXT_LEN         = 140;    // below this, never fragment
const MAX_FRAGMENT_COUNT   = 3;      // cap
// Shortened from earlier 1500-5000ms after real-usage feedback.
// A 5s gap between bubbles reads as "she's gone", not "second thought".
// 900-2500ms keeps the aside feeling like an aside.
const PAUSE_MIN_MS         = 900;
const PAUSE_MAX_MS         = 2500;

// Clause-pivot markers that signal a natural fragment boundary. These are
// mid-response shifts where splitting feels like a second thought arriving.
const PIVOT_MARKERS = [
  /\.\s+(Actually|Wait|Also|Oh|And honestly|Actually wait|One more thing|Though)[,\s]/,
];

// Consider splitting a response into fragments. Returns { fragments, pauses }.
// fragments.length === 1 means no fragmenting happened.
//
// input:
//   text:        the final shaped response
//   context:     { knobs, pragmatics, state, disableRandom }
//
// output:
//   { fragments: [string, ...], pauses: [msBetween1And2, ...] }
export function maybeFragment(text, context = {}) {
  if (!text) return { fragments: [text], pauses: [] };

  const knobs      = context.knobs || null;
  const pragmatics = context.pragmatics || null;
  const state      = context.state || null;

  const weight    = pragmatics?.weight ?? 0.3;
  const register  = knobs?.textingRegister || "typed";
  const activePart = knobs?.activePart || "observer";
  const comfort   = state?.socialComfort ?? 0.5;

  // ── Gates ──
  if (text.length < MIN_TEXT_LEN)     return solo(text);
  if (weight >= 0.65)                 return solo(text);
  if (activePart === "protector")     return solo(text);
  if (register === "typed")           return solo(text);

  // Probabilistic — even when eligible, only fragment sometimes.
  const roll = context.disableRandom ? 1 : Math.random();
  if (roll > FRAGMENT_PROBABILITY)    return solo(text);

  // ── Find a natural break ──
  const split = findNaturalBreak(text);
  if (!split) return solo(text);

  const fragments = split;
  const pauses = computePauses(fragments, { comfort, register, state });

  return { fragments, pauses };
}

function solo(text) {
  return { fragments: [text], pauses: [] };
}

// Try to find a natural break. Returns an array of 2-3 fragments or null.
function findNaturalBreak(text) {
  // A) Pivot marker mid-response — strongest signal.
  for (const rx of PIVOT_MARKERS) {
    const m = text.match(rx);
    if (m && m.index > 30 && m.index < text.length - 30) {
      const cut = m.index + 1;   // keep the period on the first chunk
      const first  = text.slice(0, cut).trim();
      const second = text.slice(cut).trim();
      if (first.length >= 30 && second.length >= 20) {
        return [first, second];
      }
    }
  }

  // B) Short final sentence as aside. Find the last sentence boundary.
  const lastBoundary = text.search(/[.!?]\s+[^.!?]+[.!?]?\s*$/);
  if (lastBoundary > 0) {
    const cut = lastBoundary + 1;
    const first = text.slice(0, cut).trim();
    const last  = text.slice(cut).trim();
    // Aside sweet spot: 15-60 chars, main body at least 80.
    if (last.length >= 15 && last.length <= 60 && first.length >= 80) {
      return [first, last];
    }
  }

  // C) Fallback: no natural break.
  return null;
}

// Compute the pause BETWEEN each fragment (one pause per gap between
// sequential fragments). Length-proportional — a longer next-fragment
// took longer to "think up" — bounded by PAUSE_MIN / PAUSE_MAX.
function computePauses(fragments, { comfort, register, state }) {
  if (fragments.length < 2) return [];
  const pauses = [];
  for (let i = 0; i < fragments.length - 1; i++) {
    const nextLen = fragments[i + 1].length;
    // Base: 1.2s + ~10ms per char of the NEXT fragment. Shorter than the
    // earlier tuning — still scales with next-fragment size but tops out
    // well below the abandonment threshold.
    let base = 1200 + Math.min(1200, nextLen * 10);

    // Comfort shaves pauses — more at-ease = less hesitation.
    base -= (comfort - 0.5) * 600;   // ±300ms

    // Register shaves — casual is quicker between sends.
    if (register === "textedCasual") base *= 0.8;
    if (register === "textedTired")  base *= 1.05;

    // Jitter — ±200ms.
    base += (Math.random() - 0.5) * 400;

    pauses.push(Math.round(Math.max(PAUSE_MIN_MS, Math.min(PAUSE_MAX_MS, base))));
  }
  return pauses;
}
