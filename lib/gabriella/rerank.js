// rerank.js
// LLM-based reranking of retrieval candidates.
//
// Single-vector cosine retrieval (what Upstash Vector provides) is lossy:
// two memories with the same cosine distance can differ wildly in how
// relevant they actually are to the current moment. Rerankers close that
// gap by running a richer comparison — typically a cross-encoder that
// sees both texts simultaneously — and reshuffling the top-K.
//
// Cross-encoder models cost GPU. We don't have GPU. But an LLM with
// in-context reasoning is a zero-cost cross-encoder: we over-fetch
// (topK × 4 candidates), hand them to a fast-tier Llama call with the
// current moment as pivot, and let the model score all candidates in
// one batched pass. Groq fast-tier does this in ~400 ms for 20
// candidates. Documented ~10-15% precision gain over raw cosine rerank.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

// ─── Batched rerank over up to N candidates in one LLM call ─────────────────

export async function rerankByLLM(currentMoment, candidates, {
  topN           = 5,
  maxCandidates  = 20,
  lastUserMessage = null,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  if (candidates.length <= topN) return candidates;

  const pool = candidates.slice(0, maxCandidates);
  const indexed = pool.map((c, i) => ({ i, text: c.text || "", meta: c }));

  const listing = indexed
    .map(x => `[${x.i}] ${x.text.slice(0, 220).replace(/\s+/g, " ")}`)
    .join("\n");

  const pivot = [
    currentMoment ? `current moment: ${currentMoment.slice(0, 280)}` : null,
    lastUserMessage && lastUserMessage !== currentMoment
      ? `they just said: ${lastUserMessage.slice(0, 280)}`
      : null,
  ].filter(Boolean).join("\n");

  const prompt = `You are a retrieval reranker for a character named Gabriella. Given the CURRENT MOMENT and a list of candidate past memories, score each candidate for how relevant it is to the moment right now — not just textually similar, but actually worth surfacing as resonance or reference.

Scoring rubric (integer 0-10):
  10 = this memory IS the thing the moment is echoing; surfacing it would be uncanny
   7 = meaningfully related, same affective register or thematic line
   4 = loosely adjacent, same general area but not quite
   1 = surface-level token overlap only, not actually relevant
   0 = unrelated — the embedding matched on noise

# CURRENT MOMENT

${pivot}

# CANDIDATES (with their index numbers)

${listing}

Return ONLY a JSON object of this exact shape:
{"ranked": [ {"i": <index>, "s": <score 0-10>} ]}

Include ALL candidate indices. Don't add prose. Don't add reasons. Just the list.`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens:  Math.max(240, pool.length * 14),
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.ranked)) return candidates.slice(0, topN);

    const scoreByIndex = new Map();
    for (const entry of parsed.ranked) {
      const idx = Number(entry.i);
      const sc  = Number(entry.s);
      if (Number.isFinite(idx) && Number.isFinite(sc)) scoreByIndex.set(idx, sc);
    }

    // Combined score: 70% LLM rerank, 30% original (preserves some of the
    // salience/cosine signal — prevents the LLM from dominating entirely
    // on small candidate pools where it can get the ordering wildly wrong).
    const combined = indexed.map(x => {
      const llmScore = scoreByIndex.get(x.i) ?? 0;
      const origScore = typeof x.meta.combined === "number"
        ? x.meta.combined
        : typeof x.meta.score === "number" ? x.meta.score : 0.5;
      return {
        ...x.meta,
        _llmRerank: llmScore,
        combined:   llmScore * 0.7 + origScore * 3.0,  // origScore is 0-1, llm 0-10 — weight comparably
      };
    });

    combined.sort((a, b) => b.combined - a.combined);
    return combined.slice(0, topN);
  } catch {
    // On failure, fall back to original ordering — no regression versus
    // pre-rerank retrieval.
    return candidates.slice(0, topN);
  }
}
