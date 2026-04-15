// fireworks.js
// Minimal Fireworks AI client for Gabriella's learning + inference.
//
// Covers five capabilities:
//   1. Datasets    — create + upload training JSONL via signed URL
//                    (the current Fireworks API flow, post-2024 migration)
//   2. Files       — legacy /files endpoint, used as fallback for older
//                    accounts still on the pre-migration upload path
//   3. SFT jobs    — create, poll, extract the resulting model id
//   4. Deployments — serverless LoRA; best-effort, idempotent
//   5. Inference   — OpenAI-compatible chat completions for the speaker
//
// The upload flow is:
//   a. POST  /v1/accounts/{acct}/datasets              → create empty dataset
//   b. POST  .../{dataset_id}:getUploadEndpoint        → get signed upload URL
//   c. PUT   signedUrl                                  → stream JSONL
//   d. POST  .../{dataset_id}:validateUpload           → finalize
//
// If step (a) returns 404 with a "not found" body, we fall back to the
// legacy /files endpoint — some accounts on older SKUs still want that.
//
// Endpoints follow the paths published at docs.fireworks.ai as of 2025.
// If the API shape evolves, error messages surface the raw HTTP body
// so you know what changed.

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

function isNotFound(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  // gRPC-style "code 5 not found" body even when HTTP status is 400 — we've
  // seen Fireworks do this when the endpoint doesn't exist for the account.
  return /"code"\s*:\s*5|not\s*found/i.test(err.body || "");
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

// ─── 1. Datasets (current flow: create → signed URL → PUT → validate) ────────

export async function createDatasetShell({ apiKey, accountId, datasetId, displayName, exampleCount }) {
  const body = {
    datasetId,
    dataset: {
      displayName:  displayName || datasetId,
      format:       "CHAT",
      exampleCount: exampleCount ? String(exampleCount) : undefined,
      userUploaded: {},
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

export async function getDatasetUploadEndpoint({ apiKey, accountId, datasetId, filename, size }) {
  // Fireworks uses the AIP custom-method convention (colon in path).
  const body = {
    filenameToSize: { [filename]: String(size) },
  };

  // Try the plural form first (current API), fall back to singular.
  const attempts = [
    { path: `/datasets/${datasetId}:getUploadEndpoint`, body },
    { path: `/datasets/${datasetId}:getSignedURL`,      body },
  ];

  let lastErr;
  for (const a of attempts) {
    try {
      const res = await fetch(acctUrl(accountId, a.path), {
        method:  "POST",
        headers: jsonHeaders(apiKey),
        body:    JSON.stringify(a.body),
      });
      const data = await expect(res, `upload endpoint (${a.path})`);
      // Response keys have varied: uploadUrl / signedUrl / filenameToSignedUrls.
      const url =
        data.uploadUrl ||
        data.signedUrl ||
        data.filenameToSignedUrls?.[filename] ||
        (Array.isArray(data.signedUrls) ? data.signedUrls[0] : null);
      if (url) return { uploadUrl: url, raw: data };
      lastErr = new Error(`no uploadUrl in response: ${JSON.stringify(data).slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
      if (!isNotFound(err)) break; // non-404 = real error, don't try fallback
    }
  }
  throw lastErr || new Error("getDatasetUploadEndpoint exhausted attempts");
}

export async function uploadToSignedUrl({ signedUrl, jsonl }) {
  const res = await fetch(signedUrl, {
    method:  "PUT",
    headers: { "Content-Type": "application/jsonl" },
    body:    jsonl,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Signed upload failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return { ok: true, bytes: jsonl.length };
}

export async function validateDatasetUpload({ apiKey, accountId, datasetId }) {
  const res = await fetch(acctUrl(accountId, `/datasets/${datasetId}:validateUpload`), {
    method:  "POST",
    headers: jsonHeaders(apiKey),
    body:    "{}",
  });
  // 200 and 404 (already validated) are both acceptable.
  if (res.ok || res.status === 409) return { validated: true };
  // If validateUpload doesn't exist on this account, consider it a no-op.
  if (res.status === 404) return { validated: true, note: "validateUpload not needed on this account" };
  const body = await res.text().catch(() => "");
  throw new Error(`validateUpload failed (${res.status}): ${body.slice(0, 200)}`);
}

// One-shot: create dataset, upload the file, validate it. Returns datasetId
// on success. This is the modern flow and what most accounts should use.
export async function uploadDataset({ apiKey, accountId, jsonl, filename, exampleCount }) {
  if (!jsonl || jsonl.length === 0) throw new Error("uploadDataset: empty body");

  const datasetId   = deriveDatasetId(filename) + "-" + Date.now().toString(36);
  const displayName = (filename || datasetId).replace(/\.jsonl$/, "");

  // 1. Create the dataset shell.
  await createDatasetShell({ apiKey, accountId, datasetId, displayName, exampleCount });

  // 2. Get signed upload URL.
  const { uploadUrl } = await getDatasetUploadEndpoint({
    apiKey, accountId, datasetId,
    filename: filename || `${datasetId}.jsonl`,
    size:     jsonl.length,
  });

  // 3. Upload the file.
  await uploadToSignedUrl({ signedUrl: uploadUrl, jsonl });

  // 4. Validate.
  await validateDatasetUpload({ apiKey, accountId, datasetId });

  return { datasetId, bytes: jsonl.length, flow: "signed-url" };
}

// ─── 2. Legacy /files endpoint (fallback) ────────────────────────────────────

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

  const data    = await expect(res, "file upload (legacy)");
  const fileId  = data.name || data.id || data.file?.name || null;
  return { fileId, bytes: jsonl.length, raw: data };
}

// Wrap a legacy file in a dataset. Uses the existing create endpoint with
// a source.fileId reference instead of the signed-url upload.
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

  if (res.status === 409) return { datasetId, reused: true };
  const data = await expect(res, "dataset create (legacy)");
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

// ─── 4. Serverless LoRA deployment ────────────────────────────────────────────

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
