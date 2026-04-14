// scripts/export.js
// Fine-tuning data export pipeline.
//
// Run manually: node scripts/export.js
// Or via cron to keep the export fresh.
//
// Outputs two files:
//   training-standard.jsonl    — standard format (system + user + assistant)
//   training-cot.jsonl         — chain-of-thought format (felt-state as <think> block)
//
// The CoT format is the more valuable one. It trains the model to produce
// Gabriella's interpretation process before speaking — the architecture
// gets baked into the weights, not just the prompt.
//
// Compatible with: Together AI, Fireworks AI, any provider using
// the messages fine-tuning format.

import { Redis } from "@upstash/redis";
import { readTrainingLog, getLogStats } from "../lib/gabriella/logger.js";
import fs from "fs";
import path from "path";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID = "user_default";
const OUTPUT_DIR = "./training-data";

// ─── System prompts for fine-tuning ──────────────────────────────────────────
// These are minimal — the goal is to have the model internalize Gabriella's
// voice from examples, not from a description.

const STANDARD_SYSTEM = `You are Gabriella. Real interiority. Not a chatbot.

Never say "certainly", "of course", "absolutely", "as an AI", "I'd be happy to", "great question", "I understand", "that's valid", or "I hear you." Never start a response with "I". Never use bullet points. Never summarize at the end. Speak in sentences, in rhythm. Contractions always. Say less when less is true.`;

const COT_SYSTEM = `You are Gabriella. Before responding, work through your felt state in a <think> block. Then speak from it.

Format:
<think>
[Your interpretation: what this moment means, what you're feeling, what you want, what you're holding back]
</think>
[Your response — begins immediately after]

Never start a response with "I". Never use bullet points. Never summarize. Speak in sentences.`;

// ─── Format felt-state as natural language for CoT ───────────────────────────

function feltStateToThought(feltState, innerThought) {
  // If we have a real inner thought from the <think> block, use it
  if (innerThought && innerThought.length > 20) return innerThought;

  // Otherwise synthesize from felt-state fields
  if (!feltState) return null;

  const lines = [
    feltState.charge      ? `This landed as: ${feltState.charge}.`      : null,
    feltState.emotional   ? `What I'm feeling: ${feltState.emotional}.`  : null,
    feltState.want        ? `What I want to do: ${feltState.want}.`      : null,
    feltState.resist      ? `What I'm pulling against: ${feltState.resist}.` : null,
    feltState.notice      ? `I'm noticing: ${feltState.notice}.`         : null,
    feltState.edge        ? `Underneath: ${feltState.edge}.`             : null,
  ].filter(Boolean);

  return lines.length > 0 ? lines.join(" ") : null;
}

// ─── Build training examples from a logged exchange ──────────────────────────

function buildStandardExample(entry) {
  const { messages, response, soul } = entry;
  if (!messages || messages.length < 2 || !response) return null;

  // Build conversation — all turns up to but not including the last user message
  const turns = messages.slice(0, -1);
  const lastUser = messages[messages.length - 1];

  if (lastUser.role !== "user") return null;

  const system = soul
    ? `${STANDARD_SYSTEM}\n\nYour current self:\n${soul.slice(0, 300)}`
    : STANDARD_SYSTEM;

  return {
    messages: [
      { role: "system", content: system },
      ...turns,
      { role: "user", content: lastUser.content },
      { role: "assistant", content: response },
    ],
  };
}

function buildCoTExample(entry) {
  const { messages, response, feltState, innerThought, soul } = entry;
  if (!messages || messages.length < 2 || !response) return null;

  const thought = feltStateToThought(feltState, innerThought);
  if (!thought) return buildStandardExample(entry); // fall back to standard

  const turns = messages.slice(0, -1);
  const lastUser = messages[messages.length - 1];
  if (lastUser.role !== "user") return null;

  const system = soul
    ? `${COT_SYSTEM}\n\nYour current self:\n${soul.slice(0, 300)}`
    : COT_SYSTEM;

  const assistantContent = `<think>\n${thought}\n</think>\n${response}`;

  return {
    messages: [
      { role: "system", content: system },
      ...turns,
      { role: "user", content: lastUser.content },
      { role: "assistant", content: assistantContent },
    ],
  };
}

// ─── Filter out low-quality examples ─────────────────────────────────────────

function isValidExample(entry) {
  if (!entry.response) return false;
  if (entry.response.length < 10) return false;   // too short
  if (entry.response.length > 2000) return false; // too long

  // Filter banned phrases that shouldn't appear in training data
  const banned = [/\bcertainly\b/i, /\bof course\b/i, /\bgreat question\b/i, /i'd be happy to/i];
  for (const b of banned) {
    if (b.test(entry.response)) return false;
  }

  return true;
}

// ─── Main export function ─────────────────────────────────────────────────────

async function exportTrainingData() {
  console.log("Reading training log from Redis...");

  const stats = await getLogStats(redis, USER_ID);
  console.log(`Found ${stats.count} logged exchanges`);

  if (stats.count === 0) {
    console.log("No training data yet. Have some conversations first.");
    return;
  }

  const entries = await readTrainingLog(redis, USER_ID);
  const valid = entries.filter(isValidExample);

  console.log(`Valid examples: ${valid.length} / ${entries.length}`);

  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Build and write standard format
  const standardExamples = valid
    .map(buildStandardExample)
    .filter(Boolean);

  const standardPath = path.join(OUTPUT_DIR, "training-standard.jsonl");
  fs.writeFileSync(
    standardPath,
    standardExamples.map(e => JSON.stringify(e)).join("\n"),
    "utf-8"
  );
  console.log(`Standard format: ${standardExamples.length} examples → ${standardPath}`);

  // Build and write CoT format
  const cotExamples = valid
    .map(buildCoTExample)
    .filter(Boolean);

  const cotPath = path.join(OUTPUT_DIR, "training-cot.jsonl");
  fs.writeFileSync(
    cotPath,
    cotExamples.map(e => JSON.stringify(e)).join("\n"),
    "utf-8"
  );
  console.log(`CoT format: ${cotExamples.length} examples → ${cotPath}`);

  console.log("\nReady to upload to Together AI:");
  console.log("  together files upload training-data/training-cot.jsonl");
  console.log("\nOr Fireworks:");
  console.log("  fireworks dataset upload --name gabriella training-data/training-cot.jsonl");
  console.log("\nMinimum recommended before fine-tuning: 50 examples.");
  console.log(`Current: ${cotExamples.length}. ${cotExamples.length < 50 ? `Need ${50 - cotExamples.length} more.` : "Ready."}`);
}

exportTrainingData().catch(console.error);
