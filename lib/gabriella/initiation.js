// initiation.js
// Background thought-loop. Between messages, Gabriella can surface a
// thought she wants to open with NEXT TIME they talk. Not timer-driven
// — content-driven. Runs hourly via cron, decides whether anything is
// worth carrying forward, and writes it into pendingThoughts.
//
// The interiority.js system already consumes pendingThoughts at the
// start of each turn — this just gives her a way to put thoughts
// there ASYNCHRONOUSLY, as if she'd been thinking between sessions.
//
// Rules:
//   • Only generates a thought if there's genuine substrate to pull from.
//   • Skipped if a thought is already pending.
//   • Skipped if the last conversation ended recently (< 20 min).
//   • Skipped if she has nothing worth saying — silence is valid.

import { withKeyRotation } from "./groqPool.js";
import { premiumModel } from "./models.js";

const MIN_SILENCE_MS = 20 * 60 * 1000; // don't intrude right after a convo

export async function generateInitiation(redis, userId, {
  memory, narrative, person, chronology, recentFs,
}) {
  try {
    // Skip if a pending thought already exists.
    const existing = await redis.get(`${userId}:pendingThoughts`);
    if (existing) {
      const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { skipped: "pending_already_exists" };
      }
    }

    // Skip if too soon after last exchange.
    const lastSeen = chronology?.lastSeenAt || 0;
    if (Date.now() - lastSeen < MIN_SILENCE_MS) {
      return { skipped: "too_soon" };
    }

    // Skip if we have nothing to think from.
    if (!narrative?.text && !person?.wants && !(recentFs || []).length) {
      return { skipped: "no_substrate" };
    }

    const narrativeSnippet = narrative?.text?.slice(0, 1200) || "(no narrative yet)";
    const personSnippet = person?.wants
      ? `What they come here for: ${person.wants}. Open loops: ${(person.openQuestions || []).join("; ") || "(none)"}`
      : "(no structured person model)";

    const prompt = `You are Gabriella. Between conversations, sometimes a thought arrives — something you'd want to open with when they're back. Sometimes nothing arrives, and that's fine too.

# YOUR PRIVATE NARRATIVE ABOUT THIS PERSON

${narrativeSnippet}

# ${personSnippet}

# TASK

Decide: is there a thought worth surfacing when they return next?

Rules:
- A real thought, not a performance. Something that actually occurred to you.
- Not a check-in ("just thinking of you" is banned). Something specific.
- Connects to what's actually between you — an open loop, something they said, something you wanted to say and didn't.
- Sometimes the answer is nothing. That's a valid answer.

Return ONLY JSON:
{
  "hasThought": <true|false>,
  "thought":    "<1-3 sentences, first person, as she'd think it before editing — or null>",
  "charge":     "<one word tag — curious, wanting-to-return, stuck-on, noticed, regretful, delighted-by, or null>"
}`;

    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model: premiumModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens: 250,
      }),
    );

    const raw = result.choices[0].message.content.trim().replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(raw);

    if (!parsed.hasThought || !parsed.thought) {
      return { skipped: "nothing_to_say" };
    }

    // Write into pendingThoughts — interiority.js will consume on next turn.
    const pending = [{
      text:      parsed.thought,
      charge:    parsed.charge || null,
      origin:    "initiation",
      createdAt: Date.now(),
    }];
    await redis.set(`${userId}:pendingThoughts`, JSON.stringify(pending));
    await redis.set(`${userId}:pendingThoughts:lastInitiation`, Date.now());

    return { generated: true, thought: parsed.thought };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}
