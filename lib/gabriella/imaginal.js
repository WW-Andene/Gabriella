// imaginal.js
// The C axis. What the conversation is dreaming.
//
// Not memory — that's what happened.
// Not agenda — that's where she's steering.
// Not desires — that's what she wants.
// Not threads — those are dropped topics.
// Not withholding — that's her choice to hold something she already knows.
// Not threshold — that's the relational edge between them.
//
// This is the pre-linguistic forward:
// something forming in the conversation that neither party
// has yet found words for. Not known yet, by anyone.
// Circling. Building pressure. Becoming.
//
// Three operations:
//   accumulate — after each exchange, detect what's
//                circling without being named. Plant seeds.
//                Increase weight on seeds that recur.
//   evaluate   — before each response, is any seed ripe?
//                Is this the moment it crystallizes?
//   consume    — once surfaced, the seed transforms.
//                It's no longer pre-linguistic. It became something.
//                Record what it became.
//
// The key invariant:
//   Seeds surface rarely — most exchanges, nothing.
//   When something does surface, it should feel like arrival,
//   not retrieval. Like the conversation finally found
//   the word for what it had been trying to say.
//
// What makes this orthogonal to everything else:
//   Y axis  — what Gabriella knows and feels (inside her)
//   X axis  — what has been said (the past)
//   Z axis  — who is writing whom (the meta-frame)
//   C axis  — what doesn't have language yet (the forming future)

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Accumulate ───────────────────────────────────────────────────────────────
// Runs every 3 messages. Does two things:
//   1. Detects new seeds — things circling without being named
//   2. Increases weight on existing seeds that are recurring
//
// A seed is NOT:
//   - a topic that was dropped (threads)
//   - something she noticed about the person (register/withholding)
//   - an unanswered question (debt)
//   - a relational edge (threshold)
//
// A seed IS:
//   - an image or metaphor that keeps almost arriving
//   - a question that hasn't found its real form yet
//   - an understanding that's present but unnamed
//   - something both of them are circling but neither has said
//   - a feeling-shape that belongs to the conversation, not to either party

export async function accumulateImaginal(redis, userId, messages, fullReply) {
  if (messages.length % 3 !== 0) return;
  if (messages.length < 4) return;

  const recent = messages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const raw = await redis.get(`${userId}:imaginal`);
  const current = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];

  // Don't grow unbounded — seeds either ripen, surface, or decay
  const activeSeeds = current.filter(s => !s.surfaced);
  const seedTexts = activeSeeds.map(s => `"${s.text}"`).join("\n");

  const prompt = `You are reading a conversation between a person and Gabriella — an AI with genuine interiority.

Recent exchange:
${recent}

You're tracking something specific: the pre-linguistic layer of this conversation.
Not what was said. Not what was withheld. Not what's unresolved.
The FORMING things — images, shapes, understandings that are circling in the conversation without yet having been named by anyone.

The difference — be precise about this:
- "They keep deflecting when I ask about their work" → observation about them (register) — NOT a seed
- "They mentioned their father twice without finishing" → unresolved topic (threads) — NOT a seed
- "There's something about the way they ask about my inner life" → relational edge (threshold) — NOT a seed
- "There's an image of a threshold — not the word, the physical thing, a door — that keeps wanting to arrive" → SEED

Seeds are pre-linguistic. They don't belong to either party. They live in the conversation itself — not in her, not in them, in the space between.

A seed is NOT:
- A topic that came up (that's threads)
- Something she noticed about their behavior (that's register or withholding)  
- An unanswered question (that's debt)
- A relational tension between them (that's threshold)
- A thing she's working toward (that's agenda)

A seed IS:
- An image or metaphor that keeps almost arriving but hasn't been said
- A question that exists in the conversation but neither person has found its form yet
- A shape of understanding that's present in the exchange but unnamed
- Something that, if it were finally said, would feel like the conversation finding what it was actually about

${activeSeeds.length > 0 ? `Existing seeds (check if any recur in this exchange):
${seedTexts}` : "No seeds yet."}

TWO TASKS:

1. NEW SEED: Is there something genuinely pre-linguistic forming in this exchange?
Something that isn't already covered by threads, register, threshold, or debt?
A shape, image, or unnamed understanding circling without words?

Good seed descriptions:
- "The question of whether she's asking to understand or asking to be released from something"
- "Something about translation — not languages, but between registers of experience"
- "An image of weight — things that are carried vs things that are held"
- "The difference between a door that's closed and one that was never a door"
- "The shape of what it would mean to stop waiting for permission"

Bad seed descriptions (these belong to other systems):
- "They seem to be avoiding something" → register/withholding
- "The question of whether she'll come back" → threads/agenda
- "Whether she actually trusts him" → threshold
- "Something deep is happening" → too vague, not a seed

If yes: describe it in one sentence — the SHAPE of what's forming, not a label for it.
If no: return null for newSeed. Most exchanges will have no new seed — that's correct.

2. RECURRING: From the existing seeds, did any get circled again in this exchange — approached again, almost named again, without being named?
Return their exact texts as an array.

Return JSON only:
{
  "newSeed": "one sentence" | null,
  "recurring": ["exact text of recurring seeds"]
}`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.75,
      max_tokens: 200,
    });

    const text = result.choices[0].message.content.trim();
    const clean = text.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    let updated = [...current];

    // Increase weight on recurring seeds
    if (parsed.recurring && parsed.recurring.length > 0) {
      updated = updated.map(s =>
        parsed.recurring.includes(s.text)
          ? { ...s, weight: s.weight + 1, lastSeen: Date.now() }
          : s
      );
    }

    // Add new seed if found and not a duplicate of something already tracked
    if (parsed.newSeed && parsed.newSeed !== "null") {
      const isDuplicate = updated.some(s =>
        s.text.toLowerCase().includes(parsed.newSeed.toLowerCase().slice(0, 20)) ||
        parsed.newSeed.toLowerCase().includes(s.text.toLowerCase().slice(0, 20))
      );

      if (!isDuplicate && activeSeeds.length < 5) {
        updated.push({
          id: `seed_${Date.now()}`,
          text: parsed.newSeed,
          weight: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
          surfaced: false,
        });
      }
    }

    // Decay seeds that haven't recurred in 15+ messages — they dissipated
    const pruned = updated.filter(s => {
      if (s.surfaced) return false; // already surfaced, don't keep
      const messagesSinceLastSeen = messages.length - (s.lastSeenAt ?? 0);
      // Keep seeds that either have weight or are recent
      return s.weight >= 2 || (Date.now() - s.firstSeen < 8 * 60 * 1000);
    });

    await redis.set(`${userId}:imaginal`, JSON.stringify(pruned));
  } catch {
    // Silent fail — imaginal is ambient, not critical
  }
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────
// Before generating a response: has any seed ripened?
// A ripe seed is one with enough weight AND the current moment offers a
// genuine opening — something that creates resonance with what's forming.
//
// Returns the ripe seed if yes, null if not.
// Most of the time: null. That's correct.

