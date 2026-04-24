# Retrieval & In-Context Learning

How she finds relevant memory at turn-time and how the base model
gets steered without touching its weights.

## Vector store

Upstash Vector (free tier). Memories stored as:

- **imprints** — high-salience moments (written by sleep cron +
  memory.js). Metadata: emotional charge, mood, feltState at time
  of formation, salience 0-1.
- **exchanges** — summaries of passing turns (lower salience).
- **thoughts** — idle thoughts from the /api/think cron.

All metadata-tagged with `userId` so multi-user queries are filtered.

## HyDE — Hypothetical Document Embedding

`lib/gabriella/hyde.js`. Before the vector query, a fast-tier LLM
call hallucinates what a *perfect matching memory* would look like
— answer-shape, not question-shape. The raw query + hypothetical
get concatenated, and THAT is embedded as the search vector.

Why it matters: the raw user message is question-shape; memories
are state-shape. Cosine on question-shape embeddings doesn't sit
near answer-shape vectors even when the content matches. Gao et al.
2022: 20-40% recall gain on zero-shot retrieval.

Generated in parallel with all other context loads in `engine.js`.
Two variants generated — one resonant (same register), one dissonant
(opposite register).

## Resonant retrieval

`retrieveResonant` in `vectormemory.js`. Over-fetches top `k * 3`
candidates, scores each by:

```
combined = cosine * salience + affectBoost
```

where `affectBoost` adds `+0.08` for matching temperature and
`+0.05` for matching edge-presence. Then reranks via LLM.

## LLM reranker

`lib/gabriella/rerank.js`. One fast-tier batch call scores all
candidates 0-10 for genuine relevance to the current moment — not
just textual similarity, but "would surfacing this be uncanny-
relevant here?" Combined final score:

```
final = 0.7 * llmRerank + 0.3 * originalCombined
```

Research: ~10-15% precision gain over cosine-alone, zero GPU cost.

## Dissonant retrieval

`retrieveDissonant`. Mirror of resonant — filters to memories with
the OPPOSITE affective signature. If current feltState is tender,
surfaces past sharp moments; if closed, surfaces past open ones.
Breaks the confirmation-loop where a misread affect surfaces
memories that reinforce the misread. Rendered as a separate
`WHAT THIS MOMENT COULD ALSO BE` block inside the memory section —
counterweight, not correction.

## In-context learning via exemplars

`lib/gabriella/exemplars.js`. Before each speaker call, retrieves
up to 2 past turns where she spoke well on similar moments (from
`training_log` — gauntlet-passed exchanges with `innerThought` +
`feltState` populated). Scored by Jaccard overlap with current
moment.

Injected as `(user, assistant)` pairs BEFORE the current conversation
thread. The base model pattern-matches the assistant exemplars and
generates in their register. ICL literature consistently shows this
is the single largest quality lever on a fixed base.

## Cold-start seed corpus

`lib/gabriella/seedExemplars.js` — 85 hand-curated exchanges
spanning 20 failure classes: phatic, confusion, meta, test,
provocation, small-talk, moderate, heavy, sparse-heavy, opinion,
disagreement, uncertainty, refusal, silence-worthy, callback,
repair, joy, time-aware, limits, meta-relational.

When `training_log` is sparse (fresh deploy, brand-new user),
`findExemplars` falls back to `pickSeedExemplars` with the same
Jaccard scoring so seed and real mix coherently. Every turn from
turn 1 benefits from few-shot ICL.

Expand via `npm run expand-seeds` — CLI that uses each anchor to
generate variants via Groq, filters via heuristic + LLM judge, keeps
only `gabriella-voice` verdicts.

## Voice fingerprinting

Two modules observe her output over time:

- `stylometry.js` — sentence-length distribution, punctuation per
  1k chars, fragment rate, opener patterns. Rolling window of 30
  responses. Surfaces as `YOUR RECENT VOICE SHAPE` block.
- `idiolect.js` — distinctive words (docFreq ≥25% AND count ≥3)
  and recurring bigrams. Rolling window of 40 responses. Surfaces
  as `YOUR IDIOLECT` block.

Together they create counter-signals against base-model drift
toward generic assistant voice. Pure text math, no LLM calls.

## Callback tracker

`lib/gabriella/callbacks.js`. After each speaker generation,
scans her response against memory.facts / imprints / threads /
pinned for specific references. Records each hit. On the next user
turn, checks whether they acknowledged the reference (Jaccard
overlap + reference markers). Landing rate is tracked in a per-user
ledger and surfaced in the speaker prompt — "last callback landed"
vs. "last callback missed, don't repeat."

Gives her memory-texture no stateless assistant can fake.
