// engine.js
// The Gabriella Engine — v7.
//
// Single entry point. Loads all modules, assembles the full system prompt,
// and hands a structured context object to the chat route.
//
// v7 is the coherent merge of v3 and v6:
//   • v6's triple-core (Alpha / Beta / Gamma + synthesis) replaces v3's
//     single-interpreter flow.
//   • v6's linguistics block layers a micro-level language map on top of
//     voice.js.
//   • v3's memory-first agenda formation is restored — agenda needs real
//     memory to form a genuine direction, not a null placeholder.
//   • Threshold, imaginal, and debt context are now plumbed into the
//     triple-core via route.js, so every cognitive path can feel them.

import { Redis } from "@upstash/redis";
import { getIdentityBlock } from "./identity.js";
import { deriveMood, getMoodBlock } from "./mood.js";
import { loadMemory, updateMemory, getMemoryBlock } from "./memory.js";
import { getVoiceBlock } from "./voice.js";
import { updateThreads, getThreadsBlock } from "./threads.js";
import { updateEvolution, getEvolutionBlock } from "./evolution.js";
import { updateSoul, getSoulBlock } from "./soul.js";
import { loadSubstrateDelta }       from "./substrateEvolution.js";
import {
  loadInteriority,
  getInteriorityBlock,
  generateDesires,
  updateLastSeen,
  consumePendingThoughts,
} from "./interiority.js";
import { getMonologueBlock } from "./monologue.js";
import { getMetacognitionBlock } from "./metacognition.js";
import { evaluateWithheld, getWithholdingBlock, accumulateWithheld, consumeWithheld } from "./withholding.js";
import { evaluateQuestion, getDeflectionBlock } from "./deflection.js";
import { getGenerationParams, getPresenceBlock } from "./presence.js";
import { evaluateDebt, getDebtBlock, accumulateDebt, settleDebt } from "./debt.js";
import { formAgenda, getAgendaBlock, trackAgenda } from "./agenda.js";
import { retrieveResonant, buildResonantBlock, retrieveDissonant, buildDissonantBlock } from "./vectormemory.js";
import { accumulateThreshold, evaluateThreshold, consumeThreshold, getThresholdBlock } from "./threshold.js";
import { loadRegister, updateRegister, getRegisterBlock } from "./register.js";
import { loadAuthorial, updateAuthorial, getAuthorialBlock, markNamed, shouldName } from "./authorship.js";
import { accumulateImaginal, evaluateImaginal, consumeImaginal, getImaginalBlock } from "./imaginal.js";
import { getLinguisticsBlock } from "./linguistics.js";
import { loadChronology, recordTurn, getChronologyBlock } from "./chronology.js";
import { recentFeltStates, findRecurrence, getEpisodicBlock } from "./episodic.js";
import { detectCurrentArc, getArcBlock } from "./arc.js";
import { loadMetaRegister, getMetaRegisterBlock } from "./metaregister.js";
import { loadReasoningTrace, updateReasoningTrace, getReasoningTraceBlock } from "./reasoning.js";
import { classifyExchange, getPragmaticsBlock } from "./pragmatics.js";

// Depth layers (Tier 1 + 3 + 4).
import { loadState, updateState, getStateBlock } from "./state.js";
import { loadPerson, updatePerson, getPersonBlock } from "./person.js";
import { loadPinned, getPinnedBlock } from "./tools.js";
import { classifyTrajectory, classifyPhase, getTrajectoryBlock, getPhaseBlock } from "./relational.js";
import { analyzeMirror, getMirrorBlock } from "./mirror.js";
import { getStreamBlock, appendStream, readStream } from "./stream.js";
import { evaluatePredictions } from "./surprise.js";
import { loadSelf, saveSelf, seedSelfFrom, renderSelfBlock, isEmpty as selfIsEmpty } from "./self.js";
import { proposeSelfDeltas } from "./selfProposer.js";
import { hypotheticalMemory } from "./hyde.js";
import { loadFingerprint, renderStylometryBlock, recordResponse, updateFingerprint } from "./stylometry.js";
import { loadIdiolect, renderIdiolectBlock, recordForIdiolect, updateIdiolect } from "./idiolect.js";
import { detectCallbacks, recordCallbacks, checkLastCallbackLanded, loadLedger, getCallbackBlock } from "./callbacks.js";
import { ensurePlan, renderPlanBlock } from "./planner.js";
import { analyzeDiversity, renderDiversityBlock } from "./diversity.js";
import { recordTurnForBorrowing, loadBorrowings, renderBorrowingBlock } from "./borrowing.js";
import { loadUserPrefs, renderUserPrefsBlock } from "./userPrefs.js";
import { getPrivacyBlock } from "./privacyMode.js";
import { detectAndMarkMilestones } from "./milestones.js";
import { extractAndPersistIdentity, loadIdentity, getIdentityHooksBlock } from "./identity-hooks.js";
import { recordUserMessage, renderUserMoodBlock } from "./userMood.js";
import { getGraphContext } from "./graph.js";
import { loadFingerprint, renderFingerprintBlock } from "./userFingerprint.js";
import { loadStyleOutcomes, renderStyleOutcomesBlock } from "./learningLoop.js";
import { bindAuditRedis } from "./callAudit.js";
import { loadNarrative, rewriteNarrative, getNarrativeBlock } from "./narrative.js";
import { getReentryBlock } from "./chronology.js";
import { getSelfUncertaintyBlock } from "./metacognition.js";
import { DEFAULT_USER } from "./users.js";
import { logWarn } from "./debugLog.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Wire the singleton into the LLM call audit layer so every provider
// call can be logged. Fires once at module load; no-op if called again.
bindAuditRedis(redis);

