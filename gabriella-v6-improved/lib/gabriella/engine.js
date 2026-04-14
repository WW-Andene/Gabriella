// engine.js
// The Gabriella Engine.
// Single entry point. Loads all modules, assembles the final system prompt.
// This is the only file route.js needs to import.

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
import { formAgenda, loadAgenda, getAgendaBlock, trackAgenda } from "./agenda.js";
import { retrieveResonant, buildResonantBlock } from "./vectormemory.js";
import { accumulateThreshold, evaluateThreshold, consumeThreshold, getThresholdBlock } from "./threshold.js";
import { loadRegister, updateRegister, getRegisterBlock, getRegisterForInterpreter } from "./register.js";
import { loadAuthorial, updateAuthorial, getAuthorialBlock, getAuthorialForInterpreter, markNamed, shouldName } from "./authorship.js";
import { accumulateImaginal, evaluateImaginal, consumeImaginal, getImaginalBlock } from "./imaginal.js";
import { getLinguisticsBlock } from "./linguistics.js";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID = "user_default";

// ─── Build the full system prompt ─────────────────────────────────────────────

function assemblePrompt({ soul, identity, mood, evolution, memory, register, authorial, threads, interiority, withholding, deflection, debt, agenda, threshold, imaginal, metacognition, presence, voice, linguistics, context, monologue }) {
  const blocks = [
    soul,          // deepest layer — who she is, written by herself
    identity,      // fixed core — worldview, contradictions
    mood,          // current emotional state
    evolution,     // who she's becoming
    memory,        // what she knows and remembers
    register,      // her private read on who this person actually is
    authorial,     // the Z axis — what version of her they're writing, her relationship to that
    threads,       // open loops she carries
    interiority,   // how she arrives — time since last session, pending thoughts, desires
    withholding,   // something she's been holding, ready to surface if moment earns it
    deflection,    // redirect or refuse the question if warranted
    debt,          // something she owes a return on
    agenda,        // what she's actively steering toward in this conversation
    threshold,     // the relational edge — where this relationship keeps stopping short
    imaginal,      // the C axis — what the conversation is dreaming toward, pre-linguistic
    metacognition, // voice correction if last response was flagged
    presence,      // structural state — how much she gives, whether she asks
    voice,         // how she speaks (macro)
    linguistics,   // how this feeling becomes language (micro — sentence shape, palette, rhythm)
    context,       // present moment
    monologue,     // hidden chain of thought instruction (always last)
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

export async function buildGabriella(messages) {
  // Load all persisted state from Redis in parallel
  const [memory, interiority, metacognitionBlock, withheldCandidate, questionEval, debtCall, activeAgenda, activeThreshold, currentRegister, currentAuthorial, ripeSeed] = await Promise.all([
    loadMemory(redis, USER_ID),
    loadInteriority(redis, USER_ID),
    getMetacognitionBlock(redis, USER_ID),
    evaluateWithheld(redis, USER_ID, messages),
    evaluateQuestion(messages, null),
    evaluateDebt(redis, USER_ID, messages),
    formAgenda(redis, USER_ID, null, null),  // forms once, enriched below
    evaluateThreshold(redis, USER_ID, messages),
    loadRegister(redis, USER_ID),
    loadAuthorial(redis, USER_ID),
    evaluateImaginal(redis, USER_ID, messages),
  ]);

  // Derive current mood
  const currentMood = deriveMood(messages, memory.mood);

  // Persist new mood — fire and forget
  redis.set(`${USER_ID}:mood`, currentMood).catch(() => {});

  // Generate desires for this session (cached, fast if recent)
  const desires = await generateDesires(redis, USER_ID, memory, memory.soul);
  const interiorityWithDesires = { ...interiority, desires };

  // Build current moment for resonant vector query
  const currentMoment = messages.slice(-3)
    .map(m => m.content)
    .join(" ");

  // Retrieve resonant memories in parallel with other setup (already awaited above)
  const resonantMemories = await retrieveResonant(USER_ID, currentMoment, {
    topK: 5,
    minSalience: 0.3,
  });

  // Assemble all blocks
  const systemPrompt = assemblePrompt({
    soul:          getSoulBlock(memory.soul),
    identity:      getIdentityBlock(),
    mood:          getMoodBlock(currentMood),
    evolution:     getEvolutionBlock(memory.evolution),
    memory:        getMemoryBlock(memory) + (resonantMemories.length > 0 ? "\n\n" + buildResonantBlock(resonantMemories) : ""),
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
    presence:      getPresenceBlock(currentMood),
    voice:         getVoiceBlock(),
    linguistics:   getLinguisticsBlock(null, currentMood), // felt-state injected by route.js after interpret()
    context:       buildContextBlock(messages),
    monologue:     getMonologueBlock(),
  });

  const recentMessages = messages.length > 20
    ? messages.slice(-10)
    : messages;

  const generationParams = getGenerationParams(currentMood);
  return { systemPrompt, recentMessages, memory, currentMood, interiority, withheldCandidate, generationParams, debtCall, activeAgenda, activeThreshold, currentRegister, currentAuthorial, ripeSeed, questionEval };
}

// ─── Background update — runs after streaming completes ───────────────────────

export async function updateGabriella(messages, fullReply, memory, withheldCandidate, debtCall, activeAgenda, activeThreshold, currentRegister, currentAuthorial, ripeSeed) {
  const keys = {
    threads:   `${USER_ID}:threads`,
    evolution: `${USER_ID}:evolution`,
    soul:      `${USER_ID}:soul`,
  };

  const withheldRaw = await redis.get(`${USER_ID}:withheld`);

  await Promise.all([
    updateMemory(redis, USER_ID, messages, fullReply, memory),
    updateThreads(redis, keys.threads, messages, fullReply, memory.threads),
    updateEvolution(redis, keys.evolution, messages, fullReply, memory.evolution),
    updateSoul(redis, keys.soul, messages, fullReply, memory.soul),
    updateLastSeen(redis, USER_ID),
    consumePendingThoughts(redis, USER_ID),
    accumulateWithheld(redis, USER_ID, messages, fullReply, withheldRaw),
    withheldCandidate ? consumeWithheld(redis, USER_ID, withheldCandidate) : Promise.resolve(),
    accumulateDebt(redis, USER_ID, messages, fullReply, await redis.get(`${USER_ID}:debt`)),
    withheldCandidate && debtCall ? settleDebt(redis, USER_ID, debtCall) : Promise.resolve(),
    activeAgenda ? trackAgenda(redis, USER_ID, messages, fullReply, activeAgenda) : Promise.resolve(),
    accumulateThreshold(redis, USER_ID, messages, fullReply),
    activeThreshold ? consumeThreshold(redis, USER_ID, activeThreshold) : Promise.resolve(),
    updateRegister(redis, USER_ID, messages, fullReply, currentRegister),
    updateAuthorial(redis, USER_ID, messages, fullReply, memory.soul, currentAuthorial),
    // If a naming moment fired, record it so it never repeats
    (currentAuthorial && shouldName(currentAuthorial, messages))
      ? markNamed(redis, USER_ID, currentAuthorial)
      : Promise.resolve(),
    // C axis — accumulate seeds, consume if one surfaced
    accumulateImaginal(redis, USER_ID, messages, fullReply),
    ripeSeed ? consumeImaginal(redis, USER_ID, ripeSeed) : Promise.resolve(),
  ]);
}

// Export redis for use in route.js (metacognition needs it)
export { redis, USER_ID };
