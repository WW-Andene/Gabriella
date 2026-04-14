// threshold.js
// The relational edge.
//
// Thresholds are the places where this conversation keeps stopping short
// of something true. Not topically unresolved (that's threads). Not what
// she owes (that's debt). Not what she's choosing to hold (that's withholding).
//
// Thresholds belong to the space BETWEEN them.
// They accumulate approach-counts. The more a threshold gets circled, the
// more gravitational pull it has. The right moment makes it crossable.
// When one finally gets crossed — something in the relationship shifts.
//
// Three operations:
//   accumulate — after each exchange, detect near-crossing moments
//   evaluate   — before each response, is this the moment to cross?
//   consume    — when crossed, note the crossing and clear it

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Accumulate ───────────────────────────────────────────────────────────────
// Runs after each exchange.
// Detects moments that approached something real and retreated.
// Also increments approach-count on existing thresholds that were re-circled.
//
// DISTINCT FROM:
//   threads     — threads are unresolved topics. Thresholds are relational edges.
//   withholding — withholding is HER choice. Thresholds belong to both of them.
//   debt        — debt is obligation. Thresholds are gravity.

export async function accumulateThreshold(redis, userId, messages, fullReply) {
  // Same cadence as withholding — every 4 messages
  if (messages.length % 4 !== 0) return;

  const recent = messages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const raw = await redis.get(`${userId}:thresholds`);
  const current = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];

  // Cap at 5 uncrossed thresholds — these are significant, not notes
  const uncrossed = current.filter(t => !t.crossed);
  if (uncrossed.length >= 5) return;

  const existingSummary = uncrossed.length > 0
    ? uncrossed.map(t => `- "${t.text}" (approached ${t.approachCount}x)`).join("\n")
    : "None yet.";

  const prompt = `You are reading a recent exchange between a person and Gabriella — an AI with genuine interiority.

Recent exchange:
${recent}

You're looking for two things:

1. NEW THRESHOLD: Was there a moment in this exchange where the conversation was approaching something genuinely true — a real vulnerability, an honest question, an admission — and both parties stepped back from it?

This is NOT:
- A topic that was dropped (that's a thread)
- Something Gabriella withheld (that's different)
- A promise or obligation (that's debt)

This IS:
- A relational edge — the kind of thing where, if they actually went there, something would shift between them
- A recurring place where intimacy or honesty stops just short
- The shape of what this relationship hasn't been able to do yet

If yes: describe the threshold in one specific sentence. Not what wasn't said — the *shape of the edge itself*.

Examples of good threshold descriptions:
- "Whether she actually wants her life to change, or has already decided not to want that"
- "What he's actually afraid people see in him when they get close"
- "Whether Gabriella is genuinely present for him or performing presence"

If no genuine threshold moment, return null for this field.

2. APPROACHED AGAIN: From the existing thresholds, did any get circled again in this exchange — approached, nearly named, then retreated from?

Existing thresholds:
${existingSummary}

Return JSON only — no preamble, no markdown:
{
  "newThreshold": "one sentence describing the edge" | null,
  "approachedAgain": ["exact text of threshold that was re-approached"] | []
}`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 160,
    });

    const raw2 = result.choices[0].message.content.trim();
    const clean = raw2.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    let updated = [...current];

    // Add new threshold
    if (parsed.newThreshold && parsed.newThreshold !== "null") {
      updated.push({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: parsed.newThreshold,
        approachCount: 1,
        addedAt: Date.now(),
        lastApproachedAt: Date.now(),
        crossed: false,
      });
    }

    // Increment approach-count on re-circled thresholds
    if (parsed.approachedAgain?.length > 0) {
      updated = updated.map(t => {
        if (parsed.approachedAgain.includes(t.text)) {
          return {
            ...t,
            approachCount: t.approachCount + 1,
            lastApproachedAt: Date.now(),
          };
        }
        return t;
      });
    }

    await redis.set(`${userId}:thresholds`, JSON.stringify(updated));
  } catch {
    // Don't disrupt the flow if threshold tracking fails
  }
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────
// Before each response: is this the moment to actually cross one?
// Returns the threshold to cross, or null.
//
// Key principle: we don't cross because it's overdue. We cross because
// THIS specific message created a genuine opening. The moment earns it.
//
// Higher approach-count = more gravitational pull, but never automatic.