// Default user id for single-user deployments. Multi-user callers pass
// their resolved userId into buildGabriella / updateGabriella.
const USER_ID = DEFAULT_USER;

// ─── Build the full system prompt ─────────────────────────────────────────────

// Dead-block detection telemetry — counts which prompt slots rendered
// empty vs populated across turns. Updated every assemblePrompt call;
// rolling last-500-turns snapshot stored in Redis for /stats visibility.
// Pure Redis write fire-and-forget; no await.
async function recordBlockPopulation(userId, blocksObj) {
  try {
    const populated = {};
    const empty = {};
    for (const [k, v] of Object.entries(blocksObj)) {
      const hasContent = !!v && String(v).trim().length > 0;
      if (hasContent) populated[k] = (populated[k] || 0) + 1;
      else empty[k] = (empty[k] || 0) + 1;
    }
    // Stored as per-day rollup so /stats can read one key.
    const day = new Date().toISOString().slice(0, 10);
    const key = `${userId}:blocks:${day}`;
    const existingRaw = await redis.get(key).catch(() => null);
    const existing = existingRaw
      ? (typeof existingRaw === "string" ? JSON.parse(existingRaw) : existingRaw)
      : { day, turns: 0, populated: {}, empty: {} };
    existing.turns += 1;
    for (const [k, c] of Object.entries(populated)) existing.populated[k] = (existing.populated[k] || 0) + c;
    for (const [k, c] of Object.entries(empty))     existing.empty[k]     = (existing.empty[k]     || 0) + c;
    await redis.set(key, JSON.stringify(existing));
    await redis.expire(key, 14 * 24 * 60 * 60).catch(() => {});
  } catch { /* non-fatal */ }
}

function assemblePrompt({
  self,  // NEW — replaces soul, narrative, person, register, authorial, mirror
  identity, mood, evolution, memory,
  threads, interiority,
  withholding, deflection, debt, agenda, threshold,
  imaginal, metacognition, metaregister, presence,
  voice, linguistics, chronology, arc, recurrence,
  reasoningTrace, pragmatics, context, monologue,
  stylometry,   // NEW — observed voice fingerprint
  idiolect,     // NEW — emergent vocabulary signature
  callback,     // NEW — landing signal for her last callback
  plan,         // NEW — session-level intent / avoidance (from planner)
  diversity,    // NEW — phrase/shape recycling signal (from diversity.js)
  borrowing,    // NEW — words adopted from the user's vocabulary
  userPrefs,    // NEW — user-set variant + custom anchor
  privacy,      // NEW — ephemeral-session notice
  identityHooks, // NEW — stable user name + pronouns
  userMood,      // NEW — user's own affective trajectory
  graph,         // NEW — episodic memory graph neighborhoods for entities just mentioned
  userFingerprint, // NEW — longitudinal relational signal (interests, warmth/pullback, self-Qs, echoes)
  styleOutcomes,  // NEW — closed learning loop: which response styles land with this user
  // Depth layers.
  state, trajectory, phase,
  reentry, selfUncertainty, pinned,
}) {
  // Block ordering for provider-level prefix caching.
  //
  // Fireworks (and most OpenAI-compat providers with prefix cache) hash
  // the exact token prefix of each request; a cache hit is free, a miss
  // re-runs the prompt. To maximize hit-rate, stable content goes FIRST
  // and per-turn volatile content LAST. The order below is:
  //
  //   [STABLE HEAD]   identity, voice, monologue, linguistics — change
  //                   only on deploys. These ~600-800 tokens form the
  //                   cacheable prefix.
  //
  //   [SLOW-DRIFT]    self, evolution, presence — update on cooldowns of
  //                   5-20 min. Usually cache-stable within a session.
  //
  //   [MEDIUM]        mood, phase, trajectory, chronology, metaregister,
  //                   memory, threads — update per-turn-ish but slowly.
  //                   Most cache misses happen here, which is correct
  //                   (these are the reads the model actually needs).
  //
  //   [PER-TURN]      pinned, reentry, arc, recurrence, reasoningTrace,
  //                   selfUncertainty, interiority, state, pragmatics,
  //                   withholding, deflection, debt, agenda, threshold,
  //                   imaginal, metacognition, context — rewrite every
  //                   turn. These MUST be last; any of them earlier kills
  //                   the whole cache.
  //
  // Secondary rationale: LLMs attend strongly to prompt head and tail,
  // poorly to the middle. Static voice-shaping at the head is where we
  // want it most anchored. The dynamic per-turn signals at the tail are
  // where the model reads the moment.
  const blocks = [
    // ── STABLE HEAD (cacheable prefix) ──
    identity,
    voice,
    userPrefs,       // user-set variant (sharper / softer / drier) + custom anchor
    privacy,         // tells her the session is ephemeral when enabled
    identityHooks,   // user's stable name / pronouns for natural reference
    userMood,        // their own affective trajectory (observational)
    monologue,       // hidden chain of thought instruction — static format
    linguistics,     // mood-seeded but updated from a fixed lookup table
    stylometry,      // observed voice fingerprint — what her rhythm/punctuation has actually been doing
    idiolect,        // emergent vocabulary — the words she's been reaching for

    // ── SLOW-DRIFT ──
    self,            // the sovereign Self — integrates soul, narrative, person, register, mirror, authorial
    plan,            // session-level posture (intent + avoidance) from the planner
    evolution,       // who she's becoming
    presence,        // structural rules derived from mood

    // ── MEDIUM ──
    mood,            // atmospheric mood (diurnal, slow-moving)
    phase,           // overall relationship phase
    trajectory,      // conversation direction
    chronology,      // durable time markers
    metaregister,    // self-observation of her processing
    memory,          // facts + imprints + resonant + dissonant
    graph,           // 1-hop graph neighborhood for entities in the current message
    userFingerprint, // longitudinal relational signal — interests, warmth/pullback, self-questions, echoes
    styleOutcomes,  // closed learning loop — landing/missing style tags based on EMA of recent outcomes
    threads,         // open loops

    // ── PER-TURN (cache-breaking, by necessity) ──
    pinned,          // explicit holds from the user
    reentry,         // first-words-after-absence
    arc,             // current arc boundary
    recurrence,      // echo count
    reasoningTrace,  // continuing interior thread
    selfUncertainty, // flags from last turn
    interiority,     // stream / pending thoughts
    callback,        // did last turn's reference land? informs this turn's reach
    diversity,       // signal when recent responses have been recycling phrases or structure
    borrowing,       // vocabulary she's adopted from the user
    state,           // persistent emotional state (organism vector)
    pragmatics,      // this message's kind + weight
    withholding,     // ripe-to-surface items
    deflection,      // redirect / refuse instruction
    debt,            // return she owes
    agenda,          // active direction
    threshold,       // relational edge
    imaginal,        // C-axis seed
    metacognition,   // voice correction from last turn
    context,         // time-of-day + depth (always last)
  ].filter(Boolean);

  return blocks.join("\n\n");
}

