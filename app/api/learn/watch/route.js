// app/api/learn/watch/route.js
//
// The eye on the training job.
//
// Runs hourly via Vercel Cron. Reads the pending SFT job from Redis,
// asks Fireworks for its current status, and acts on terminal states:
//
//   COMPLETED  → attempt to deploy the resulting LoRA adapter, then
//                set it as Gabriella's active speaker model. The chat
//                route picks up the new model on the next request
//                (cached 60s in-process).
//   FAILED     → log the failure and clear the pending state so next
//                week's push can try again.
//   running    → just report back; no action.
//
// The circuit breaker in the speaker takes over from there: if the
// fine-tune generates broken outputs, consecutive failures will trip
// the breaker and Gabriella falls back to Groq automatically. The
// watch endpoint won't re-activate a cleared model — you'd trigger a
// fresh fine-tune (or wait for next week's cycle).
//
//   GET  /api/learn/watch   — poll current status (bearer-authed)
//   POST /api/learn/watch   — inspect speaker + pending job state

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { loadPendingJob, clearPendingJob, recordLearningEvent } from "../../../../lib/gabriella/learning.js";
import { getSftJob, ensureDeployed, fireworksConfig, fireworksReady } from "../../../../lib/gabriella/fireworks.js";
import {
  setActiveSpeakerModel,
  loadSpeakerStatus,
  clearActiveSpeakerModel,
} from "../../../../lib/gabriella/speakerState.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID = "user_default";

export async function GET(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  try {
    const cfg = fireworksConfig();

    // Always load speaker state so the response is useful even without a
    // pending job — the dev UI needs this to show what's active.
    const speaker = await loadSpeakerStatus(redis, USER_ID).catch(() => null);

    if (!fireworksReady(cfg)) {
      return json({ ok: true, skipped: true, reason: "Fireworks credentials not configured", speaker });
    }

    const pending = await loadPendingJob(redis, USER_ID);
    if (!pending) {
      return json({ ok: true, skipped: true, reason: "no pending job", speaker, pending: null });
    }

    const status = await getSftJob({
      apiKey:    cfg.apiKey,
      accountId: cfg.accountId,
      jobId:     pending.jobId,
    });

    // Non-terminal — just report.
    const state = String(status.state || "UNKNOWN").toUpperCase();
    if (!isTerminal(state)) {
      return json({
        ok:        true,
        action:    "still-running",
        job:       pending,
        pending:   { ...pending, state },
        state,
        speaker,
      });
    }

    // FAILED / CANCELLED — clear and log.
    if (state === "FAILED" || state === "CANCELLED" || state === "CANCELED") {
      await Promise.all([
        clearPendingJob(redis, USER_ID),
        recordLearningEvent(redis, USER_ID, {
          kind:        "sft-failed",
          jobId:       pending.jobId,
          displayName: pending.displayName,
          state,
          error:       status.error,
        }),
      ]);
      return json({ ok: true, action: "cleared-failed", state, error: status.error, speaker, pending: null });
    }

    // COMPLETED — deploy (best-effort) and activate.
    if (state === "COMPLETED" || state === "SUCCEEDED") {
      if (!status.modelId) {
        // Rare — job says completed but didn't expose a model id.
        await Promise.all([
          clearPendingJob(redis, USER_ID),
          recordLearningEvent(redis, USER_ID, {
            kind:   "sft-completed-no-model",
            jobId:  pending.jobId,
            rawState: state,
          }),
        ]);
        return json({ ok: true, action: "completed-but-no-model", state });
      }

      const deploy = await ensureDeployed({
        apiKey:    cfg.apiKey,
        accountId: cfg.accountId,
        modelId:   status.modelId,
      });

      await Promise.all([
        setActiveSpeakerModel(redis, status.modelId, USER_ID),
        clearPendingJob(redis, USER_ID),
        recordLearningEvent(redis, USER_ID, {
          kind:         "sft-activated",
          jobId:        pending.jobId,
          displayName:  pending.displayName,
          modelId:      status.modelId,
          deploy:       deploy,
        }),
      ]);

      return json({
        ok:      true,
        action:  "activated",
        modelId: status.modelId,
        deploy,
        speaker: { ...speaker, activeModel: status.modelId },
        pending: null,
      });
    }

    // Unknown terminal state.
    return json({ ok: true, action: "unknown-terminal-state", state, speaker, pending });

  } catch (err) {
    console.error("Watch route failed:", err);
    return json({ ok: false, error: err.message }, 500);
  }
}

// Inspection — useful when debugging from mobile:
//   POST /api/learn/watch   → returns pending job + current speaker state
export async function POST(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  const [pending, speaker] = await Promise.all([
    loadPendingJob(redis, USER_ID),
    loadSpeakerStatus(redis, USER_ID),
  ]);

  return json({ ok: true, pending, speaker });
}

// DELETE — manually clear the active fine-tune and fall back to Groq.
// Useful if the fine-tune is producing bad outputs and you want to roll
// back without touching env vars.
export async function DELETE(req) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  await clearActiveSpeakerModel(redis, "manual rollback via DELETE", USER_ID);
  return json({ ok: true, cleared: true });
}

function authorized(req) {
  if (!process.env.CRON_SECRET) return true;
  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const url = new URL(req.url);
  if (url.searchParams.get("key") === process.env.CRON_SECRET) return true;
  return false;
}

function isTerminal(state) {
  return ["COMPLETED", "SUCCEEDED", "FAILED", "CANCELLED", "CANCELED", "ERROR"].includes(state);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
