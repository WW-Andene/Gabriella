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
import { rerankByLLM } from "./rerank.js";

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
  // Optional affect tags derived from a felt-state.
  // These let retrieval filter by emotional texture, not just semantic
  // similarity — resonance becomes affective, not just topical.
  feltState,
}) {
  const id = `${userId}:${type}:${timestamp || Date.now()}`;
  const salienceScore = salience ?? scoreSalience(text, emotionalCharge);

  const affectTags = feltState ? {
    fsTemp:      feltState.temperature || null,
    fsEdge:      !!feltState.edge,
    fsCharge:    (feltState.charge || "").slice(0, 120),
    fsConsensus: feltState.consensus  || null,
  } : {};

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
      ...affectTags,
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
  // Optional affect filter: bias retrieval toward memories that share
  // the current moment's emotional texture. This is where resonant
  // recall becomes genuinely emotional — a "tender" query surfaces
  // tender imprints, not merely semantically similar ones.
  feltState    = null,
  // Optional HyDE augmentation: if the caller has pre-computed a
  // hypothetical matching memory, pass it here and the query that gets
  // embedded becomes "rawMoment + hypothetical". Lifts recall 20-40% on
  // zero-shot retrieval (Gao et al. 2022). Free — one fast-tier call
  // upstream per turn.
  hydeAugment  = null,
  // Optional LLM rerank: after raw cosine + salience + affect scoring,
  // pass the top-N*4 candidates through a fast-tier LLM that scores
  // each for genuine relevance to the current moment. Documented
  // ~10-15% precision gain over cosine alone. Set rerank=false to skip
  // when caller doesn't want the extra LLM call.
  rerank       = true,
  lastUserMessage = null,   // fed into the reranker's pivot
} = {}) {
  const filterClauses = [
    `userId = '${userId}'`,
    `salience >= ${minSalience}`,
  ];
  if (type) filterClauses.push(`type = '${type}'`);

  const filter = filterClauses.join(" AND ");

  // Vector retrieval is a non-essential signal — if the index isn't
  // configured (no embedding model enabled, missing credentials, network
  // hiccup), Gabriella should still respond. Swallow and return empty
  // rather than letting the whole chat route 500.
  //
  // Query string: if a HyDE hypothetical was produced upstream, concat
  // it with the raw moment so the embedding lands in a region that
  // covers both question-shape (raw) and answer-shape (hypothetical)
  // vectors. Empirically: better recall than either alone.
  const queryText = hydeAugment
    ? `${currentMoment}\n\n${hydeAugment}`
    : currentMoment;

  let results;
  try {
    results = await index.query({
      data:            queryText,      // Upstash embeds the query automatically
      topK:            topK * 3,       // over-fetch, then rerank by salience + affect
      filter,
      includeMetadata: true,
    });
  } catch (err) {
    console.warn(`vectormemory.retrieveResonant skipped: ${err?.message || err}`);
    return [];
  }

  if (!results || results.length === 0) return [];

  // Rerank: cosine similarity * salience * affect-match-bonus.
  // Affect match is additive — a memory with the same temperature or
  // edge-presence as the current felt-state gets a modest boost.
  const currentTemp = feltState?.temperature || null;
  const currentEdge = !!feltState?.edge;

  // Stage 1: affect-adjusted cosine × salience rerank. Keep a WIDER pool
  // (topK × 3) so the LLM reranker has room to genuinely rearrange.
  const stage1 = results
    .map(r => {
      const m = r.metadata || {};
      let affectBoost = 0;
      if (currentTemp && m.fsTemp === currentTemp) affectBoost += 0.08;
      if (currentEdge && m.fsEdge === true)        affectBoost += 0.05;
      const combined = r.score * (m.salience || 0.5) + affectBoost;
      return { ...r, combined };
    })
    .sort((a, b) => b.combined - a.combined)
    .slice(0, topK * 3);

  const candidates = stage1.map(r => ({
    text:            r.metadata?.text || "",
    type:            r.metadata?.type,
    emotionalCharge: r.metadata?.emotionalCharge,
    salience:        r.metadata?.salience,
    timestamp:       r.metadata?.timestamp,
    fsTemp:          r.metadata?.fsTemp,
    fsEdge:          r.metadata?.fsEdge,
    score:           r.score,
    combined:        r.combined,
  }));

  // Stage 2: LLM rerank. Zero GPU cost; one Groq fast-tier call per
  // retrieval. Silent fallback to stage-1 ordering on failure.
  if (!rerank || candidates.length <= topK) return candidates.slice(0, topK);
  return await rerankByLLM(currentMoment, candidates, {
    topN:           topK,
    maxCandidates:  Math.min(20, candidates.length),
    lastUserMessage,
  });
}