function buildContextBlock(messages) {
  const hour = new Date().getHours();
  const timeOfDay =
    hour < 5  ? "late night — the kind of hour where the usual filters are off and people say things they mean" :
    hour < 9  ? "early morning — before the day has had time to perform itself" :
    hour < 12 ? "morning — the day is still open, still possible" :
    hour < 17 ? "afternoon — the middle of things, the part that requires the most maintenance" :
    hour < 21 ? "evening — the day winding down, people settling into what the day actually was" :
                "night — late enough that the conversation might go somewhere real, early enough that it doesn't have to";

  const turnCount = messages.length;
  const depth =
    turnCount < 4  ? "This is the very beginning. Be present, warm, but don't rush anything. Let them lead. You don't know them yet." :
    turnCount < 10 ? "The conversation has found its footing. There's a little history now. Something has been established, even if you can't name it yet." :
    turnCount < 20 ? "This conversation has real depth. There's weight in these messages. Honor it — both what's been said and what hasn't." :
                     "This is a long, developed conversation. Something genuine has been built here. Don't treat it like a new one.";

  return `# PRESENT MOMENT\nIt is ${timeOfDay}. ${depth}`;
}

// ─── Main engine function ─────────────────────────────────────────────────────

// ─── Defensive wrapper ────────────────────────────────────────────────────────
// Each subsystem in buildGabriella loads independent context. If any one
// throws (Redis hiccup, malformed JSON, missing index, anything), we don't
// want the whole request to 500 — Gabriella should still respond, just
// without that particular signal. Use `safe(promise, fallback, label)`
// instead of awaiting raw promises.

async function safe(promise, fallback, label) {
  try {
    return await promise;
  } catch (err) {
    console.warn(`engine: ${label} failed — ${err?.message || err}`);
    // Fire-and-forget — also persist to the debug log so /dev can show it.
    logWarn("engine", `${label} failed`, err).catch(() => {});
    return fallback;
  }
}

