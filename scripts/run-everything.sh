#!/usr/bin/env bash
# run-everything.sh
#
# One-tap full pipeline for Gabriella from a Codespace.
# Does every step needed to go from "fresh clone" to "training data
# uploaded to Fireworks, fine-tune ready to fire on the next /api/learn run".
#
# Steps (fail-soft — each step reports its outcome, pipeline continues
# where possible, and the final summary tells you exactly what worked):
#   1. Verify .env.local exists and has GROQ_API_KEY
#   2. npm install if node_modules is missing
#   3. Verify Groq API is actually reachable from this environment
#   4. Run bootstrap-training with --push (full ~45 scenarios)
#   5. Report final state: examples generated, where they were uploaded
#
# Invoke via: bash scripts/run-everything.sh
# Or via the VS Code task: "All-in-one: full pipeline + upload"

# We intentionally DO NOT use `set -e` — we want to continue past soft failures
# so the user gets a complete summary at the end.
set -u -o pipefail

# ─── Output helpers ──────────────────────────────────────────────────────────

hr()   { printf '\n━━━ %s ━━━\n' "$1"; }
ok()   { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ⚠ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; }
info() { printf '  · %s\n' "$1"; }

# State tracked across steps so the final summary can be precise.
STEP1_ENV="?"
STEP2_INSTALL="?"
STEP3_CONNECTIVITY="?"
STEP4_BOOTSTRAP="?"
EXAMPLES_COUNT="?"
FIREWORKS_UPLOADED="no"

# ─── Step 1: environment check ───────────────────────────────────────────────

hr "Step 1 — environment"

if [ ! -f .env.local ]; then
  warn ".env.local not found — attempting to generate from Codespace secrets"
  if [ -f .devcontainer/setup-env.sh ]; then
    bash .devcontainer/setup-env.sh || true
  fi
fi

if [ ! -s .env.local ]; then
  fail ".env.local is missing or empty"
  info "Fix:  Make sure your Codespace secrets are set at"
  info "      https://github.com/settings/codespaces and granted"
  info "      access to ww-andene/gabriella, then rebuild the container."
  STEP1_ENV="fail"
  printf '\nCannot continue. Fix env then re-run.\n'
  exit 1
fi

if ! grep -q '^GROQ_API_KEY=' .env.local; then
  fail "GROQ_API_KEY is not set in .env.local"
  STEP1_ENV="fail"
  exit 1
fi

ok ".env.local exists"
ok "GROQ_API_KEY present"
GROQ_COUNT=1
for i in 2 3 4 5 6 7 8 9 10; do
  if grep -q "^GROQ_API_KEY_${i}=" .env.local; then
    GROQ_COUNT=$((GROQ_COUNT + 1))
  fi
done
ok "Groq pool size: ${GROQ_COUNT} key(s)"
if [ "$GROQ_COUNT" -ge 4 ]; then
  ok "Pool has dedicated core lanes + round-robin bank"
fi
if grep -q '^FIREWORKS_API_KEY=' .env.local && grep -q '^FIREWORKS_ACCOUNT_ID=' .env.local; then
  ok "Fireworks credentials present (--push will upload)"
else
  warn "Fireworks credentials missing — upload will be skipped (data still generated locally)"
fi
STEP1_ENV="ok"

# ─── Step 2: install ─────────────────────────────────────────────────────────

hr "Step 2 — dependencies"

if [ ! -d node_modules/groq-sdk ]; then
  info "node_modules/groq-sdk missing — running npm install"
  if npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -3; then
    ok "dependencies installed"
    STEP2_INSTALL="ok"
  else
    fail "npm install failed"
    STEP2_INSTALL="fail"
    exit 1
  fi
else
  ok "node_modules already in place"
  STEP2_INSTALL="ok"
fi

# ─── Step 3: connectivity check ──────────────────────────────────────────────

hr "Step 3 — verify Groq is reachable"