// ─── Retrieve by DIS-sonance ──────────────────────────────────────────────────
// The mirror of retrieveResonant. Same semantic query, but filtered
// toward the OPPOSITE affective signature: if the current feltState is
// tender, surface memories that were sharp; if closed, surface memories
// that were open. These enter the prompt as a "what this moment could
// also be" counterweight — productive tension against the retrieval
// confirmation loop where a misread affect surfaces memories that
// reinforce the misread.
//
// Conservative: returns at most `topK` items (default 2) and only if the
// vector store is reachable. Dissonance is a small additive signal, not
// a replacement for resonant recall.

const TEMP_OPPOSITE = {
  closed:  ["open", "present"],
  terse:   ["open"],
  present: ["closed", "terse"],
  open:    ["closed", "terse"],
};

export async function retrieveDissonant(userId, currentMoment, {
  topK         = 2,
  minSalience  = 0.4,     // slightly stricter — we want memories that actually mattered
  feltState    = null,
  hydeAugment  = null,    // hypothetical memory in the OPPOSITE register
} = {}) {
  if (!feltState || !feltState.temperature) return [];
  const opposites = TEMP_OPPOSITE[feltState.temperature] || [];
  if (opposites.length === 0) return [];

  const oppSet  = new Set(opposites);
  const edgeFlip = feltState.edge ? false : true; // if current has no edge, look for edge'd past

  const filter = `userId = '${userId}' AND salience >= ${minSalience}`;

  const queryText = hydeAugment
    ? `${currentMoment}\n\n${hydeAugment}`
    : currentMoment;

  let results;
  try {
    results = await index.query({
      data:            queryText,
      topK:            topK * 4,  // over-fetch so filter-by-opposite has room
      filter,
      includeMetadata: true,
    });
  } catch (err) {
    console.warn(`vectormemory.retrieveDissonant skipped: ${err?.message || err}`);
    return [];
  }

  if (!results || results.length === 0) return [];

  const filtered = results
    .map(r => ({ ...r, m: r.metadata || {} }))
    .filter(r => {
      // Must be affectively opposite on at least one axis.
      const oppTemp = r.m.fsTemp && oppSet.has(r.m.fsTemp);
      const oppEdge = typeof r.m.fsEdge === "boolean" && r.m.fsEdge === edgeFlip;
      return oppTemp || oppEdge;
    })
    .map(r => ({
      ...r,
      combined: r.score * (r.m.salience || 0.5),
    }))
    .sort((a, b) => b.combined - a.combined)
    .slice(0, topK);

  return filtered.map(r => ({
    text:            r.m.text || "",
    type:            r.m.type,
    emotionalCharge: r.m.emotionalCharge,
    salience:        r.m.salience,
    fsTemp:          r.m.fsTemp,
    fsEdge:          r.m.fsEdge,
    score:           r.score,
    combined:        r.combined,
  }));
}

export function buildDissonantBlock(memories) {
  if (!memories || memories.length === 0) return "";

  const lines = memories.map(m => {
    const tempTag = m.fsTemp ? ` [${m.fsTemp}]` : "";
    return `— ${m.text}${tempTag}`;
  }).join("\n");

  return `# WHAT THIS MOMENT COULD ALSO BE
Memories that landed in the opposite affective register from your current read. They're a counterweight, not a correction — if your reading is right, these stay underneath. If your reading is drifting, one of these might be the truer shape.

${lines}`;
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

export async function storeImprint(userId, text, emotionalCharge, mood, feltState = null) {
  return storeMemory(userId, {
    text,
    type: "imprint",
    emotionalCharge,
    mood,
    feltState,
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
