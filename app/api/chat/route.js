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
import {
  runMetacognition,
  getDynamicBanned, recordBannedPhrase, extractPhraseFromFailure,
} from "../../../lib/gabriella/metacognition.js";
import { logExchange }                                      from "../../../lib/gabriella/logger.js";
import { recordEpisode }                                    from "../../../lib/gabriella/episodic.js";
import { recordGauntletOutcome }                            from "../../../lib/gabriella/metaregister.js";
import { recordPreferencePair }                             from "../../../lib/gabriella/preferences.js";
import { recordEnsembleLabel }                              from "../../../lib/gabriella/ensembleJudge.js";
import { withKeyRotation }                                  from "../../../lib/gabriella/groqPool.js";
import { resolveUserId, registerUser }                      from "../../../lib/gabriella/users.js";
import { logError, logWarn }                                from "../../../lib/gabriella/debugLog.js";
import { chatCompletion, fireworksConfig, fireworksReady }  from "../../../lib/gabriella/fireworks.js";
import { computeCadence, sleep }                            from "../../../lib/gabriella/cadence.js";
import { premiumModel }                                     from "../../../lib/gabriella/models.js";
import { runTurn }                                          from "../../../lib/gabriella/turn.js";

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

// ─── Substance-marker detector — content override for the pragmatic fast-path ─
// A 5-word turn-2 message can still carry real weight. Pragmatics scores
// by accumulated substrate, which is sparse early; markers of substance
// let a short message break through that gate and reach the cores.
//
// Conservative by design: only fires on clear signals. If in doubt,
// the fast-path still wins — we'd rather take a light path on an
// ambiguous heavy moment than force depth on a truly phatic one.
const SUBSTANCE_MARKERS = [
  // Questions about self / inner life / meaning — short but heavy
  /\b(do you|have you|are you|can you|could you|would you)\s+(ever|still|really|actually|genuinely|honestly)\b/i,
  /\b(do|have|are|can|could|would)\s+(you\s+)?ever\s+(feel|felt|think|thought|wonder|wondered|miss|missed|regret|love|hate|want)\b/i,
  /\bwhat\s+(makes|made|does it|is it like|do you)\b/i,
  /\bwhy\s+(do|did|does|does it|are you|do you)\b/i,
  // Emotional vocabulary — if they name a feeling, it's not small talk
  /\b(lonely|alone|scared|afraid|tired|exhausted|broken|hurt|hurting|grief|grieving|lost|trapped|stuck|dying|suicidal|empty|numb|ashamed|regret|sorry|miss|missing|longing|yearning)\b/i,
  // Personal revelation framing
  /\b(i just|i've been|i can't|i don't know|i'm not sure|i keep|i wish|i need|i feel like|it feels like|i feel|i felt)\b/i,
  // Meta-relational openers — "can I ask you something" / "something I've been thinking"
  /\b(can i ask|something i've been|something i want|something i need|i want to tell|i have to tell|i need to tell)\b/i,
  // Heavy topics by keyword
  /\b(death|dying|loss|grief|mortality|meaning|purpose|existence|god|love|trust|betrayal|abuse|trauma|therapy)\b/i,
];

function detectSubstanceMarkers(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  // Very short messages (1-2 words) are almost always phatic unless they're a
  // heavy standalone question. "what?" "why?" are context-dependent; let the
  // fast-path handle those — they're correct as light.
  if (trimmed.length < 8) return false;
  return SUBSTANCE_MARKERS.some(rx => rx.test(trimmed));
}

function streamString(text, controller, encoder, perCharMs = { min: 4, max: 12 }) {
  return new Promise((resolve) => {
    let i = 0;
    const spread = Math.max(0, perCharMs.max - perCharMs.min);
    function sendNext() {
      if (i >= text.length) { resolve(); return; }
      const chunkSize = Math.floor(Math.random() * 4) + 2;
      controller.enqueue(encoder.encode(text.slice(i, i + chunkSize)));
      i += chunkSize;
      setTimeout(sendNext, Math.random() * spread + perCharMs.min);
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
      self,
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
    //
    //     Content override: a short message on sparse context can still
    //     carry real substance — "do you ever feel trapped?" on turn 2
    //     is 5 words but isn't small talk. If the message contains
    //     markers of substance (questions about self/feeling/meaning,
    //     emotional vocabulary, or explicit vulnerability), refuse the
    //     fast-path even at low pragmatic weight. The cores get to see
    //     moments the classifier can't score yet.
    const lastUserMessageText = recentMessages[recentMessages.length - 1]?.content || "";
    const hasSubstanceMarkers = detectSubstanceMarkers(lastUserMessageText);

    const fastPathEligible =
      pragmatics &&
      (pragmatics.act === "phatic" || (pragmatics.act === "casual" && pragmatics.weight < 0.22)) &&
      pragmatics.weight < 0.25 &&
      !hasSubstanceMarkers;

    if (fastPathEligible) {
      const fastResponse = await generateFastPath({
        systemPrompt,
        recentMessages,
        pragmatics,
        currentMood,
      });

      // Phase 7: compute pre-stream thinking delay for the fast path.
      // Phatic exchanges should feel responsive but not robotic —
      // computeCadence produces 200-400ms here.
      const fastCadence = computeCadence({
        state:          affectState,
        pragmatics,
        responseLength: fastResponse.length,
        isReentry:      false,
        gapSinceLastTurnMs: 0,
        textingRegister: "typed",
      });

      const encoder  = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          await sleep(fastCadence.preDelayMs);
          await streamString(fastResponse, controller, encoder, fastCadence.perCharMs);
          controller.close();

          const lastUser = recentMessages[recentMessages.length - 1]?.content || "";
          Promise.allSettled([
            updateGabriella(
              messages, fastResponse, memory,
              withheldCandidate, debtCall, activeAgenda, activeThreshold,
              currentRegister, currentAuthorial, ripeSeed,
              null, reasoningTrace,
              { userId, pragmatics, chronology, self },
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

    // 3. Per-turn pipeline — extracted into runTurn() so route.js stays
    //    an HTTP boundary and the cognition + speak + gauntlet sequence
    //    can be iterated on without touching transport. Priors (person
    //    + narrative) flow into the cores as continuity signals.
    const turnResult = await runTurn({
      // buildGabriella output
      messages, recentMessages, memory, currentMood,
      withheldCandidate, debtCall, activeAgenda, activeThreshold,
      currentRegister, currentAuthorial, ripeSeed,
      questionEval, chronology, currentArc, recurrence,
      reasoningTrace, pragmatics, affectState, personModel, narrative,
      trajectory, phase, self,
      // Lifecycle state
      withheld, dynamicBanned,
      // Infra
      redis, userId,
    });

    const {
      finalResponse, fragments, pauses, cadence,
      feltState, innerThought, finalUncertain, finalGauntlet,
      retried, rejectedCandidate, rejectedReasons,
      consensus, alpha: alphaResult, beta: betaResult, gamma: gammaResult,
      turnKnobs, substrateDelta,
      toolResult,
    } = turnResult;

    const encoder  = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        // PEEK sidecar — emitted BEFORE the pre-stream delay so the
        // client can render "what she's about to do" during the typing-
        // dots phase. Glass-mind mode: the user sees her plan while she's
        // still preparing to speak. Not the final response, just the
        // interpretive frame — felt-state summary, silence / wit flags,
        // whether the cores diverged, whether a gauntlet retry happened.
        try {
          const peek = {
            charge:      feltState?.charge      || null,
            emotional:   feltState?.emotional   || null,
            want:        feltState?.want        || null,
            temperature: feltState?.temperature || null,
            edge:        feltState?.edge        || null,
            consensus:   consensus              || null,
            retried:     !!retried,
            silence:     feltState?._silence?.kind || null,
            wit:         feltState?._wit?.flavor || null,
          };
          controller.enqueue(encoder.encode(
            `\u001F__PEEK__${JSON.stringify(peek)}\u001F`,
          ));
        } catch { /* peek is optional; never block streaming */ }

        await sleep(cadence.preDelayMs);
        for (let i = 0; i < fragments.length; i++) {
          await streamString(fragments[i], controller, encoder, cadence.perCharMs);
          if (i < fragments.length - 1) {
            controller.enqueue(encoder.encode("\n\n"));
            await sleep(pauses[i]);
          }
        }

        // Phase D: emit tool result as a sidecar marker line the client
        // splits off from the response text. Uses a rare delimiter
        // (unit-separator U+001F) so there's no collision with natural
        // prose.
        // Sidecar: inner monologue. The speaker's hidden <think> block
        // is real interior process, stripped from the visible stream.
        // Emit as a sidecar marker the client can optionally reveal —
        // a toggleable "show me what she's thinking" UX. No competitor
        // exposes this because their characters don't have a coherent
        // inner monologue to show.
        if (innerThought) {
          controller.enqueue(encoder.encode(
            `\u001F__THINK__${JSON.stringify({ text: innerThought, uncertain: finalUncertain || null })}\u001F`,
          ));
        }

        // Sidecar: felt-state snapshot — her read of the moment, want,
        // temperature. Lets the UI render a subtle mood indicator or
        // cognition inspector without a second /api call per turn.
        if (feltState) {
          const feltSidecar = {
            charge:      feltState.charge      || null,
            emotional:   feltState.emotional   || null,
            want:        feltState.want        || null,
            temperature: feltState.temperature || null,
            edge:        feltState.edge        || null,
            consensus:   feltState.consensus   || null,
            retried:     !!retried,
          };
          controller.enqueue(encoder.encode(
            `\u001F__FELT__${JSON.stringify(feltSidecar)}\u001F`,
          ));
        }

        if (toolResult) {
          controller.enqueue(encoder.encode(
            `\u001F__TOOL__${JSON.stringify(toolResult)}\u001F`,
          ));
        }
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
            { userId, pragmatics, chronology, self },
          ),
          runMetacognition(finalResponse, innerThought, redis, userId, finalUncertain),

          recordEpisode(redis, userId, {
            userMsg:   lastUser,
            reply:     finalResponse,
            feltState,
            mood:      currentMood,
          }),

          // Ensemble judge — three-family scoring of the final response.
          // Fire-and-forget. Feeds directly into the KTO training pipeline
          // as thumbs-up / thumbs-down labels. Only records when 2-of-3
          // judges agree OR when only one judge is available. Ambiguous
          // cases are dropped rather than adding noise.
          recordEnsembleLabel(redis, userId, {
            context:  messages.slice(-6),
            response: finalResponse,
            lastUser,
          }).catch(() => null),

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

// Unified cognition now lives in turn.js (same module that owns the
// whole per-turn pipeline). The inline version used to live here; it's
// been moved so all cognition entry points sit together.
