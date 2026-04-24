// groqPool.js
// Multi-provider LLM client pool.
//
// Originally Groq-only, this pool now spans Groq + Cerebras + Gemini via
// OpenAI-compatible adapters. Callers keep the same interface:
//
//   pickClient()              round-robin across all live clients
//   pickClient({ providers })  restrict to a provider subset (e.g. speaker)
//   clientForLane("alpha")    dedicated lane per named role
//   withKeyRotation(fn)       auto-retry across clients on transient errors
//
// The returned client is always OpenAI-shaped:
//
//   await client.chat.completions.create({ model, messages, ... })
//   → { choices: [{ message: { content } }], ... }
//
// For Groq it's the native SDK. For Cerebras and Gemini it's a light
// fetch adapter that exposes the same surface. Model names are
// translated per-provider so call-sites continue to use the canonical
// Groq model names (premiumModel(), fastModel()).
//
// Env:
//   GROQ_API_KEY, GROQ_API_KEY_2..10   — Groq keys (main workhorse)
//   CEREBRAS_API_KEY                   — Cerebras (fast Llama, separate pool)
//   GEMINI_API_KEY                     — Google Gemini (different family)
//
// Voice-sensitive callers (speaker.js) should pass
// `{ providers: ["groq", "cerebras"] }` so the Llama voice stays
// consistent. Everything else (cores, gauntlet, metacognition,
// consolidation jobs) can use the full pool.

import Groq from "groq-sdk";
import { recordCall } from "./callAudit.js";

// ─── Model name translation per provider ────────────────────────────────────
// Canonical names are Groq's. Adapters translate to their provider's
// equivalent model id. A null mapping means "this provider does not
// serve this model — skip it for this call" (the adapter throws with
// a specific error, withKeyRotation rotates to the next client).

const MODEL_MAP = {
  cerebras: {
    // Fast tier: works on every Cerebras account tier.
    "llama-3.1-8b-instant": "llama3.1-8b",
    // Premium tier: Cerebras's public free catalog does NOT serve
    // Maverick or 3.3-70b reliably — accounts vary in which Llama-large
    // models are reachable. Setting this to null signals "Cerebras
    // does not serve this model for this deployment" — translateModel
    // throws model_unavailable, withKeyRotation rotates to the next
    // client (usually Groq). The speaker stays on Llama-family via
    // Groq; Cerebras still participates for the fast tier.
    "meta-llama/llama-4-maverick-17b-128e-instruct": null,
  },
  gemini: {
    "llama-3.1-8b-instant":                          "gemini-2.5-flash",
    "meta-llama/llama-4-maverick-17b-128e-instruct": "gemini-2.5-flash",
  },
};

// Sentinel: if a provider explicitly doesn't serve a model, set the
// mapping to null and the adapter will throw a "model_unavailable"
// error that withKeyRotation treats as a rotate-to-next signal rather
// than a user-visible failure.
function translateModel(provider, model) {
  if (provider === "groq") return model;
  const map = MODEL_MAP[provider] || {};
  if (map[model] === null) {
    const err = new Error(`${provider} does not serve model ${model}`);
    err.code = "model_unavailable";
    err.status = 503;   // treated as transient by withKeyRotation → rotates
    throw err;
  }
  return map[model] || model;
}

// ─── OpenAI-compatible fetch adapter ────────────────────────────────────────
// Used for Cerebras and Gemini. Both expose /chat/completions endpoints
// that accept OpenAI-shaped requests and return OpenAI-shaped responses.

