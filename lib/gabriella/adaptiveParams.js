// adaptiveParams.js
// Signal-coupled generation parameters.
//
// The existing path: presence.js picks { temperature, top_p, top_k,
// max_tokens } from the current mood, and speaker.js uses them as-is.
// That's fine as a prior; it doesn't adapt.
//
// This module tunes those params with per-user signals that are
// already flowing through the engine:
//
//   - Closed learning loop (styleOutcomes): if 'brief' is landing and
//     'long' is missing, bias toward shorter max_tokens and lower
//     temperature (less meandering).
//   - User fingerprint stance: a 'closed' user gets cooler temperature
//     (less improvisation); 'trusting' gets warmer (more variance to
//     keep it alive).
//   - Rollout confidence (if Step NN rolled out): high-confidence pick
//     lets us generate more tokens; low-confidence shortens + cools.
//   - Privacy mode: never changes params; privacy is orthogonal.
//
// Delta-bounded: no single adjustment can move any param by more
// than its configured CAP, and the net adjustment from all signals
// is clamped to preserve voice coherence. This is a nudge, not a
// rewrite — the mood-driven prior stays dominant.

const CAPS = {
  temperature: 0.10,   // +/- 0.10 from prior
  top_p:       0.05,   // +/- 0.05
  max_tokens:  0.30,   // +/- 30% of prior
};

export function adaptParams(baseParams, signals) {
  if (!baseParams) return baseParams;
  const base = { ...baseParams };
  const s = signals || {};

  let dTemp = 0;
  let dTopP = 0;
  let dMaxFactor = 1;  // multiplicative for max_tokens

  // ── Style outcomes — landing/missing tag EMAs ──
  const land = new Set((s.styleOutcomes?.landing || []).map(x => x.tag));
  const miss = new Set((s.styleOutcomes?.missing || []).map(x => x.tag));
  if (land.has("brief")  && miss.has("long"))      dMaxFactor *= 0.80;
  if (land.has("long")   && miss.has("brief"))     dMaxFactor *= 1.15;
  if (land.has("direct") && miss.has("hedged"))    dTemp -= 0.04;
  if (land.has("hedged") && miss.has("direct"))    dTemp += 0.03;
  if (land.has("playful"))                          dTemp += 0.02;
  if (miss.has("playful"))                          dTemp -= 0.02;
  if (land.has("vulnerable") && miss.has("direct")) dTemp += 0.03;

  // ── Fingerprint stance — derived in userRead.js ──
  const stance = s.stance || "unknown";
  if (stance === "closed") {
    dTemp -= 0.05;
    dTopP -= 0.02;
    dMaxFactor *= 0.85;
  } else if (stance === "trusting") {
    dTemp += 0.03;
  } else if (stance === "opening") {
    dTemp += 0.02;
    dMaxFactor *= 1.05;
  } else if (stance === "testing") {
    dTemp -= 0.02;
    dMaxFactor *= 0.9;
  }

  // ── Rollout confidence (0..1) — only meaningful when heavy-moment rollout fired ──
  const rc = typeof s.rolloutConfidence === "number" ? s.rolloutConfidence : null;
  if (rc !== null) {
    if (rc >= 0.8)      dMaxFactor *= 1.10;   // high confidence — let it run
    else if (rc <= 0.4) { dMaxFactor *= 0.80; dTemp -= 0.03; }   // low — cool and shorten
  }

  // ── High pullback rate from the user — protective restraint ──
  const pullbackRate = s.heatmap?.pullbackRate || 0;
  if (pullbackRate >= 0.2) {
    dTemp -= 0.04;
    dMaxFactor *= 0.8;
  }

  // ── Clamp to caps ──
  dTemp      = Math.max(-CAPS.temperature, Math.min(CAPS.temperature, dTemp));
  dTopP      = Math.max(-CAPS.top_p,       Math.min(CAPS.top_p,       dTopP));
  dMaxFactor = Math.max(1 - CAPS.max_tokens, Math.min(1 + CAPS.max_tokens, dMaxFactor));

  // ── Apply ──
  const out = {
    ...base,
    temperature: clamp(base.temperature + dTemp, 0.3, 1.2),
    top_p:       clamp((base.top_p || 0.9) + dTopP, 0.5, 0.99),
    max_tokens:  Math.max(40, Math.round((base.max_tokens || 320) * dMaxFactor)),
  };

  // Preserve any other keys caller passed (top_k, frequency_penalty, etc.)
  return out;
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// ─── Explain — for logs / /api/explain / /stats ──────────────────────────────
// Returns a short string explaining what moved and by how much.

export function explainAdaptation(baseParams, outParams) {
  if (!baseParams || !outParams) return null;
  const parts = [];
  const dt = +(outParams.temperature - baseParams.temperature).toFixed(3);
  const dp = +(outParams.top_p - (baseParams.top_p || 0.9)).toFixed(3);
  const mFactor = +(outParams.max_tokens / (baseParams.max_tokens || 1)).toFixed(2);
  if (Math.abs(dt) >= 0.01)     parts.push(`temp ${dt >= 0 ? "+" : ""}${dt}`);
  if (Math.abs(dp) >= 0.01)     parts.push(`top_p ${dp >= 0 ? "+" : ""}${dp}`);
  if (Math.abs(mFactor - 1) >= 0.05) parts.push(`max_tokens ×${mFactor}`);
  return parts.length > 0 ? parts.join(", ") : "no adjustment";
}
