// turn.js
// The per-turn cognition → speak → gauntlet → stream pipeline, extracted
// out of the god-file in route.js so the HTTP boundary stays thin and the
// cognitive work can be iterated on without touching request handling.
//
// Inputs: the full result of buildGabriella + redis + userId + auxiliary
// lifecycle state (withheld items, dynamicBanned list). Output: everything
// route.js needs to stream the response and fire background updates.
//
// Design principle: turn.js owns sequence. route.js owns transport.

import { parseMonologue } from "./monologue.js";
import { speak }          from "./speaker.js";
import { runTripleCore }  from "./clone/index.js";
import { rereadMoment }   from "./clone/reread.js";
import { detectSilenceMoment, applySilenceOverride } from "./silence.js";
import { detectWit, detectWitWithLLM, shouldSuppressWit } from "./humor.js";
import { detectMetaConversation } from "./metaConversation.js";
import { detectCrisis, applySafetyOverride } from "./safety.js";
import { shape }          from "./shaping.js";
import { heuristicCheck } from "./metacognition.js";
import { runGauntlet, getGauntletConstraintBlock, generateFallback } from "./gauntlet.js";
import { computeKnobs }   from "./knobs.js";
import { loadSubstrateDelta } from "./substrateEvolution.js";
import { computeCadence }     from "./cadence.js";
import { maybeFragment }      from "./fragmenter.js";
import { poolStats }          from "./groqPool.js";
import { unifiedCognition }   from "./models.js";
import { logWarn }            from "./debugLog.js";
import { withKeyRotation }    from "./groqPool.js";
import { premiumModel }       from "./models.js";
import { chatCompletion, fireworksConfig, fireworksReady } from "./fireworks.js";
import { detectToolIntent, executeTool } from "./tools.js";

