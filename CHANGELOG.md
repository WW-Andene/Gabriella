# Changelog

Notable changes on branch `claude/replace-scout-with-maverick-O9yWg`.
For the architectural tour, see [`docs/`](./docs/).

## Sprint — post-v7 extensions

Structured per-area. Commits are bisectable; each entry aligns with
one commit hash.

### Cognition & self

- **Sovereign Self** — unified structured self-model with longitudinal
  wants, confidence-tracked reads, commitments with confirmation/
  refutation ledger, retired-items visible in prompt. Collapses what
  used to be six independent prompt writers into one integrated self.
- **Self delta proposer** — fast-tier LLM pass after each turn
  emits typed deltas (add_want / touch_want / retire_want /
  update_read / add_commitment / confirm_commitment /
  refute_commitment / note_contradiction / set_confidence).
- **Stream** — append-only time-ordered log of inner experience
  (thoughts, predictions, connections, surprises, re-readings,
  observations), pruned by age × weight. Replaces ephemeral
  `pendingThoughts` with a durable primitive.
- **Thinker** — `/api/inner-loop` every 10 min writes to the stream.
- **Surprise** — when user returns, live predictions are scored
  against what they actually said; surprise entries feed the next
  turn's prompt.
- **Mirror** — second-order theory of mind (what she thinks they're
  reading of her, what's unsaid, where she's held back).
- **Silence policy** — pre-generation detection of withdrawal, raw
  loss, command-stop, explicit-listen-request, phatic overload,
  single-word emotional. Forces short / present.
- **Constitutional critique** — one fast-tier call before the
  speaker produces per-turn `aim / avoid` guidance.
- **Re-reader** — on gauntlet rejection, a single-pass re-read
  produces a NEW felt-state before retry (vs. regenerating from
  the same wrong reading).
- **Session planner** — once per session, she chooses a posture
  (intent + trap to avoid) for this conversation.
- **Wit detection** — regex + LLM disambiguation for ambiguously-
  ironic messages; permission-not-requirement guidance block.
- **Meta-conversation detector** — recognizes when user asks ABOUT
  the relationship / her memory / her nature; register shifts.
- **Safety frame** — crisis-language detection (suicidality /
  self-harm / acute distress / abuse disclosure) with specific
  resource pointers and explicit anti-therapy-speak voice notes.
- **Contradiction detector** — flags when her new response
  contradicts something she said earlier; writes a high-weight
  stream entry so next turn can self-correct.

### Retrieval & in-context learning

- **HyDE** — hypothetical-memory generated before vector query;
  closes question-shape vs. answer-shape gap.
- **LLM reranker** — batch-score top-K*3 candidates via fast-tier,
  combined 70% LLM + 30% cosine.
- **Dissonant retrieval** — parallel retrieval in OPPOSITE affective
  register as counterweight.
- **Exemplar ICL** — retrieves past gauntlet-passing turns similar
  to current moment; injects as few-shot (user, assistant) pairs.
- **Cold-start seed corpus** — 85 hand-curated exemplars across 20
  failure classes; used when training_log is thin.
- **Seed expansion CLI** — `npm run expand-seeds` generates filtered
  synthetic variants on Groq free tier.
- **Best-of-two sampling** — primary + shadow at different operating
  points; fast-tier judge picks winner. Cross-provider variant:
  primary on Groq, shadow on Fireworks base.
- **Logit bias** — Llama-3 token IDs for chatbot-tell phrases
  (Certainly / Absolutely / "I hear" / Amazing / etc.) suppressed at
  generation.
- **Stylometry fingerprint** — sentence length / punctuation /
  opener patterns as observed voice-shape counter-signal.
- **Idiolect tracker** — emergent distinctive vocabulary from her
  own output.
- **Callback tracker** — detects specific references in her response,
  tracks landing rate on next turn, surfaces landing or missing.
- **Response diversity** — detects phrase / shape recycling in last
  N responses, flags specific overused phrases.
- **Vocabulary borrowing** — tracks words she's adopted FROM the
  user; surfaces as relational-intimacy signal.
- **Adaptive model routing** — fast-tier for phatic / short-closed
  turns, premium for substantive.

### Training loop

- **Ensemble judge** — Groq + Cerebras + Gemini score every gauntlet-
  passing turn; 2-of-3 consensus labels feed KTO training.
- **KTO export** — single-label training alongside SFT + DPO.
- **Autonomous daily eval** — `/api/eval` at 12:00 UTC runs 100 A/B
  scenarios (fine-tune ON vs. OFF), records KTO labels + DPO regression
  pairs, rolling 60-day history.
- **Weekly digest** — `/api/digest` at Sunday 10:00 UTC writes her
  own reflection paragraph as a stream entry.
- **Eval harness** — `npm run eval` with `--selfplay` stability check,
  `--pipeline` full-engine mode, `--fine-tune on|off` toggle,
  `--max-rpm` rate governor, checkpoint-resume, big-run safety gate.
- **User feedback** — `/api/feedback` thumbs-up/down per turn; feeds
  directly into KTO via ensemble_labels list.
- **Self-eval → DPO loop closed** — `--push` flag regenerates chosen
  alternatives for failures and records as DPO pairs.

### Resilience & infrastructure