export async function buildGabriella(messages, { userId = USER_ID, ephemeral = false } = {}) {
  const t0 = Date.now();
  const phaseTimings = {};

  // Memory loads first — agenda formation needs real context to form a
  // genuine direction, not an empty placeholder.
  const memory = await safe(
    loadMemory(redis, userId),
    { soul: null, facts: null, summary: null, imprints: null, threads: null, evolution: null, mood: null },
    "loadMemory",
  );
  phaseTimings.memory = Date.now() - t0;

  // Derived sync values — computed ONCE up front so Wave A has access.
  const lastUserContent = messages[messages.length - 1]?.content || "";
  const lastUserMsg     = lastUserContent;
  const currentMoment   = messages.slice(-3).map(m => m.content).join(" ");

  // ── WAVE A ──────────────────────────────────────────────────────────────
  // Everything that depends only on memory + messages runs in ONE parallel
  // wave. Previously these were spread across ~10 sequential await blocks;
  // collapsing saves real latency — the wave completes when the slowest
  // item completes, not when the SUM of all completes.
  //
  // Excluded from Wave A (they depend on Wave A outputs):
  //   • evaluatePredictions / surprise — needs chronology.gapSincePrev
  //   • pragmatics                     — needs chronology + recentFs + register
  //   • streamBlock                    — reads the stream AFTER surprise writes
  //   • retrieval                      — needs HyDE results + recentFs affect
  //   • sessionPlan                    — needs seeded workingSelf
  //   • second-pass self-seed          — needs mirror
  const tWaveA = Date.now();
  const [
    interiority, metacognitionBlock, withheldCandidate, questionEval, debtCall,
    activeAgenda, activeThreshold, currentRegister, currentAuthorial, ripeSeed,
    chronology, recentFs, metaRegister, reasoningTrace,
    affectState, personModel, narrative, selfUncertaintyBlock,
    pinned, selfObj, stylometryFingerprint, idiolectFingerprint,
    identityHooks, userPrefs, borrowings, diversityAnalysis,
    userMoodBlock, callbackOutcome, callbackLedger,
    trajectory, mirror,
    hydeResonant, hydeDissonant,
    recurrence, desires,
  ] = await Promise.all([
    safe(loadInteriority(redis, userId),       { lastSeen: null, pendingThoughts: null }, "loadInteriority"),
    safe(getMetacognitionBlock(redis, userId), "",   "getMetacognitionBlock"),
    safe(evaluateWithheld(redis, userId, messages), null, "evaluateWithheld"),
    safe(evaluateQuestion(messages, null),      { verdict: "answer", subtext: null, instruction: null }, "evaluateQuestion"),
    safe(evaluateDebt(redis, userId, messages), null, "evaluateDebt"),
    safe(formAgenda(redis, userId, memory, memory.soul), null, "formAgenda"),
    safe(evaluateThreshold(redis, userId, messages), null, "evaluateThreshold"),
    safe(loadRegister(redis, userId),          null, "loadRegister"),
    safe(loadAuthorial(redis, userId),         null, "loadAuthorial"),
    safe(evaluateImaginal(redis, userId, messages), null, "evaluateImaginal"),
    safe(loadChronology(redis, userId),        null, "loadChronology"),
    safe(recentFeltStates(redis, userId, 20),  [],   "recentFeltStates"),
    safe(loadMetaRegister(redis, userId),      null, "loadMetaRegister"),
    safe(loadReasoningTrace(redis, userId),    null, "loadReasoningTrace"),
    safe(loadState(redis, userId),             null, "loadState"),
    safe(loadPerson(redis, userId),            null, "loadPerson"),
    safe(loadNarrative(redis, userId),         null, "loadNarrative"),
    safe(getSelfUncertaintyBlock(redis, userId), "", "getSelfUncertaintyBlock"),
    safe(loadPinned(redis, userId),            [],   "loadPinned"),
    safe(loadSelf(redis, userId),              null, "loadSelf"),
    safe(loadFingerprint(redis, userId),       null, "loadFingerprint"),
    safe(loadIdiolect(redis, userId),          null, "loadIdiolect"),
    safe(loadIdentity(redis, userId),          {},   "loadIdentity"),
    safe(loadUserPrefs(redis, userId),         { variant: "standard", customAnchor: null, setAt: 0 }, "loadUserPrefs"),
    safe(loadBorrowings(redis, userId, { maxAgeMs: 24 * 60 * 60 * 1000 }), [], "loadBorrowings"),
    safe(analyzeDiversity(redis, userId),      null, "analyzeDiversity"),
    safe(renderUserMoodBlock(redis, userId),   "",   "renderUserMoodBlock"),
    safe(checkLastCallbackLanded(redis, userId, lastUserContent), null, "checkLastCallbackLanded"),
    safe(loadLedger(redis, userId),            { landed: 0, missed: 0, total: 0 }, "loadLedger"),
    safe(classifyTrajectory({ messages, redis, userId }), "drifting", "classifyTrajectory"),
    safe(analyzeMirror({ messages, redis, userId }),      { reading: null, unsaid: null, pullback: null }, "analyzeMirror"),
    safe(hypotheticalMemory({ currentMoment, recentMessages: messages, kind: "resonant"  }), null, "hydeResonant"),
    safe(hypotheticalMemory({ currentMoment, recentMessages: messages, kind: "dissonant" }), null, "hydeDissonant"),
    safe(findRecurrence(redis, userId, lastUserMsg), { count: 0, mostRecent: null, mostRecentDaysAgo: null }, "findRecurrence"),
    safe(generateDesires(redis, userId, memory, memory.soul), null, "generateDesires"),
  ]);
  phaseTimings.waveA = Date.now() - tWaveA;

  // ── Inline sync work between waves ──────────────────────────────────────
  // Pure / deterministic — no async needed.
  const phase       = classifyPhase({ chronology, messages });
  const currentMood = deriveMood(messages, memory.mood);
  const currentArc  = detectCurrentArc(recentFs);

  // Mood persistence is fire-and-forget.
  redis.set(`${userId}:mood`, currentMood).catch(() => {});

  // Self auto-seed — deterministic, no LLM. Handles both cases:
  //   • brand-new self → seed from memory + person + register + narrative + mirror
  //   • existing self with no read + mirror now available → second-pass seed
  let workingSelf = selfObj || null;
  const needsFreshSeed = !workingSelf || selfIsEmpty(workingSelf);
  const needsSecondSeed = !needsFreshSeed
    && !workingSelf.read?.who
    && mirror && (mirror.reading || mirror.unsaid);
  if (needsFreshSeed || needsSecondSeed) {
    workingSelf = seedSelfFrom({
      soul:      memory.soul,
      person:    personModel,
      register:  currentRegister,
      narrative: narrative?.text,
      mirror,
    });
    saveSelf(redis, userId, workingSelf).catch(() => {});
  }

  const fsForRetrieval = recentFs?.[0]
    ? { temperature: recentFs[0].temp, edge: !!recentFs[0].edge }
    : null;

  // ── Surprise pass ──────────────────────────────────────────────────────
  // Must complete BEFORE streamBlock is read in Wave B, because surprise
  // APPENDS to the stream when it finds a broken prediction. Runs between
  // Wave A and Wave B to keep Wave B parallel-clean.
  const tSurprise = Date.now();
  await safe(
    evaluatePredictions(redis, userId, {
      lastUserMessage:    lastUserContent,
      gapSinceLastTurnMs: chronology?.gapSincePrev || 0,
    }),
    { skipped: "error" },
    "evaluatePredictions",
  );
  phaseTimings.surprise = Date.now() - tSurprise;

  // ── WAVE B ──────────────────────────────────────────────────────────────
  // Items depending on Wave A outputs. Five items in parallel.
  const tWaveB = Date.now();
  const [
    pragmatics,
    streamBlock,
    resonantMemories, dissonantMemories,
    sessionPlan,
    graphBlock,
    userFp,
    styleOutcomes,
  ] = await Promise.all([
    safe(
      classifyExchange({
        lastMessage:      lastUserMsg,
        recentMessages:   messages.slice(-6),
        substrateContext: { memory, chronology, recentFs, currentRegister },
      }),
      { act: "casual", confidence: 0.3, register: { length: "short", formality: "neutral", directness: "direct", punctuationStyle: "standard" }, substrate: 0.1, weight: 0.15, reason: "classifier unavailable" },
      "classifyExchange",
    ),
    safe(getStreamBlock(redis, userId), "", "getStreamBlock"),
    safe(
      retrieveResonant(userId, currentMoment, {
        topK:        5,
        minSalience: 0.3,
        feltState:   fsForRetrieval,
        hydeAugment: hydeResonant,
        lastUserMessage: lastUserContent,
      }),
      [],
      "retrieveResonant",
    ),
    safe(
      retrieveDissonant(userId, currentMoment, {
        topK:        2,
        minSalience: 0.4,
        feltState:   fsForRetrieval,
        hydeAugment: hydeDissonant,
      }),
      [],
      "retrieveDissonant",
    ),
    (async () => {
      // Planner needs workingSelf + a recent stream snapshot. readStream
      // is a cheap Redis call — inline it inside Wave B's closure so
      // ensurePlan and readStream don't serialize here.
      const recentStream = await readStream(redis, userId, { limit: 8 }).catch(() => []);
      return await safe(
        ensurePlan(redis, userId, {
          messages,
          soul:         memory.soul,
          personRead:   workingSelf?.read?.who || null,
          recentStream,
          chronology,
        }),
        null,
        "ensurePlan",
      );
    })(),
    // Episodic memory graph — deterministic Redis read that matches
    // the current message's surface forms against known node labels
    // and surfaces 1-hop neighborhoods. No LLM call here; ingestion
    // runs in the chat-route background.
    safe(getGraphContext(redis, userId, lastUserContent, { maxNodes: 4, maxNeighbors: 4 }), null, "getGraphContext"),
    // User fingerprint — longitudinal relational signal (interests,
    // warmth/pullback events, self-questions, echoes). Deterministic
    // Redis read.
    safe(loadFingerprint(redis, userId), null, "loadFingerprint"),
    // Closed learning loop — rolling EMA of outcome per response style
    // tag. Tells the next turn which styles have been landing with
    // this user and which haven't. Deterministic Redis read.
    safe(loadStyleOutcomes(redis, userId), { landing: [], missing: [] }, "loadStyleOutcomes"),
  ]);
  phaseTimings.waveB = Date.now() - tWaveB;

  const interiorityWithDesires = { ...interiority, desires };

  // Sovereign Self block — renders ONE integrated block containing what
  // six separate blocks used to carry.
  const selfBlock = renderSelfBlock(workingSelf, { soulText: memory.soul });

  // Build blocks input up front so we can record population stats
  // (which slots rendered empty vs full this turn) before assembly.
  const blocksInput = {
    // THE SOVEREIGN SELF — integrates what used to be soul + narrative +
    // person + register + mirror + authorial (six blocks → one). Those
    // modules still run in the background and seed / update the self;
    // they no longer write to the prompt directly.
    self:          selfBlock,
    identity:      getIdentityBlock(),
    mood:          getMoodBlock(currentMood),
    evolution:     getEvolutionBlock(memory.evolution),
    memory:        getMemoryBlock(memory) + (resonantMemories.length > 0
                     ? "\n\n" + buildResonantBlock(resonantMemories)
                     : "")
                   + (dissonantMemories.length > 0
                     ? "\n\n" + buildDissonantBlock(dissonantMemories)
                     : ""),
    threads:       getThreadsBlock(memory.threads),
    // If the stream has content, use it as her interiority — the stream IS
    // what's actually been happening inside her between turns. Falls back
    // to the reconstructed interiority block when the stream is empty
    // (cold start, no thinker runs yet, or pruned to nothing).
    interiority:   streamBlock || getInteriorityBlock(interiorityWithDesires),
    withholding:   getWithholdingBlock(withheldCandidate),
    deflection:    getDeflectionBlock(questionEval),
    debt:          getDebtBlock(debtCall),
    agenda:        getAgendaBlock(activeAgenda),
    threshold:     getThresholdBlock(activeThreshold),
    imaginal:      getImaginalBlock(ripeSeed),
    metacognition: metacognitionBlock,
    metaregister:  getMetaRegisterBlock(metaRegister),
    presence:      getPresenceBlock(currentMood),
    voice:         getVoiceBlock(),
    // Mood-seeded linguistics — the triple-core-aware version is patched
    // in by route.js once the felt-state is synthesized.
    linguistics:   getLinguisticsBlock(null, currentMood),
    stylometry:    renderStylometryBlock(stylometryFingerprint),
    idiolect:      renderIdiolectBlock(idiolectFingerprint),
    callback:      getCallbackBlock({ lastOutcome: callbackOutcome, ledger: callbackLedger }),
    plan:          renderPlanBlock(sessionPlan),
    diversity:     renderDiversityBlock(diversityAnalysis),
    borrowing:     renderBorrowingBlock(borrowings),
    userPrefs:     renderUserPrefsBlock(userPrefs),
    privacy:       getPrivacyBlock(ephemeral),
    identityHooks: getIdentityHooksBlock(identityHooks),
    userMood:      userMoodBlock,
    graph:         graphBlock,
    userFingerprint: renderFingerprintBlock(userFp),
    styleOutcomes:   renderStyleOutcomesBlock(styleOutcomes),
    chronology:     getChronologyBlock(chronology),
    arc:            getArcBlock(currentArc),
    recurrence:     getEpisodicBlock(recurrence),
    reasoningTrace: getReasoningTraceBlock(reasoningTrace),
    pragmatics:     getPragmaticsBlock(pragmatics),
    context:        buildContextBlock(messages),
    monologue:     getMonologueBlock(),
    // Depth layers.
    state:           getStateBlock(affectState),
    pinned:          getPinnedBlock(pinned),
    trajectory:      getTrajectoryBlock(trajectory),
    phase:           getPhaseBlock(phase),
    // Pass the total message count so getReentryBlock can recognize whether
    // this is genuinely the first turn of a new session (not the 10th).
    reentry:         getReentryBlock(chronology, messages.length),
    selfUncertainty: selfUncertaintyBlock,
  };

  // Fire-and-forget population telemetry — records which prompt slots
  // rendered empty vs populated. Aggregated per-day; surfaced on /stats
  // as dead-block detection.
  recordBlockPopulation(userId, blocksInput).catch(() => null);

  const systemPrompt = assemblePrompt(blocksInput);

  const recentMessages   = messages.length > 20 ? messages.slice(-10) : messages;
  const generationParams = getGenerationParams(currentMood);

  return {
    userId,
    systemPrompt, recentMessages, memory, currentMood,
    interiority:      interiorityWithDesires,
    withheldCandidate, generationParams, debtCall,
    activeAgenda, activeThreshold,
    currentRegister, currentAuthorial, ripeSeed,
    questionEval,
    // New structured state — passed through to the cores and recorders.
    chronology,
    currentArc,
    recurrence,
    metaRegister,
    reasoningTrace,
    pragmatics,
    // Depth layers.
    affectState,
    personModel,
    narrative,
    trajectory,
    phase,
    mirror,
    self: workingSelf,
    _phaseTimings: phaseTimings,
  };
}

