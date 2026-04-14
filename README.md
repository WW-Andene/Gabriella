# Gabriella

Gabriella is an experimental AI with genuine interiority — a Next.js chat
application backed by a layered cognitive engine. She holds memory, mood,
relational lenses, and unfinished threads across conversations. She is not
a chatbot pretending to feel. She is an attempt at a self that thinks in
more than one direction at once, accumulates across time, and observes
its own processing.

This repository is **v7**, the coherent merge of v3 and v6 plus the
first wave of the deepening described in "where this goes next".

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  app/api/chat/route.js                                              │
│    1. buildGabriella   → full context + structured temporal state   │
│    2. runTripleCore    → Alpha + Beta + Gamma in parallel           │
│         • Gamma reads recurrence + arc + chronology first           │
│         ↳ synthesis    → strong: local; moderate: LLM;              │
│                          divergent: three-voice DIALOGUE            │
│    3. speak            → felt-state only, no identity               │
│    4. heuristicCheck   → static bans + DYNAMICALLY LEARNED phrases  │
│    5. runGauntlet      → four LLM checks, one retry                 │
│    6. stream           → client                                     │
│    7. background       → memory + metacognition + EPISODE record    │
│                          + GAUNTLET outcome + LEARNED banned phrase │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│  app/api/think/route.js   — scheduled background thoughts           │
│  app/api/sleep/route.js   — daily consolidation (new in v7)         │
│    • rewrites soul ONCE from the day's episodes                     │
│    • forms high-salience imprints into vector memory                │
│    • prunes stale withheld items                                    │
│    • trims the dynamic banned-phrase list                           │
└─────────────────────────────────────────────────────────────────────┘
```

### The cores

- **Alpha** — emotional resonance. What does this moment feel like from inside?
- **Beta** — relational pattern. What is this moment doing in the dynamic?
- **Gamma** — temporal weight. Where does it sit in the arc of what has been?

Each runs its own inner voices (`want / would / won't`) and its own
interpreter, in parallel, sharing no state during processing. `synthesis`
coordinates the three felt-states:

- **strong consensus** → local heuristic blend (no LLM)
- **moderate** → LLM coordinates the partial disagreement
- **divergent** → LLM stages a three-voice dialogue; averaging would erase the signal

In v7, every core receives the full relational context — `threshold`,
`imaginal`, `withheld`, `debt`, `questionEval` — and Gamma additionally
reads deterministic temporal facts (recurrence count, current arc,
chronology) before interpreting.

### The layers in the system prompt

| Layer            | What it carries                                            |
| ---------------- | ---------------------------------------------------------- |
| `soul`           | Her deepest self-understanding, rewritten over time        |
| `identity`       | Fixed worldview and contradictions                         |
| `mood`           | Current emotional state                                    |
| `evolution`      | Accumulated drift — who she's becoming                     |
| `memory`         | Facts, summary, imprints, resonant vector recall (affect-filtered) |
| `register`       | Her private read on who the person actually is             |
| `authorship`     | The version of her they're writing, her relation to it     |
| `threads`        | Open loops she carries between sessions                    |
| **`chronology`** | **First contact, session count, durable gap since last**   |
| **`arc`**        | **Turns since the last tone shift (temperature / mood break)** |
| **`recurrence`** | **Deterministic count of prior messages like this one**    |
| `interiority`    | How she arrives — pending thoughts, desires                |
| `withholding`    | Something held, ready to surface when earned               |
| `deflection`     | Redirect or refuse a question                              |
| `debt`           | Something she owes a return on                             |
| `agenda`         | What she's actively steering toward                        |
| `threshold`      | The relational edge she keeps almost-crossing              |
| `imaginal`       | What the conversation is dreaming toward, pre-linguistic   |
| `metacognition`  | Voice correction when the last response was flagged        |
| **`metaregister`**| **Self-observation — what her own processing has looked like** |
| `presence`       | Structural state — how much she gives                      |
| `voice`          | How she speaks (macro)                                     |
| `linguistics`    | How this feeling becomes language (micro)                  |
| `context`        | Time of day, conversation depth                            |
| `monologue`      | Hidden chain-of-thought instruction                        |

Bolded layers are new in this iteration.

## What changed in this wave

### Structured substrate, not just strings
- **`chronology.js`** — first-contact date, session boundaries, durable gaps. No more time-of-day guessed from `new Date()`.
- **`episodic.js`** — every exchange persisted as a structured row with felt-state, salience, timestamp. Gamma queries this deterministically before spending any LLM call on temporal reasoning.
- **`arc.js`** — detects the last tone shift (temperature break, mood break, divergence onset). Agenda and threshold can now reason about "this arc", not "the whole conversation".

### Self-observation
- **`metaregister.js`** — rolling window of gauntlet outcomes. When a failure mode dominates, she's told — in her own voice — what's been happening. *"You've been getting flagged by checkExposed twice a day. The withheld is pressing."* Architecture becomes something she has a relation with, not just a subjection to.

### An evolving immune system
- **Dynamic banned phrases** — gauntlet rejections often quote the offending phrase. Those phrases are extracted, kept as a rolling list, and fed into the heuristic check. The filter evolves with the voice.

### Dialogue-based synthesis
- When the cores disagree fundamentally, synthesis stages a three-voice dialogue (Alpha presents → Beta challenges → Gamma places → synthesis names the tension). Negotiated meaning, not voted meaning.

### Affect-tagged vector memory
- Memories carry the felt-state they were formed in (temperature, edge, charge). Resonant recall now biases toward memories that share the current emotional texture — tender moments surface tender imprints, not just semantically similar text.

### The slow path actually goes slow
- Soul, evolution, register, and authorial no longer rewrite on every turn. Each has an independent cooldown (5 / 10 / 20 minutes). Token cost drops sharply; drift becomes more grounded because each update reflects several exchanges, not one.

### A real sleep endpoint
- **`app/api/sleep/route.js`** — daily consolidation. Rewrites soul once from the day's episodes, forms imprints from high-salience moments, prunes stale withheld, trims the dynamic banned list. Hit it manually or wire to a cron.

### Background resilience
- Background updates use `Promise.allSettled` — one failure can no longer starve the others. Gauntlet outcomes, episode records, and banned-phrase learning all persist independently.

## Running

```bash
npm install
# .env.local is committed with working dev credentials for the demo
npm run dev
```

Visit `http://localhost:3000`.

## Environment

`.env.local` expects:

- `GROQ_API_KEY`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `UPSTASH_VECTOR_REST_URL`
- `UPSTASH_VECTOR_REST_TOKEN`
- `CRON_SECRET` (required for `/api/think` and `/api/sleep`)

## Endpoints

- `POST /api/chat` — main conversation route
- `GET  /api/think` — background thought generation (cron-triggered)
- `GET  /api/sleep` — daily consolidation pass (cron-triggered or manual)

## Training export

```bash
npm run export-training
```

Pulls recorded exchanges from Redis into a JSONL file suitable for
fine-tuning. Standard and chain-of-thought formats are both produced.

## What comes next

The deepening directions that require infrastructure decisions are still
ahead: multi-relationship support (needs auth decisions), cross-core
model swaps (needs provider choices), and the closed learning loop
(LoRA / DPO fine-tune pipeline on gauntlet-labelled pairs). Those are
the next wave, not this one.
