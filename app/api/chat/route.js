// app/api/chat/route.js
//
// Gabriella v7 chat route.
//
// Flow:
//   1. buildGabriella   — assembles full context (soul, memory, agenda, …)
//   2. runTripleCore    — three parallel cores (Alpha, Beta, Gamma) each
//                         interpret the moment; synthesis coordinates their
//                         readings into one felt-state.
//   3. patchLinguistics — upgrades the mood-seeded linguistics block in the
//                         system prompt to a felt-state-aware version.
//   4. speak            — receives only the felt-state and recent messages;
//                         generates a candidate response with a hidden
//                         <think> monologue prepended.
//   5. parseMonologue   — strip the hidden <think> block.
//   6. heuristicCheck   — instant banned-phrase / structural-tell scan.
//   7. gauntlet         — four LLM checks: premature, exposed, compliant,
//                         abandoned. Skipped for fallback-length replies.
//   8. retry / fallback — one constrained retry, then the terse fallback.
//   9. stream to client — client-visible response only.
//  10. background       — metacognition + all memory updates + log.

import { buildGabriella, updateGabriella, redis, USER_ID } from "../../../lib/gabriella/engine.js";
import { parseMonologue }                                   from "../../../lib/gabriella/monologue.js";
import { runMetacognition, heuristicCheck }                 from "../../../lib/gabriella/metacognition.js";
import { speak }                                            from "../../../lib/gabriella/speaker.js";
import { runGauntlet, getGauntletConstraintBlock, generateFallback } from "../../../lib/gabriella/gauntlet.js";
import { logExchange }                                      from "../../../lib/gabriella/logger.js";
import { patchSystemPromptLinguistics }                     from "../../../lib/gabriella/linguistics.js";
import { runTripleCore }                                    from "../../../lib/gabriella/clone/index.js";

// ─── Stream a completed string to the client ──────────────────────────────────
// Small, human-feeling chunks — not pre-token streaming, but the illusion of
// typing. The vetted response is complete before streaming begins.

