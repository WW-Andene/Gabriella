// app/api/chat/route.js
//
// Gabriella v7 chat route.
//
// Flow:
//   1. buildGabriella   — assembles full context (soul, memory, agenda, …)
//                         and loads structured temporal state: chronology,
//                         arc, recurrence, meta-register.
//   2. runTripleCore    — three parallel cores (Alpha, Beta, Gamma) each
//                         interpret the moment; synthesis coordinates their
//                         readings into one felt-state. When the cores
//                         diverge, synthesis stages a dialogue between them.
//   3. patchLinguistics — upgrades the mood-seeded linguistics block in the
//                         system prompt to a felt-state-aware version.
//   4. speak            — receives only the felt-state and recent messages;
//                         generates a candidate response with a hidden
//                         <think> monologue prepended.
//   5. parseMonologue   — strip the hidden <think> block.
//   6. heuristicCheck   — instant banned-phrase / structural-tell scan,
//                         now augmented with a rolling list of phrases
//                         the gauntlet has recently penalized.
//   7. gauntlet         — four LLM checks: premature, exposed, compliant,
//                         abandoned. Skipped for fallback-length replies.
//   8. retry / fallback — one constrained retry, then the terse fallback.
//   9. stream to client — client-visible response only.
//  10. background       — metacognition + memory updates + record episode +
//                         record gauntlet outcome + log. The gauntlet's
//                         quoted phrases are fed back into the dynamic
//                         banned list so the heuristic filter evolves.

