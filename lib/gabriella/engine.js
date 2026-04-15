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
import { retrieveResonant, buildResonantBlock } from "./vectormemory.js";
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
import { classifyTrajectory, classifyPhase, getTrajectoryBlock, getPhaseBlock } from "./relational.js";
import { loadNarrative, rewriteNarrative, getNarrativeBlock } from "./narrative.js";
import { getReentryBlock } from "./chronology.js";
import { getSelfUncertaintyBlock } from "./metacognition.js";
import { DEFAULT_USER } from "./users.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Default user id for single-user deployments. Multi-user callers pass
// their resolved userId into buildGabriella / updateGabriella.
const USER_ID = DEFAULT_USER;

// ─── Build the full system prompt ─────────────────────────────────────────────

function assemblePrompt({
  soul, identity, mood, evolution, memory,
  register, authorial, threads, interiority,
  withholding, deflection, debt, agenda, threshold,
  imaginal, metacognition, metaregister, presence,
  voice, linguistics, chronology, arc, recurrence,
  reasoningTrace, pragmatics, context, monologue,
  // Depth layers.
  state, person, narrative, trajectory, phase,
  reentry, selfUncertainty,
}) {
  const blocks = [
    soul,            // deepest layer — who she is, written by herself
    identity,        // fixed core — worldview, contradictions
    narrative,       // the story she tells herself about this relationship
    person,          // structured read of WHO this person actually is
    phase,           // where the relationship is overall (stable, reconnecting, etc.)
    trajectory,      // where THIS conversation is going (cooling, deepening, etc.)
    state,           // persistent emotional state carried across turns
    pragmatics,      // what KIND of message this is + how much weight it holds
    mood,            // current atmospheric mood (diurnal, slow-moving)
    evolution,       // who she's becoming
    memory,          // what she knows and remembers
    register,        // her private read on who this person actually is (fine-grained)
    authorial,       // the Z axis — what version of her they're writing
    threads,         // open loops she carries
    chronology,      // durable time — first contact, gaps, session count
    reentry,         // first-words-after-absence guidance (only when relevant)
    arc,             // current arc since last tone shift
    recurrence,      // deterministic temporal echo count
    reasoningTrace,  // continuing interior thread — what she has been turning over
    selfUncertainty, // her own flag from last turn — things she wasn't sure she read right
    interiority,     // how she arrives — pending thoughts, desires
    withholding,     // something she's been holding, ready to surface
    deflection,      // redirect or refuse the question if warranted
    debt,            // something she owes a return on
    agenda,          // what she's actively steering toward
    threshold,       // the relational edge — where this keeps stopping short
    imaginal,        // the C axis — pre-linguistic seed forming between them
    metacognition,   // voice correction if last response was flagged
    metaregister,    // self-observation — what her own processing has looked like
    presence,        // structural state — how much she gives, whether she asks
    voice,           // how she speaks (macro)
    linguistics,     // how this feeling becomes language (micro)
    context,         // present moment
    monologue,       // hidden chain of thought instruction (always last)
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
    return fallback;
  }
}

