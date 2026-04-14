#!/usr/bin/env bash
# setup-env.sh
#
# Auto-generate .env.local inside a Codespace (or any container where
# the required env vars have been injected — devcontainer.json pipes
# Codespace user secrets into remoteEnv).
#
# Safe to re-run: if .env.local already has content, this script does
# nothing rather than overwriting.
#
# Idempotent, no-ops outside Codespace if env vars aren't set.

set -euo pipefail

ENV_FILE=".env.local"

if [ -s "$ENV_FILE" ]; then
  echo "setup-env: $ENV_FILE already exists and is non-empty — leaving it alone."
  exit 0
fi

echo "# Generated from environment at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ENV_FILE"

# Required — app won't run without these.
REQUIRED_VARS=(
  GROQ_API_KEY
  UPSTASH_REDIS_REST_URL
  UPSTASH_REDIS_REST_TOKEN
  UPSTASH_VECTOR_REST_URL
  UPSTASH_VECTOR_REST_TOKEN
  CRON_SECRET
)

# Optional — pool, Fireworks, tuning overrides.
OPTIONAL_VARS=(
  GROQ_API_KEY_2
  GROQ_API_KEY_3
  GROQ_API_KEY_4
  GROQ_API_KEY_5
  GROQ_API_KEY_6
  GROQ_API_KEY_7
  GROQ_API_KEY_8
  GROQ_API_KEY_9
  GROQ_API_KEY_10
  FIREWORKS_API_KEY
  FIREWORKS_ACCOUNT_ID
  FIREWORKS_BASE_MODEL
  AUTO_FINETUNE
  AUTO_FINETUNE_MIN_EXAMPLES
  AUTO_FINETUNE_MIN_DAYS_BETWEEN
  TOGETHER_API_KEY
  LEARNING_WEBHOOK_URL
  GABRIELLA_PREMIUM_MODEL
  GABRIELLA_FAST_MODEL
)

missing=()
written=0

for var in "${REQUIRED_VARS[@]}"; do
  if [ -n "${!var:-}" ]; then
    printf "%s=%s\n" "$var" "${!var}" >> "$ENV_FILE"
    written=$((written + 1))
  else
    missing+=("$var")
  fi
done

for var in "${OPTIONAL_VARS[@]}"; do
  if [ -n "${!var:-}" ]; then
    printf "%s=%s\n" "$var" "${!var}" >> "$ENV_FILE"
    written=$((written + 1))
  fi
done

echo "setup-env: wrote $written variable(s) to $ENV_FILE."
if [ ${#missing[@]} -gt 0 ]; then
  echo "setup-env: missing required variables — the app won't fully run:"
  for v in "${missing[@]}"; do echo "  - $v"; done
  echo ""
  echo "Add them as Codespace secrets at:"
  echo "  https://github.com/settings/codespaces"
  echo "then rebuild this Codespace (Cmd/Ctrl+Shift+P → 'Rebuild Container')."
fi