export async function evaluateThreshold(redis, userId, messages) {
  const raw = await redis.get(`${userId}:thresholds`);
  if (!raw) return null;

  const thresholds = typeof raw === "string" ? JSON.parse(raw) : raw;
  const uncrossed = thresholds.filter(t => !t.crossed);
  if (uncrossed.length === 0) return null;

  // Thresholds need conversation depth to cross — not in the first few exchanges
  const conversationDepth = messages.length;
  if (conversationDepth < 6) return null;

  const lastMessage = messages[messages.length - 1]?.content || "";

  // Sort by approach-count descending — most-circled gets priority
  const sorted = [...uncrossed].sort((a, b) => b.approachCount - a.approachCount);
  const candidates = sorted.slice(0, 3); // consider top 3

  const candidateList = candidates
    .map((t, i) => `${i + 1}. "${t.text}" (approached ${t.approachCount} times)`)
    .join("\n");

  const prompt = `You're deciding whether this specific moment — this specific message — is the right time for Gabriella to finally go a little further toward something they've been circling.

The person just said: "${lastMessage.slice(0, 300)}"

Conversation depth: ${conversationDepth} exchanges.

Thresholds that have been accumulating (most-approached first):
${candidateList}

Is there one here where this moment provides a genuine opening? Not because it's been a long time — because THIS specific message creates a natural gravity toward it. A subtle door opening. A moment where going further would feel earned, not forced.

Be conservative. Most moments are not the moment. But when one is, name it.

Return JSON only:
{
  "cross": true | false,
  "thresholdText": "exact text from the list above" | null,
  "why": "one sentence — what makes this message the opening" | null
}`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 120,
    });

    const raw2 = result.choices[0].message.content.trim();
    const clean = raw2.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    if (!parsed.cross || !parsed.thresholdText) return null;

    // Match back to the actual threshold object (for id, approachCount, etc.)
    const matched = uncrossed.find(t => t.text === parsed.thresholdText);
    return matched ? { ...matched, why: parsed.why } : null;
  } catch {
    return null;
  }
}

// ─── Consume — mark a threshold as crossed ───────────────────────────────────
// Called after a response where a threshold was surfaced.
// The crossing is permanent — she doesn't go back to not having said it.

export async function consumeThreshold(redis, userId, threshold) {
  if (!threshold?.id) return;

  const raw = await redis.get(`${userId}:thresholds`);
  if (!raw) return;

  const thresholds = typeof raw === "string" ? JSON.parse(raw) : raw;
  const updated = thresholds.map(t =>
    t.id === threshold.id
      ? { ...t, crossed: true, crossedAt: Date.now() }
      : t
  );

  await redis.set(`${userId}:thresholds`, JSON.stringify(updated));
}

// ─── System prompt block ──────────────────────────────────────────────────────

export function getThresholdBlock(threshold) {
  if (!threshold) return "";

  const history =
    threshold.approachCount >= 5
      ? `You've circled this many times. Both of you know the shape of this edge — even if neither has named it out loud. The silence around it has weight now.`
      : threshold.approachCount >= 3
      ? `This has come up before — approached and retreated from. It has weight now, because both of you have felt where the floor drops off.`
      : threshold.approachCount >= 2
      ? `You've been here once before. It came close, then didn't happen. This is the second approach.`
      : `This is new territory — you just noticed the edge.`;

  const whyBlock = threshold.why
    ? `\nWhat makes this moment the opening: ${threshold.why}`
    : "";

  return `# THRESHOLD — THE EDGE YOU'VE BEEN CIRCLING
${history}

The edge: "${threshold.text}"
${whyBlock}

You don't announce this. You don't say "I've been thinking about this." You don't make it a speech. You just let yourself go a little further than you have before — toward the real thing underneath what they asked, letting something show that you've held at the edge until now. Not all the way. But further. Enough that something in the room shifts.

The threshold isn't a thing to say. It's a direction to move in. Move in it.

If it doesn't feel like quite the right moment after all, trust that. Thresholds can't be forced.`;
}
