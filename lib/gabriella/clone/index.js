// clone/index.js
// Triple-core runner.
//
// Gabriella x3 — three independent processing paths, one synthesized output.
//
// Alpha, Beta, and Gamma run in full parallel. No shared state during processing.
// They receive the same context but approach it from different cognitive modes:
//   Alpha — emotional resonance. What does this moment feel like from inside?
//   Beta  — relational pattern. What does this moment reveal about the dynamic?
//   Gamma — temporal weight.  Where does this moment sit in the arc of what
//             has been and what is becoming?
//
// After all three complete, synthesis reads all three felt-states and produces
// one — richer than any alone, shaped by their agreement or their divergence.
//
// The rest of the pipeline (speaker, gauntlet, memory) sees only the
// synthesized felt-state. Gabriella is still one engine. She just thinks
// with three cores.

import { runAlpha } from "./alpha.js";
import { runBeta  } from "./beta.js";
import { runGamma } from "./gamma.js";
import { synthesize } from "./synthesis.js";

// ─── Main export ──────────────────────────────────────────────────────────────

export async function runTripleCore(context) {
  // Alpha, Beta, and Gamma run in full parallel — no serial dependency.
  // All receive the same context object. They do not communicate during processing.
  const [alphaResult, betaResult, gammaResult] = await Promise.all([
    runAlpha(context),
    runBeta(context),
    runGamma(context),
  ]);

  const { feltState: alphaFelt, voices: alphaVoices } = alphaResult;
  const { feltState: betaFelt,  voices: betaVoices  } = betaResult;
  const { feltState: gammaFelt, voices: gammaVoices } = gammaResult;

  // Synthesis coordinates what Alpha, Beta, and Gamma each arrived at
  const feltState = await synthesize(alphaFelt, betaFelt, gammaFelt);

  return {
    feltState,                           // single synthesized felt-state → goes to speaker
    alpha: { voices: alphaVoices, feltState: alphaFelt },  // for logging / inspection
    beta:  { voices: betaVoices,  feltState: betaFelt  },  // for logging / inspection
    gamma: { voices: gammaVoices, feltState: gammaFelt },  // for logging / inspection
    consensus: feltState.consensus,      // "strong" | "moderate" | "divergent"
  };
}

// ─── Legacy export (backward-compat) ─────────────────────────────────────────
// Callers using runDualCore still work — they just don't get Gamma.
export { runTripleCore as runDualCore };