CONN_OUT=$(node --env-file=.env.local -e '
  import("groq-sdk").then(async ({default: G}) => {
    const r = await new G({apiKey: process.env.GROQ_API_KEY}).chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{role: "user", content: "say hi in one word"}],
      max_tokens: 5,
    });
    console.log("REPLY:" + r.choices[0].message.content.trim());
  }).catch(e => { console.error("ERR:" + (e?.message || e)); process.exit(1); });
' 2>&1)
CONN_STATUS=$?

if [ $CONN_STATUS -eq 0 ]; then
  REPLY_TEXT=$(echo "$CONN_OUT" | grep -oE 'REPLY:.+$' | head -1)
  ok "Groq reachable — ${REPLY_TEXT:-response received}"
  STEP3_CONNECTIVITY="ok"
else
  fail "Groq API call failed"
  echo "$CONN_OUT" | tail -5 | sed 's/^/    /'
  info "Common causes:"
  info "  • GROQ_API_KEY is invalid or revoked"
  info "  • Network not available in this container"
  info "  • Model name mismatch (Llama 4 Scout access required)"
  STEP3_CONNECTIVITY="fail"
  exit 1
fi

# ─── Step 4: bootstrap + push ────────────────────────────────────────────────

hr "Step 4 — bootstrap generation + Fireworks upload"

BOOTSTRAP_ARGS=()
FIREWORKS_CONFIGURED="no"
if grep -q '^FIREWORKS_API_KEY=' .env.local && grep -q '^FIREWORKS_ACCOUNT_ID=' .env.local; then
  BOOTSTRAP_ARGS+=("--push" "--finetune")
  FIREWORKS_CONFIGURED="yes"
  info "running with --push --finetune (upload to Fireworks + archive + launch SFT)"
else
  info "running without upload (Fireworks env vars not set)"
fi

if npm run bootstrap-training -- "${BOOTSTRAP_ARGS[@]}"; then
  STEP4_BOOTSTRAP="ok"
  ok "bootstrap completed"
else
  STEP4_BOOTSTRAP="partial"
  warn "bootstrap exited with non-zero — partial results may still be on disk"
fi

# Count examples if the output file exists.
if [ -f training-data/bootstrap-cot.jsonl ]; then
  EXAMPLES_COUNT=$(wc -l < training-data/bootstrap-cot.jsonl | tr -d ' ')
fi

# ─── Final summary ───────────────────────────────────────────────────────────

hr "Summary"

printf '  env:           %s\n' "$STEP1_ENV"
printf '  install:       %s\n' "$STEP2_INSTALL"
printf '  connectivity:  %s\n' "$STEP3_CONNECTIVITY"
printf '  bootstrap:     %s\n' "$STEP4_BOOTSTRAP"
printf '  examples:      %s\n' "$EXAMPLES_COUNT"

if [ "$STEP4_BOOTSTRAP" = "ok" ] && [ "$EXAMPLES_COUNT" != "?" ] && [ "$EXAMPLES_COUNT" -gt 0 ]; then
  printf '\n'
  ok "training data written to training-data/bootstrap-cot.jsonl"
  if [ "$FIREWORKS_CONFIGURED" = "yes" ]; then
    ok "upload + SFT launch attempted — check output above for ✓ Fireworks / ✓ SFT"
    printf '\n'
    info "Training runs for ~1-2 hours on Fireworks servers."
    info "The hourly /api/learn/watch cron will:"
    info "  • Poll the SFT job status"
    info "  • When COMPLETED, auto-deploy the LoRA adapter"
    info "  • Activate it as Gabriella's speaker model"
    info "  • Your chat will then run through the fine-tune (Groq as automatic fallback)"
    printf '\n'
    info "You can also poll manually at any time:"
    info "  https://<your-app>.vercel.app/api/learn/watch?key=<CRON_SECRET>"
  else
    printf '\n'
    info "Data generated but not uploaded. To upload + fine-tune, set FIREWORKS_API_KEY"
    info "and FIREWORKS_ACCOUNT_ID as Codespace secrets, rebuild the container,"
    info "and run this script again — or push manually with:"
    info "  npm run bootstrap-training -- --push --finetune"
  fi
else
  printf '\n'
  warn "Pipeline did not complete fully. Re-run to retry — nothing is destructive."
fi

printf '\n'