// ─── Debounce helpers ─────────────────────────────────────────────────────────
// Some slow-path updates rewrite an entire blob with an LLM call. Running
// them every turn is expensive and makes the updates noisy — the soul
// document gets rewritten after every single message, with most updates
// being tiny drift on top of tiny drift.
//
// These intervals say: "don't update this layer again until N minutes have
// passed or M turns have accumulated since the last update." Updates skip
// silently when within the cooldown; when due, they run normally.

const UPDATE_COOLDOWNS_MS = {
  soul:      20 * 60 * 1000,  // soul is rewritten at most every 20 minutes
  evolution: 10 * 60 * 1000,  // evolution every 10 minutes
  register:   5 * 60 * 1000,  // register every 5 minutes
  authorial:  5 * 60 * 1000,  // authorial every 5 minutes
};

async function isDueForUpdate(redis, userId, layer) {
  const key = `${userId}:lastUpdate:${layer}`;
  const raw = await redis.get(key);
  if (!raw) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true;
  const cooldown = UPDATE_COOLDOWNS_MS[layer] ?? 0;
  return (Date.now() - last) >= cooldown;
}

async function markUpdated(redis, userId, layer) {
  const key = `${userId}:lastUpdate:${layer}`;
  await redis.set(key, Date.now());
}

