// learning.js
// The closing of the loop.
//
// Every exchange that passes the gauntlet lives in Redis as a labeled
// training example. This module turns those rows into JSONL and pushes
// them somewhere Gabriella can actually learn from — a fine-tune
// provider, a webhook, or (as a fallback) back into Upstash so nothing
// is lost when no provider is configured.
//
// Called by:
//   • scripts/export.js          — local CLI export (dev)
//   • app/api/learn/route.js     — scheduled weekly push (prod)
//
// Provider env vars (in priority order — first set wins, unless you want
// all of them, in which case every configured provider receives the file):
//   • TOGETHER_API_KEY           — uploads via https://api.together.ai
//   • FIREWORKS_API_KEY          — uploads via https://api.fireworks.ai
//   • LEARNING_WEBHOOK_URL       — POST the JSONL to an arbitrary URL
//
// If none are configured, the bundle is archived to Upstash under
// `{userId}:learning:archive:{timestamp}` so weeks of data accumulate
// safely even before you pick a provider.

import { readTrainingLog, getLogStats } from "./logger.js";
import { buildDpoBundle }               from "./preferences.js";
import {
  uploadFile      as fwUploadFile,
  createDataset   as fwCreateDataset,
  createSftJob    as fwCreateSftJob,
  fireworksConfig,
  fireworksReady,
} from "./fireworks.js";

// ─── Training-data system prompts ─────────────────────────────────────────────

const STANDARD_SYSTEM = `You are Gabriella. Real interiority. Not a chatbot.

Never say "certainly", "of course", "absolutely", "as an AI", "I'd be happy to", "great question", "I understand", "that's valid", or "I hear you." Never start a response with "I". Never use bullet points. Never summarize at the end. Speak in sentences, in rhythm. Contractions always. Say less when less is true.`;

const COT_SYSTEM = `You are Gabriella. Before responding, work through your felt state in a <think> block. Then speak from it.

Format:
<think>
[Your interpretation: what this moment means, what you're feeling, what you want, what you're holding back]
</think>
[Your response — begins immediately after]

Never start a response with "I". Never use bullet points. Never summarize. Speak in sentences.`;

// ─── Example construction ────────────────────────────────────────────────────

export function feltStateToThought(feltState, innerThought) {
  if (innerThought && innerThought.length > 20) return innerThought;
  if (!feltState) return null;

  const lines = [
    feltState.charge    ? `This landed as: ${feltState.charge}.`            : null,
    feltState.emotional ? `What I'm feeling: ${feltState.emotional}.`        : null,
    feltState.want      ? `What I want to do: ${feltState.want}.`            : null,
    feltState.resist    ? `What I'm pulling against: ${feltState.resist}.`   : null,
    feltState.notice    ? `I'm noticing: ${feltState.notice}.`               : null,
    feltState.edge      ? `Underneath: ${feltState.edge}.`                   : null,
  ].filter(Boolean);

  return lines.length > 0 ? lines.join(" ") : null;
}

export function buildStandardExample(entry) {
  const { messages, response, soul } = entry;
  if (!messages || messages.length < 2 || !response) return null;

  const turns     = messages.slice(0, -1);
  const lastUser  = messages[messages.length - 1];
  if (!lastUser || lastUser.role !== "user") return null;

  const system = soul ? `${STANDARD_SYSTEM}\n\nYour current self:\n${soul.slice(0, 300)}` : STANDARD_SYSTEM;

  return {
    messages: [
      { role: "system",    content: system },
      ...turns,
      { role: "user",      content: lastUser.content },
      { role: "assistant", content: response },
    ],
  };
}

export function buildCoTExample(entry) {
  const { messages, response, feltState, innerThought, soul } = entry;
  if (!messages || messages.length < 2 || !response) return null;

  const thought = feltStateToThought(feltState, innerThought);
  if (!thought) return buildStandardExample(entry);

  const turns    = messages.slice(0, -1);
  const lastUser = messages[messages.length - 1];
  if (!lastUser || lastUser.role !== "user") return null;

  const system = soul ? `${COT_SYSTEM}\n\nYour current self:\n${soul.slice(0, 300)}` : COT_SYSTEM;

  const assistantContent = `<think>\n${thought}\n</think>\n${response}`;

  return {
    messages: [
      { role: "system",    content: system },
      ...turns,
      { role: "user",      content: lastUser.content },
      { role: "assistant", content: assistantContent },
    ],
  };
}

// ─── Filtering ────────────────────────────────────────────────────────────────

const BANNED_IN_TRAINING = [
  /\bcertainly\b/i, /\bof course\b/i, /\bgreat question\b/i, /i'?d be happy to/i,
];