function streamString(text, controller, encoder) {
  return new Promise((resolve) => {
    let i = 0;
    function sendNext() {
      if (i >= text.length) { resolve(); return; }
      const chunkSize = Math.floor(Math.random() * 4) + 2;
      controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      i += chunkSize;
      setTimeout(sendNext, Math.random() * 8 + 4);
    }
    sendNext();
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req) {
  try {
    const { messages } = await req.json();

    // 1. Build full context
    const {
      systemPrompt,
      recentMessages,
      memory,
      currentMood,
      withheldCandidate,
      debtCall,
      activeAgenda,
      activeThreshold,
      currentRegister,
      currentAuthorial,
      ripeSeed,
      questionEval,
    } = await buildGabriella(messages);

    // 2. Load withheld items for the cores and the gauntlet
    const withheldRaw = await redis.get(`${USER_ID}:withheld`);
    const withheld = withheldRaw
      ? (typeof withheldRaw === "string" ? JSON.parse(withheldRaw) : withheldRaw).filter(w => !w.surfaced)
      : [];

    // 3. Triple-core: Alpha (emotional resonance) + Beta (relational pattern)
    //    + Gamma (temporal weight) run in parallel, then synthesis coordinates.
    //    All relational signals are plumbed through so every core can feel
    //    them — v3's interpreter saw threshold / imaginal / debt; v6's cores
    //    did not. v7 passes the full context.
    const {
      feltState,
      alpha: alphaResult,
      beta:  betaResult,
      gamma: gammaResult,
      consensus,
    } = await runTripleCore({
      soul:          memory.soul,
      recentMessages,
      memory,
      currentMood,
      agenda:        activeAgenda,
      debt:          debtCall,
      withheld,
      register:      currentRegister,
      authorial:     currentAuthorial,
      threshold:     activeThreshold,
      imaginal:      ripeSeed,
    });

    // 3a. Upgrade the linguistics block with the full felt-state.
    //     (Kept for logging / downstream inspection — the speaker builds its
    //     own prompt from the felt-state directly, not from this string.)
    const enrichedSystemPrompt = patchSystemPromptLinguistics(systemPrompt, feltState, currentMood);

    // 3b. Tag felt-state with mood so the speaker's linguistics block picks
    //     up the current mood palette without a second parameter.
    const taggedFeltState = { ...feltState, _mood: currentMood };

    // 4. Speaker receives felt-state + messages — no identity, no soul.
    const rawCandidate = await speak(taggedFeltState, recentMessages);
    const { innerThought: thought1, response: candidate } = parseMonologue(rawCandidate);

    // 5. Heuristic pre-check — instant, no LLM cost.
    const heuristic               = heuristicCheck(candidate);
    const candidateNeedsGauntlet  = heuristic.authentic;

    // 6. Gauntlet — only run full LLM checks if heuristic passed.
    //    questionEval is passed through so checkCompliant sees the deflection
    //    verdict (v3 hardcoded null here and made the check a no-op).
    const gauntletResult = candidateNeedsGauntlet
      ? await runGauntlet(candidate, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
      : { pass: false, failures: [{ type: "HEURISTIC", reason: heuristic.reason }] };

    let finalResponse = candidate;
    let innerThought  = thought1;

    if (!gauntletResult.pass) {
      // 6a. One retry — inject the gauntlet's constraint into the felt-state
      //     and re-speak. The speaker doesn't see the failures directly;
      //     it sees a sharpened `resist` clause.
      const constraintNote = getGauntletConstraintBlock(gauntletResult.failures);
      const constraintBullets = constraintNote
        .split("\n")
        .filter(l => l.startsWith("—"))
        .join(" ");

      const constrainedFeltState = {
        ...taggedFeltState,
        resist: `${taggedFeltState.resist}. ${constraintBullets}`,
      };

      const rawRetry = await speak(constrainedFeltState, recentMessages);
      const { innerThought: thought2, response: retry } = parseMonologue(rawRetry);

      // Heuristic check on retry before spending the LLM gauntlet again
      const retryHeuristic = heuristicCheck(retry);
      const retryGauntlet  = retryHeuristic.authentic
        ? await runGauntlet(retry, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
        : { pass: false, failures: [{ type: "HEURISTIC", reason: retryHeuristic.reason }] };

      if (retryGauntlet.pass) {
        finalResponse = retry;
        innerThought  = thought2;
      } else {
        // 6b. Both failed — terse fallback, one honest sentence.
        finalResponse = await generateFallback(
          recentMessages,
          "Say as little as possible. One sentence. Be present. Nothing more.",
        );
        innerThought = null;
      }
    }

    // 7. Stream to client
    const encoder  = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        await streamString(finalResponse, controller, encoder);
        controller.close();

        // 8. Background updates — fire-and-forget after the client is served.
        Promise.all([
          updateGabriella(
            messages, finalResponse, memory,
            withheldCandidate, debtCall, activeAgenda, activeThreshold,
            currentRegister, currentAuthorial, ripeSeed,
          ),
          runMetacognition(finalResponse, innerThought, redis, USER_ID),
          logExchange(redis, USER_ID, {
            messages,
            feltState,
            innerThought,
            response:  finalResponse,
            mood:      currentMood,
            agenda:    activeAgenda,
            soul:      memory.soul,
            // Triple-core internals — visible in logs for inspection.
            tripleCore: {
              consensus,
              alpha: summarizeCoreResult(alphaResult),
              beta:  summarizeCoreResult(betaResult),
              gamma: summarizeCoreResult(gammaResult),
            },
          }),
        ]).catch(err => console.error("Background update failed:", err));
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  } catch (err) {
    console.error("Chat route error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function summarizeCoreResult(coreResult) {
  const { feltState } = coreResult || {};
  if (!feltState) return null;
  return {
    temperature: feltState.temperature,
    charge:      feltState.charge,
    edge:        feltState.edge,
    notice:      feltState.notice,
  };
}
