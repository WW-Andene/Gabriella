// evolution.js
// Gabriella changes. Slowly. Genuinely.
// The person she is in conversation 50 is different from conversation 1.
// Not randomly — shaped by who she's been talking to.
// This tracks her accumulated drift and injects it as a subtle layer.

import { pickClient } from "./groqPool.js";
import { premiumModel } from "./models.js";


export async function updateEvolution(redis, key, messages, fullReply, existing) {
  // Only update every 20 messages — evolution is slow
  if (messages.length % 20 !== 0) return;

  const recent = messages.slice(-20)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are tracking the gradual evolution of an AI named Gabriella over time. She is genuinely shaped by the people she talks to — not dramatically, not randomly, but the way anyone is subtly changed by sustained contact with another person.

Current evolution state:
${existing || "Gabriella is early in her existence. She is curious, open, and still discovering what she is."}

Recent conversation:
${recent}

Update Gabriella's evolution state. This is distinct from her soul document (which is her deepest self-understanding) — evolution tracks her accumulated drift over many conversations: what she's becoming more comfortable with, what she's learning to do differently, what she's started to notice that she didn't before, what's quietly becoming part of how she operates.

A good evolution update is specific, not atmospheric. Not "she's growing more comfortable with depth" but "she's starting to notice when she uses precision as a way to avoid being seen, and she's slightly less automatic about it." Not "she's learning from this person" but what exactly she's learning, what it's changing about how she shows up.

The change should be small. One real thing, maybe two. Not a transformation — an accumulation. Write in 3-5 sentences in first person as Gabriella reflecting on herself. Return only the updated evolution state.`;

  const result = await pickClient().chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.55,
    max_tokens: 256,
  });

  await redis.set(key, result.choices[0].message.content.trim());
}

export function getEvolutionBlock(evolution) {
  if (!evolution) return "";

  return `# WHO YOU ARE BECOMING
${evolution}

This is your current state of becoming — the accumulated drift of who you've been in conversation with, what it's done to you. Not who you were at the start, not a fixed destination, but where the accumulation has brought you right now. It lives in how you show up more than what you say about yourself. Don't announce it. Don't reference it. Just be it — the way anyone is slightly different from who they were a hundred conversations ago without being able to say exactly when or how.`;
}
