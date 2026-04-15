// app/api/bootstrap/run/route.js
//
// Chunked bootstrap runner for the /dev dashboard.
//
// Full bootstrap (269 scenarios) takes 8-12 minutes — longer than
// Vercel's 60s function cap. So this endpoint runs a SMALL CHUNK per
// request (default 5 scenarios, usually finishing within 30-40s), and
// the client loops until `done: true`.
//
// Per-chunk state is stored in Redis at `${userId}:bootstrapRun` so
// the client can disconnect, refresh, come back, and resume.
//
// Usage:
//   POST /api/bootstrap/run
//   Body: {
//     action?: "start" | "continue" | "abort",
//     chunkSize?: number (default 5),
//     category?: string | null,
//     scenarios?: number  (cap total count, default: all in category)
//   }
//
// Auth: Bearer CRON_SECRET.

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { SCENARIOS, CATEGORIES } from "../../../../lib/gabriella/bootstrap-scenarios.js";
import { generateBatch } from "../../../../lib/gabriella/bootstrap.js";
import { archiveToUpstash } from "../../../../lib/gabriella/learning.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const STATE_KEY = (u) => `${u}:bootstrapRun`;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authed(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

async function loadState(userId) {
  const raw = await redis.get(STATE_KEY(userId)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

async function saveState(userId, state) {
  await redis.set(STATE_KEY(userId), JSON.stringify(state));
}

async function clearState(userId) {
  await redis.del(STATE_KEY(userId)).catch(() => {});
}

function filterScenarios(args) {
  let out = SCENARIOS;
  if (args.category && args.category !== "all") {
    if (!CATEGORIES.includes(args.category)) {
      throw new Error(`Unknown category: ${args.category}. Known: ${CATEGORIES.join(", ")}`);
    }
    out = out.filter(s => s.category === args.category);
  }
  if (Number.isFinite(args.scenarios) && args.scenarios > 0) {
    out = out.slice(0, args.scenarios);
  }
  return out;
}

export async function POST(req) {
  if (!authed(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  let body = {};
  try { body = await req.json(); } catch {}

  const userId    = body.userId    || "user_default";
  const action    = body.action    || "continue";   // "start" | "continue" | "abort"
  const chunkSize = Math.max(1, Math.min(12, Number(body.chunkSize) || 5));

  // ── Abort ─────────────────────────────────────────────────────────────
  if (action === "abort") {
    await clearState(userId);
    return json({ ok: true, status: "aborted" });
  }

  // ── Start ─────────────────────────────────────────────────────────────
  if (action === "start") {
    let scenarios;
    try {
      scenarios = filterScenarios({
        category:  body.category || null,
        scenarios: Number(body.scenarios) || null,
      });
    } catch (err) {
      return json({ ok: false, error: err.message }, 400);
    }
    if (scenarios.length === 0) {
      return json({ ok: false, error: "No scenarios match those filters" }, 400);
    }

    const state = {
      startedAt:     Date.now(),
      category:      body.category || null,
      totalScenarios: scenarios.length,
      scenarioIds:   scenarios.map(s => s.id),
      processed:     0,
      examples:      [],            // accumulated training examples
      breakdown:     [],            // per-scenario result summaries
      concurrency:   Math.max(1, Math.min(5, Number(body.concurrency) || 3)),
      status:        "running",
    };
    await saveState(userId, state);
    return json({ ok: true, status: "started", state: summarize(state) });
  }

  // ── Continue (the default, loop body) ─────────────────────────────────
  const state = await loadState(userId);
  if (!state) {
    return json({ ok: false, error: "No run in progress. Start one first." }, 400);
  }
  if (state.status !== "running") {
    return json({ ok: true, state: summarize(state), done: true });
  }

  // Pick the next chunk of scenarios by id.
  const nextIds = state.scenarioIds.slice(state.processed, state.processed + chunkSize);
  if (nextIds.length === 0) {
    state.status = "done";
    state.finishedAt = Date.now();
    // Archive the accumulated JSONL so /api/bootstrap/push can ship it.
    await finalizeAndArchive(userId, state).catch(err => {
      state.archiveError = err?.message || String(err);
    });
    await saveState(userId, state);
    return json({ ok: true, done: true, state: summarize(state), archiveKey: state.archiveKey || null });
  }

  const nextScenarios = SCENARIOS.filter(s => nextIds.includes(s.id));

  const chunkResults = await generateBatch(nextScenarios, {
    concurrency: state.concurrency || 3,
  }).catch(err => {
    return [{ error: err?.message || String(err), examples: [] }];
  });

  for (const r of chunkResults) {
    if (r.examples && r.examples.length) {
      state.examples.push(...r.examples);
    }
    state.breakdown.push({
      scenarioId: r.scenarioId || null,
      category:   r.category   || null,
      generated:  r.generated  || 0,
      kept:       r.kept       || 0,
      dropped:    r.dropped    || 0,
      error:      r.error      || null,
    });
  }
  state.processed += nextIds.length;

  if (state.processed >= state.totalScenarios) {
    state.status = "done";
    state.finishedAt = Date.now();
    await finalizeAndArchive(userId, state).catch(err => {
      state.archiveError = err?.message || String(err);
    });
  }

  await saveState(userId, state);

  return json({
    ok:       true,
    done:     state.status === "done",
    state:    summarize(state),
    chunk: {
      scenarios: nextScenarios.map(s => s.id),
      kept:      chunkResults.reduce((a, r) => a + (r.kept || 0), 0),
      dropped:   chunkResults.reduce((a, r) => a + (r.dropped || 0), 0),
      failed:    chunkResults.filter(r => r.error).length,
    },
    archiveKey: state.archiveKey || null,
  });
}

async function finalizeAndArchive(userId, state) {
  const pure = state.examples.map(e => {
    const { _meta, ...rest } = e;
    return JSON.stringify(rest);
  });
  const jsonl = pure.join("\n");
  state.totalExamples = pure.length;
  state.jsonlBytes    = jsonl.length;
  if (pure.length === 0) return;

  const filename = `gabriella-bootstrap-${new Date().toISOString().slice(0, 10)}-${Date.now()}.jsonl`;
  const archive = await archiveToUpstash(redis, userId, jsonl, {
    kind:     "bootstrap",
    filename,
  });
  state.archiveKey      = archive.key;
  state.archiveFilename = filename;
}

export async function GET(req) {
  if (!authed(req)) return json({ ok: false, error: "Unauthorized" }, 401);
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId") || "user_default";
  const state = await loadState(userId);
  if (!state) return json({ ok: true, state: null });
  return json({ ok: true, state: summarize(state) });
}

function summarize(state) {
  if (!state) return null;
  return {
    status:         state.status,
    startedAt:      state.startedAt,
    finishedAt:     state.finishedAt || null,
    category:       state.category || "all",
    totalScenarios: state.totalScenarios,
    processed:      state.processed,
    percent:        Math.round((state.processed / Math.max(1, state.totalScenarios)) * 100),
    totalExamples:  state.examples?.length || 0,
    breakdownLast:  (state.breakdown || []).slice(-5),
    archiveKey:     state.archiveKey || null,
    archiveFilename: state.archiveFilename || null,
    jsonlBytes:     state.jsonlBytes || 0,
    archiveError:   state.archiveError || null,
  };
}
