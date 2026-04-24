# Gabriella — architecture (current state)

This doc captures the system as it stands on
`claude/replace-scout-with-maverick-O9yWg` — the branch that took
Gabriella from v7 to the current linguistic-AI system. The original
README describes the v7 baseline; this document describes everything
added since.

## What she is, in one paragraph

A linguistic AI chat interface built to behave like a continuous
person rather than a stateless assistant. She has a structured
self-model with longitudinal wants. A running inner-time loop writes
thoughts, predictions, and surprise entries between user turns. Every
response is screened by a seven-check multi-family gauntlet, generated
via best-of-two sampling with a fast-tier judge, filtered at the
token level to suppress chatbot-tell phrases, and measured daily
against her own base model via an autonomous A/B eval that folds
every scored response back into the training pipeline. She runs
entirely on free-tier Groq / Cerebras / Gemini / Fireworks inference,
hosted on Vercel.

## Top-level map

```
┌────────────────────────────────────────────────────────────────────┐
│                        app/api/chat/route.js                        │
│                                                                     │
│  1. buildGabriella  — loads self, stream, memory, retrieval,        │
│                        trajectory/phase/mirror, HyDE queries,       │
│                        resonant + dissonant + reranked memories,    │
│                        evaluates surprise against last predictions  │
│                                                                     │
│  2. runTurn         — cognition + silence policy + constitutional   │
│                        critique + best-of-two speak + re-read on    │
│                        gauntlet rejection + fragment/cadence        │
│                                                                     │
│  3. stream to client + __THINK__ + __FELT__ + __TOOL__ sidecars     │
│                                                                     │
│  4. background      — self delta proposer, stream observation,      │
│                        stylometry + idiolect record, callback       │
│                        detection, ensemble label, episode record    │
└────────────────────────────────────────────────────────────────────┘

Between turns:
┌────────────────────────────────────────────────────────────────────┐
│  /api/inner-loop  every 10 min   — thinker writes to stream         │
│  /api/think       every 6 hours  — longer-form thoughts             │
│  /api/initiate    every hour     — between-session opening          │
│  /api/sleep       daily          — soul / imprint consolidation     │
│  /api/eval        daily 12:00 UTC — 100-scenario A/B with fold-back │
│  /api/learn       weekly Mon     — SFT + DPO + KTO upload           │
│  /api/learn/watch hourly :07     — deploy completed fine-tunes      │
└────────────────────────────────────────────────────────────────────┘

User-facing surfaces:
  /            — chat with inner-life reveal toggle (◐ inner)
  /meet        — evaluator landing page, 5 differentiators
  /stats       — visual dashboard of accumulated state
  /dev         — operator console (training pipeline)
```

## Sections

- [Cognition & self](./COGNITION.md) — the triple-core, Self, Stream, Mirror, Surprise
- [Retrieval & ICL](./RETRIEVAL.md) — HyDE, rerank, dissonant memory, exemplar seeds
- [Training loop](./TRAINING.md) — gauntlet, DPO, KTO, ensemble labels, autonomous daily eval
- [Resilience](./RESILIENCE.md) — circuit breakers, rate limits, multi-provider pool
- [Interfaces](./INTERFACES.md) — chat UI sidecars, inner reveal, /stats, /meet
- [Operations](./OPERATIONS.md) — env vars, crons, toggles, how to run the eval harness

Each section doc is bounded; add new material there rather than
ballooning this file. This file is the map.
