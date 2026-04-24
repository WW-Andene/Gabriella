# Resilience

Free-tier providers fail. Rate limits, 5xx's, account flags,
occasional 20-second pauses in the Cerebras API. None of that
should reach the user. The production path is hardened against
every source of failure I've encountered.

## Three-state circuit breakers

`lib/gabriella/circuitBreaker.js`. Redis-backed so serverless cold-
starts inherit state.

States:
- **closed** — normal. All calls go through.
- **open** — hit `failureThreshold` consecutive failures. Calls
  short-circuit to the provided `fallback` WITHOUT the LLM call.
- **half_open** — after `coolDownMs`, one probe call is allowed. On
  success → close. On failure → re-open.

Wrapping:
```js
const result = await withBreaker(redis, "thinker", fn, {
  fallback: null,
  failureThreshold: 5,
  coolDownMs: 10 * 60_000,
});
```

Currently wrapped: `thinker`, `selfProposer`, `mirror`, `surprise`,
`constitutional`, plus the speaker's fine-tune path. States exposed
at `/api/stats` → `breakers`.

## Rate governor

`scripts/eval-harness.js::RateGovernor` — serializes every LLM call
through a global RPM limit. Default 30 RPM for speaker-mode evals,
20 for pipeline-mode, 60 for autonomous daily. Sustained load looks
like a careful client, not an abusive one. Conservative by design:
the key-safety constraint is real and came from explicit user
feedback.

## Multi-provider pool

`lib/gabriella/groqPool.js`. Unified OpenAI-compat abstraction over:

- **Groq** (workhorse, 3-10 keys rotated)
- **Cerebras** (same Llama family, different infra, free tier)
- **Gemini** (independent family, 2.5 Flash free tier)
- **Fireworks** (fine-tune + base model fallback, freemium)

Features:
- Dead-key tracking with `maybeMarkDead` on 401/403/org-restricted
- Lane reservation: Alpha / Beta / Gamma cores each get a dedicated
  Groq key when ≥3 available
- Per-provider model name translation (Maverick on Groq →
  `llama3.1-8b` on Cerebras for fast-tier calls; null on providers
  that don't serve a given model)
- `pickClient({ providers: ["gemini"] })` for explicit family
  routing (used by the gauntlet's voice-drift + evasive checks)

## Speaker fallback chain

1. Fireworks fine-tune (if `getActiveSpeakerModel` returns one AND
   breaker closed AND `GABRIELLA_EVAL_NO_FT` not set)
2. Groq + Cerebras (voice-family consistent) with best-of-two
3. Fireworks base model (voice approximate; last-resort fallback
   when the Llama pool is fully exhausted)

Gemini stays OFF the speaker path — its voice difference is too
pronounced. Gemini is used only for judging.

## Graceful degradation examples

- **Groq fully rate-limited** → Cerebras takes over; best-of-two
  collapses to best-of-one if Cerebras lane is also limited
- **Gemini API down** → voice-drift + evasive checks run on Groq
  (same family as speaker; weaker signal but functional)
- **Upstash Vector unreachable** → resonant + dissonant retrieval
  return empty; memory section falls back to facts/imprints text
- **Fine-tune inference 5xx** → circuit breaker trips after 5
  errors; `speakerState.brokenAt` recorded; speaker routes to Groq;
  next completed fine-tune re-engages on activation

## Per-turn defensive `safe()` wrapper

`engine.js::safe(promise, fallback, label)` — wraps every parallel
context load. One subsystem throwing (malformed JSON in Redis,
missing index, etc.) can't take the whole request down — the
failing branch returns its fallback, a warning is logged to
`debugLog`, and the turn continues with partial context.

## Request-level timeouts

- Fireworks inference: 20 second timeout → abort + fall-through
- Cerebras / Gemini: 30 second adapter timeout
- Background updates: all fire-and-forget via `Promise.allSettled`,
  so one slow update can't delay the next turn
