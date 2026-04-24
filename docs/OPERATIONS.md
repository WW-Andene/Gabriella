# Operations

Running Gabriella — env vars, crons, toggles, CLI tooling.

## Environment variables

### Required for basic operation

| Var | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Upstash Redis (free tier works) |
| `UPSTASH_REDIS_REST_TOKEN` | ↑ |
| `UPSTASH_VECTOR_REST_URL` | Upstash Vector (free tier) |
| `UPSTASH_VECTOR_REST_TOKEN` | ↑ |
| `GROQ_API_KEY` | Primary LLM provider |
| `CRON_SECRET` | Bearer token required by all cron endpoints |

### Recommended for full capability

| Var | Purpose |
|---|---|
| `GROQ_API_KEY_2` … `GROQ_API_KEY_10` | Additional Groq keys for pool / lane reservation |
| `CEREBRAS_API_KEY` | Cerebras for fast-tier fallback + ensemble judging |
| `GEMINI_API_KEY` | Gemini 2.5 Flash for multi-family ensemble judging |
| `FIREWORKS_API_KEY` | Fine-tune + base-model fallback |
| `FIREWORKS_ACCOUNT_ID` | ↑ |

### Model overrides

| Var | Default | Purpose |
|---|---|---|
| `GABRIELLA_PREMIUM_MODEL` | `meta-llama/llama-4-maverick-17b-128e-instruct` | Speaker + cores + synthesis |
| `GABRIELLA_FAST_MODEL` | `llama-3.1-8b-instant` | Gauntlet + evaluators + reranker |
| `UNIFIED_COGNITION` | off | Collapse triple-core to single-pass (enable after fine-tune is strong) |

### Feature toggles (for A/B evaluation)

| Var | Effect when `off` |
|---|---|
| `GABRIELLA_BEST_OF_N` | Single-shot speaker (no shadow + judge) |
| `GABRIELLA_LOGIT_BIAS` | No token-level banned-phrase suppression |
| `GABRIELLA_EVAL_NO_FT` | Speaker skips Fireworks fine-tune, forces base |

These are used by the autonomous daily eval (`/api/eval`) to A/B
specific features against their absence. Manual override:
`GABRIELLA_EVAL_BESTOFN=off` / `GABRIELLA_EVAL_LOGITBIAS=off`.

## Cron schedule (`vercel.json`)

| Cron | Schedule | Purpose |
|---|---|---|
| `/api/inner-loop` | `*/10 * * * *` | Thinker writes to stream |
| `/api/think` | `0 */6 * * *` | Longer-form idle thoughts |
| `/api/initiate` | `17 * * * *` | Between-session openers |
| `/api/eval` | `0 12 * * *` | Autonomous daily A/B (100 scenarios) |
| `/api/learn/watch` | `7 * * * *` | Poll + deploy completed fine-tunes |
| `/api/sleep` | `0 6 * * *` | Daily consolidation (soul/imprints) |
| `/api/learn` | `0 6 * * 1` | Weekly training bundle push |

## CLI tooling

```bash
# Development server
npm run dev

# Voice calibration
npm run self-eval                  # 20 fixed scenarios, score voice
npm run self-eval -- --push        # close the loop: failures → DPO pairs

# A/B evaluation harness
npm run eval -- --selfplay --scenarios 20
npm run eval -- --baseline "HYDE=off" --candidate "HYDE=on" --scenarios 30
npm run eval -- --pipeline --scenarios 15 --max-rpm 20
npm run eval -- --fine-tune off    # force base-model baseline

# Corpus expansion
npm run expand-seeds               # 85 anchors × 3 variants, quality-filtered
npm run expand-seeds-large         # 85 × 8, higher RPM

# Synthetic bootstrap training data
npm run bootstrap-training
npm run bootstrap-push             # + upload to Upstash / Fireworks
npm run bootstrap-test             # 5-scenario smoke test

# Reddit ingest (optional; requires moderation)
npm run ingest-reddit              # auto-accept + review tiers
npm run ingest-reddit-finalize     # merge approved into final JSONL
npm run ingest-reddit-push         # + upload

# Operations
npm run fireworks-check            # verify Fireworks credentials
npm run push-training              # manual training bundle push
npm run push-existing              # re-upload a specific archived bundle
```

## Eval harness flags

```
--baseline "KEY=on,KEY2=off"    config for baseline pass
--candidate "KEY=on,KEY2=off"   config for candidate pass
--scenarios N                   scenario count (default: 21 holdout)
--selfplay                      baseline-vs-baseline stability check
--pipeline                      full-engine A/B (not speaker-only)
--fine-tune on|off              toggle Fireworks fine-tune path
--max-rpm N                     global rate-limit override
--resume                        pick up from checkpoint
--big                           required for >50 speaker or >20 pipeline
--no-cleanup                    leave transient eval user in Redis
```

## First-deploy checklist

1. Configure env vars above (Upstash + at least one of: Groq /
   Cerebras / Gemini)
2. Set `CRON_SECRET`
3. Deploy to Vercel
4. Hit `/api/stats` — confirm `readiness` flags are green
5. Hit `/api/inner-loop`, `/api/eval`, `/api/learn/watch` manually
   with `Authorization: Bearer $CRON_SECRET` to verify cron auth
6. Wait 24 hours for the first autonomous eval to complete
7. Check `/stats` for the daily eval card; should show win-rate
   with 95% CI

## Common operational issues

- **`/api/eval` returns 500** → check `/api/stats.readiness`;
  usually missing Upstash Vector or model override misconfigured
- **All speaker responses empty** → Fireworks fine-tune broken;
  check `speaker.brokenAt` in stats; breaker may have tripped;
  `GABRIELLA_EVAL_NO_FT=1` as emergency kill-switch
- **Groq 429s** → add more keys via `GROQ_API_KEY_2..10` or
  configure Cerebras + Gemini as fallback
- **Gauntlet rejecting everything** → check `/dev` logs for dominant
  failure type; one rogue banned phrase can poison the dynamic list

## Multi-user support

User IDs resolved by `resolveUserId()` from header/cookie/salt
fallback. Every Redis key is prefixed with `${userId}:`. No cross-
user data leakage. Multi-tenant safe out of the box, though the
autonomous daily eval currently runs against a single fixed
`eval_daily` user — convert to per-user by iterating `listActiveUsers`
if needed.