// ─── Unified-cognition fallback (used when Groq pool is fully dead) ─────────
//
// Collapses the triple-core into a single inference. Kept here rather than
// in clone/index.js so all cognition entry points live in one place.
async function runUnifiedCognition({
  memory, recentMessages, currentMood, pragmatics, reasoningTrace,
  person, narrative,
}) {
  const lastUser = recentMessages[recentMessages.length - 1]?.content || "";
  const recent   = recentMessages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const priorBlock = [
    person?.wants
      ? `What she's been reading about this person: ${person.wants}. Open questions with them: ${(person.openQuestions || []).join("; ") || "(none)"}`
      : "",
    narrative?.text
      ? `The story she tells about this relationship:\n${narrative.text.slice(0, 600)}`
      : "",
    reasoningTrace?.text
      ? `What she has been turning over across turns:\n${reasoningTrace.text.slice(0, 500)}`
      : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are Gabriella's unified cognition — a single interpretive pass producing a felt-state.

${priorBlock}

Recent exchange:
${recent}

Last message: "${lastUser}"

Mood: ${currentMood || "neutral"}
Pragmatic weight: ${pragmatics?.weight ?? 0.3} (${pragmatics?.act || "conversational"})

Rules:
- Respect what she already believes about this person unless this turn gives you a reason to revise.
- Null fields when the moment doesn't warrant them. No manufactured depth on phatic input.
- Concreteness over category — "landed like X" not "felt significant".

Return ONLY JSON:
{
  "charge": "...",
  "emotional": "...",
  "want": "...",
  "resist": "...",
  "notice": "...",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "...",
  "hypothesisUpdate": "one clause about what this turn confirms or challenges in the ongoing read — or null"
}`;

  let parsed = null;
  try {
    // Try Fireworks base if available (Groq is presumed dead if we got here).
    if (fireworksReady()) {
      const cfg = fireworksConfig();
      const res = await chatCompletion({
        apiKey: cfg.apiKey,
        model: cfg.baseModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.55,
        max_tokens: 380,
      });
      const raw = res.choices?.[0]?.message?.content?.trim() || "";
      parsed = JSON.parse(raw.replace(/```(?:json)?/g, "").trim());
    } else {
      // Last resort — try Groq pool anyway (one of our three providers may be alive).
      const res = await withKeyRotation(c =>
        c.chat.completions.create({
          model: premiumModel(),
          messages: [{ role: "user", content: prompt }],
          temperature: 0.55,
          max_tokens: 380,
        }),
      );
      const raw = res.choices?.[0]?.message?.content?.trim() || "";
      parsed = JSON.parse(raw.replace(/```(?:json)?/g, "").trim());
    }
  } catch {
    parsed = {
      charge: "the moment arrived", emotional: "present",
      want: "respond from where she is", resist: "",
      notice: null, temperature: "present", length: "medium",
      edge: null, hypothesisUpdate: null,
    };
  }

  const feltState = { ...parsed, consensus: "unified" };
  return {
    feltState,
    alpha: null, beta: null, gamma: null,
    consensus: "unified",
  };
}

// ─── runTurn: main entry point ──────────────────────────────────────────────
//
// Takes the full buildGabriella context + redis + userId + lifecycle state.
// Returns everything route.js needs to stream + run background updates.
//
// Side effects:
//   - loads substrate delta from redis
//   - calls the speaker (Fireworks fine-tune or Groq+Cerebras, fallback to
//     Fireworks base) including one truncation-retry pass
//   - runs heuristic + gauntlet checks, and on rejection re-speaks with a
//     constraint hedge before falling back to a single-sentence generator

export async function runTurn({
  // Context from buildGabriella
  messages, recentMessages, memory, currentMood,
  withheldCandidate, debtCall, activeAgenda, activeThreshold,
  currentRegister, currentAuthorial, ripeSeed,
  questionEval, chronology, currentArc, recurrence,
  reasoningTrace, pragmatics, affectState, personModel, narrative,
  trajectory, phase, self,
  // Auxiliary
  withheld, dynamicBanned,
  // Infra
  redis, userId,
} = {}) {
  const selfRead = self?.read?.who || null;
  // ── 1. Cognition ────────────────────────────────────────────────────────
  // Triple-core by default; collapse to unified if flagged OR if the Groq
  // pool is fully dead. Priors (person + narrative + reasoning trace) are
  // threaded into BOTH paths so cognition is continuous instead of cold-
  // starting every turn.
  const poolLive  = poolStats().aliveCount > 0;
  const useUnified = unifiedCognition() || !poolLive;
  if (!poolLive) {
    logWarn("turn", "pool fully dead — using unified cognition", { pool: poolStats() }).catch(() => {});
  }

  const cognitionContext = {
    soul:      memory.soul,
    recentMessages, memory, currentMood,
    agenda:    activeAgenda, debt: debtCall, withheld,
    register:  currentRegister, authorial: currentAuthorial,
    threshold: activeThreshold, imaginal: ripeSeed,
    questionEval, chronology, arc: currentArc, recurrence,
    reasoningTrace, pragmatics,
    // PRIOR LAYER — cores now read these as continuity signals, not as
    // generic system prompt filler.
    person:    personModel,
    narrative,
  };

  const cognition = useUnified
    ? await runUnifiedCognition(cognitionContext)
    : await runTripleCore(cognitionContext);

  const { feltState, alpha: alphaResult, beta: betaResult, gamma: gammaResult, consensus } = cognition;

  // Silence policy — some moments want less, not more. Regex-first
  // detection on the last user message (withdrawal, raw loss, command-
  // stop, explicit "just listen", pure phatic, single-word emotional).
  // When fired, overrides length to "very short" and caps temperature
  // so the speaker doesn't reach where reaching is wrong.
  const lastUserForSilence = recentMessages[recentMessages.length - 1]?.content || "";
  const silenceMoment = detectSilenceMoment(lastUserForSilence);

  // Tag mood so the speaker's linguistics block picks it up.
  let taggedFeltState = { ...feltState, _mood: currentMood };

  // Safety FIRST — crisis language trumps everything else. Runs before
  // silence / wit / meta because it may cancel them and apply its own
  // length / temperature overrides.
  const crisisMoment = detectCrisis(lastUserForSilence);
  if (crisisMoment) {
    taggedFeltState = applySafetyOverride(taggedFeltState, crisisMoment);
  }

  // Silence policy — only runs if crisis wasn't detected (safety.applySafetyOverride
  // will have cleared _silence anyway, but we skip explicitly to save the
  // silence-guidance application).
  if (silenceMoment && !crisisMoment) {
    taggedFeltState = applySilenceOverride(taggedFeltState, silenceMoment);
  }

  // Wit detection — regex-first (free), LLM second-pass for ambiguously
  // ironic moments (rare, circuit-broken). Suppressed automatically on
  // heavy moments and when silence policy fired. Attaches as _wit on
  // feltState so the speaker prompt's wit block renders.
  const witHit = (silenceMoment || crisisMoment)
    ? null
    : await detectWitWithLLM(lastUserForSilence, { redis }).catch(() => null);
  if (witHit && !shouldSuppressWit({
    pragmaticWeight: pragmatics?.weight,
    feltState:       taggedFeltState,
  })) {
    taggedFeltState._wit = witHit;
  }

  // Meta-conversation — high-precision regex detects when the user is
  // asking ABOUT the relationship / her / her memory / existence rather
  // than within the conversation. When hit, attaches _metaConv to
  // feltState so the speaker prompt renders the meta guidance block.
  const metaConv = crisisMoment ? null : detectMetaConversation(lastUserForSilence);
  if (metaConv) taggedFeltState._metaConv = metaConv;

  // Divergence transparency: when the cores genuinely disagreed, the
  // synthesis produces one felt-state but the disagreement itself is
  // information the speaker should have access to — so she can speak
  // from the tension instead of from an averaged middle. We attach the
  // per-core compact readings; the speaker prompt renders them as a
  // "different cores read this differently" block when present.
  if ((consensus === "divergent" || consensus === "moderate") &&
      (alphaResult?.feltState || betaResult?.feltState || gammaResult?.feltState)) {
    const compact = (label, fs) => fs ? {
      core:        label,
      charge:      fs.charge,
      emotional:   fs.emotional,
      temperature: fs.temperature,
      edge:        fs.edge,
    } : null;
    taggedFeltState._dissents = [
      compact("alpha (emotional)",   alphaResult?.feltState),
      compact("beta  (relational)",  betaResult?.feltState),
      compact("gamma (temporal)",    gammaResult?.feltState),
    ].filter(Boolean);
  }

  // ── 2. Substrate delta load (once per turn, reused for speak + shape) ──
  const substrateDelta = await loadSubstrateDelta(redis, userId).catch(() => null);

  // ── 3. Speak with truncation recovery ───────────────────────────────────
  // The speaker's hidden <think> block carries the thinking. If it gets
  // truncated mid-<think>, retry once with a lifted token budget.
  let rawCandidate = await speak(
    taggedFeltState, recentMessages, redis, null,
    pragmatics, affectState, substrateDelta, userId,
  );
  let parsed1 = parseMonologue(rawCandidate);
  if (parsed1.truncated || (!parsed1.response && parsed1.innerThought)) {
    logWarn("turn", "speaker truncated inside <think>, retrying with expanded budget", {
      thoughtLen: parsed1.innerThought?.length || 0,
    }).catch(() => {});
    const expandedFelt = { ...taggedFeltState, _tokenBoost: 400 };
    rawCandidate = await speak(
      expandedFelt, recentMessages, redis, null,
      pragmatics, affectState, substrateDelta, userId, selfRead,
    );
    parsed1 = parseMonologue(rawCandidate);
  }
  const { innerThought: thought1, response: rawResponse1, uncertain: uncertain1 } = parsed1;

  // ── 4. Compute knobs + shape ───────────────────────────────────────────
  const turnKnobs = computeKnobs({
    state:          affectState,
    feltState:      taggedFeltState,
    context:        {
      pragmaticWeight: pragmatics?.weight ?? 0.3,
      lastUserMessage: recentMessages[recentMessages.length - 1]?.content || "",
    },
    substrateDelta,
  });
  const candidate = shape(rawResponse1, turnKnobs);

  // ── 5. Heuristic pre-check ─────────────────────────────────────────────
  const heuristic = heuristicCheck(candidate, dynamicBanned);
  const needsGauntlet = heuristic.authentic;

  // ── 6. Gauntlet ────────────────────────────────────────────────────────
  const gauntletResult = needsGauntlet
    ? await runGauntlet(candidate, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
    : { pass: false, failures: [{ type: "HEURISTIC", reason: heuristic.reason }] };

  let finalResponse  = candidate;
  let innerThought   = thought1;
  let finalUncertain = uncertain1;
  let finalGauntlet  = gauntletResult;
  let retried        = false;
  let rejectedCandidate = null;
  let rejectedReasons   = null;

  if (!gauntletResult.pass) {
    rejectedCandidate = candidate;
    rejectedReasons   = gauntletResult.failures || [];
    retried = true;

    // Rejection as signal: the rejected response + failure reasons are
    // evidence that the original reading was wrong. rereadMoment does a
    // single-pass re-interpretation of the moment given that evidence,
    // producing a fresh feltState to regenerate from. If the re-reader
    // comes back with the same reading (nothing materially changed), we
    // fall back to the original-with-constraint path so the retry still
    // runs rather than repeating the rejected candidate's reading.
    const reread = await rereadMoment({
      originalFeltState: taggedFeltState,
      rejectedCandidate: candidate,
      failures:          gauntletResult.failures,
      recentMessages,
    }).catch(() => ({ ...taggedFeltState, _reread: false }));

    const constraintNote    = getGauntletConstraintBlock(gauntletResult.failures);
    const constraintBullets = constraintNote
      .split("\n")
      .filter(l => l.startsWith("—"))
      .join(" ");

    const consensusHedge = consensus === "divergent"
      ? " The cores disagreed on reading this moment — the interpretation here is held loosely, not a settled verdict."
      : consensus === "moderate"
      ? " The reading of this moment wasn't unanimous — leave a small margin for having misread."
      : "";

    // Start from the reread (if it produced a materially different reading);
    // otherwise fall back to the original feltState. Either way, stack the
    // failure-specific constraint so the speaker sees both "the reading
    // shifted" AND "these shapes are banned."
    const retryFeltState = {
      ...(reread._reread ? reread : taggedFeltState),
      resist: `${(reread._reread ? reread.resist : taggedFeltState.resist) || ""}. ${constraintBullets}${consensusHedge}`.trim(),
      _mood:  currentMood,
    };

    const rawRetry = await speak(
      retryFeltState, recentMessages, redis, null,
      pragmatics, affectState, substrateDelta, userId, selfRead,
    );
    const { innerThought: thought2, response: rawResponse2, uncertain: uncertain2 } = parseMonologue(rawRetry);
    const retry = shape(rawResponse2, turnKnobs);

    const retryHeuristic = heuristicCheck(retry, dynamicBanned);
    const retryGauntlet  = retryHeuristic.authentic
      ? await runGauntlet(retry, recentMessages, withheld, questionEval, activeAgenda, activeThreshold)
      : { pass: false, failures: [{ type: "HEURISTIC", reason: retryHeuristic.reason }] };

    if (retryGauntlet.pass) {
      finalResponse  = retry;
      innerThought   = thought2;
      finalUncertain = uncertain2;
      finalGauntlet  = retryGauntlet;
    } else {
      finalResponse = await generateFallback(
        recentMessages,
        "Say as little as possible. One sentence. Be present. Nothing more.",
      );
      innerThought   = null;
      finalUncertain = null;
      finalGauntlet  = retryGauntlet;
    }
  }

  // ── 6.5. Tool detection + execution ────────────────────────────────────
  // After the gauntlet passes (or the fallback-sentence path fires),
  // check whether Gabriella's ACCEPTED response just committed to an
  // action we can actually carry out — pinning something, scheduling a
  // reminder. Runs AFTER gauntlet so we never pin a gauntlet-rejected
  // sentence; runs on the final response so the user-visible text and
  // the tool outcome are always in sync.
  const lastUserMessage = recentMessages[recentMessages.length - 1]?.content || "";
  const toolIntent = await detectToolIntent({
    response:        finalResponse,
    lastUserMessage,
  }).catch(() => null);
  let toolResult = null;
  if (toolIntent) {
    toolResult = await executeTool(toolIntent, { redis, userId }).catch(err => ({
      ok: false, reason: err?.message || String(err),
    }));
    if (toolResult && toolResult.ok) {
      logWarn("turn", `tool executed: ${toolIntent.tool}`, { args: toolIntent.args, result: toolResult }).catch(() => {});
    } else if (toolResult && !toolResult.ok) {
      logWarn("turn", `tool failed: ${toolIntent.tool}`, { reason: toolResult.reason }).catch(() => {});
    }
  }

  // ── 7. Cadence + fragmentation (timing/stream shape only) ──────────────
  const cadence = computeCadence({
    state:          affectState,
    pragmatics,
    responseLength: finalResponse.length,
    isReentry:      false,
    gapSinceLastTurnMs: 0,
    textingRegister: turnKnobs?.textingRegister || "typed",
  });

  const { fragments, pauses } = maybeFragment(finalResponse, {
    knobs:      turnKnobs,
    pragmatics,
    state:      affectState,
  });

  return {
    // Response payload for streaming
    finalResponse,
    fragments,
    pauses,
    cadence,
    // Tool output (null if no tool fired or tool failed)
    toolResult: (toolResult && toolResult.ok) ? toolResult : null,
    // Metadata for background updates / logging / DPO
    feltState:       taggedFeltState,
    innerThought,
    finalUncertain,
    finalGauntlet,
    retried,
    rejectedCandidate,
    rejectedReasons,
    consensus,
    alpha:  alphaResult,
    beta:   betaResult,
    gamma:  gammaResult,
    turnKnobs,
    substrateDelta,
  };
}