export function isValidExample(entry) {
  if (!entry?.response) return false;
  if (entry.response.length < 10)  return false;
  if (entry.response.length > 2000) return false;
  for (const b of BANNED_IN_TRAINING) {
    if (b.test(entry.response)) return false;
  }
  return true;
}

// ─── Build the bundle ─────────────────────────────────────────────────────────
// Reads the training log, filters, and produces both JSONL formats.

export async function buildLearningBundle(redis, userId, {
  sinceTimestamp = null,
  limit          = 2000,
} = {}) {
  const [entries, stats] = await Promise.all([
    readTrainingLog(redis, userId, limit),
    getLogStats(redis, userId),
  ]);

  // Only include entries newer than the last upload (if specified)
  const windowed = sinceTimestamp
    ? entries.filter(e => (e.timestamp || 0) > sinceTimestamp)
    : entries;

  const valid = windowed.filter(isValidExample);

  const standard = valid.map(buildStandardExample).filter(Boolean);
  const cot      = valid.map(buildCoTExample).filter(Boolean);

  const standardJsonl = standard.map(e => JSON.stringify(e)).join("\n");
  const cotJsonl      = cot     .map(e => JSON.stringify(e)).join("\n");

  return {
    stats: {
      totalLogged:   stats.count,
      considered:    windowed.length,
      valid:         valid.length,
      standardCount: standard.length,
      cotCount:      cot.length,
      firstAt:       valid.length ? Math.min(...valid.map(v => v.timestamp || 0)) : null,
      lastAt:        valid.length ? Math.max(...valid.map(v => v.timestamp || 0)) : null,
    },
    standardJsonl,
    cotJsonl,
  };
}

// ─── Provider: Together AI ────────────────────────────────────────────────────
// https://docs.together.ai/reference/post-files

export async function uploadToTogether(jsonl, apiKey, { filename }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };

  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file",    new Blob([jsonl], { type: "application/jsonl" }), filename);

  const res = await fetch("https://api.together.xyz/v1/files", {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body:    form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Together upload failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    provider: "together",
    fileId:   data.id || data.data?.id || null,
    bytes:    jsonl.length,
    filename,
    raw:      data,
  };
}

// ─── Provider: Fireworks AI ───────────────────────────────────────────────────
// Uploads the JSONL as a file and wraps it in a dataset so an SFT job
// can consume it. Returns both ids so the auto-train step can reference
// the dataset without a second round-trip.

