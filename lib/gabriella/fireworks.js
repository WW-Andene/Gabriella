// fireworks.js
// Fireworks AI client for Gabriella's learning + inference.
//
// Endpoints verified against docs.fireworks.ai/api-reference in April 2026.
// If the API changes, error messages surface the exact URL and body that
// failed so the miscompare is immediately obvious.
//
// ─── Dataset upload flow ──────────────────────────────────────────────────────
//
// For files ≤ 150MB (which covers us — our bundles are ~250KB):
//
//   1. POST /v1/accounts/{acct}/datasets           create dataset shell
//   2. POST .../{dataset_id}:upload                multipart form, field=file
//   3. POST .../{dataset_id}:validateUpload        finalize
//
// For files > 150MB (not our case today, but supported as fallback):
//
//   1. POST .../datasets                           create shell
//   2. POST .../{dataset_id}:getUploadEndpoint     get signed URL
//   3. PUT  signedUrl                              Content-Type: application/octet-stream
//   4. POST .../{dataset_id}:validateUpload        finalize
//
// ─── Fine-tuning ──────────────────────────────────────────────────────────────
//
//   POST /v1/accounts/{acct}/supervisedFineTuningJobs
//     Required: dataset  (full resource path: accounts/{acct}/datasets/{id})
//     Recommended: baseModel, displayName, epochs, learningRate, loraRank
//
// ─── Account ID ───────────────────────────────────────────────────────────────
//
// The account_id path segment is the slug visible on your Fireworks
// profile — the same slug that appears in URLs when you're logged in.
// NOT your API key, NOT an email, NOT a UUID on most accounts.

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
  const url  = res.url || "(unknown url)";
  const err  = new Error(
    `Fireworks ${label} failed (${res.status}) at ${url}\n  body: ${body.slice(0, 600)}`,
  );
  err.status = res.status;
  err.body   = body;
  err.url    = url;
  throw err;
}

// Derive a dataset id from a filename: strip extension, kebab-case, trim.
function deriveDatasetId(filename) {
  const base = String(filename || `dataset-${Date.now()}`)
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base || `dataset-${Date.now()}`;
}

// ─── 1. Create dataset shell ──────────────────────────────────────────────────

export async function createDatasetShell({ apiKey, accountId, datasetId, displayName, exampleCount, format = "CHAT" }) {
  const body = {
    datasetId,
    dataset: {
      displayName:  displayName || datasetId,
      // exampleCount is a number (integer) per the API schema — not a string.
      ...(Number.isFinite(exampleCount) ? { exampleCount } : {}),
      format,
    },
  };

  const res = await fetch(acctUrl(accountId, "/datasets"), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    JSON.stringify(body),
  });

  if (res.status === 409) return { datasetId, reused: true };
  return await expect(res, "dataset create");
}

// ─── 2a. Direct multipart upload (files ≤ 150MB) ─────────────────────────────

export async function uploadDatasetMultipart({ apiKey, accountId, datasetId, jsonl, filename }) {
  const form = new FormData();
  form.append("file", new Blob([jsonl], { type: "application/octet-stream" }), filename);

  const res = await fetch(acctUrl(accountId, `/datasets/${datasetId}:upload`), {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body:    form,
  });

  return await expect(res, `dataset upload (${datasetId}:upload)`);
}

// ─── 2b. Signed-URL upload (files > 150MB, optional fallback) ────────────────