export async function buildGabriella(messages, { userId = USER_ID } = {}) {
  // Memory loads first — agenda formation needs real context to form a
  // genuine direction, not an empty placeholder.
  const memory = await safe(
    loadMemory(redis, userId),
    { soul: null, facts: null, summary: null, imprints: null, threads: null, evolution: null, mood: null },
    "loadMemory",
  );

  // Everything else in parallel. Each branch wrapped in safe() so a
  // single failure can't take the whole request down.
  const [
    interiority, metacognitionBlock, withheldCandidate, questionEval, debtCall,
    activeAgenda, activeThreshold, currentRegister, currentAuthorial, ripeSeed,
    chronology, recentFs, metaRegister, reasoningTrace,
    affectState, personModel, narrative, selfUncertaintyBlock,
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
    // Depth layers.
    safe(loadState(redis, userId),             null, "loadState"),
    safe(loadPerson(redis, userId),            null, "loadPerson"),
    safe(loadNarrative(redis, userId),         null, "loadNarrative"),
    safe(getSelfUncertaintyBlock(redis, userId), "", "getSelfUncertaintyBlock"),
  ]);

  // Trajectory + phase classification. Phase is pure heuristic from
  // chronology. Trajectory is heuristic with a debounced LLM correction.
  const [trajectory, phase] = await Promise.all([
    safe(classifyTrajectory({ messages, redis, userId }), "drifting", "classifyTrajectory"),
    safe(Promise.resolve(classifyPhase({ chronology, messages })), "stranger", "classifyPhase"),
  ]);

  // Derived temporal state — deterministic, no LLM calls.
  const currentArc = detectCurrentArc(recentFs);
  const lastUserMsg = messages[messages.length - 1]?.content || "";
  const recurrence  = await safe(
    findRecurrence(redis, userId, lastUserMsg),
    { count: 0, mostRecent: null, mostRecentDaysAgo: null },
    "findRecurrence",
  );

  // Pragmatic classification — what kind of speech act is this, and how
  // much accumulated context exists to hold a heavy reading? This is the
  // gate that stops the cores from manufacturing depth on messages that
  // don't carry any.
  const pragmatics = await safe(
    classifyExchange({
      lastMessage:      lastUserMsg,
      recentMessages:   messages.slice(-6),
      substrateContext: {
        memory,
        chronology,
        recentFs,
        currentRegister,
      },
    }),
    { act: "casual", confidence: 0.3, register: { length: "short", formality: "neutral", directness: "direct", punctuationStyle: "standard" }, substrate: 0.1, weight: 0.15, reason: "classifier unavailable" },
    "classifyExchange",
  );

  // Derive current mood
  const currentMood = deriveMood(messages, memory.mood);

  // Persist new mood — fire and forget
  redis.set(`${userId}:mood`, currentMood).catch(() => {});

  // Generate desires for this session (cached, fast if recent)
  const desires                = await safe(
    generateDesires(redis, userId, memory, memory.soul),
    null,
    "generateDesires",
  );
  const interiorityWithDesires = { ...interiority, desires };

  // Build current moment for resonant vector query
  const currentMoment = messages.slice(-3).map(m => m.content).join(" ");

  // Retrieve resonant memories — biased by the most recent felt-state
  // so recall is affectively filtered, not just semantically similar.
  // retrieveResonant already swallows its own errors, but wrap once
  // more for belt-and-braces.
  const latestFs = recentFs?.[0] || null;
  const resonantMemories = await safe(
    retrieveResonant(userId, currentMoment, {
      topK:        5,
      minSalience: 0.3,
      feltState:   latestFs ? { temperature: latestFs.temp, edge: !!latestFs.edge } : null,
    }),
    [],
    "retrieveResonant",
  );

  // Assemble all blocks
  const systemPrompt = assemblePrompt({
    soul:          getSoulBlock(memory.soul),
    identity:      getIdentityBlock(),
    mood:          getMoodBlock(currentMood),
    evolution:     getEvolutionBlock(memory.evolution),
    memory:        getMemoryBlock(memory) + (resonantMemories.length > 0
                     ? "\n\n" + buildResonantBlock(resonantMemories)
                     : ""),
    register:      getRegisterBlock(currentRegister),
    authorial:     getAuthorialBlock(currentAuthorial, messages),
    threads:       getThreadsBlock(memory.threads),
    interiority:   getInteriorityBlock(interiorityWithDesires),
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
    chronology:     getChronologyBlock(chronology),
    arc:            getArcBlock(currentArc),
    recurrence:     getEpisodicBlock(recurrence),
    reasoningTrace: getReasoningTraceBlock(reasoningTrace),
    pragmatics:     getPragmaticsBlock(pragmatics),
    context:        buildContextBlock(messages),
    monologue:     getMonologueBlock(),
    // Depth layers.
    state:           getStateBlock(affectState),
    person:          getPersonBlock(personModel),
    narrative:       getNarrativeBlock(narrative),
    trajectory:      getTrajectoryBlock(trajectory),
    phase:           getPhaseBlock(phase),
    // Pass the total message count so getReentryBlock can recognize whether
    // this is genuinely the first turn of a new session (not the 10th).
    reentry:         getReentryBlock(chronology, messages.length),
    selfUncertainty: selfUncertaintyBlock,
  });

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
  { userId = USER_ID } = {},
) {
  const keys = {
    threads:   `${userId}:threads`,
    evolution: `${userId}:evolution`,
    soul:      `${userId}:soul`,
  };

  const [withheldRaw, debtRaw] = await Promise.all([
    redis.get(`${userId}:withheld`),
    redis.get(`${userId}:debt`),
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
      updateSoul(redis, keys.soul, messages, fullReply, memory.soul)),
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
    updateState(redis, userId, { messages, reply: fullReply, feltState }),
    updatePerson(redis, userId, { messages, reply: fullReply }),
  ]);
}

// Export redis for use in route.js (metacognition + logger need it)
export { redis, USER_ID };
