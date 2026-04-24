// finetuneConfig.js
// Runtime-tunable fine-tune hyperparameters.
//
// Priority (highest wins):
//   1. CLI flag or query-string param (per-invocation override)
//   2. Upstash override (persistent, edited via /api/fireworks/config)
//   3. Environment variable (FINETUNE_*)
//   4. Hardcoded default
//
// The Upstash layer is what lets you change params from a phone browser
// without redeploying Vercel or touching Codespace secrets.

const KEY = "gabriella:finetuneConfig";

const FIELD_SPECS = {
  baseModel:    { type: "string", default: "accounts/fireworks/models/llama-v3p1-8b-instruct" },
  epochs:       { type: "int",    default: 3,      min: 1,    max: 20 },
  loraRank:     { type: "int",    default: 16,     min: 1,    max: 128 },
  learningRate: { type: "float",  default: 0.0001, min: 1e-6, max: 1e-2 },
  batchSize:    { type: "int",    default: null,   min: 1,    max: 64,  nullable: true },
  displayNamePrefix: { type: "string", default: "gabriella" },
};

function coerce(value, spec) {
  if (value == null || value === "") return spec.default;
  if (spec.type === "int") {
    const n = Number.parseInt(String(value), 10);
    if (!Number.isFinite(n)) return spec.default;
    if (spec.min != null && n < spec.min) return spec.min;
    if (spec.max != null && n > spec.max) return spec.max;
    return n;
  }
  if (spec.type === "float") {
    const n = Number.parseFloat(String(value));
    if (!Number.isFinite(n)) return spec.default;
    if (spec.min != null && n < spec.min) return spec.min;
    if (spec.max != null && n > spec.max) return spec.max;
    return n;
  }
  return String(value);
}

// Read current effective config: defaults ← env ← upstash overrides.
// Returns { config, sources } so the API can show where each value came from.
export async function loadFinetuneConfig(redis, env = process.env) {
  // Layer 2: env.
  const envLayer = {
    baseModel:         env.FIREWORKS_BASE_MODEL || env.FINETUNE_BASE_MODEL || null,
    epochs:            env.FINETUNE_EPOCHS        ?? null,
    loraRank:          env.FINETUNE_LORA_RANK     ?? null,
    learningRate:      env.FINETUNE_LEARNING_RATE ?? null,
    batchSize:         env.FINETUNE_BATCH_SIZE    ?? null,
    displayNamePrefix: env.FINETUNE_DISPLAY_PREFIX ?? null,
  };

  // Layer 3: upstash overrides.
  let upstashLayer = {};
  try {
    const raw = await redis.get(KEY);
    if (raw) upstashLayer = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {}

  const config = {};
  const sources = {};

  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    if (upstashLayer[field] != null && upstashLayer[field] !== "") {
      config[field]  = coerce(upstashLayer[field], spec);
      sources[field] = "upstash";
    } else if (envLayer[field] != null && envLayer[field] !== "") {
      config[field]  = coerce(envLayer[field], spec);
      sources[field] = "env";
    } else {
      config[field]  = spec.default;
      sources[field] = "default";
    }
  }

  return { config, sources };
}

// Update overrides. Pass { epochs: 5, loraRank: 32 } etc. Missing / null
// fields clear their override (fall back to env/default next read).
export async function updateFinetuneConfig(redis, patch = {}) {
  const current = (await redis.get(KEY).catch(() => null));
  const existing = current ? (typeof current === "string" ? JSON.parse(current) : current) : {};

  const next = { ...existing };
  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    if (!(field in patch)) continue;
    const val = patch[field];
    if (val === null || val === "" || val === "null" || val === "default") {
      delete next[field];     // clear override
    } else {
      next[field] = coerce(val, spec);
    }
  }

  await redis.set(KEY, JSON.stringify(next));
  return next;
}

// Expose schema for the /api/fireworks/config endpoint.
export function getFinetuneConfigSchema() {
  return FIELD_SPECS;
}

// Apply CLI/query-param overrides on top of a loaded config, keeping the
// type coercion and bounds. Returns { config: merged, sources: {...with "override" where applicable} }.
export function applyOverrides({ config, sources }, overrides = {}) {
  const merged = { ...config };
  const mergedSources = { ...sources };
  for (const [field, spec] of Object.entries(FIELD_SPECS)) {
    if (field in overrides && overrides[field] != null && overrides[field] !== "") {
      merged[field] = coerce(overrides[field], spec);
      mergedSources[field] = "override";
    }
  }
  return { config: merged, sources: mergedSources };
}
