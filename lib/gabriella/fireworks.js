// fireworks.js
// Minimal Fireworks AI client for Gabriella's learning + inference.
//
// Covers four capabilities:
//   1. Files       — upload training JSONL
//   2. Datasets    — wrap a file into a dataset that SFT jobs accept
//   3. SFT jobs    — create, poll, extract the resulting model id
//   4. Deployments — serverless LoRA; best-effort, idempotent
//   5. Inference   — OpenAI-compatible chat completions for the speaker
//
// Nothing here requires firectl. Everything is HTTPS + an API key.
// Endpoints follow the paths published at docs.fireworks.ai as of 2025.
// If the API shape evolves the error messages surface the raw HTTP
// body so you know what changed.

const CONTROL_API   = "https://api.fireworks.ai";
const INFERENCE_API = "https://api.fireworks.ai/inference/v1";

// ─── Small helpers ────────────────────────────────────────────────────────────

function acctUrl(accountId, path) {
  return `${CONTROL_API}/v1/accounts/${accountId}${path}`;
}

function jsonHeaders(apiKey) {
  return {
    Authorization:  `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function expect(res, label) {
  if (res.ok) {
    const text = await res.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
  }
  const body = await res.text().catch(() => "");
  throw new Error(`Fireworks ${label} failed (${res.status}): ${body.slice(0, 400)}`);
}

// ─── 1. Files ─────────────────────────────────────────────────────────────────

export async function uploadFile({ apiKey, accountId, jsonl, filename }) {
  if (!jsonl || jsonl.length === 0) throw new Error("uploadFile: empty body");

  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file",    new Blob([jsonl], { type: "application/jsonl" }), filename);

  const res = await fetch(acctUrl(accountId, "/files"), {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body:    form,
  });

  const data    = await expect(res, "file upload");
  const fileId  = data.name || data.id || data.file?.name || null;
  return { fileId, bytes: jsonl.length, raw: data };
}

// ─── 2. Datasets ──────────────────────────────────────────────────────────────
// Some Fireworks deploys let SFT consume files directly, most require a
// dataset wrapper. We create one. Idempotent-ish: if a dataset with the
// chosen id already exists the API returns 409 and we treat that as OK.

export async function createDataset({ apiKey, accountId, fileId, datasetId, displayName }) {
  const body = {
    datasetId,
    dataset: {
      displayName,
      format: "CHAT",
      source: { fileId },
    },
  };

  const res = await fetch(acctUrl(accountId, "/datasets"), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    JSON.stringify(body),
  });

  if (res.status === 409) {
    return { datasetId, reused: true };
  }

  const data = await expect(res, "dataset create");
  return { datasetId: data.name || datasetId, raw: data };
}

// ─── 3. Supervised Fine-Tuning ────────────────────────────────────────────────

export async function createSftJob({
  apiKey, accountId, datasetId,
  baseModel    = "accounts/fireworks/models/llama-v3p1-8b-instruct",
  epochs       = 3,
  learningRate = 0.0001,
  loraRank     = 16,
  displayName,
}) {
  const body = {
    displayName,
    baseModel,
    dataset:       datasetId.startsWith("accounts/")
                     ? datasetId
                     : `accounts/${accountId}/datasets/${datasetId}`,
    epochs,
    learningRate,
    loraRank,
  };

  const res = await fetch(acctUrl(accountId, "/supervisedFineTuningJobs"), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    JSON.stringify(body),
  });

  const data = await expect(res, "SFT create");
  // The API returns something like:
  //   { name: "accounts/andene/supervisedFineTuningJobs/abcd1234", state: "PENDING", ... }
  const jobId   = data.name ? data.name.split("/").pop() : null;
  const jobName = data.name || null;
  return { jobId, jobName, state: data.state || "PENDING", raw: data };
}

export async function getSftJob({ apiKey, accountId, jobId }) {
  const res = await fetch(acctUrl(accountId, `/supervisedFineTuningJobs/${jobId}`), {
    headers: jsonHeaders(apiKey),
  });
  const data    = await expect(res, "SFT get");
  // Successful fine-tunes expose the output model under `outputModel` or
  // `modelId` depending on API version. Try both.
  const modelId = data.outputModel || data.modelId || data.outputModelId || null;
  return {
    state:   data.state || data.status || "UNKNOWN",
    modelId,
    error:   data.error || data.errorMessage || null,
    raw:     data,
  };
}

// ─── 4. Serverless LoRA deployment ────────────────────────────────────────────
// For most Llama-family fine-tunes, a serverless deployment is free and
// auto-serves the adapter. This call is best-effort: if the model is
// already deployed (409) or auto-deployed at inference time, we proceed.

export async function ensureDeployed({ apiKey, accountId, modelId }) {
  const requestBody = {
    deployment: { model: modelId },
  };

  try {
    const res = await fetch(acctUrl(accountId, "/deployments"), {
      method:  "POST",
      headers: jsonHeaders(apiKey),
      body:    JSON.stringify(requestBody),
    });
    if (res.status === 409)  return { deployed: true, reused: true };
    if (res.ok)              return { deployed: true, raw: await res.json().catch(() => null) };

    // Some accounts get serverless LoRA auto-serving and reject explicit
    // deployment. That's fine — inference will still work.
    const errText = await res.text().catch(() => "");
    return { deployed: false, note: `deploy returned ${res.status}: ${errText.slice(0, 200)}` };
  } catch (err) {
    return { deployed: false, note: err.message };
  }
}

// ─── 5. Chat completions (OpenAI-compatible) ─────────────────────────────────

export async function chatCompletion({
  apiKey, model, messages,
  temperature = 0.9,
  top_p       = 0.95,
  max_tokens  = 400,
  frequency_penalty,
  presence_penalty,
  stream      = false,
  signal,
}) {
  const body = {
    model, messages, temperature, top_p, max_tokens, stream,
    ...(frequency_penalty !== undefined ? { frequency_penalty } : {}),
    ...(presence_penalty  !== undefined ? { presence_penalty  } : {}),
  };

  const res = await fetch(`${INFERENCE_API}/chat/completions`, {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    JSON.stringify(body),
    signal,
  });

  const data = await expect(res, "chat.completions");
  return data;
}

// ─── Configuration read from env ──────────────────────────────────────────────

export function fireworksConfig(env = process.env) {
  return {
    apiKey:    env.FIREWORKS_API_KEY    || null,
    accountId: env.FIREWORKS_ACCOUNT_ID || null,
    baseModel: env.FIREWORKS_BASE_MODEL || "accounts/fireworks/models/llama-v3p1-8b-instruct",
    autoFinetune:
      (env.AUTO_FINETUNE || "").toLowerCase() === "1" ||
      (env.AUTO_FINETUNE || "").toLowerCase() === "true" ||
      (env.AUTO_FINETUNE || "").toLowerCase() === "on",
    minExamples:       Number(env.AUTO_FINETUNE_MIN_EXAMPLES     || 50),
    minDaysBetween:    Number(env.AUTO_FINETUNE_MIN_DAYS_BETWEEN || 7),
  };
}

export function fireworksReady(cfg = fireworksConfig()) {
  return !!(cfg.apiKey && cfg.accountId);
}