export async function getDatasetUploadEndpoint({ apiKey, accountId, datasetId, filename, size }) {
  const body = {
    // API schema: filenameToSize is { [filename]: <string, bytes> }.
    filenameToSize: { [filename]: String(size) },
  };

  const res = await fetch(acctUrl(accountId, `/datasets/${datasetId}:getUploadEndpoint`), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    JSON.stringify(body),
  });

  const data = await expect(res, "getUploadEndpoint");
  // Response schema: { filenameToSignedUrls: { [filename]: <url> } }
  const signedUrl = data.filenameToSignedUrls?.[filename]
    || data.filenameToSignedUrls?.[Object.keys(data.filenameToSignedUrls || {})[0]]
    || null;
  if (!signedUrl) {
    throw new Error(`getUploadEndpoint returned no signed URL. Response: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { signedUrl, raw: data };
}

export async function uploadToSignedUrl({ signedUrl, jsonl }) {
  const res = await fetch(signedUrl, {
    method:  "PUT",
    // The signed URL points at cloud storage (GCS / S3). Standard file
    // upload content type.
    headers: { "Content-Type": "application/octet-stream" },
    body:    jsonl,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Signed upload failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return { ok: true, bytes: jsonl.length };
}

// ─── 3. Validate upload ──────────────────────────────────────────────────────
// IMPORTANT: Fireworks' :upload endpoint auto-validates on success — it
// transitions the dataset state from UPLOADING to READY as part of
// writing the file. A subsequent :validateUpload call on an already-
// uploaded dataset returns gRPC code 9 ("dataset is already uploaded"),
// which is SUCCESS from our perspective: the dataset is live and usable
// for fine-tuning.
//
// This was verified empirically against Fireworks' production API on
// 2026-04-15: the upload step returned {purpose: "dataset", bytes: ...}
// and the dataset appeared in the account immediately. The validate
// call afterward was the redundant step that erred.

export async function validateDatasetUpload({ apiKey, accountId, datasetId }) {
  const res = await fetch(acctUrl(accountId, `/datasets/${datasetId}:validateUpload`), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    "{}",
  });

  if (res.ok || res.status === 409) return { validated: true };

  const body = await res.text().catch(() => "");

  // Code 9 / "already uploaded" means the :upload endpoint auto-validated.
  // Treat as success. This is the documented idempotent path on Fireworks.
  const isAlreadyDone =
    /"code"\s*:\s*9/.test(body) ||
    /already\s*(uploaded|validated|exists|ready)/i.test(body);

  if (isAlreadyDone) {
    return { validated: true, note: "dataset was auto-validated by :upload" };
  }

  throw new Error(`validateUpload failed (${res.status}): ${body.slice(0, 400)}`);
}

// ─── One-shot upload ─────────────────────────────────────────────────────────
// Create → upload → validate. Uses :upload (multipart) for files under the
// 150MB limit, falls back to signed-URL PUT only for larger files.

const MULTIPART_LIMIT_BYTES = 150 * 1024 * 1024;

export async function uploadDataset({ apiKey, accountId, jsonl, filename, exampleCount }) {
  if (!jsonl || jsonl.length === 0) throw new Error("uploadDataset: empty body");

  const datasetId   = deriveDatasetId(filename) + "-" + Date.now().toString(36);
  const displayName = (filename || datasetId).replace(/\.jsonl$/, "");
  const trace = [];

  const step = async (label, fn) => {
    try {
      const out = await fn();
      trace.push({ step: label, ok: true, out });
      return out;
    } catch (err) {
      trace.push({ step: label, ok: false, error: err.message || String(err), body: err.body?.slice?.(0, 500) });
      const combined = new Error(
        `Fireworks upload failed at step "${label}": ${err.message}\n\n` +
        `Full trace:\n${JSON.stringify(trace, null, 2)}`,
      );
      combined.trace  = trace;
      combined.step   = label;
      combined.status = err.status;
      combined.body   = err.body;
      throw combined;
    }
  };

  // 1. Create the dataset shell.
  await step("createDatasetShell", () =>
    createDatasetShell({ apiKey, accountId, datasetId, displayName, exampleCount }),
  );

  // 2. Upload — multipart when small, signed URL when large.
  let flow;
  if (jsonl.length <= MULTIPART_LIMIT_BYTES) {
    await step("uploadDatasetMultipart", () =>
      uploadDatasetMultipart({
        apiKey, accountId, datasetId, jsonl,
        filename: filename || `${datasetId}.jsonl`,
      }),
    );
    flow = "multipart";
  } else {
    const { signedUrl } = await step("getDatasetUploadEndpoint", () =>
      getDatasetUploadEndpoint({
        apiKey, accountId, datasetId,
        filename: filename || `${datasetId}.jsonl`,
        size:     jsonl.length,
      }),
    );
    await step("uploadToSignedUrl", () => uploadToSignedUrl({ signedUrl, jsonl }));
    flow = "signed-url";
  }

  // 3. Validate — required to move the dataset to READY state.
  await step("validateDatasetUpload", () =>
    validateDatasetUpload({ apiKey, accountId, datasetId }),
  );

  return { datasetId, bytes: jsonl.length, flow, trace };
}

// ─── Fine-tuning ──────────────────────────────────────────────────────────────

export async function createSftJob({
  apiKey, accountId, datasetId,
  baseModel    = "accounts/fireworks/models/llama-v3p1-8b-instruct",
  epochs       = 3,
  learningRate = 0.0001,
  loraRank     = 16,
  batchSize    = null,
  displayName,
}) {
  // Dataset must be a full resource path per the schema.
  const dataset = datasetId.startsWith("accounts/")
    ? datasetId
    : `accounts/${accountId}/datasets/${datasetId}`;

  const body = {
    dataset,
    baseModel,
    ...(displayName  ? { displayName  } : {}),
    ...(epochs       ? { epochs       } : {}),
    ...(learningRate ? { learningRate } : {}),
    ...(loraRank     ? { loraRank     } : {}),
    ...(batchSize    ? { batchSize    } : {}),
  };

  const res = await fetch(acctUrl(accountId, "/supervisedFineTuningJobs"), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    JSON.stringify(body),
  });

  const data = await expect(res, "SFT create");
  const jobId   = data.name ? data.name.split("/").pop() : null;
  const jobName = data.name || null;
  return { jobId, jobName, state: data.state || "PENDING", raw: data };
}

export async function getSftJob({ apiKey, accountId, jobId }) {
  const res = await fetch(acctUrl(accountId, `/supervisedFineTuningJobs/${jobId}`), {
    headers: jsonHeaders(apiKey),
  });
  const data    = await expect(res, "SFT get");
  const modelId = data.outputModel || data.modelId || data.outputModelId || null;
  return {
    state:   data.state || data.status || "UNKNOWN",
    modelId,
    error:   data.error || data.errorMessage || null,
    raw:     data,
  };
}

// ─── Deployment ──────────────────────────────────────────────────────────────

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

    const errText = await res.text().catch(() => "");
    return { deployed: false, note: `deploy returned ${res.status}: ${errText.slice(0, 200)}` };
  } catch (err) {
    return { deployed: false, note: err.message };
  }
}

// ─── Inference (OpenAI-compatible) ───────────────────────────────────────────

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
    baseModel: env.FIREWORKS_BASE_MODEL || env.FINETUNE_BASE_MODEL
               || "accounts/fireworks/models/llama-v3p1-8b-instruct",
    autoFinetune:
      (env.AUTO_FINETUNE || "").toLowerCase() === "1" ||
      (env.AUTO_FINETUNE || "").toLowerCase() === "true" ||
      (env.AUTO_FINETUNE || "").toLowerCase() === "on",
    minExamples:       Number(env.AUTO_FINETUNE_MIN_EXAMPLES     || 50),
    minDaysBetween:    Number(env.AUTO_FINETUNE_MIN_DAYS_BETWEEN || 7),
    // Per-job hyperparameters. All overridable at runtime via CLI flag
    // or query param, but these env values become the defaults.
    epochs:            Number(env.FINETUNE_EPOCHS        || 3),
    loraRank:          Number(env.FINETUNE_LORA_RANK     || 16),
    learningRate:      Number(env.FINETUNE_LEARNING_RATE || 0.0001),
    batchSize:         env.FINETUNE_BATCH_SIZE ? Number(env.FINETUNE_BATCH_SIZE) : null,
  };
}

export function fireworksReady(cfg = fireworksConfig()) {
  return !!(cfg.apiKey && cfg.accountId);
}

// ─── Back-compat shims ────────────────────────────────────────────────────────
// Older call-sites imported these names. The current implementations have
// different signatures, so callers must migrate to uploadDataset /
// createDatasetShell. Keeping the names exported but pointing at safe
// wrappers that throw an explicit error rather than silently calling
// the wrong function.

export function uploadFile() {
  throw new Error(
    "uploadFile is deprecated. Use uploadDataset() instead — it handles " +
    "the whole create → upload → validate flow and returns { datasetId }.",
  );
}

export function createDataset() {
  throw new Error(
    "createDataset (legacy shape) is deprecated. Use createDatasetShell() " +
    "with the current API schema, or uploadDataset() for the full flow.",
  );
}
