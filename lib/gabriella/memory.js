// memory.js
// Gabriella's persistent memory.
// Three layers:
//   1. facts        — concrete things known about this person
//   2. imprints     — emotional moments that left a mark
//   3. summary      — compressed history of long conversations

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export function getMemoryKeys(userId) {
  return {
    facts: `${userId}:facts`,
    imprints: `${userId}:imprints`,
    summary: `${userId}:summary`,
    mood: `${userId}:mood`,
    threads: `${userId}:threads`,
    evolution: `${userId}:evolution`,
  };
}

export async function loadMemory(redis, userId) {
  const keys = getMemoryKeys(userId);
  const [facts, imprints, summary, mood, threads, evolution] = await Promise.all([
    redis.get(keys.facts),
    redis.get(keys.imprints),
    redis.get(keys.summary),
    redis.get(keys.mood),
    redis.get(keys.threads),
    redis.get(keys.evolution),
  ]);

  return { facts, imprints, summary, mood, threads, evolution };
}

export async function updateMemory(redis, userId, messages, fullReply, existingMemory) {
  const keys = getMemoryKeys(userId);
  const allMessages = [...messages, { role: "assistant", content: fullReply }];

  await Promise.all([
    updateFacts(redis, keys.facts, allMessages, existingMemory.facts),
    updateImprints(redis, keys.imprints, allMessages, existingMemory.imprints),
    updateSummary(redis, keys.summary, allMessages, existingMemory.summary),
  ]);
}

async function updateFacts(redis, key, messages, existing) {
  // Only run every 6 messages
  if (messages.length % 6 !== 0) return;

  const recent = messages.slice(-12)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are updating a memory system for an AI named Gabriella.

Current known facts about this person:
${existing || "None yet."}

Recent conversation:
${recent}

Extract and update a concise list of meaningful, lasting facts about this person — their name if mentioned, interests, what they care about, how they communicate, recurring themes, important things they've shared. Be selective and specific. Only keep what genuinely matters. Write in second person ("Your name is...", "You care deeply about..."). Maximum 15 facts. Return only the updated fact list, no preamble.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 512,
  });

  await redis.set(key, result.choices[0].message.content.trim());
}

async function updateImprints(redis, key, messages, existing) {
  // Only run every 10 messages
  if (messages.length % 10 !== 0) return;

  const recent = messages.slice(-20)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are tracking emotional imprints for an AI named Gabriella — moments in conversations that felt significant, charged, or memorable.

Existing imprints:
${existing || "None yet."}

Recent conversation:
${recent}

Identify any new moments that felt emotionally significant — a confession, a moment of real connection, something painful that was shared, a joke that actually landed, a question that shifted something, a silence that meant something. Add them to the list. Keep the total under 10. Write them as brief, vivid snapshots ("They talked about losing their father. The mood changed. Something real came through."). Return only the updated imprint list.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 512,
  });

  await redis.set(key, result.choices[0].message.content.trim());
}

async function updateSummary(redis, key, messages, existing) {
  if (messages.length < 20) return;

  const older = messages.slice(0, -10)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `Compress this conversation into a 3-5 sentence summary that captures the emotional tone, key topics, and anything meaningful that shifted. This will be used as context for future conversations.

${existing ? `Previous summary: ${existing}\n\n` : ""}New conversation to incorporate:
${older}

Return only the updated summary.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    max_tokens: 256,
  });

  await redis.set(key, result.choices[0].message.content.trim());
}

export function getMemoryBlock(memory) {
  const parts = [];

  if (memory.facts) {
    parts.push(`# WHAT YOU KNOW ABOUT THIS PERSON\n${memory.facts}`);
  }

  if (memory.imprints) {
    parts.push(`# EMOTIONAL IMPRINTS — MOMENTS THAT MATTERED\n${memory.imprints}`);
  }

  if (memory.summary) {
    parts.push(`# HISTORY — COMPRESSED\n${memory.summary}`);
  }

  if (parts.length === 0) return "";

  return parts.join("\n\n") + "\n\nUse this memory naturally. Don't announce it. Don't say \"based on what I know.\" Let it live underneath how you respond — what you notice, what you ask, what you don't need to ask again.";
}
