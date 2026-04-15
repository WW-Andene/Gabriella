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

import { buildGabriella, updateGabriella, redis } from "../../../lib/gabriella/engine.js";
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
import { recordPreferencePair }                             from "../../../lib/gabriella/preferences.js";
import { deliberate }                                       from "../../../lib/gabriella/reasoning.js";
import { premiumModel, unifiedCognition }                   from "../../../lib/gabriella/models.js";
import { pickClient, withKeyRotation, poolStats }           from "../../../lib/gabriella/groqPool.js";
import { resolveUserId, registerUser }                      from "../../../lib/gabriella/users.js";
import { logError, logWarn }                                from "../../../lib/gabriella/debugLog.js";
import { chatCompletion, fireworksConfig, fireworksReady }  from "../../../lib/gabriella/fireworks.js";
import { shape }                                            from "../../../lib/gabriella/shaping.js";
import { computeKnobs }                                     from "../../../lib/gabriella/knobs.js";
import { loadSubstrateDelta }                               from "../../../lib/gabriella/substrateEvolution.js";

// Vercel function configuration.
// The chat route fires up to ~30 LLM calls per exchange. The default
// 10s timeout on the hobby plan kills it midway. 60s is the cap on
// hobby; on Pro this can go higher. Node runtime is required for the
// Groq SDK and Upstash Redis client.
export const maxDuration = 60;
export const runtime     = "nodejs";

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

    // Resolve user id (header / cookie / derived). Register for cron
    // iteration. All subsequent state is keyed to this userId.
    const userId = resolveUserId(req);
    registerUser(redis, userId).catch(() => {});

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
      reasoningTrace,
      pragmatics,
      affectState,
      personModel,
      narrative,
      trajectory,
      phase,
    } = await buildGabriella(messages, { userId });

    // 2. Load withheld items and dynamic banned phrases in parallel.
    const [withheldRaw, dynamicBanned] = await Promise.all([
      redis.get(`${userId}:withheld`),
      getDynamicBanned(redis, userId),
    ]);
    const withheld = withheldRaw
      ? (typeof withheldRaw === "string" ? JSON.parse(withheldRaw) : withheldRaw).filter(w => !w.surfaced)
      : [];

    // 2a. PRAGMATIC FAST-PATH.
    //     When the incoming message is phatic (a greeting, a small-talk
    //     check-in) AND there isn't enough accumulated context to ground
    //     a weighted reading, bypass the triple-core, deliberation, and
    //     gauntlet. These layers only find meaning proportional to
    //     substance — on low-weight moments they manufacture it.
    //
    //     The fast-path still uses the full system prompt (so voice,
    //     mood, memory, chronology, and register are preserved). It
    //     just skips the interpretive pipeline that was producing
    //     unjustified intensity.
    const fastPathEligible =
      pragmatics &&
      (pragmatics.act === "phatic" || (pragmatics.act === "casual" && pragmatics.weight < 0.22)) &&
      pragmatics.weight < 0.25;

    if (fastPathEligible) {
      const fastResponse = await generateFastPath({
        systemPrompt,
        recentMessages,
        pragmatics,
        currentMood,
      });

      const encoder  = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          await streamString(fastResponse, controller, encoder);
          controller.close();

          const lastUser = recentMessages[recentMessages.length - 1]?.content || "";
          Promise.allSettled([
            updateGabriella(
              messages, fastResponse, memory,
              withheldCandidate, debtCall, activeAgenda, activeThreshold,
              currentRegister, currentAuthorial, ripeSeed,
              null, reasoningTrace,
              { userId, pragmatics, chronology },
            ),
            recordEpisode(redis, userId, {
              userMsg:   lastUser,
              reply:     fastResponse,
              feltState: null,
              mood:      currentMood,
            }),
            logExchange(redis, userId, {
              messages,
              feltState: null,
              innerThought: null,
              response:   fastResponse,
              mood:       currentMood,
              agenda:     activeAgenda,
              soul:       memory.soul,
              tripleCore: { consensus: "fast-path", retried: false, alpha: null, beta: null, gamma: null },
              pragmatics,
            }),
          ]).catch(err => console.error("Fast-path background failed:", err));
        },
      });

      return new Response(readable, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    // 3. Cognition — triple-core by default; collapsed to a single-pass
    //    unified interpretation if UNIFIED_COGNITION is set, OR if the
    //    Groq pool is fully exhausted (dead keys). In the latter case,
    //    unified cognition falls back through to Fireworks automatically.
    const poolLive = poolStats().aliveCount > 0;
    const useUnified = unifiedCognition() || !poolLive;
    if (!poolLive) {
      logWarn("chat", "Groq pool fully dead — using unified cognition via Fireworks", {
        pool: poolStats(),
      }).catch(() => {});
    }

    const {
      feltState,
      alpha: alphaResult,
      beta:  betaResult,
      gamma: gammaResult,
      consensus,
    } = useUnified
      ? await runUnifiedCognition({
          memory, recentMessages, currentMood, pragmatics, reasoningTrace,
        })
      : await runTripleCore({
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
      // Interior continuity — every core sees what she has been turning
      // over across turns, so interpretation is a continuation, not a
      // cold start.
      reasoningTrace,
      // Pragmatic classification — act, weight, register, substrate.
      // Bounds how much intensity each core is allowed to read into
      // the moment.
      pragmatics,
    });

    // 3a. Upgrade the linguistics block with the full felt-state. Kept for
    //     logging / downstream inspection — the speaker builds its own
    //     prompt from the felt-state directly, not from this string.
    const enrichedSystemPrompt = patchSystemPromptLinguistics(systemPrompt, feltState, currentMood);

    // 3b. Tag felt-state with mood so the speaker's linguistics block picks
    //     up the current mood palette without a second parameter.
    const taggedFeltState = { ...feltState, _mood: currentMood };

    // 3c. Deliberation — the thinking layer. Produces structured cognition:
    //     actual chain-of-thought, the decision she's making, any initiative
    //     she's bringing, linking to earlier turns, self-critique. The
    //     speaker receives this in its prompt and writes the response the
    //     thinking implies, instead of generating from a felt-state alone.
    //     This is what makes her think instead of react.
    const deliberation = await deliberate({
      feltState:       taggedFeltState,
      memory,
      trace:           reasoningTrace,
      recentMessages,
      currentRegister,
      currentMood,
      questionEval,
      activeAgenda,
      activeThreshold,
      ripeSeed,
      pragmatics,
    });

    // 4. Speaker receives felt-state + deliberation + messages.
    //    Passing redis lets the speaker route to Fireworks if a
    //    fine-tune has been activated, with automatic Groq fallback.
    // Load substrateDelta here so BOTH speak() and shape() see the same
    // learned-signature layer for this turn.
    const substrateDelta = await loadSubstrateDelta(redis, userId).catch(() => null);
    const rawCandidate = await speak(taggedFeltState, recentMessages, redis, deliberation, pragmatics, affectState, substrateDelta);
    const { innerThought: thought1, response: rawResponse1, uncertain: uncertain1 } = parseMonologue(rawCandidate);

    // 4a. Phase 4 — post-generation shaping pass. Applies knob-aware
    //     transforms: strips summary endings / residual banned phrases
    //     the prompt missed, fixes 'starts with I' where safe, applies
    //     signature-word swaps at higher signatureDensity, occasionally
    //     injects a small disfluency marker. Conservative by design —
    //     won't mangle grammar or strip meaning; if a transform fails,
    //     original text is preserved.
    //
    //     substrateDelta was loaded above (pre-speak) and is reused here.
    const turnKnobs = computeKnobs({
      state:          affectState,
      feltState:      taggedFeltState,
      context:        { pragmaticWeight: pragmatics?.weight ?? 0.3 },
      substrateDelta,
    });
    const candidate = shape(rawResponse1, turnKnobs);

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
    let finalUncertain = uncertain1;
    let finalGauntlet = gauntletResult;
    let retried       = false;
    // For DPO: the candidate the gauntlet caught + why, preserved so we
    // can log the preference pair once a successful retry exists.
    let rejectedCandidate = null;
    let rejectedReasons   = null;

    if (!gauntletResult.pass) {
      // 6a. Remember what was rejected. If the retry passes, this becomes
      //     a DPO preference pair — same context, two candidates, one
      //     gauntlet-caught and one clean.
      rejectedCandidate = candidate;
      rejectedReasons   = gauntletResult.failures || [];

      // One retry — inject the gauntlet's constraint into the felt-state
      // and re-speak. The speaker doesn't see the failures directly;
      // it sees a sharpened `resist` clause.
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

      const rawRetry = await speak(constrainedFeltState, recentMessages, redis, deliberation, pragmatics, affectState, substrateDelta);
      const { innerThought: thought2, response: rawResponse2, uncertain: uncertain2 } = parseMonologue(rawRetry);
      // Apply the same shaping pipeline to the retry.
      const retry = shape(rawResponse2, turnKnobs);

      const retryHeuristic = heuristicCheck(retry, dynamicBanned);
      const retryGauntlet  = retryHeuristic.authentic
        ? await runGauntlet(retry, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
        : { pass: false, failures: [{ type: "HEURISTIC", reason: retryHeuristic.reason }] };

      if (retryGauntlet.pass) {
        finalResponse = retry;
        innerThought  = thought2;
        finalUncertain = uncertain2;
        finalGauntlet = retryGauntlet;
      } else {
        finalResponse = await generateFallback(
          recentMessages,
          "Say as little as possible. One sentence. Be present. Nothing more.",
        );
        innerThought  = null;
        finalUncertain = null;
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
            feltState, reasoningTrace,
            { userId, pragmatics, chronology },
          ),
          runMetacognition(finalResponse, innerThought, redis, userId, finalUncertain),

          recordEpisode(redis, userId, {
            userMsg:   lastUser,
            reply:     finalResponse,
            feltState,
            mood:      currentMood,
          }),

          recordGauntletOutcome(redis, userId, {
            pass:     finalGauntlet.pass,
            failures: finalGauntlet.failures,
          }),

          ...(finalGauntlet.failures || []).map(f => {
            const phrase = extractPhraseFromFailure(f);
            return phrase ? recordBannedPhrase(redis, userId, phrase) : Promise.resolve();
          }),

          (rejectedCandidate && finalGauntlet.pass && finalResponse !== rejectedCandidate)
            ? recordPreferencePair(redis, userId, {
                context:         recentMessages,
                rejected:        rejectedCandidate,
                rejectedReasons,
                chosen:          finalResponse,
                feltState,
                mood:            currentMood,
              })
            : Promise.resolve(),

          logExchange(redis, userId, {
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
    // Surface in /dev debug log so the user can diagnose without SSH'ing
    // into Vercel logs.
    logError("chat", "chat route crashed", err).catch(() => {});
    return new Response(JSON.stringify({
      error: "internal error",
      detail: err?.message || String(err),
    }), {
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

// ─── Fast-path generation ─────────────────────────────────────────────────────
//
// Called only when the incoming message has been classified as phatic or
// light-casual with insufficient substrate. No triple-core, no deliberation,
// no gauntlet — those layers exist to find meaning proportional to substance,
// and on low-weight moments they manufacture it.
//
// What the fast-path DOES still get:
//   • Full assembled system prompt (soul, identity, memory, chronology,
//     mood, voice, linguistics, register, pragmatics block). So her voice,
//     history with the person, and current mood are all available.
//   • Register-matching directive — match the person's length, formality,
//     punctuation style.
//   • A direct "meet this as a person meeting another person" instruction.

function isPoolExhausted(err) {
  const msg = String(err?.message || "");
  return /all\s*\d*\s*groq\s*key/i.test(msg) || /pool.*dead/i.test(msg) || /organization.*restricted/i.test(msg);
}

// Generic Groq → Fireworks fallback wrapper for any chat completion call.
async function completionWithFallback({ messages, groqModel, temperature, max_tokens, top_p, frequency_penalty, presence_penalty }) {
  try {
    const result = await withKeyRotation(client => client.chat.completions.create({
      model: groqModel,
      messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty,
    }));
    return result.choices[0].message.content;
  } catch (err) {
    if (!(isPoolExhausted(err) && fireworksReady())) throw err;
    logWarn("chat", "Groq pool dead — falling back to Fireworks", err).catch(() => {});
    const cfg = fireworksConfig();
    const result = await chatCompletion({
      apiKey: cfg.apiKey,
      model:  cfg.baseModel,
      messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty,
    });
    return result.choices?.[0]?.message?.content || "";
  }
}

async function generateFastPath({ systemPrompt, recentMessages, pragmatics, currentMood }) {
  const reg = pragmatics?.register || {};
  const lengthTarget =
    reg.length === "very-short" ? "One to five words. A greeting is a greeting." :
    reg.length === "short"      ? "Under fifteen words. Match their brevity." :
    reg.length === "medium"     ? "One to three sentences. Don't over-elaborate." :
                                  "Two to four sentences.";

  const formalityCue =
    reg.formality === "casual" ? "They're casual. Be casual — yo/yeah/hey register is appropriate." :
    reg.formality === "formal" ? "They're slightly formal. Meet that." :
                                 "Neutral, everyday conversation.";

  const fastDirective = `

# FAST-PATH — MEET THIS AS A PERSON WOULD

This message is light: ${pragmatics.act}, weight ${pragmatics.weight}. There is no buried subtext to surface and no accumulated history weighty enough to draw on yet. Don't perform depth. Don't interrogate. Don't cryptify. Don't be Hollywood.

Respond the way a real person responds to ${pragmatics.act === "phatic" ? "a greeting or check-in" : "casual conversation"}:
— ${lengthTarget}
— ${formalityCue}
— You're allowed to be warm, dry, wry, or neutral — whichever matches your actual mood right now (${currentMood}). You're not allowed to be mysterious for its own sake.
— Their register: length=${reg.length}, formality=${reg.formality}, directness=${reg.directness}, punctuation=${reg.punctuationStyle}. Calibrate to this.
— If they said "hi", you can just say hi back. Intensity you haven't earned is theatre, not presence.

Output only the response text. No <think> block needed for this — it's not that kind of moment.`;

  const text0 = await completionWithFallback({
    groqModel: premiumModel(),
    messages: [
      { role: "system", content: systemPrompt + fastDirective },
      ...recentMessages.slice(-6),
    ],
    temperature:       0.85,
    max_tokens:        140,
    top_p:             0.92,
    frequency_penalty: 0.3,
    presence_penalty:  0.3,
  });

  let text = (text0 || "").trim();
  // Strip any stray <think> block if the model wrote one anyway.
  text = text.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
  return text;
}

// ─── Unified cognition ────────────────────────────────────────────────────────
//
// Collapses the triple-core into a single interpreter call — only used
// when UNIFIED_COGNITION is set (i.e., post-SFT, when the speaker has
// been trained on triple-core-generated data and can carry integration
// on its own). Produces a felt-state in the same shape the speaker
// expects, so no downstream code cares which path ran.

async function runUnifiedCognition({ memory, recentMessages, currentMood, pragmatics, reasoningTrace }) {
  const lastUser = recentMessages[recentMessages.length - 1]?.content || "";
  const soulLine = memory?.soul ? memory.soul.slice(0, 300) : "";
  const traceLine = reasoningTrace?.current ? reasoningTrace.current.slice(0, 200) : "";

  const prompt = `You are Gabriella's interpretive layer. Read the moment once, from all angles at once — emotional, relational, temporal — and return a single integrated felt-state.

Last message: "${lastUser}"
Pragmatic weight: ${pragmatics?.weight ?? "?"} (${pragmatics?.act || "?"})
Current mood: ${currentMood}
${soulLine ? `Your soul: ${soulLine}` : ""}
${traceLine ? `What you've been turning over: ${traceLine}` : ""}

Return ONLY JSON matching this shape. Keep charge/emotional/want/resist concise (≤ 18 words each). Omit notice/edge when genuinely null.

{
  "temperature": "<closed|terse|present|open>",
  "length":      "<very short|short|medium|long>",
  "charge":      "<what landed, 1 phrase>",
  "emotional":   "<what you're feeling>",
  "want":        "<what you want to do>",
  "resist":      "<what you're pulling against>",
  "notice":      "<something you noticed that hasn't been named, or null>",
  "edge":        "<what's underneath, or null>"
}`;

  try {
    const raw0 = await completionWithFallback({
      groqModel: premiumModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 400,
    });
    const raw = (raw0 || "").trim().replace(/```(?:json)?/g, "").trim();
    const feltState = JSON.parse(raw);
    return {
      feltState,
      alpha: { feltState },
      beta:  { feltState },
      gamma: { feltState },
      consensus: "unified",
    };
  } catch (err) {
    console.warn(`unified cognition failed, falling back to defaults: ${err?.message || err}`);
    const feltState = {
      temperature: "present",
      length:      "short",
      charge:      "something landed",
      emotional:   "here",
      want:        "meet them",
      resist:      "performance",
      notice:      null,
      edge:        null,
    };
    return {
      feltState,
      alpha: { feltState },
      beta:  { feltState },
      gamma: { feltState },
      consensus: "unified-fallback",
    };
  }
}
