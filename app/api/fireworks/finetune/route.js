// app/api/fireworks/finetune/route.js
//
// Browser-hittable endpoint that launches a Supervised Fine-Tuning job
// on an existing Fireworks dataset. Use this after uploading training
// data via /api/bootstrap/push — this kicks off the actual training.
//
// Also lists existing datasets and running/completed jobs so you can
// see what's there without logging into the Fireworks dashboard.
//
// Endpoints:
//
//   GET  /api/fireworks/finetune?key=<SECRET>              → status: list datasets + jobs
//   GET  /api/fireworks/finetune?key=<SECRET>&launch=1     → launch SFT on the newest dataset
//   GET  /api/fireworks/finetune?key=<SECRET>&launch=1&dataset=<id>
//                                                          → launch SFT on a specific dataset
//
// Optional query params:
//   epochs       (default 3)
//   loraRank     (default 16)
//   learningRate (default 0.0001)
//   baseModel    (default FIREWORKS_BASE_MODEL env, or Llama 3.1 8B Instruct)

export const maxDuration = 30;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { createSftJob, fireworksConfig } from "../../../../lib/gabriella/fireworks.js";
import { savePendingJob, recordLearningEvent } from "../../../../lib/gabriella/learning.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("key") === process.env.CRON_SECRET) return true;
  return false;
}

async function listDatasets({ apiKey, accountId }) {
  const res = await fetch(
    `https://api.fireworks.ai/v1/accounts/${accountId}/datasets?pageSize=50`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) throw new Error(`list datasets ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return (data.datasets || []).map(d => ({
    name:         d.name,
    id:           (d.name || "").split("/").pop(),
    displayName:  d.displayName,
    state:        d.state,
    format:       d.format,
    exampleCount: d.exampleCount,
    createTime:   d.createTime,
  }));
}

async function listJobs({ apiKey, accountId }) {
  const res = await fetch(
    `https://api.fireworks.ai/v1/accounts/${accountId}/supervisedFineTuningJobs?pageSize=25`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!res.ok) {
    return { error: `list jobs ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }
  const data = await res.json();
  return (data.supervisedFineTuningJobs || data.jobs || []).map(j => ({
    name:         j.name,
    id:           (j.name || "").split("/").pop(),
    displayName:  j.displayName,
    dataset:      j.dataset,
    baseModel:    j.baseModel,
    state:        j.state,
    status:       j.status,
    outputModel:  j.outputModel,
    createTime:   j.createTime,
  }));
}

export async function GET(req) {
  if (!authorized(req)) {
    return json({ ok: false, error: "Unauthorized. Append ?key=<CRON_SECRET> to the URL." }, 401);
  }

  const cfg = fireworksConfig();
  if (!cfg.apiKey || !cfg.accountId) {
    return json({ ok: false, error: "FIREWORKS_API_KEY + FIREWORKS_ACCOUNT_ID must be set on Vercel." }, 500);
  }

  const url          = new URL(req.url);
  const shouldLaunch = url.searchParams.get("launch") === "1" || url.searchParams.get("launch") === "true";
  const datasetParam = url.searchParams.get("dataset");
  const epochs       = Number(url.searchParams.get("epochs")       || 3);
  const loraRank     = Number(url.searchParams.get("loraRank")     || 16);
  const learningRate = Number(url.searchParams.get("learningRate") || 0.0001);
  const baseModel    = url.searchParams.get("baseModel") || cfg.baseModel;

  try {
    // Always fetch current state so the response is self-explanatory.
    const [datasets, jobs] = await Promise.all([
      listDatasets(cfg).catch(err => ({ error: err.message })),
      listJobs(cfg).catch(err => ({ error: err.message })),
    ]);

    if (!shouldLaunch) {
      return json({
        ok:       true,
        action:   "status",
        baseModel,
        datasets,
        jobs,
        hint: Array.isArray(datasets) && datasets.length > 0
          ? `To launch SFT on the newest dataset, append &launch=1 to this URL.`
          : `No datasets yet — run /api/bootstrap/push first to upload one.`,
      });
    }

    // ─── Launch path ────────────────────────────────────────────────────────

    if (!Array.isArray(datasets) || datasets.length === 0) {
      return json({
        ok:    false,
        error: "No datasets available to fine-tune on. Upload one first via /api/bootstrap/push.",
      }, 400);
    }

    // Pick dataset: explicit id wins, else newest READY.
    const readyDatasets = datasets.filter(d => d.state === "READY" || d.state === "UPLOADING");
    const chosen = datasetParam
      ? datasets.find(d => d.id === datasetParam || d.name === datasetParam)
      : readyDatasets.sort((a, b) => new Date(b.createTime) - new Date(a.createTime))[0];

    if (!chosen) {
      return json({
        ok:    false,
        error: datasetParam
          ? `Dataset "${datasetParam}" not found.`
          : `No READY datasets found.`,
        datasets,
      }, 400);
    }

    const displayName = `gabriella-${new Date().toISOString().slice(0, 10)}-${chosen.id.slice(-8)}`;

    const job = await createSftJob({
      apiKey:    cfg.apiKey,
      accountId: cfg.accountId,
      datasetId: chosen.name,   // full resource path
      baseModel,
      epochs,
      learningRate,
      loraRank,
      displayName,
    });

    const pending = {
      jobId:       job.jobId,
      jobName:     job.jobName,
      displayName,
      datasetId:   chosen.name,
      createdAt:   Date.now(),
      state:       job.state || "PENDING",
      baseModel,
    };

    await Promise.all([
      savePendingJob(redis, "user_default", pending),
      recordLearningEvent(redis, "user_default", {
        kind:      "sft-launched-manual",
        jobId:     job.jobId,
        displayName,
        datasetId: chosen.name,
        baseModel,
      }),
    ]);

    return json({
      ok:             true,
      action:         "launched",
      job:            pending,
      datasetUsed:    chosen,
      trainingConfig: { baseModel, epochs, learningRate, loraRank },
      message:
        `SFT job launched. It will run in the background (~1-2 hours). ` +
        `The /api/learn/watch cron (hourly) polls it and activates the model when done.`,
    });
  } catch (err) {
    return json({
      ok:    false,
      error: err.message || String(err),
    }, 500);
  }
}