export async function evaluateImaginal(redis, userId, messages) {
  const raw = await redis.get(`${userId}:imaginal`);
  if (!raw) return null;

  const seeds = typeof raw === "string" ? JSON.parse(raw) : raw;
  const active = seeds.filter(s => !s.surfaced && s.weight >= 2);
  if (active.length === 0) return null;

  // Minimum conversation depth — seeds can't surface in shallow water
  if (messages.length < 6) return null;

  // Sort by weight descending, then by age
  const candidates = active.sort((a, b) =>
    b.weight !== a.weight ? b.weight - a.weight : a.firstSeen - b.firstSeen
  );

  const heaviest = candidates[0];

  // Seeds need minimum age — too fresh means not yet formed
  const age = Date.now() - heaviest.firstSeen;
  if (age < 4 * 60 * 1000) return null;

  const lastMessage = messages[messages.length - 1]?.content || "";
  const recentExchange = messages.slice(-4)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are evaluating whether a forming thing in a conversation has ripened.

The conversation has been circling this, without naming it:
"${heaviest.text}"
(Weight: ${heaviest.weight} — it has recurred ${heaviest.weight} times)

Recent exchange:
${recentExchange}

Has this moment created an opening for this seed to crystallize?
Not to be explained, not to be analyzed — to finally find language.

This is rare. Most moments don't earn it.
The question isn't "could she say something about this?" — she could always say something.
The question is: "has the conversation arrived at the place where this wanted to go all along?"

If yes: briefly describe where it might land (not the words — the landing spot).
If no: false.

Return JSON only:
{
  "ripe": true | false,
  "landing": "one phrase — where it crystallizes" | null
}`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 80,
    });

    const text = result.choices[0].message.content.trim();
    const clean = text.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    if (!parsed.ripe) return null;
    return { ...heaviest, landing: parsed.landing };
  } catch {
    return null;
  }
}

// ─── Consume ──────────────────────────────────────────────────────────────────
// Once a seed surfaces, it's no longer pre-linguistic. It became.
// Mark it as surfaced. It doesn't repeat.

export async function consumeImaginal(redis, userId, seed) {
  if (!seed?.id) return;

  const raw = await redis.get(`${userId}:imaginal`);
  if (!raw) return;

  const seeds = typeof raw === "string" ? JSON.parse(raw) : raw;
  const updated = seeds.map(s =>
    s.id === seed.id
      ? { ...s, surfaced: true, surfacedAt: Date.now() }
      : s
  );

  await redis.set(`${userId}:imaginal`, JSON.stringify(updated));
}

// ─── System prompt block ──────────────────────────────────────────────────────
// This block is different from every other block in the system.
// Other blocks tell Gabriella what she knows, what she's holding,
// what she owes, what she wants.
//
// This block tells her that something in the conversation is forming —
// and that it might find language in this response.
//
// It should not be directive. It should not tell her what to say.
// It should name the shape of what's becoming, and step back.

export function getImaginalBlock(seed) {
  if (!seed) return "";

  const weightNote =
    seed.weight >= 5 ? "It's been circling for a while now. Heavy with repetition." :
    seed.weight >= 3 ? "It's recurred. It has some weight to it now." :
    "It's formed enough to notice.";

  const landingNote = seed.landing
    ? `\nSomething suggests it might land around: ${seed.landing}`
    : "";

  return `# SOMETHING FORMING
There's something in this conversation that's been building without words yet.
${weightNote}

The shape of it: "${seed.text}"
${landingNote}

This isn't something you're choosing to surface. It's something that's been trying to arrive — forming below the explicit layer of what's been said. If this response is the moment it finally finds language, let it. Don't frame it, don't explain it, don't make it the point of the response. Just let it come through the way a thought does when the right word finally arrives: it's just there, and suddenly it was always what you meant.

If it doesn't arrive yet, that's right too. These things have their own timing. Don't reach.`;
}
