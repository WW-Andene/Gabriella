// models.js
// Central model config — two tiers, override per env var.
//
// Premium tier:   used wherever the call does long-form creative or
//                  analytical work. Cores, synthesis, speaker fallback,
//                  soul / evolution / memory / register / authorship
//                  rewrites, thought generation, imprint narration.
//
// Fast tier:      used wherever the call is a short classification —
//                  yes/no with a reason, a verdict, a small JSON. The
//                  gauntlet, metacognition deep-check, deflection /
//                  debt / threshold / imaginal / withheld evaluators,
//                  agenda tracking.
//
// The fast tier at 8B is noticeably cheaper and faster than the
// premium 17B tier while being entirely sufficient for classification.
// Per-exchange LLM budget drops by more than half without any
// measurable change to response quality.
//
// Override via:
//   GABRIELLA_PREMIUM_MODEL   — default: meta-llama/llama-4-scout-17b-16e-instruct
//   GABRIELLA_FAST_MODEL      — default: llama-3.1-8b-instant

const env = (name, fallback) => process.env[name] || fallback;

export const MODELS = {
  premium: env("GABRIELLA_PREMIUM_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
  fast:    env("GABRIELLA_FAST_MODEL",    "llama-3.1-8b-instant"),
};

// Convenience accessors — import these directly from call-sites so the
// usage reads as intent ("this is a fast classification") rather than
// as a model id.
export const premiumModel = () => MODELS.premium;
export const fastModel    = () => MODELS.fast;