- **Circuit breakers** — 3-state Redis-backed breakers wrap 9+
  expensive LLM paths (thinker / selfProposer / mirror / surprise /
  constitutional / planner / humorLLM / digest / retroNarrative /
  contradictionCheck / identityHook).
- **Rate governor** — per-process RPM limit on eval harness with
  conservative defaults (60 for autonomous, 30 CLI default).
- **Multi-provider pool** — Groq + Cerebras + Gemini + Fireworks
  with lane reservation, dead-key tracking, per-provider model
  translation.
- **Speaker fallback chain** — fine-tune → Groq+Cerebras → Fireworks
  base with circuit-breaker on the fine-tune path.
- **JSON-mode** — `response_format: { type: "json_object" }` on all
  evaluator LLM calls; Gemini-adapter strips it; Groq/Fireworks
  honor it.
- **Prompt prefix restructure** — stable head first, per-turn
  dynamic content last for provider-side prefix caching.
- **Deploy-check CLI** — `npm run deploy-check` verifies env / Redis
  / Vector / Pool / Models; `--url` extends to cron-endpoint auth
  probes; exit codes for CI gating.
- **Audit ledger** — every LLM call logged with provider / model /
  tokens to Redis; daily rollup surfaced on `/stats`.
- **Unit tests** — `npm test` runs vanilla-node assertions over
  pure-function modules (silence, humor, stylometry, userPrefs,
  seedExemplars, borrowing).

### User-facing surfaces

- **`/` chat** with inner-monologue reveal toggle (◐ inner), privacy-
  mode toggle (◐ private), thumbs-up/down feedback buttons on every
  assistant bubble, fragmented delivery with cadence-aware pauses.
- **`/meet`** — evaluator landing page with 5 differentiators + under-
  the-hood paragraph.
- **`/retro`** — relationship retrospective with LLM-narrated summary
  (when `GABRIELLA_RETRO_LLM_NARRATIVE=on`), current read, longitudinal
  wants, commitments, retired track record, recent stream, callback
  landing rate, milestones timeline, SVG arc chart with temperature +
  weight + self-events overlay.
- **`/stats`** — operator dashboard with self-model / stream / memory /
  training pipeline / speaker / heartbeats / breakers / pool / audit /
  gauntlet-per-check / readiness.
- **`/memory`** — per-entry delete for facts / imprints / threads /
  pinned / stream; nuclear "forget everything" option; markdown and
  JSON export links.
- **`/prefs`** — user persona-variant picker (standard / sharper /
  softer / drier) + optional custom anchor.
- **`/api/retro`** — structured JSON with arc + selfEvents overlay.
- **`/api/export`** — markdown conversation + state download.
- **`/api/feedback`** — POST thumbs with context + response.
- **`/api/explain`** — per-turn decision trace.
- **`/api/healthz`** — plain-text uptime probe.
- **`/api/memory`** — inspect + delete facts / imprints / threads /
  pinned / stream / nuclear wipe.
- **`/api/stats`** — operator JSON.
- **`/api/prefs`** — GET / POST persona preferences.

### Sidecar streaming

- `__THINK__` — hidden monologue block, revealed via ◐ inner toggle
- `__FELT__` — felt-state snapshot (charge / want / temperature / edge
  / consensus / retried), same reveal toggle
- `__PEEK__` — pre-response glass-mind preview arriving during the
  typing delay so the user can see her plan before the response lands
- `__TOOL__` — tool execution result chip on last bubble

### Background crons (vercel.json)

```
*/10 * * * *  — /api/inner-loop   (thinker)
 0 */6 * * *  — /api/think         (long-form thoughts)
17 * * * *    — /api/initiate      (between-session opener)
 0 12 * * *   — /api/eval          (autonomous A/B)
 7 * * * *    — /api/learn/watch   (fine-tune activation)
 0 6 * * *    — /api/sleep         (daily consolidation)
 0 6 * * 1    — /api/learn         (weekly training push)
 0 10 * * 0   — /api/digest        (Sunday reflection)
```

### User control / privacy / trust

- **Privacy mode** — ephemeral session toggle; server short-circuits
  ALL Redis writes.
- **Memory editor** — per-entry deletion + full wipe, including the
  stream.
- **Export** — one-click download.
- **Persona variant** — user-set register preference.

### Documentation

- `docs/ARCHITECTURE.md` — top-level map + section index
- `docs/COGNITION.md` — cognitive layer (triple-core, Self, Stream,
  Surprise, Mirror, re-reader)
- `docs/RETRIEVAL.md` — HyDE, rerank, dissonant, ICL, seeds,
  stylometry, idiolect, callbacks
- `docs/TRAINING.md` — autonomous DPO/KTO loop + daily eval
- `docs/RESILIENCE.md` — circuit breakers, rate governor, fallback
  chain
- `docs/INTERFACES.md` — chat UI, sidecars, pages
- `docs/OPERATIONS.md` — env, crons, CLI, deploy, troubleshooting

---

## v7 baseline

See [README.md](./README.md) for the authoritative v7 description.
Everything above extends v7 rather than replacing it; the triple-core,
gauntlet, soul / evolution / narrative / register / authorial layers,
withholding / debt / agenda / threshold / imaginal lifecycle signals,
metaregister self-observation, Fireworks fine-tune path, episodic
memory, arc / recurrence / chronology substrate, and dynamic banned
phrase list all remain as they were in v7 and now coexist with the
new layers.
