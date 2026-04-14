// vectormemory.js
// Memory that retrieves by resonance, not recency.
//
// Every significant moment — imprints, exchanges, thoughts, revelations —
// is stored as a vector embedding with emotional salience metadata.
//
// Retrieval: embed the current moment, query by cosine similarity,
// weight results by salience. Different memories surface for the same
// words in different emotional contexts. That's not something a
// Redis string can do.
//
// Requires: Upstash Vector index with an embedding model enabled.
// Env vars: UPSTASH_VECTOR_REST_URL, UPSTASH_VECTOR_REST_TOKEN

import { Index } from "@upstash/vector";

const index = new Index({
  url:   process.env.UPSTASH_VECTOR_REST_URL,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN,
});

// ─── Salience scoring ─────────────────────────────────────────────────────────
// How emotionally charged is this memory? 0 = neutral, 1 = deeply significant.
// Scored heuristically — fast, no model call needed.

const HIGH_SALIENCE_SIGNALS = [
  /\b(love|hate|fear|death|grief|loss|lonely|broken|hurt|pain|cry|scared|terrified)\b/i,
  /\b(first time|last time|never told|always|never|everyone left|alone)\b/i,
  /\b(my father|my mother|my sister|my brother|my child|my partner|my ex)\b/i,
  /\b(I realized|I understood|I finally|it hit me|something shifted)\b/i,
];

const MEDIUM_SALIENCE_SIGNALS = [
  /\b(remember|miss|wish|hope|dream|want|need|feel|felt)\b/i,
  /\b(always|usually|often|sometimes|never|sometimes)\b/i,
  /\b(work|job|project|money|stress|tired|exhausted)\b/i,
];

export function scoreSalience(text, emotionalCharge) {
  let score = 0.3; // baseline

  for (const pattern of HIGH_SALIENCE_SIGNALS) {
    if (pattern.test(text)) { score += 0.25; break; }
  }

  for (const pattern of MEDIUM_SALIENCE_SIGNALS) {
    if (pattern.test(text)) { score += 0.1; break; }
  }

  // Emotional charge from mood system boosts salience
  const chargeBoost = {
    melancholic: 0.2,
    tender:      0.15,
    alive:       0.1,
    sharp:       0.05,
    wry:         0.05,
    quiet:       0.1,
    restless:    0.0,
    contemplative: 0.1,
  }[emotionalCharge] || 0;

  score += chargeBoost;

  return Math.min(1, score);
}

// ─── Store a memory ───────────────────────────────────────────────────────────
// Upstash Vector with an embedding model enabled accepts raw text —
// the embedding is generated server-side. We pass text as the `data` field.

export async function storeMemory(userId, {
  text,
  type,           // "imprint" | "exchange" | "thought" | "revelation"
  emotionalCharge,
  mood,
  salience,
  timestamp,
}) {
  const id = `${userId}:${type}:${timestamp || Date.now()}`;
  const salienceScore = salience ?? scoreSalience(text, emotionalCharge);

  await index.upsert({
    id,
    data: text,           // Upstash embeds this automatically
    metadata: {
      userId,
      type,
      emotionalCharge: emotionalCharge || "neutral",
      mood:            mood || "contemplative",
      salience:        salienceScore,
      timestamp:       timestamp || Date.now(),
      text,             // stored in metadata for retrieval without re-fetching
    },
  });

  return { id, salience: salienceScore };
}

// ─── Retrieve by resonance ────────────────────────────────────────────────────
// The query is the current moment — what's happening right now.
// Results are filtered by userId, then reranked by cosine similarity * salience.
// Different emotional contexts surface different memories for identical words.

export async function retrieveResonant(userId, currentMoment, {
  topK          = 5,
  minSalience   = 0.3,
  type          = null,   // filter by type, or null for all
} = {}) {
  const filter = type
    ? `userId = '${userId}' AND type = '${type}' AND salience >= ${minSalience}`
    : `userId = '${userId}' AND salience >= ${minSalience}`;

  const results = await index.query({
    data:            currentMoment,  // Upstash embeds the query automatically
    topK:            topK * 2,       // over-fetch, then rerank by salience
    filter,
    includeMetadata: true,
  });

  if (!results || results.length === 0) return [];

  // Rerank: cosine score * salience weight
  const reranked = results
    .map(r => ({
      ...r,
      combined: r.score * (r.metadata?.salience || 0.5),
    }))
    .sort((a, b) => b.combined - a.combined)
    .slice(0, topK);

  return reranked.map(r => ({
    text:            r.metadata?.text || "",
    type:            r.metadata?.type,
    emotionalCharge: r.metadata?.emotionalCharge,
    salience:        r.metadata?.salience,
    timestamp:       r.metadata?.timestamp,
    score:           r.score,
    combined:        r.combined,
  }));
}

// ─── Build the resonant memory block for the system prompt ───────────────────
// Instead of a flat list of facts, this is what surfaces when this
// specific moment is used as a query. It changes with context.

export function buildResonantBlock(memories) {
  if (!memories || memories.length === 0) return "";

  const sorted = [...memories].sort((a, b) => b.salience - a.salience);

  const lines = sorted.map(m => {
    const charge = m.emotionalCharge && m.emotionalCharge !== "neutral"
      ? ` [${m.emotionalCharge}]`
      : "";
    return `— ${m.text}${charge}`;
  }).join("\n");

  return `# WHAT THIS MOMENT SURFACES
These memories came up when the current moment was used as a query. They're not a list of facts — they're what resonates right now. Different moment, different memories.

${lines}

Let what's relevant live underneath. Don't announce it. Don't inventory it. Just carry it.`;
}

// ─── Store an imprint (high-salience moment) ──────────────────────────────────
// Called from memory.js after significant exchanges.

export async function storeImprint(userId, text, emotionalCharge, mood) {
  return storeMemory(userId, {
    text,
    type: "imprint",
    emotionalCharge,
    mood,
  });
}

// ─── Store an exchange summary (lower salience, broader context) ──────────────

export async function storeExchange(userId, text, mood) {
  return storeMemory(userId, {
    text,
    type: "exchange",
    mood,
    salience: 0.35, // exchanges are lower salience by default
  });
}

// ─── Store a thought (from /api/think cron) ───────────────────────────────────

export async function storeThought(userId, text) {
  return storeMemory(userId, {
    text,
    type: "thought",
    salience: 0.5,
  });
}
