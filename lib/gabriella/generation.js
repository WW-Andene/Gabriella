// generation.js
// Routing layer for synthetic-data generation (bootstrap, adversarial
// near-misses, Reddit finalization, etc). Keeps high-volume generation
// traffic OFF Groq when configured, so a single surviving key doesn't
// get banned from a bulk generation run.
//
// Priority:
//   1. Explicit env var GENERATION_BACKEND ("fireworks" | "groq" | "auto")
//   2. Auto: prefer Fireworks when credentials set; else Groq via pool
//   3. Fallback: if primary fails, try the other provider
//
// All generation call sites (bootstrap.js, ingest.js) should use
// generateChat() from this file instead of raw Groq calls. Chat route
// is UNCHANGED — real-time conversation still uses Groq primarily.

import { withKeyRotation } from "./groqPool.js";
import { chatCompletion, fireworksConfig, fireworksReady } from "./fireworks.js";
import { premiumModel } from "./models.js";

function chosenBackend() {
  const explicit = (process.env.GENERATION_BACKEND || "").toLowerCase().trim();
  if (explicit === "fireworks") return "fireworks";
  if (explicit === "groq")      return "groq";
  // Auto: prefer Fireworks when it's available (it tolerates volume better
  // and doesn't carry ban risk on the user's Groq account).
  if (fireworksReady()) return "fireworks";
  return "groq";
}

async function viaFireworks({ model, messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty }) {
  const cfg = fireworksConfig();
  // Caller-supplied models throughout this codebase are Groq-shaped
  // (e.g. "meta-llama/llama-4-..."). Fireworks only accepts its own
  // path-shaped ids ("accounts/<owner>/models/<id>"), so anything that
  // doesn't already look like a Fireworks path must be replaced with
  // the configured baseModel — otherwise every call 404s.
  const fwModel = (typeof model === "string" && model.startsWith("accounts/"))
    ? model
    : cfg.baseModel;
  const result = await chatCompletion({
    apiKey:            cfg.apiKey,
    model:             fwModel,
    messages,
    temperature,
    max_tokens,
    top_p,
    frequency_penalty,
    presence_penalty,
    stream:            false,
  });
  return result;
}

async function viaGroq({ model, messages, temperature, max_tokens, top_p, frequency_penalty, presence_penalty }) {
  return await withKeyRotation(client => client.chat.completions.create({
    model: model || premiumModel(),
    messages,
    temperature,
    max_tokens,
    top_p,
    frequency_penalty,
    presence_penalty,
  }));
}

// Unified chat-completion entry for GENERATION workflows. Returns the
// same `{ choices: [{ message: { content }}] }` shape either backend
// uses, so call-sites are identical.
export async function generateChat(params) {
  const primary = chosenBackend();
  try {
    if (primary === "fireworks") return await viaFireworks(params);
    return await viaGroq(params);
  } catch (err) {
    // If primary fails hard, try the other backend once as fallback.
    console.warn(`generateChat: ${primary} failed (${err?.message?.slice(0, 140) || err}); trying other backend`);
    try {
      if (primary === "fireworks") return await viaGroq(params);
      if (fireworksReady())        return await viaFireworks(params);
    } catch (fallbackErr) {
      err.fallbackError = fallbackErr.message;
    }
    throw err;
  }
}

export function currentGenerationBackend() {
  return chosenBackend();
}