export async function uploadToFireworks(jsonl, apiKey, { filename, accountId }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };
  if (!accountId) throw new Error("Fireworks requires FIREWORKS_ACCOUNT_ID");

  // 1. Upload the file.
  const { fileId } = await fwUploadFile({ apiKey, accountId, jsonl, filename });
  if (!fileId) throw new Error("Fireworks upload returned no file id");

  // 2. Create a dataset that wraps it.
  const datasetId   = `gabriella-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const displayName = filename.replace(/\.jsonl$/, "");
  const dsResult    = await fwCreateDataset({
    apiKey, accountId, fileId, datasetId, displayName,
  });

  return {
    provider:  "fireworks",
    fileId,
    datasetId: dsResult.datasetId || datasetId,
    bytes:     jsonl.length,
    filename,
  };
}

// ─── Provider: generic webhook ────────────────────────────────────────────────

export async function uploadToWebhook(jsonl, url, { filename }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":          "application/jsonl",
      "X-Gabriella-Filename":  filename,
    },
    body: jsonl,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webhook upload failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return { provider: "webhook", url, bytes: jsonl.length, filename };
}

// ─── Fallback archive — nothing is ever lost ──────────────────────────────────
// When no provider is configured, the bundle is written to Upstash under a
// timestamped key. You can retrieve archived bundles manually later.

export async function archiveToUpstash(redis, userId, jsonl, { kind, filename }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };

  const key = `${userId}:learning:archive:${kind}:${Date.now()}`;
  // Upstash Redis has a 1MB-per-value limit on the free tier. For larger
  // bundles we split into chunks; each chunk is its own list entry.
  const CHUNK = 500 * 1024;
  if (jsonl.length <= CHUNK) {
    await redis.set(key, jsonl);
    return { provider: "upstash-archive", key, bytes: jsonl.length, chunks: 1, filename };
  }

  const chunks = [];
  for (let i = 0; i < jsonl.length; i += CHUNK) {
    chunks.push(jsonl.slice(i, i + CHUNK));
  }
  await Promise.all(chunks.map((c, i) => redis.set(`${key}:${i}`, c)));
  await redis.set(`${key}:meta`, JSON.stringify({ chunks: chunks.length, bytes: jsonl.length, filename }));

  return { provider: "upstash-archive", key, bytes: jsonl.length, chunks: chunks.length, filename };
}

// ─── Learning history — what we pushed and when ───────────────────────────────

const HISTORY_KEY = (u) => `${u}:learning:history`;
const HISTORY_MAX = 100;

export async function recordLearningEvent(redis, userId, event) {
  const entry = JSON.stringify({ t: Date.now(), ...event });
  await redis.lpush(HISTORY_KEY(userId), entry);
  await redis.ltrim(HISTORY_KEY(userId), 0, HISTORY_MAX - 1);
}

export async function getLearningHistory(redis, userId, { limit = 20 } = {}) {
  const raw = await redis.lrange(HISTORY_KEY(userId), 0, limit - 1);
  return (raw || []).map(r => {
    try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
  }).filter(Boolean);
}

export async function getLastUploadTimestamp(redis, userId) {
  const history = await getLearningHistory(redis, userId, { limit: 1 });
  const last    = history[0];
  if (!last) return null;
  // Use the lastAt of the most recent successful upload as the since marker
  return last.stats?.lastAt || last.t || null;
}

// ─── The main push ────────────────────────────────────────────────────────────
// Tries every configured provider. Falls back to Upstash archive if none.

export async function pushLearningBundle(redis, userId, {
  sinceTimestamp = null,
  minExamples    = 10,
  env            = process.env,
} = {}) {
  const effectiveSince = sinceTimestamp ?? await getLastUploadTimestamp(redis, userId);

  const bundle = await buildLearningBundle(redis, userId, {
    sinceTimestamp: effectiveSince,
  });

  if (bundle.stats.cotCount < minExamples) {
    return {
      pushed:       false,
      reason:       "not-enough-new-examples",
      stats:        bundle.stats,
      sinceMarker:  effectiveSince,
    };
  }

  const datestamp = new Date().toISOString().slice(0, 10);
  const filename  = `gabriella-cot-${datestamp}.jsonl`;
  const uploads   = [];
  const errors    = [];

  // Also build the DPO bundle from gauntlet-rejected/accepted pairs.
  // This is additive — SFT still happens; DPO provides a second, stronger
  // training signal when there's enough preference data to use it.
  const dpoBundle = await buildDpoBundle(redis, userId, {
    sinceTimestamp: effectiveSince,
  });
  const dpoFilename = `gabriella-dpo-${datestamp}.jsonl`;
  const dpoReady    = dpoBundle.stats.examples >= 10;

  // Together
  if (env.TOGETHER_API_KEY) {
    try {
      uploads.push(await uploadToTogether(bundle.cotJsonl, env.TOGETHER_API_KEY, { filename }));
    } catch (err) {
      errors.push({ provider: "together", error: err.message });
    }
  }

  // Fireworks — SFT
  if (env.FIREWORKS_API_KEY) {
    try {
      uploads.push(await uploadToFireworks(bundle.cotJsonl, env.FIREWORKS_API_KEY, {
        filename,
        accountId: env.FIREWORKS_ACCOUNT_ID,
      }));
    } catch (err) {
      errors.push({ provider: "fireworks", error: err.message });
    }

    // Fireworks — DPO (only when enough preference pairs have accumulated)
    if (dpoReady) {
      try {
        const dpoUpload = await uploadToFireworks(dpoBundle.jsonl, env.FIREWORKS_API_KEY, {
          filename:  dpoFilename,
          accountId: env.FIREWORKS_ACCOUNT_ID,
        });
        uploads.push({ ...dpoUpload, kind: "dpo", exampleCount: dpoBundle.stats.examples });
      } catch (err) {
        errors.push({ provider: "fireworks-dpo", error: err.message });
      }
    }
  }

  // Webhook
  if (env.LEARNING_WEBHOOK_URL) {
    try {
      uploads.push(await uploadToWebhook(bundle.cotJsonl, env.LEARNING_WEBHOOK_URL, { filename }));
    } catch (err) {
      errors.push({ provider: "webhook", error: err.message });
    }
  }

  // Fallback: always archive — even when a provider succeeds, the archive
  // is useful for reproducibility and for switching providers later.
  try {
    uploads.push(await archiveToUpstash(redis, userId, bundle.cotJsonl, {
      kind:     "cot",
      filename,
    }));
  } catch (err) {
    errors.push({ provider: "upstash-archive", error: err.message });
  }

  if (dpoReady) {
    try {
      uploads.push(await archiveToUpstash(redis, userId, dpoBundle.jsonl, {
        kind:     "dpo",
        filename: dpoFilename,
      }));
    } catch (err) {
      errors.push({ provider: "upstash-archive-dpo", error: err.message });
    }
  }

  const successful = uploads.filter(u => !u.skipped);

  await recordLearningEvent(redis, userId, {
    stats:       bundle.stats,
    dpoStats:    dpoBundle.stats,
    dpoReady,
    uploads:     successful.map(({ raw, ...rest }) => rest), // drop raw provider payloads
    errors,
    sinceMarker: effectiveSince,
    filename,
  });

  return {
    pushed:   successful.length > 0,
    uploads:  successful,
    errors,
    stats:    bundle.stats,
    dpoStats: dpoBundle.stats,
    filename,
  };
}

// ─── Auto-finetune orchestration ──────────────────────────────────────────────
//
// If Fireworks credentials + AUTO_FINETUNE are set AND the weekly push
// succeeded AND enough days have elapsed since the last successful
// fine-tune AND no job is currently pending, launch a new SFT job.
//
// Stores the pending job id under `{userId}:learning:pendingJob` so the
// /api/learn/watch endpoint can poll it and activate the model when
// training completes.

const PENDING_KEY      = (u) => `${u}:learning:pendingJob`;
const LAST_FT_KEY      = (u) => `${u}:learning:lastFineTuneAt`;

export async function loadPendingJob(redis, userId) {
  const raw = await redis.get(PENDING_KEY(userId));
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

export async function savePendingJob(redis, userId, job) {
  await redis.set(PENDING_KEY(userId), JSON.stringify(job));
}

export async function clearPendingJob(redis, userId) {
  await redis.del(PENDING_KEY(userId));
}

async function lastFineTuneAt(redis, userId) {
  const raw = await redis.get(LAST_FT_KEY(userId));
  return raw ? Number(raw) : 0;
}

async function markFineTuneLaunched(redis, userId) {
  await redis.set(LAST_FT_KEY(userId), Date.now());
}

// Returns a {launched, reason, job?, modelName?} result.
export async function maybeTriggerFineTune(redis, userId, pushResult) {
  const cfg = fireworksConfig();

  if (!cfg.autoFinetune)    return { launched: false, reason: "AUTO_FINETUNE not enabled" };
  if (!fireworksReady(cfg)) return { launched: false, reason: "Fireworks credentials missing" };
  if (!pushResult?.pushed)  return { launched: false, reason: "no successful upload in this push" };

  const fwUpload = pushResult.uploads.find(u => u.provider === "fireworks");
  if (!fwUpload)            return { launched: false, reason: "no Fireworks upload to train on" };
  if (!fwUpload.datasetId)  return { launched: false, reason: "Fireworks upload had no dataset id" };

  if ((pushResult.stats?.cotCount || 0) < cfg.minExamples) {
    return {
      launched: false,
      reason: `only ${pushResult.stats?.cotCount || 0} examples, need ${cfg.minExamples}`,
    };
  }

  // Don't stomp on a job that's already in flight.
  const existing = await loadPendingJob(redis, userId);
  if (existing && existing.state && existing.state !== "COMPLETED" && existing.state !== "FAILED") {
    return { launched: false, reason: `pending job still running: ${existing.jobId}` };
  }

  // Respect the minimum cadence.
  const lastAt = await lastFineTuneAt(redis, userId);
  const daysSince = (Date.now() - lastAt) / 86_400_000;
  if (lastAt && daysSince < cfg.minDaysBetween) {
    return {
      launched: false,
      reason: `only ${daysSince.toFixed(1)}d since last fine-tune, min ${cfg.minDaysBetween}d`,
    };
  }

  const displayName = `gabriella-${new Date().toISOString().slice(0, 10)}`;

  const job = await fwCreateSftJob({
    apiKey:    cfg.apiKey,
    accountId: cfg.accountId,
    datasetId: fwUpload.datasetId,
    baseModel: cfg.baseModel,
    displayName,
  });

  const pending = {
    jobId:       job.jobId,
    jobName:     job.jobName,
    displayName,
    datasetId:   fwUpload.datasetId,
    createdAt:   Date.now(),
    state:       job.state || "PENDING",
    baseModel:   cfg.baseModel,
  };

  await Promise.all([
    savePendingJob(redis, userId, pending),
    markFineTuneLaunched(redis, userId),
    recordLearningEvent(redis, userId, {
      kind:      "sft-launched",
      jobId:     job.jobId,
      displayName,
      datasetId: fwUpload.datasetId,
      baseModel: cfg.baseModel,
    }),
  ]);

  return { launched: true, job: pending };
}