import { buildGabriella, updateGabriella, redis, USER_ID } from "../../../lib/gabriella/engine.js";
import { parseMonologue }                                   from "../../../lib/gabriella/monologue.js";
import {
  runMetacognition, heuristicCheck,
  getDynamicBanned, recordBannedPhrase, extractPhraseFromFailure,
} from "../../../lib/gabriella/metacognition.js";
import { speak }                                            from "../../../lib/gabriella/speaker.js";
import { runGauntlet, getGauntletConstraintBlock, generateFallback } from "../../../lib/gabriella/gauntlet.js";
import { logExchange }                                      from "../../../lib/gabriella/logger.js";
import { patchSystemPromptLinguistics }                     from "../../../lib/gabriella/linguistics.js";
import { runTripleCore }                                    from "../../../lib/gabriella/clone/index.js";
import { recordEpisode }                                    from "../../../lib/gabriella/episodic.js";
import { recordGauntletOutcome }                            from "../../../lib/gabriella/metaregister.js";

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

    // 1. Build full context + structured temporal state.
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
      chronology,
      currentArc,
      recurrence,
    } = await buildGabriella(messages);

    // 2. Load withheld items and dynamic banned phrases in parallel.
    const [withheldRaw, dynamicBanned] = await Promise.all([
      redis.get(`${USER_ID}:withheld`),
      getDynamicBanned(redis, USER_ID),
    ]);
    const withheld = withheldRaw
      ? (typeof withheldRaw === "string" ? JSON.parse(withheldRaw) : withheldRaw).filter(w => !w.surfaced)
      : [];

    // 3. Triple-core: every core receives the full relational + temporal
    //    context. Gamma additionally reads structured recurrence / arc /
    //    chronology so its temporal reasoning rests on facts, not guesses.
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
      questionEval,
      // Structured temporal — Gamma queries these before interpreting.
      chronology,
      arc:           currentArc,
      recurrence,
    });

    // 3a. Upgrade the linguistics block with the full felt-state. Kept for
    //     logging / downstream inspection — the speaker builds its own
    //     prompt from the felt-state directly, not from this string.
    const enrichedSystemPrompt = patchSystemPromptLinguistics(systemPrompt, feltState, currentMood);

    // 3b. Tag felt-state with mood so the speaker's linguistics block picks
    //     up the current mood palette without a second parameter.
    const taggedFeltState = { ...feltState, _mood: currentMood };

    // 4. Speaker receives felt-state + messages — no identity, no soul.
    //    Passing redis lets the speaker route to Fireworks if a
    //    fine-tune has been activated, with automatic Groq fallback.
    const rawCandidate = await speak(taggedFeltState, recentMessages, redis);
    const { innerThought: thought1, response: candidate } = parseMonologue(rawCandidate);

    // 5. Heuristic pre-check — instant, no LLM cost. Dynamic banned list
    //    passed in so recently-penalized phrases trip the filter without
    //    waiting for the gauntlet to catch them again.
    const heuristic              = heuristicCheck(candidate, dynamicBanned);
    const candidateNeedsGauntlet = heuristic.authentic;

    // 6. Gauntlet — only run full LLM checks if heuristic passed.
    //    questionEval flows in so checkCompliant sees the deflection verdict.
    const gauntletResult = candidateNeedsGauntlet
      ? await runGauntlet(candidate, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
      : { pass: false, failures: [{ type: "HEURISTIC", reason: heuristic.reason }] };

    let finalResponse = candidate;
    let innerThought  = thought1;
    let finalGauntlet = gauntletResult;
    let retried       = false;

    if (!gauntletResult.pass) {
      // 6a. One retry — inject the gauntlet's constraint into the felt-state
      //     and re-speak. The speaker doesn't see the failures directly;
      //     it sees a sharpened `resist` clause.
      retried = true;
      const constraintNote    = getGauntletConstraintBlock(gauntletResult.failures);
      const constraintBullets = constraintNote
        .split("\n")
        .filter(l => l.startsWith("—"))
        .join(" ");

      const constrainedFeltState = {
        ...taggedFeltState,
        resist: `${taggedFeltState.resist}. ${constraintBullets}`,
      };

      const rawRetry = await speak(constrainedFeltState, recentMessages, redis);
      const { innerThought: thought2, response: retry } = parseMonologue(rawRetry);

      const retryHeuristic = heuristicCheck(retry, dynamicBanned);
      const retryGauntlet  = retryHeuristic.authentic
        ? await runGauntlet(retry, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
        : { pass: false, failures: [{ type: "HEURISTIC", reason: retryHeuristic.reason }] };

      if (retryGauntlet.pass) {
        finalResponse = retry;
        innerThought  = thought2;
        finalGauntlet = retryGauntlet;
      } else {
        finalResponse = await generateFallback(
          recentMessages,
          "Say as little as possible. One sentence. Be present. Nothing more.",
        );
        innerThought  = null;
        finalGauntlet = retryGauntlet;
      }
    }

    // 7. Stream to client.
    const encoder  = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        await streamString(finalResponse, controller, encoder);
        controller.close();

        // 8. Background — fire-and-forget after the client is served.
        //    The promises here must be defensively independent so one
        //    failure doesn't starve the others.
        const lastUser = recentMessages[recentMessages.length - 1]?.content || "";

        const bg = [
          updateGabriella(
            messages, finalResponse, memory,
            withheldCandidate, debtCall, activeAgenda, activeThreshold,
            currentRegister, currentAuthorial, ripeSeed,
          ),
          runMetacognition(finalResponse, innerThought, redis, USER_ID),

          // Record the structured episode — the substrate for Gamma,
          // arc detection, and future learning loops.
          recordEpisode(redis, USER_ID, {
            userMsg:   lastUser,
            reply:     finalResponse,
            feltState,
            mood:      currentMood,
          }),

          // Record whether this exchange passed the gauntlet — the
          // meta-register reads this to surface self-observation.
          recordGauntletOutcome(redis, USER_ID, {
            pass:     finalGauntlet.pass,
            failures: finalGauntlet.failures,
          }),

          // Feed the gauntlet's quoted phrases back into the heuristic
          // filter. The immune system learns.
          ...(finalGauntlet.failures || []).map(f => {
            const phrase = extractPhraseFromFailure(f);
            return phrase ? recordBannedPhrase(redis, USER_ID, phrase) : Promise.resolve();
          }),

          logExchange(redis, USER_ID, {
            messages,
            feltState,
            innerThought,
            response:   finalResponse,
            mood:       currentMood,
            agenda:     activeAgenda,
            soul:       memory.soul,
            tripleCore: {
              consensus,
              retried,
              alpha: summarizeCoreResult(alphaResult),
              beta:  summarizeCoreResult(betaResult),
              gamma: summarizeCoreResult(gammaResult),
            },
          }),
        ];

        Promise.allSettled(bg).then(results => {
          const failed = results.filter(r => r.status === "rejected");
          if (failed.length > 0) {
            console.error("Background updates: some failed:",
              failed.map(f => f.reason?.message || f.reason));
          }
        });
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
