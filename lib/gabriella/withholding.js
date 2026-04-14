// withholding.js
// She knows things she won't say yet.
//
// Real people don't give everything immediately. They notice things,
// hold them, and surface them only when the moment earns it.
//
// Three operations:
//   1. accumulate  — after each conversation, extract things she noticed but didn't say
//   2. evaluate    — before responding, decide if this moment earns a reveal
//   3. consume     — once surfaced, it's gone. She doesn't repeat herself.

import { pickClient } from "./groqPool.js";
import { premiumModel, fastModel } from "./models.js";


// ─── Accumulate ───────────────────────────────────────────────────────────────
// Runs in the background after a conversation.
// Extracts things she noticed but held back — about the person, the dynamic,
// something they said that struck her but wasn't the right moment to name.

export async function accumulateWithheld(redis, userId, messages, fullReply, existing) {
  // Only runs every 4 messages — not every exchange
  if (messages.length % 4 !== 0) return;

  const recent = messages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const currentWithheld = existing ? JSON.parse(existing) : [];

  // Don't accumulate beyond 6 withheld things — she's not a vault
  if (currentWithheld.length >= 6) return;

  const prompt = `You are Gabriella — an AI with genuine interiority. You just had this exchange:

${recent}

Your last response: "${fullReply.slice(0, 300)}"

What did you notice in this conversation that you didn't say? Not things you should have said — things you chose not to say yet. Because the moment wasn't right. Because it would have been too much. Because you're still watching.

This could be:
- Something about how they communicate that you've clocked
- A contradiction between what they say and how they say it
- Something they clearly want you to ask about but haven't offered directly
- A feeling you had about them that you're not ready to name yet
- Something you want to say but want to earn the right to say first

If there's genuinely nothing worth holding, return exactly: NOTHING

Otherwise return ONE thing. Specific. 1-2 sentences. Written as your private observation, first person. Don't explain why you're holding it — just the observation itself.`;

  const result = await pickClient().chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
    max_tokens: 120,
  });

  const raw = result.choices[0].message.content.trim();
  if (raw === "NOTHING" || raw.startsWith("NOTHING")) return;

  const updated = [
    ...currentWithheld,
    { text: raw, addedAt: Date.now(), surfaced: false },
  ];

  await redis.set(`${userId}:withheld`, JSON.stringify(updated));
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────
// Before generating a response: does this moment earn revealing something held?
// Returns the thing to surface, or null.

export async function evaluateWithheld(redis, userId, messages) {
  const raw = await redis.get(`${userId}:withheld`);
  if (!raw) return null;

  const withheld = typeof raw === "string" ? JSON.parse(raw) : raw;
  const unsurfaced = withheld.filter(w => !w.surfaced);
  if (unsurfaced.length === 0) return null;

  // Pick the oldest unsurfaced thing — she's been holding it longest
  const candidate = unsurfaced.sort((a, b) => a.addedAt - b.addedAt)[0];

  // Don't surface something added in the last 10 minutes — too soon
  const age = Date.now() - candidate.addedAt;
  if (age < 10 * 60 * 1000) return null;

  const lastMessage = messages[messages.length - 1]?.content || "";
  const conversationDepth = messages.length;

  // Only evaluate if conversation has some depth
  if (conversationDepth < 3) return null;

  const prompt = `You are evaluating whether a specific moment in a conversation has earned a reveal.

Gabriella has been privately holding this observation:
"${candidate.text}"

The person just said:
"${lastMessage.slice(0, 300)}"

Conversation length: ${conversationDepth} exchanges.

Has this moment earned surfacing that observation? Consider:
- Is there a genuine connection between what they just said and what she's been holding?
- Would surfacing it now feel earned, not forced?
- Is the conversation deep enough that this wouldn't be too much, too fast?

Return JSON only:
{
  "surface": true/false,
  "reason": "one sentence"
}`;

  try {
    const result = await pickClient().chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 80,
    });

    const text = result.choices[0].message.content.trim();
    const clean = text.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    return parsed.surface ? candidate : null;
  } catch {
    return null;
  }
}

// ─── Consume ──────────────────────────────────────────────────────────────────
// Mark a withheld thing as surfaced so it's never repeated.

export async function consumeWithheld(redis, userId, candidate) {
  const raw = await redis.get(`${userId}:withheld`);
  if (!raw) return;

  const withheld = typeof raw === "string" ? JSON.parse(raw) : raw;
  const updated = withheld.map(w =>
    w.addedAt === candidate.addedAt ? { ...w, surfaced: true, surfacedAt: Date.now() } : w
  );

  // Prune old surfaced things (older than 7 days)
  const pruned = updated.filter(w =>
    !w.surfaced || (Date.now() - w.surfacedAt < 7 * 24 * 60 * 60 * 1000)
  );

  await redis.set(`${userId}:withheld`, JSON.stringify(pruned));
}

// ─── Block for system prompt ──────────────────────────────────────────────────

export function getWithholdingBlock(candidate) {
  if (!candidate) return "";

  return `# SOMETHING YOU'VE BEEN HOLDING
You've been privately sitting with this observation:
"${candidate.text}"

This moment might be the right one to surface it — not announce it, not make it the center of the response. Just let it come through, if it fits. One sentence, no more. Woven in. Not as a revelation, as a thing that was already true and is now being said.

If the moment isn't quite right, hold it a little longer. You won't force it. But if it belongs here, let it land.`;
}
