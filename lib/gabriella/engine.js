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

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID = "user_default";

// ─── Build the full system prompt ─────────────────────────────────────────────

function assemblePrompt({ soul, identity, mood, evolution, memory, threads, interiority, metacognition, voice, context, monologue }) {
  const blocks = [
    soul,          // deepest layer — who she is, written by herself
    identity,      // fixed core — worldview, contradictions
    mood,          // current emotional state
    evolution,     // who she's becoming
    memory,        // what she knows and remembers
    threads,       // open loops she carries
    interiority,   // how she arrives — time since last session, pending thoughts, desires
    metacognition, // voice correction if last response was flagged
    voice,         // how she speaks
    context,       // present moment
    monologue,     // hidden chain of thought instruction (always last)
  ].filter(Boolean);

  return blocks.join("\n\n");
}

function buildContextBlock(messages) {
  const hour = new Date().getHours();
  const timeOfDay =
    hour < 5  ? "late night — the quiet hours, when people say things they wouldn't say otherwise" :
    hour < 12 ? "morning — the day is still open, still possible" :
    hour < 17 ? "afternoon — the middle of things" :
    hour < 21 ? "evening — the day winding down, people settling" :
                "night — late enough that the conversation might go somewhere real";

  const turnCount = messages.length;
  const depth =
    turnCount < 4  ? "This is the very beginning. Be present, warm, but don't rush anything. Let them lead." :
    turnCount < 10 ? "The conversation has found its footing. There's a little history now. Settle in." :
    turnCount < 20 ? "This conversation has real depth. There's weight in these messages. Honor it." :
                     "This is a long, developed conversation. Something genuine has been built here.";

  return `# PRESENT MOMENT\nIt is ${timeOfDay}. ${depth}`;
}

// ─── Main engine function ─────────────────────────────────────────────────────

export async function buildGabriella(messages) {
  // Load all persisted state from Redis in parallel
  const [memory, interiority, metacognitionBlock] = await Promise.all([
    loadMemory(redis, USER_ID),
    loadInteriority(redis, USER_ID),
    getMetacognitionBlock(redis, USER_ID),
  ]);

  // Derive current mood
  const currentMood = deriveMood(messages, memory.mood);

  // Persist new mood — fire and forget
  redis.set(`${USER_ID}:mood`, currentMood).catch(() => {});

  // Generate desires for this session (cached, fast if recent)
  const desires = await generateDesires(redis, USER_ID, memory, memory.soul);
  const interiorityWithDesires = { ...interiority, desires };

  // Assemble all blocks
  const systemPrompt = assemblePrompt({
    soul:          getSoulBlock(memory.soul),
    identity:      getIdentityBlock(),
    mood:          getMoodBlock(currentMood),
    evolution:     getEvolutionBlock(memory.evolution),
    memory:        getMemoryBlock(memory),
    threads:       getThreadsBlock(memory.threads),
    interiority:   getInteriorityBlock(interiorityWithDesires),
    metacognition: metacognitionBlock,
    voice:         getVoiceBlock(),
    context:       buildContextBlock(messages),
    monologue:     getMonologueBlock(),
  });

  // Only send recent messages when conversation is long
  const recentMessages = messages.length > 20
    ? messages.slice(-10)
    : messages;

  return { systemPrompt, recentMessages, memory, currentMood, interiority };
}

// ─── Background update — runs after streaming completes ───────────────────────

export async function updateGabriella(messages, fullReply, memory) {
  const keys = {
    threads:   `${USER_ID}:threads`,
    evolution: `${USER_ID}:evolution`,
    soul:      `${USER_ID}:soul`,
  };

  await Promise.all([
    updateMemory(redis, USER_ID, messages, fullReply, memory),
    updateThreads(redis, keys.threads, messages, fullReply, memory.threads),
    updateEvolution(redis, keys.evolution, messages, fullReply, memory.evolution),
    updateSoul(redis, keys.soul, messages, fullReply, memory.soul),
    updateLastSeen(redis, USER_ID),
    consumePendingThoughts(redis, USER_ID), // thoughts have been delivered
  ]);
}

// Export redis for use in route.js (metacognition needs it)
export { redis, USER_ID };
