// app/api/chat/route.js
//
// Flow:
//   1. buildGabriella  — assembles full context (soul, memory, agenda, etc.)
//   2. runDualCore     — three parallel cores (Alpha + Beta + Gamma) interpret the moment,
//                        synthesis coordinates all three readings into one felt-state
//   3. speak           — receives ONLY felt-state + messages, generates candidate
//   4. parseMonologue  — strip hidden <think> block
//   5. heuristic check — instant banned-phrase / structural tell scan (no LLM cost)
//   6. gauntlet        — reject if premature, exposed, compliant, or abandoned
//   7. retry / fallback if needed
//   8. stream the vetted response
//   9. background: metacognition + all memory updates

import Groq from "groq-sdk";
import { buildGabriella, updateGabriella, redis, USER_ID } from "../../../lib/gabriella/engine.js";
import { parseMonologue } from "../../../lib/gabriella/monologue.js";
import { runMetacognition, heuristicCheck } from "../../../lib/gabriella/metacognition.js";
import { speak } from "../../../lib/gabriella/speaker.js";
import { runGauntlet, getGauntletConstraintBlock, generateFallback } from "../../../lib/gabriella/gauntlet.js";
import { logExchange } from "../../../lib/gabriella/logger.js";
import { patchSystemPromptLinguistics } from "../../../lib/gabriella/linguistics.js";
import { runDualCore } from "../../../lib/gabriella/clone/index.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Stream a completed string to the client ──────────────────────────────────

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
      generationParams,
      debtCall,
      activeAgenda,
      activeThreshold,
      currentRegister,
      currentAuthorial,
      ripeSeed,
      questionEval,
    } = await buildGabriella(messages);

    // 2. Load withheld items for gauntlet
    const withheldRaw = await redis.get(`${USER_ID}:withheld`);
    const withheld = withheldRaw
      ? (typeof withheldRaw === "string" ? JSON.parse(withheldRaw) : withheldRaw).filter(w => !w.surfaced)
      : [];

    // 3. Triple-core: Alpha (emotional resonance) + Beta (relational pattern) + Gamma (temporal weight)
    //    run in parallel, then synthesis coordinates all three readings into one felt-state.
    const {
      feltState,
      alpha: alphaResult,
      beta:  betaResult,
      gamma: gammaResult,
      consensus,
    } = await runDualCore({
      soul:          memory.soul,
      recentMessages,
      memory,
      currentMood,
      agenda:        activeAgenda,
      debt:          debtCall,
      withheld,
      register:      currentRegister,
      authorial:     currentAuthorial,
    });

    // 3a. Upgrade the linguistics block with the full felt-state.
    const enrichedSystemPrompt = patchSystemPromptLinguistics(systemPrompt, feltState, currentMood);

    // 3b. Tag felt-state with mood for the speaker's linguistics block.
    const taggedFeltState = { ...feltState, _mood: currentMood };

    // 4. Speaker receives felt-state + messages — no identity, no soul.
    const rawCandidate = await speak(taggedFeltState, recentMessages);
    const { innerThought: thought1, response: candidate } = parseMonologue(rawCandidate);

    // 5. Heuristic pre-check — instant, no LLM cost.
    //    Catches banned phrases and structural tells before any gauntlet LLM calls.
    const heuristic = heuristicCheck(candidate);
    const candidateNeedsGauntlet = heuristic.authentic;

    // 6. Gauntlet — only run full LLM checks if heuristic passed.
    //    Pass the real questionEval (was previously hardcoded null, making checkCompliant a no-op).
    const gauntletResult = candidateNeedsGauntlet
      ? await runGauntlet(candidate, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
      : { pass: false, failures: [{ type: "HEURISTIC", reason: heuristic.reason }] };

    let finalResponse = candidate;
    let innerThought  = thought1;

    if (!gauntletResult.pass) {
      // One retry — inject constraint into felt-state and re-speak
      const constraintNote       = getGauntletConstraintBlock(gauntletResult.failures);
      const constrainedFeltState = {
        ...taggedFeltState,
        resist: taggedFeltState.resist + ". " + constraintNote.split("\n").filter(l => l.startsWith("—")).join(" "),
      };

      const rawRetry = await speak(constrainedFeltState, recentMessages);
      const { innerThought: thought2, response: retry } = parseMonologue(rawRetry);

      // Heuristic check on retry before spending LLM gauntlet calls
      const retryHeuristic = heuristicCheck(retry);
      const retryGauntlet = retryHeuristic.authentic
        ? await runGauntlet(retry, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
        : { pass: false };

      if (retryGauntlet.pass) {
        finalResponse = retry;
        innerThought  = thought2;
      } else {
        // Both failed — fallback: say less
        finalResponse = await generateFallback(recentMessages, "Say as little as possible. One sentence. Be present. Nothing more.");
        innerThought  = null;
      }
    }

    // 7. Stream to client
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        await streamString(finalResponse, controller, encoder);
        controller.close();

        // 8. Background updates
        Promise.all([
          updateGabriella(messages, finalResponse, memory, withheldCandidate, debtCall, activeAgenda, activeThreshold, currentRegister, currentAuthorial, ripeSeed),
          runMetacognition(finalResponse, innerThought, redis, USER_ID),
          logExchange(redis, USER_ID, {
            messages,
            feltState,
            innerThought,
            response:  finalResponse,
            mood:      currentMood,
            agenda:    activeAgenda,
            soul:      memory.soul,
            // Triple-core internals — visible in logs for inspection
            tripleCore: {
              consensus,
              alpha: {
                temperature: alphaResult.feltState.temperature,
                charge:      alphaResult.feltState.charge,
                edge:        alphaResult.feltState.edge,
              },
              beta: {
                temperature: betaResult.feltState.temperature,
                charge:      betaResult.feltState.charge,
                notice:      betaResult.feltState.notice,
              },
              gamma: {
                temperature: gammaResult.feltState.temperature,
                charge:      gammaResult.feltState.charge,
                edge:        gammaResult.feltState.edge,
              },
            },
          }),
        ]).catch(console.error);
      },
    });

    return new Response(readable, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  } catch (err) {
    console.error("Chat route error:", err);
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