function openAICompatAdapter({ apiKey, baseUrl, provider, timeoutMs = 30_000 }) {
  return {
    provider,
    chat: {
      completions: {
        async create(params) {
          if (!apiKey) throw Object.assign(new Error(`${provider}: no API key`), { status: 401 });
          const body = {
            ...params,
            model: translateModel(provider, params.model),
          };
          // Gemini's OpenAI-compat ignores unknown fields but chokes on a
          // couple. Strip defensive-only knobs that aren't universally
          // supported. Gemini's shim accepts response_format on most
          // models but returns 400 on some — easiest to translate:
          // keep it for Fireworks/Groq/Cerebras, drop for Gemini (its
          // native structured output goes through a different param).
          if (provider === "gemini") {
            delete body.frequency_penalty;
            delete body.presence_penalty;
            delete body.response_format;
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const res = await fetch(`${baseUrl}/chat/completions`, {
              method:  "POST",
              headers: {
                "Content-Type":  "application/json",
                "Authorization": `Bearer ${apiKey}`,
              },
              body:    JSON.stringify(body),
              signal:  controller.signal,
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              const err = new Error(`${provider} ${res.status}: ${text.slice(0, 300)}`);
              // If the provider returns 404 model_not_found, the model
              // name we sent doesn't exist on this provider. Treat as
              // transient so withKeyRotation moves on instead of
              // bubbling the user-facing error. Same for 400s that
              // mention the model not being available.
              const isModelMismatch =
                (res.status === 404 && /model/i.test(text) && /(not[_ ]?found|does not exist|no access)/i.test(text)) ||
                (res.status === 400 && /model/i.test(text) && /unsupported|unknown|invalid/i.test(text));
              err.status   = isModelMismatch ? 503 : res.status;
              err.code     = isModelMismatch ? "model_unavailable" : undefined;
              err.provider = provider;
              throw err;
            }
            const parsed = await res.json();
            // Fire-and-forget audit record — we have usage info from the
            // OpenAI-compat response when the provider reports it.
            recordCall({
              provider,
              model:  body.model,
              usage:  parsed.usage || null,
              promptChars:     JSON.stringify(params.messages || []).length,
              completionChars: parsed.choices?.[0]?.message?.content?.length || 0,
            }).catch(() => null);
            return parsed;
          } finally {
            clearTimeout(timer);
          }
        },
      },
    },
  };
}

// ─── Build the pool ─────────────────────────────────────────────────────────

function parseGroqKeys(env) {
  const keys = [];
  if (env.GROQ_API_KEY) keys.push(env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) {
    const k = env[`GROQ_API_KEY_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

function buildClients(env = process.env) {
  const clients = [];

  // Groq keys — these are the workhorse, indexed first so lane assignment
  // (alpha=0, beta=1, gamma=2) lands on dedicated Groq keys when available.
  // Each client is wrapped so every chat.completions.create call is
  // audited into the shared ledger — same as the OpenAI-compat adapter.
  const groqKeys = parseGroqKeys(env);
  for (const key of groqKeys) {
    const c = new Groq({ apiKey: key });
    c.provider = "groq";
    const origCreate = c.chat.completions.create.bind(c.chat.completions);
    c.chat.completions.create = async (params) => {
      const result = await origCreate(params);
      recordCall({
        provider: "groq",
        model:    params?.model,
        usage:    result?.usage || null,
        promptChars:     JSON.stringify(params?.messages || []).length,
        completionChars: result?.choices?.[0]?.message?.content?.length || 0,
      }).catch(() => null);
      return result;
    };
    clients.push(c);
  }

  // Cerebras — one key, massive rate pool, same model family as Groq.
  if (env.CEREBRAS_API_KEY) {
    clients.push(openAICompatAdapter({
      apiKey:   env.CEREBRAS_API_KEY,
      baseUrl:  env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1",
      provider: "cerebras",
    }));
  }

  // Gemini — different family. Use for consolidation / gauntlet /
  // metacognition but not for the speaker.
  if (env.GEMINI_API_KEY) {
    clients.push(openAICompatAdapter({
      apiKey:   env.GEMINI_API_KEY,
      baseUrl:  env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai",
      provider: "gemini",
    }));
  }

  return clients;
}

const CLIENTS = buildClients();

if (CLIENTS.length === 0) {
  console.warn("groqPool: no provider keys configured (GROQ_API_KEY / CEREBRAS_API_KEY / GEMINI_API_KEY)");
}

// ─── Dead-client tracking ────────────────────────────────────────────────────

const deadKeys = new Set();

function aliveIndices() {
  const alive = [];
  for (let i = 0; i < CLIENTS.length; i++) {
    if (!deadKeys.has(i)) alive.push(i);
  }
  return alive;
}

function markDead(client, reason) {
  const idx = CLIENTS.indexOf(client);
  if (idx === -1) return;
  if (deadKeys.has(idx)) return;
  deadKeys.add(idx);
  const label = labelFor(idx);
  console.error(`groqPool: client ${label} marked dead — ${reason}`);
}

function labelFor(idx) {
  const c = CLIENTS[idx];
  const provider = c?.provider || "unknown";
  // Count which-of-this-provider it is (1-indexed).
  let nth = 0;
  for (let i = 0; i <= idx; i++) {
    if (CLIENTS[i]?.provider === provider) nth++;
  }
  return `${provider}#${nth}`;
}

function maybeMarkDead(client, err) {
  const status = err?.status ?? err?.response?.status ?? err?.error?.status;
  const body   = err?.error?.error?.message || err?.message || "";
  if (status === 401) { markDead(client, "401 unauthorized — revoked or invalid"); return true; }
  if (status === 403) { markDead(client, "403 forbidden — account policy"); return true; }
  if (/organization.{0,20}restricted/i.test(body)) { markDead(client, "org restricted"); return true; }
  if (/invalid[_ ]api[_ ]key/i.test(body))          { markDead(client, "invalid api key"); return true; }
  if (/key[^a-z]{0,5}(revoked|disabled)/i.test(body)){ markDead(client, "key revoked/disabled"); return true; }
  return false;
}

// ─── Lane-dedicated clients ─────────────────────────────────────────────────
// The triple-core benefits from each lane having its own client. With
// multiple providers in the pool, this ALSO creates genuine interpretation
// divergence — Alpha on Groq Llama, Beta on Cerebras Llama, Gamma on
// Gemini (different model family) will read the same moment differently
// in ways that single-family cores can't.

const LANE_INDEX = {
  alpha: 0,
  beta:  1,
  gamma: 2,
};

const RESERVED_LANE_KEYS = Object.keys(LANE_INDEX).length;

// ─── Pool guards ────────────────────────────────────────────────────────────

function mustPool() {
  if (CLIENTS.length === 0) {
    throw new Error("No provider keys configured — set GROQ_API_KEY, CEREBRAS_API_KEY, or GEMINI_API_KEY.");
  }
  if (deadKeys.size >= CLIENTS.length) {
    const providers = [...new Set(CLIENTS.map(c => c.provider))].join(", ");
    throw new Error(
      `All ${CLIENTS.length} client(s) are dead across providers: ${providers}. ` +
      `Check account status on each provider or rotate keys.`,
    );
  }
}

// ─── Client selection ───────────────────────────────────────────────────────

let cursor = 0;

// pickClient() defaults to GROQ-ONLY.
//
// Most callers in the codebase are "direct":
//    const c = pickClient();
//    await c.chat.completions.create({ model: premiumModel(), ... });
// They don't wrap in withKeyRotation, so they get ONE shot. If that
// shot lands on a provider that doesn't serve the requested model
// (e.g., Cerebras without Maverick access), the error propagates.
//
// To preserve the pre-multi-provider contract for all 20+ direct
// callers WITHOUT touching each file, pickClient now restricts its
// default rotation to Groq. Cerebras and Gemini remain in the pool
// but are only reachable via:
//
//   withKeyRotation(fn)                              — all providers, rotates on error
//   withKeyRotation(fn, { providers: [...] })        — explicit filter
//   pickClient({ providers: ["cerebras", "gemini"] }) — explicit opt-in
//   pickClient({ allowAny: true })                    — full rotation
//
// This way the speaker continues to benefit from Cerebras as a
// Llama-family fallback (it calls withKeyRotation with explicit
// providers), and the gauntlet / metacognition / cores keep working
// against Groq as before.
export function pickClient(options = {}) {
  mustPool();
  const alive = aliveIndices();

  // Any explicit filter option (providers, allowAny, excludeProviders)
  // opts the caller into cross-provider rotation. No options at all
  // means "I'm a legacy direct caller" → Groq-only default.
  const hasExplicitFilter = !!(options.providers || options.allowAny || options.excludeProviders);

  let filtered;
  if (options.providers) {
    filtered = alive.filter(i => options.providers.includes(CLIENTS[i].provider));
  } else if (hasExplicitFilter) {
    filtered = options.excludeProviders
      ? alive.filter(i => !options.excludeProviders.includes(CLIENTS[i].provider))
      : alive;
  } else {
    // Default — Groq only. Preserves the original single-provider
    // contract for all the direct-call sites that don't wrap in
    // withKeyRotation and therefore can't recover from a provider
    // that doesn't serve the requested model.
    filtered = alive.filter(i => CLIENTS[i].provider === "groq");
    // If Groq is fully dead, fall through to anything live. Availability
    // beats preference in an emergency.
    if (filtered.length === 0) filtered = alive;
  }

  const pool = filtered.length > 0 ? filtered : alive;
  if (pool.length === 1) return CLIENTS[pool[0]];

  // Prefer bank keys (beyond the reserved-lane heads) for general traffic
  // so the core lanes keep their dedicated capacity.
  const bank = pool.filter(i => i >= RESERVED_LANE_KEYS);
  const pickFrom = bank.length > 0 ? bank : pool;
  const idx = pickFrom[cursor % pickFrom.length];
  cursor = (cursor + 1) % (pickFrom.length * 10_000);
  return CLIENTS[idx];
}

export function clientForLane(lane) {
  mustPool();
  const laneIdx = LANE_INDEX[lane];
  if (laneIdx !== undefined && laneIdx < CLIENTS.length && !deadKeys.has(laneIdx)) {
    return CLIENTS[laneIdx];
  }
  return pickClient();
}

// ─── Retry wrapper ──────────────────────────────────────────────────────────

export async function withKeyRotation(fn, options = {}) {
  mustPool();
  const { maxAttempts, providers, excludeProviders } = options;
  const attempts = Math.max(1, Math.min(maxAttempts ?? CLIENTS.length + 1, CLIENTS.length * 2));
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    let client;
    try {
      client = pickClient({ providers, excludeProviders });
      return await fn(client);
    } catch (err) {
      lastErr = err;
      const killed = client ? maybeMarkDead(client, err) : false;
      if (killed) continue;
      const status = err?.status ?? err?.response?.status ?? err?.error?.status;
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!transient) throw err;
    }
  }
  throw lastErr;
}

export { maybeMarkDead as reportClientFailure };

// ─── Introspection ──────────────────────────────────────────────────────────

export function poolSize() {
  return CLIENTS.length;
}

export function poolStats() {
  const byProvider = {};
  for (let i = 0; i < CLIENTS.length; i++) {
    const p = CLIENTS[i].provider;
    if (!byProvider[p]) byProvider[p] = { total: 0, alive: 0 };
    byProvider[p].total++;
    if (!deadKeys.has(i)) byProvider[p].alive++;
  }
  return {
    keyCount:      CLIENTS.length,
    aliveCount:    CLIENTS.length - deadKeys.size,
    deadKeys:      Array.from(deadKeys).map(labelFor),
    byProvider,
    cursor,
    lanes:         Object.fromEntries(
      Object.entries(LANE_INDEX).map(([name, idx]) => [
        name,
        idx < CLIENTS.length ? labelFor(idx) : `overflow→${labelFor(idx % CLIENTS.length)}`,
      ]),
    ),
    strategy:      CLIENTS.length >= RESERVED_LANE_KEYS + 1
      ? `${RESERVED_LANE_KEYS} dedicated lanes + ${CLIENTS.length - RESERVED_LANE_KEYS}-client bank`
      : "full round-robin (pool too small for lane reservation)",
  };
}

// ─── Test-only: rebuild clients from an injected env ────────────────────────
// Used by audit tests to exercise multi-provider behavior without real keys.
export function _test_rebuild(env) {
  CLIENTS.splice(0, CLIENTS.length, ...buildClients(env));
  deadKeys.clear();
  cursor = 0;
}