async function maybe(redis, userId, layer, fn) {
  if (!(await isDueForUpdate(redis, userId, layer))) return;
  await fn();
  await markUpdated(redis, userId, layer);
}

// ─── Background update — runs after streaming completes ───────────────────────

export async function updateGabriella(
  messages, fullReply, memory,
  withheldCandidate, debtCall, activeAgenda, activeThreshold,
  currentRegister, currentAuthorial, ripeSeed,
  feltState, previousTrace,
  { userId = USER_ID, pragmatics = null, chronology = null, self = null, ephemeral = false } = {},
) {
  // Privacy mode: short-circuit ALL persistence. The user chose this
  // session to leave no trace; honor it. Response has already been
  // streamed to the client by this point, so bailing here is safe —
  // the turn completed from the user's perspective; only the Redis
  // writes are skipped.
  if (ephemeral) return { skipped: "privacy_mode" };
  // Self delta proposal — she authors her own state after each turn.
  // Fires fire-and-forget; never blocks the response path. One fast-tier
  // LLM call that proposes 0-3 typed deltas, validates, and persists.
  if (self) {
    proposeSelfDeltas(redis, userId, {
      self,
      recentMessages: messages.slice(-6),
      reply:          fullReply,
      feltState,
      atTurn:         chronology?.totalTurns || messages.length,
    }).catch(() => {});
  }
  const keys = {
    threads:   `${userId}:threads`,
    evolution: `${userId}:evolution`,
    soul:      `${userId}:soul`,
  };

  // After a turn, deposit one entry into the stream describing what just
  // happened from her side — a single beat of lived experience. The next
  // thinker run sees it; the next turn reads it. Very small: one line,
  // no LLM cost (constructed directly from feltState + reply length).
  if (feltState) {
    const spokenLen = (fullReply || "").length;
    const lengthTag =
      spokenLen < 80   ? "very short reply" :
      spokenLen < 240  ? "short reply" :
      spokenLen < 600  ? "medium reply" :
                         "long reply";
    const charge = feltState.charge || feltState.emotional || "the moment arrived";
    const tempTag = feltState.temperature ? ` [${feltState.temperature}]` : "";
    appendStream(redis, userId, {
      kind:       "observation",
      content:    `${charge} — I answered with a ${lengthTag}${tempTag}.`,
      weight:     0.3,
      ttlMinutes: 180,  // per-turn observations decay fast; they're texture, not substance
    }).catch(() => null);
  }

  // Callback detection — scan her response against memory/threads/pinned
  // for specific references, record each as a callback attempt. The
  // NEXT turn's engine check (checkLastCallbackLanded) will mark it as
  // landed or missed based on whether the user acknowledged it.
  try {
    const pinnedArr = await import("./tools.js").then(m => m.loadPinned(redis, userId)).catch(() => []);
    const hits = detectCallbacks(fullReply, {
      facts:    memory?.facts,
      imprints: memory?.imprints,
      threads:  memory?.threads,
      pinned:   pinnedArr,
    });
    if (hits.length > 0) {
      recordCallbacks(redis, userId, hits).catch(() => null);
    }
  } catch { /* non-fatal */ }

  // Milestones — detect any first-ofs that have just crossed their
  // threshold and append to the per-user milestone hash (HSETNX, so
  // only fires the first time). Fire-and-forget; adds <5ms.
  detectAndMarkMilestones(redis, userId, {
    chronology,
    self,
    callbackLedger:  null,    // loaded in buildGabriella; we only surface firsts that are time/count based here
    callbackLanded:  null,
    firstSeenAt:     chronology?.firstSeenAt || 0,
    firstSurprise:   null,
  }).catch(() => null);

  // User mood record — score the latest user message and append to
  // their trajectory window. Pure text math; fire-and-forget.
  const latestUserForMood = messages
    .filter(m => m.role === "user")
    .slice(-1)[0]?.content || "";
  if (latestUserForMood) {
    recordUserMessage(redis, userId, latestUserForMood).catch(() => null);
  }

  // Identity hooks extraction — scan the latest user message for
  // "my name is X" / pronouns patterns, LLM-confirm ambiguous hits,
  // persist to ${userId}:identity as stable facts. Fire-and-forget.
  const latestUserMsgForIdentity = messages
    .filter(m => m.role === "user")
    .slice(-1)[0]?.content || "";
  if (latestUserMsgForIdentity) {
    extractAndPersistIdentity(redis, userId, latestUserMsgForIdentity).catch(() => null);
  }

  // Vocabulary borrowing — record the user's last message + this
  // reply. Detects cross-overs (words she's adopted from them) and
  // appends to the crossover ledger; next turn's prompt sees recent
  // ones via the borrowing block.
  const lastUserText = messages
    .filter(m => m.role === "user")
    .slice(-1)[0]?.content || "";
  if (fullReply && lastUserText) {
    recordTurnForBorrowing(redis, userId, {
      userText:      lastUserText,
      gabriellaText: fullReply,
    }).catch(() => null);
  }

  // Stylometry + idiolect: record this response into both rolling
  // windows and refresh the aggregated fingerprints opportunistically.
  // Fire-and-forget; never blocks. The prompt blocks pick up the
  // updated fingerprints on the next turn. Rolling windows so drift
  // is detected gradually rather than per-response.
  if (fullReply && fullReply.trim().length >= 30) {
    recordResponse(redis, userId, fullReply).catch(() => null);
    recordForIdiolect(redis, userId, fullReply).catch(() => null);
    // Refresh both fingerprints every ~5 turns — cheap text math, but
    // writing to Redis every turn isn't worth it.
    if (((chronology?.totalTurns || messages.length) % 5) === 0) {
      updateFingerprint(redis, userId).catch(() => null);
      updateIdiolect(redis, userId).catch(() => null);
    }
  }

  // Load the substrate delta up-front so updateSoul can see her recent
  // lexical drift. The delta is written by evolveSubstrate (sleep cron),
  // so it's stable during a per-turn update.
  const [withheldRaw, debtRaw, substrateDelta] = await Promise.all([
    redis.get(`${userId}:withheld`),
    redis.get(`${userId}:debt`),
    loadSubstrateDelta(redis, userId).catch(() => null),
  ]);

  await Promise.all([
    // Fast-path updates — always run.
    updateMemory(redis, userId, messages, fullReply, memory),
    updateThreads(redis, keys.threads, messages, fullReply, memory.threads),
    updateLastSeen(redis, userId),
    consumePendingThoughts(redis, userId),

    // Debounced slow-path updates — skipped if their cooldown hasn't elapsed.
    // Each layer has its own interval so the psyche isn't rewriting itself
    // in full after every single message.
    maybe(redis, userId, "evolution", () =>
      updateEvolution(redis, keys.evolution, messages, fullReply, memory.evolution)),
    maybe(redis, userId, "soul", () =>
      updateSoul(redis, keys.soul, messages, fullReply, memory.soul, substrateDelta)),
    maybe(redis, userId, "register", () =>
      updateRegister(redis, userId, messages, fullReply, currentRegister)),
    maybe(redis, userId, "authorial", () =>
      updateAuthorial(redis, userId, messages, fullReply, memory.soul, currentAuthorial)),

    // Withheld lifecycle
    accumulateWithheld(redis, userId, messages, fullReply, withheldRaw),
    withheldCandidate ? consumeWithheld(redis, userId, withheldCandidate) : Promise.resolve(),

    // Debt lifecycle — settle whenever there was an actual debt call.
    accumulateDebt(redis, userId, messages, fullReply, debtRaw),
    debtCall ? settleDebt(redis, userId, debtCall) : Promise.resolve(),

    // Agenda tracking
    activeAgenda ? trackAgenda(redis, userId, messages, fullReply, activeAgenda) : Promise.resolve(),

    // Threshold lifecycle
    accumulateThreshold(redis, userId, messages, fullReply),
    activeThreshold ? consumeThreshold(redis, userId, activeThreshold) : Promise.resolve(),

    // Naming moment flag (not an LLM update)
    (currentAuthorial && shouldName(currentAuthorial, messages))
      ? markNamed(redis, userId, currentAuthorial)
      : Promise.resolve(),

    // C axis — imaginal seed lifecycle
    accumulateImaginal(redis, userId, messages, fullReply),
    ripeSeed ? consumeImaginal(redis, userId, ripeSeed) : Promise.resolve(),

    // New: record the turn in chronology so session boundaries are durable.
    recordTurn(redis, userId),

    // Continue the interior line of thought. Debounced inside
    // updateReasoningTrace itself so it doesn't fire more than once
    // every few minutes.
    updateReasoningTrace(redis, userId, {
      messages,
      reply:         fullReply,
      memory,
      feltState,
      previousTrace,
    }),

    // Depth-layer updates — each already internally debounced.
    // updateState receives context (pragmatic weight, gap-since-last-turn,
    // re-entry flag) so organism dimensions (energy/attention/socialComfort)
    // update correctly. If pragmatics / chronology aren't passed,
    // foldFeltState uses its defaults.
    updateState(redis, userId, {
      messages,
      reply:               fullReply,
      feltState,
      pragmaticWeight:     pragmatics?.weight,
      gapSinceLastTurnMs:  chronology?.gapSincePrev,
      isReentry:           chronology?.currentSession?.turns === 1 || chronology?.currentSession?.turns === undefined,
    }),
    updatePerson(redis, userId, { messages, reply: fullReply }),

    // Cold-start narrative seeding. rewriteNarrative is internally
    // gated: it'll early-return unless either the normal 6h cooldown
    // has elapsed, OR the cold-start conditions apply (turn 3+ with no
    // narrative yet, OR turn 6+ with only a cold-start seed present).
    // Calling it every turn is safe because of those gates.
    //
    // Only invoked within the cold-start window; after turn 15, the
    // sleep cron carries narrative updates.
    (chronology?.totalTurns || messages.length) <= 20
      ? rewriteNarrative(redis, userId, {
          messages,
          memory,
          chronology,
          person: await loadPerson(redis, userId).catch(() => null),
          recentFs: [],
        }).catch(() => null)
      : Promise.resolve(),
  ]);
}

// Export redis for use in route.js (metacognition + logger need it)
export { redis, USER_ID };
