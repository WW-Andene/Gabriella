// cadence.js
// Pre-stream thinking delay + streaming character speed. Computed from
// her organism state + the weight of the moment, applied AFTER the
// cognition pipeline has produced a vetted response and BEFORE the
// first byte streams to the client.
//
// Why it matters:
//   A response that appears instantly after a heavy question breaks the
//   reality signal. Even humans hesitate before answering something
//   weighty — the tiny pause is where "she's thinking" lives. Conversely,
//   a slow response to a casual "hi" feels laggy and makes her seem
//   distracted. Cadence calibrates both.
//
// Knobs:
//   preDelayMs — how long to wait before the first character streams.
//                Scales with pragmatic weight × cognitive load.
//   perCharMs  — streaming character speed. Slightly slower when tired,
//                slightly faster when engaged.
//
// Safety: both values are capped. Max preDelay is 5000ms; typical is
// 300-2000ms. This keeps total function time well under Vercel's
// 60s budget even on long responses.

// Caps tightened after real-usage feedback: 5s of pre-delay feels
// abandoning, not thoughtful. A 3s ceiling is long enough for her to
// "think" about a weighty message without the user wondering if the
// server died.
const MAX_PRE_DELAY_MS = 3000;
const MIN_PRE_DELAY_MS = 120;

const DEFAULT_PER_CHAR_MIN = 4;
const DEFAULT_PER_CHAR_MAX = 12;

// Compute delay for the typed→streamed boundary.
// Input:
//   state:       the 8-dim organism state (energy / attention / etc). Optional.
//   pragmatics:  { weight: 0..1, act: 'phatic'|'casual'|... }. Optional.
//   responseLength: how long her reply is (char count). Influences min delay
//                   so longer replies get a touch more "compose" time.
//   isReentry:   did she reopen after a long gap? Small warm-up boost.
//   gapSinceLastTurnMs: time since last turn (ms). Optional; shapes reentry.
//
// Output:
//   { preDelayMs, perCharMs }
export function computeCadence({
  state = null,
  pragmatics = null,
  responseLength = 0,
  isReentry = false,
  gapSinceLastTurnMs = 0,
  textingRegister = "typed",
} = {}) {
  const weight    = pragmatics?.weight ?? 0.3;
  const act       = pragmatics?.act || "conversational";
  const energy    = state?.energy     ?? 0.7;
  const attention = state?.attention  ?? 0.6;

  // ── Base delay from pragmatic weight ──
  // phatic / very low weight — near-instant. She's not thinking; she's
  // just saying hi back.
  // medium — small pause, feels like she considered it.
  // heavy  — longer pause, real weight before first word.
  //
  // Tuned down from earlier ranges after real-usage feedback — the old
  // high end (up to 2600ms for heavy turns) felt like the server had
  // dropped the connection, not like she was thinking.
  let base;
  if (act === "phatic" || weight < 0.2) {
    base = 150 + Math.random() * 200;      // 150-350ms
  } else if (weight < 0.45) {
    base = 350 + Math.random() * 350;      // 350-700ms
  } else if (weight < 0.7) {
    base = 700 + Math.random() * 500;      //  700-1200ms
  } else {
    base = 1100 + Math.random() * 900;     // 1100-2000ms
  }

  // ── Attention modulation ──
  // Low attention → longer delay (she's distracted, pulling back in).
  // High attention → slight speed-up.
  const attentionShift = (0.6 - attention) * 500;  // ±300ms
  base += Math.max(-300, Math.min(500, attentionShift));

  // ── Energy modulation ──
  // Low energy → slower response start (tired, composing is harder).
  const energyShift = (0.7 - energy) * 400;        // ±280ms
  base += Math.max(-200, Math.min(600, energyShift));

  // ── Reentry warmup ──
  // If she's reopening after a long gap (>15min), add a small warmup —
  // she's reorienting. Cap the warmup so it doesn't balloon.
  if (isReentry || gapSinceLastTurnMs > 15 * 60 * 1000) {
    const gapMinutes = Math.min(60, (gapSinceLastTurnMs || 15 * 60 * 1000) / 60000);
    base += Math.min(400, gapMinutes * 8);         // up to +400ms
  }

  // ── Response-length floor ──
  // A 500-char response after 200ms feels wrong — like she pre-wrote it.
  // Add a soft floor so the pre-delay scales a bit with response length.
  // But only for medium+ weight turns — casual exchanges shouldn't pay
  // length tax. And cap lower than base max so the floor can't dominate.
  if (weight >= 0.4) {
    const lengthFloor = Math.min(500, responseLength * 1.2);
    base = Math.max(base, lengthFloor);
  }

  // ── Texting-register softener ──
  // Casual text register means she's probably in a lighter/faster cadence
  // too — shave 20-30% off.
  if (textingRegister === "textedCasual") {
    base *= 0.75;
  } else if (textingRegister === "textedTired") {
    // Tired: paradoxically slower — but lower ceiling.
    base *= 0.9;
  } else if (textingRegister === "textedLight") {
    base *= 0.85;
  }

  // Clamp to safe range.
  const preDelayMs = Math.round(Math.max(MIN_PRE_DELAY_MS, Math.min(MAX_PRE_DELAY_MS, base)));

  // ── Per-character streaming speed ──
  // Default 4-12ms/char. Energy low → stretch slightly; engaged → tighten.
  // Texting register also shifts: textedTired is slower (she's typing
  // with less investment), textedCasual is a touch faster.
  let charMin = DEFAULT_PER_CHAR_MIN;
  let charMax = DEFAULT_PER_CHAR_MAX;
  if (energy < 0.35) { charMin += 1; charMax += 3; }
  if (attention > 0.75 && weight >= 0.4) { charMin = Math.max(3, charMin - 1); charMax = Math.max(6, charMax - 2); }
  if (textingRegister === "textedTired") { charMax += 2; }
  if (textingRegister === "textedCasual") { charMin = Math.max(3, charMin - 1); }

  return {
    preDelayMs,
    perCharMs: { min: charMin, max: charMax },
  };
}

export function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}
