#!/usr/bin/env bash
# setup-env.sh
#
# Auto-generate .env.local inside a Codespace (or any container where
# the required env vars have been injected — devcontainer.json pipes
# Codespace user secrets into remoteEnv).
#
# Behavior: MERGES env -> .env.local. Any variable that exists in the
# environment AND isn't already in .env.local gets appended. Existing
# lines are never overwritten (so if you hand-edit .env.local you keep
# those values). Pass --force to rebuild from scratch.
#
# Idempotent, no-ops outside Codespace if env vars aren't set.

set -euo pipefail

ENV_FILE=".env.local"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
  esac
done

if [ "$FORCE" = "1" ]; then
  echo "setup-env: --force specified, rewriting $ENV_FILE from scratch."
  rm -f "$ENV_FILE"
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "# Generated from environment at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$ENV_FILE"
fi

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
skipped=0

# Append the variable to .env.local ONLY if it isn't already defined
# there (case-sensitive key match at line start). Preserves hand-edits.
maybe_append() {
  local var="$1"
  if grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
    skipped=$((skipped + 1))
    return 0
  fi
  if [ -n "${!var:-}" ]; then
    printf "%s=%s\n" "$var" "${!var}" >> "$ENV_FILE"
    written=$((written + 1))
    return 0
  fi
  return 1
}

for var in "${REQUIRED_VARS[@]}"; do
  if ! maybe_append "$var"; then
    # Only flag missing if it wasn't already present in the file.
    if ! grep -q "^${var}=" "$ENV_FILE" 2>/dev/null; then
      missing+=("$var")
    fi
  fi
done

for var in "${OPTIONAL_VARS[@]}"; do
  maybe_append "$var" || true
done

echo "setup-env: wrote $written new variable(s), kept $skipped existing, in $ENV_FILE."
if [ ${#missing[@]} -gt 0 ]; then
  echo "setup-env: missing required variables — the app won't fully run:"
  for v in "${missing[@]}"; do echo "  - $v"; done
  echo ""
  echo "Add them as Codespace secrets at:"
  echo "  https://github.com/settings/codespaces"
  echo "then rebuild this Codespace (Cmd/Ctrl+Shift+P → 'Rebuild Container')."
fi
