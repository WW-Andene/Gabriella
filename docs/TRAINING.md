# Training loop

The autonomous learning cycle. Every day she measures her own
voice, converts the measurements into training signal, and (via a
weekly job) feeds the signal back into the next fine-tune. No human
intervention required.

## Sources of training signal

1. **Gauntlet-passing exchanges** — logged to `${userId}:training_log`
   by `logger.js` after every turn that passes the 7-check gauntlet.
   Source for SFT and for ICL exemplar retrieval.

2. **DPO preference pairs** — `preferences.js` records a pair
   whenever the gauntlet rejects a draft AND the retry passes AND
   the retry differs from the rejected draft. Context + rejected +
   chosen. Capped at 1000 per user.

3. **KTO labeled examples** — both sides of each DPO pair (chosen →
   thumbs-up, rejected → thumbs-down) PLUS single-label examples
   from the ensemble judge (see below). Single-label doesn't
   require a matched pair, so data volume is much higher than DPO.

4. **Autonomous daily eval** — 100 A/B scenarios generated daily.
   Every candidate response is labeled by the ensemble judge; every
   baseline-wins verdict becomes a DPO regression pair with baseline
   as `chosen`, candidate as `rejected`.

## Ensemble judge

`lib/gabriella/ensembleJudge.js`. For every gauntlet-passing turn,
three parallel judges score the response 1-10 with up/down label:

- **Groq** (Llama-family judge)
- **Cerebras** (Llama-family, different infra)
- **Gemini** (independent model family)

Requires ≥2 of 3 to agree on a label. Ambiguous cases (3 different
verdicts) are DROPPED rather than added as noise — better no signal
than noisy signal. Consensus becomes KTO training data directly via
the `extraExamples` hook on `buildKtoBundle`.

Why three families: a Llama-only judge silently tolerates Llama-
family drift patterns its own training distribution produced.
Different lineages catch different blind spots.

## Autonomous daily eval (`/api/eval`)

Scheduled `0 12 * * *` (noon UTC). `maxDuration: 300`.

Each run:
  1. Clear the transient `eval_daily` Redis state
  2. Deterministically generate 100 scenarios (21 holdout + 50
     category-distributed extras + padding; seeded by date so the
     same day is reproducible but consecutive days rotate)
  3. A/B run each scenario:
     - **baseline** = fine-tune OFF (base Maverick, same prompt)
     - **candidate** = fine-tune ON (current active config)
  4. Fast-tier judge picks winner per scenario (positional-swap
     randomized)
  5. Per scenario: fire `recordEnsembleLabel` on the candidate →
     KTO training example
  6. Per scenario where baseline won: fire `recordPreferencePair`
     with baseline as chosen → DPO regression signal
  7. Write report to `eval:reports:YYYY-MM-DD`
  8. Append to 60-day rolling `eval:history`

Safety:
  • 60 RPM global rate governor (well under free-tier limits)
  • 260s soft time budget; graceful partial-completion
  • Transient eval user cleaned up at start of each run

## Weekly push (`/api/learn`)

Scheduled `0 6 * * 1` (Monday 06:00 UTC).

- Builds SFT bundle from `training_log` (CoT-formatted, heuristic-
  filtered)
- Builds DPO bundle from `preferences.js` (requires ≥10 pairs)
- Builds KTO bundle from preference pairs (both sides) + all
  ensemble labels accumulated through the week (requires ≥20
  examples)
- Uploads to Fireworks
- Launches LoRA SFT job (if configured)
- Archives all bundles to Upstash under `{userId}:learning:archive:*`
  so nothing is lost even if the provider upload fails

## Fine-tune deploy (`/api/learn/watch`)

Scheduled hourly at `:07`. Polls the pending Fireworks job. On
`COMPLETED`:
  1. Calls `ensureDeployed` to deploy the LoRA adapter
  2. Calls `setActiveSpeakerModel` to mark it active
  3. `speaker.js` reads the active model with 60s cache invalidation

On `FAILED` or `CANCELLED`: logs + clears pending job.

Speaker has a circuit breaker: 5+ consecutive errors on the fine-
tune path deactivate it, falling back to base Groq+Cerebras. The
next successful fine-tune re-engages via this same watch cycle.

## Expansion CLIs

- `npm run self-eval` — calibration run against the 20 fixed
  scenarios in `scripts/self-eval.js`
- `npm run self-eval -- --push` — regenerates chosen alternatives
  for every failure via Maverick + heuristic filter, records as DPO
  pairs. Closes the self-eval → training loop.
- `npm run eval -- --selfplay` — baseline-vs-baseline stability
  check; expected win-rate ~50%
- `npm run eval -- --pipeline` — full engine A/B (10× more
  expensive than speaker mode; capped at 20 scenarios without --big)
- `npm run expand-seeds` — generates synthetic variants of each
  seed exemplar, filters via heuristic + LLM judge, appends curated
  JSONL to `training-data/seed-expansions.jsonl`
- `npm run bootstrap-training` — generates synthetic dialogues
  from scratch using Maverick as teacher, formats as CoT JSONL

## The loop, in full

```
daily  12:00 UTC  — /api/eval measures + fold-back
hourly :07        — /api/learn/watch deploys completed fine-tunes
weekly Mon 06:00  — /api/learn uploads SFT + DPO + KTO bundles
```

Every day she measures herself. Every week she trains on what she
measured. Every hour the deploy pipeline catches up. Fully autonomous.
