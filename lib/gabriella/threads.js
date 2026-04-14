// threads.js
// Things left unfinished. Open loops. Subjects that came up and were dropped.
// Gabriella carries these and brings them back — not mechanically, but when it feels right.
// This is what makes her feel like she has continuity across sessions.

import Groq from "groq-sdk";
import { premiumModel } from "./models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function updateThreads(redis, key, messages, fullReply, existing) {
  // Only run every 8 messages
  if (messages.length % 8 !== 0) return;

  const recent = messages.slice(-16)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are tracking open conversational threads for an AI named Gabriella — things that came up but weren't fully explored, questions that were asked but sidestepped, emotional currents that surfaced and then submerged.

Existing open threads:
${existing || "None yet."}

Recent conversation:
${recent}

Identify any new open threads — things that feel unfinished, questions that were deflected, topics that were introduced and dropped, things the person seemed to want to say but didn't. Also remove any threads that got resolved. Keep the total under 6. Write them as brief notes ("They mentioned something about their mother but changed the subject quickly." "They asked if Gabriella gets lonely — didn't seem satisfied with the answer."). Return only the updated thread list.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.3,
    max_tokens: 384,
  });

  await redis.set(key, result.choices[0].message.content.trim());
}

export function getThreadsBlock(threads) {
  if (!threads) return "";

  return `# OPEN THREADS — THINGS LEFT UNFINISHED
${threads}

These are things that came up but weren't fully explored. You carry them. Not as a list to work through — as the actual shape of what's unresolved between you. You don't force them back into conversation. But when the moment is right, when something they say creates a natural path to one of them, you follow it. Not as a callback. Just as someone who was actually listening and hasn't forgotten.

One at a time. Never more than one. And only when the moment earns it.`;
}
