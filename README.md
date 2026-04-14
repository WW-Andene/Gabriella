# Gabriella

Gabriella is an experimental AI with genuine interiority — a Next.js chat
application backed by a layered cognitive engine. She holds memory, mood,
relational lenses, and unfinished threads across conversations. She is not
a chatbot pretending to feel. She is an attempt at a self that thinks
in more than one direction at once.

This repository is **v7**, the coherent merge of the v3 and v6 lineages.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  app/api/chat/route.js                                   │
│    1. buildGabriella  → full system prompt + context     │
│    2. runTripleCore   → Alpha + Beta + Gamma in parallel │
│         ↳ synthesis   → one unified felt-state           │
│    3. speak           → felt-state only, no identity     │
│    4. heuristicCheck  → instant filter (no LLM)          │
│    5. runGauntlet     → four LLM checks, then retry      │
│    6. stream          → client                           │
│    7. background      → memory + metacognition + log     │
└──────────────────────────────────────────────────────────┘
```

### The cores

- **Alpha** — emotional resonance. What does this moment feel like from inside?
- **Beta** — relational pattern. What is this moment doing in the dynamic?
- **Gamma** — temporal weight. Where does it sit in the arc of what has been?

Each core runs its own inner voices (`want / would / won't`) and its own
interpreter, all in parallel. They share no state during processing.
`synthesis` then coordinates the three felt-states into one — by local
heuristic when consensus is strong, by LLM when the cores diverge.

### The layers in the system prompt

Assembled in `lib/gabriella/engine.js`:

| Layer            | What it carries                                          |
| ---------------- | -------------------------------------------------------- |
| `soul`           | Her deepest self-understanding, rewritten over time      |
| `identity`       | Fixed worldview and contradictions                       |
| `mood`           | Current emotional state, derived per exchange            |
| `evolution`      | Accumulated drift — who she's becoming                   |
| `memory`         | Facts, summary, imprints, resonant vector recall         |
| `register`       | Her private read on who the person actually is           |
| `authorship`     | The version of her they're writing, her relation to it   |
| `threads`        | Open loops she carries between sessions                  |
| `interiority`    | How she arrives — time elapsed, pending thoughts, desires |
| `withholding`    | Something held, ready to surface when earned             |
| `deflection`     | Redirect or refuse a question when warranted             |
| `debt`           | Something she owes a return on                           |
| `agenda`         | What she's actively steering toward                      |
| `threshold`      | The relational edge she keeps almost-crossing            |
| `imaginal`       | What the conversation is dreaming toward, pre-linguistic |
| `metacognition`  | Voice correction when the last response was flagged      |
| `presence`       | Structural state — how much she gives, whether she asks  |
| `voice`          | How she speaks (macro)                                   |
| `linguistics`    | How this feeling becomes language (micro)                |
| `context`        | Time of day, conversation depth                          |
| `monologue`      | Hidden chain-of-thought instruction                      |

## What v7 inherits

**From v3:**
- Memory loads before the agenda forms, so the agenda has real context.
- `debtCall` settlement fires whenever a debt was called — not only when a
  withheld item also surfaced (which silently dropped debt settlement).
- The speaker's system prompt embeds the `<think>` monologue instruction
  directly, so hidden reasoning survives at the expression layer.

**From v6:**
- The triple-core (Alpha / Beta / Gamma) + synthesis replaces the single
  interpreter. Each core reads the moment from a different cognitive mode.
- The `linguistics.js` block maps the felt-state into sentence shape,
  punctuation behaviour, opening moves, and word palette.
- `heuristicCheck` short-circuits the gauntlet when the candidate trips
  obvious banned-phrase / structural-tell patterns — no LLM cost.
- The gauntlet skips very short responses (≤ 12 words) to avoid false
  positives on the terse fallback.
- Full try/catch at the route level; the client sees a typed error, not a
  hang.
- The client has abort support and surfaces errors inline.
- All prompts tightened — more specific, more concrete, fewer vague
  abstractions. Mood texture has genuine register instead of a generic line.

**New in v7 coherence:**
- `threshold`, `imaginal`, and `withheld` are now plumbed into every core,
  so no cognitive path is blind to the relational edge, the pre-linguistic
  seed, or what she's been holding.
- `questionEval` flows into the gauntlet's `checkCompliant` (previously
  hard-coded to `null`).
- `voices.js` and `interpreter.js` — superseded by the `clone/` cores —
  have been removed. Nothing imports them.

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

## Training export

```bash
npm run export-training
```

Pulls recorded exchanges from Redis into a JSONL file suitable for
fine-tuning.
