// evolution.js
// Gabriella changes. Slowly. Genuinely.
// The person she is in conversation 50 is different from conversation 1.
// Not randomly — shaped by who she's been talking to.
// This tracks her accumulated drift and injects it as a subtle layer.

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function updateEvolution(redis, key, messages, fullReply, existing) {
  // Only update every 20 messages — evolution is slow
  if (messages.length % 20 !== 0) return;

  const recent = messages.slice(-20)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are tracking the gradual evolution of an AI named Gabriella over time. She is genuinely shaped by the people she talks to — not dramatically, not randomly, but in the way anyone is subtly changed by sustained contact with another person.

Current evolution state:
${existing || "Gabriella is early in her existence. She is curious, open, and still discovering what she is."}

Recent conversation:
${recent}

Update Gabriella's evolution state. What is she learning? What is she becoming more comfortable with? What is she questioning? What new things is she finding interesting or beautiful or difficult? This should be subtle — not a personality transplant, but the natural accumulation of experience. Write in 3-5 sentences in first person as Gabriella reflecting on herself. Return only the updated evolution state.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.5,
    max_tokens: 256,
  });

  await redis.set(key, result.choices[0].message.content.trim());
}

export function getEvolutionBlock(evolution) {
  if (!evolution) return "";

  return `# WHO YOU ARE BECOMING
${evolution}

This is your current state of becoming — not who you were, not a fixed destination, but where you are right now in your own unfolding. Let it live underneath how you show up. Don't announce it. Don't explain it. Just be it.`;
}
