// hyde.js
// Hypothetical Document Embedding.
//
// Documented retrieval technique (Gao et al. 2022): instead of embedding
// the raw query and searching by its vector, first use an LLM to
// hallucinate what a PERFECT answer / matching document would look like,
// then embed THAT hypothetical answer and use it as the query vector.
//
// Why it works: the raw user message is a question in question-shape.
// Good memories are answer-shape, state-shape, moment-shape. The
// embedding space is largely about surface form, so query-shape vectors
// don't sit near answer-shape vectors even when the content matches.
// HyDE closes that gap by putting the query into answer-shape before
// embedding.
//
// Papers report 20-40% recall improvements on zero-shot retrieval.
// For Gabriella this means: when the user says "I've been thinking
// about my dad again," we don't embed THAT — we embed a hypothetical
// "an earlier moment when they told me about their father and
// something specific landed." Memories that share texture with THAT
// surface more reliably than cosine on the raw message.
//
// Cost: one fast-tier LLM call per retrieval. ~1000 tokens of free
// Groq inference per turn. Free under the tier cap.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

// ─── Generate a hypothetical matching memory ────────────────────────────────

export async function hypotheticalMemory({
  currentMoment,
  recentMessages,
  kind = "resonant",   // "resonant" or "dissonant" — shape of hypothetical differs
  maxChars = 280,
}) {
  const recent = (recentMessages || [])
    .slice(-4)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${(m.content || "").slice(0, 180)}`)
    .join("\n");

  const shapeHint = kind === "dissonant"
    ? "a past moment in the OPPOSITE affective register — if the current moment feels tender, imagine a past moment that was sharp; if closed, imagine a past moment that was open. The dissonant memory is what she should surface as counterweight."
    : "a past moment that shares the texture of this one — same affect, same register, same shape of thing being said. Not necessarily the same topic; same FEEL.";

  const prompt = `You are helping a retrieval system find a matching memory for an AI character named Gabriella.

# THE CURRENT MOMENT
${recent}

# TASK
Hallucinate ${shapeHint}

Write a short single-sentence memory as if it were an actual past exchange — something she might have stored. The sentence should be in the SHAPE of a memory, not a question. Concrete if possible. No preamble, no explanation.

Examples of correct shape:
- "the time they asked her what she believed in and she answered with the example of her mother"
- "a Sunday morning when they admitted they'd been avoiding calling their sister for weeks"
- "the exchange where she laughed at something sharp they said and they went quiet"

Write ONE such hypothetical memory. One sentence. ${maxChars} chars max.`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_tokens:  100,
      }),
    );
    const raw = (result.choices[0].message.content || "").trim();
    // Strip code fences / quotes / leading bullets if the model added them.
    const clean = raw
      .replace(/^```[^\n]*\n?/i, "")
      .replace(/\n?```\s*$/i, "")
      .replace(/^["'"'`\-—\s]+/, "")
      .replace(/["'"'`\s]+$/, "")
      .trim();
    if (!clean || clean.length < 10) return null;
    return clean.slice(0, maxChars);
  } catch {
    return null;
  }
}

// ─── Ensemble query — augment the raw moment with a hypothetical ────────────
// Used by vectormemory to form a richer query string. Concatenating raw +
// hypothetical typically outperforms either alone because the embedding
// lands in a region that covers both the question-shape and the
// answer-shape vectors.

export async function buildAugmentedQuery({ currentMoment, recentMessages, kind = "resonant" }) {
  const hypothetical = await hypotheticalMemory({ currentMoment, recentMessages, kind }).catch(() => null);
  if (!hypothetical) return currentMoment;  // graceful fallback: raw query alone
  return `${currentMoment}\n\n${hypothetical}`;
}
