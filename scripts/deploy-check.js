#!/usr/bin/env node
// scripts/deploy-check.js
//
// Pre-deploy / post-deploy health gate. Runs a series of checks and
// emits a pass/warn/fail report so a deploy can be verified (CI
// can gate on this; a human can run it after pushing).
//
// Checks:
//   ENV          — required env vars present
//   REDIS        — Upstash reachable, can read/write a scratch key
//   VECTOR       — Upstash Vector reachable
//   POOL         — at least one LLM provider alive, prints per-provider
//   MODELS       — premium + fast model IDs resolve
//   ENDPOINTS    — (optional, with --url) each cron endpoint answers
//                  the bearer auth challenge correctly
//
// Exit codes:
//   0 — all PASS
//   1 — at least one FAIL
//   2 — WARN-only (passes but with caveats)
//
// Usage:
//   node --env-file=.env.local scripts/deploy-check.js
//   node --env-file=.env.local scripts/deploy-check.js --url https://gabriella.example.com
//   node --env-file=.env.local scripts/deploy-check.js --json

import { Redis } from "@upstash/redis";
import { Index } from "@upstash/vector";
import { poolStats } from "../lib/gabriella/groqPool.js";
import { premiumModel, fastModel } from "../lib/gabriella/models.js";

const ICON = { pass: "✓", warn: "○", fail: "✗" };
const COLOR = { pass: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", reset: "\x1b[0m" };

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}

function parseArgs(argv) {
  const args = { url: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i+1]) args.url = argv[++i];
    else if (argv[i] === "--json") args.json = true;
  }
  return args;
}

// ─── ENV ────────────────────────────────────────────────────────────────────
async function checkEnv() {
  const required = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"];
  const vectorReq = ["UPSTASH_VECTOR_REST_URL", "UPSTASH_VECTOR_REST_TOKEN"];
  const llmAny   = ["GROQ_API_KEY", "CEREBRAS_API_KEY", "GEMINI_API_KEY", "FIREWORKS_API_KEY"];

  const missingRequired = required.filter(k => !process.env[k]);
  if (missingRequired.length > 0) {
    record("ENV required", "fail", `missing: ${missingRequired.join(", ")}`);
  } else {
    record("ENV required", "pass", "Upstash Redis creds present");
  }

  const missingVector = vectorReq.filter(k => !process.env[k]);
  if (missingVector.length > 0) {
    record("ENV vector", "warn", `missing (vector recall disabled): ${missingVector.join(", ")}`);
  } else {
    record("ENV vector", "pass", "Upstash Vector creds present");
  }

  const llmPresent = llmAny.filter(k => !!process.env[k]);
  if (llmPresent.length === 0) {
    record("ENV llm", "fail", `no LLM provider configured (need ≥1 of: ${llmAny.join(", ")})`);
  } else {
    record("ENV llm", "pass", `${llmPresent.length} provider(s): ${llmPresent.join(", ")}`);
  }

  if (!process.env.CRON_SECRET) {
    record("ENV cron", "warn", "CRON_SECRET not set — cron endpoints will 401");
  } else {
    record("ENV cron", "pass", "CRON_SECRET present");
  }
}

// ─── REDIS ──────────────────────────────────────────────────────────────────
async function checkRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    record("REDIS", "fail", "env missing"); return;
  }
  try {
    const redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const key = `gb:deploy-check:${Date.now()}`;
    await redis.set(key, "pong", { ex: 60 });
    const got = await redis.get(key);
    await redis.del(key);
    if (got === "pong") record("REDIS", "pass", "read/write ok");
    else                record("REDIS", "fail", `unexpected read: ${String(got)}`);
  } catch (err) {
    record("REDIS", "fail", err?.message || String(err));
  }
}

// ─── VECTOR ─────────────────────────────────────────────────────────────────
async function checkVector() {
  if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
    record("VECTOR", "warn", "not configured — resonant/dissonant retrieval will no-op");
    return;
  }
  try {
    const index = new Index({
      url:   process.env.UPSTASH_VECTOR_REST_URL,
      token: process.env.UPSTASH_VECTOR_REST_TOKEN,
    });
    // Cheap "is it reachable" probe — info() on most Upstash Vector SDKs,
    // else a tiny query. Wrapping in try so SDK variance doesn't break us.
    let probeOk = false;
    try {
      await index.info?.();
      probeOk = true;
    } catch {
      // Fallback: zero-result query
      try {
        await index.query({ data: "ping", topK: 1 });
        probeOk = true;
      } catch {}
    }
    if (probeOk) record("VECTOR", "pass", "index reachable");
    else         record("VECTOR", "warn", "index responded oddly but creds look valid");
  } catch (err) {
    record("VECTOR", "fail", err?.message || String(err));
  }
}

// ─── POOL ───────────────────────────────────────────────────────────────────
async function checkPool() {
  try {
    const stats = poolStats();
    if (stats.keyCount === 0) {
      record("POOL", "fail", "no client keys configured");
      return;
    }
    if (stats.aliveCount === 0) {
      record("POOL", "fail", "all clients dead");
      return;
    }
    const perProvider = Object.entries(stats.byProvider || {})
      .map(([p, s]) => `${p}:${s.alive}/${s.total}`)
      .join(", ");
    record("POOL", "pass", `${stats.aliveCount}/${stats.keyCount} clients alive (${perProvider})`);
  } catch (err) {
    record("POOL", "fail", err?.message || String(err));
  }
}

// ─── MODELS ─────────────────────────────────────────────────────────────────
async function checkModels() {
  try {
    const p = premiumModel();
    const f = fastModel();
    if (!p || !f) {
      record("MODELS", "fail", `premium="${p}" fast="${f}"`);
      return;
    }
    record("MODELS", "pass", `premium=${p}, fast=${f}`);
  } catch (err) {
    record("MODELS", "fail", err?.message || String(err));
  }
}

// ─── ENDPOINTS (with --url) ─────────────────────────────────────────────────
// For each cron path, verify that without auth we get 401, AND with auth we
// get a non-5xx response. Doesn't actually run the cron work — just that
// the endpoint is reachable and protected correctly.
async function checkEndpoints(baseUrl) {
  if (!baseUrl) {
    record("ENDPOINTS", "warn", "skipped — pass --url to test");
    return;
  }
  const paths = [
    "/api/inner-loop", "/api/think", "/api/initiate",
    "/api/sleep", "/api/learn", "/api/learn/watch", "/api/eval",
  ];
  const secret = process.env.CRON_SECRET;

  for (const p of paths) {
    const url = baseUrl.replace(/\/+$/, "") + p;
    // Unauth probe
    try {
      const un = await fetch(url, { method: "GET" });
      if (un.status !== 401) {
        record(`ENDPOINT ${p}`, "warn", `unauth returned ${un.status}, expected 401`);
        continue;
      }
    } catch (err) {
      record(`ENDPOINT ${p}`, "fail", `unauth probe failed: ${err?.message || err}`);
      continue;
    }
    if (!secret) {
      record(`ENDPOINT ${p}`, "pass", "401 without auth (auth check skipped — no secret)");
      continue;
    }
    // Auth probe — 2xx or recognized business error is fine; 401/403 would fail
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${secret}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 401 || res.status === 403) {
        record(`ENDPOINT ${p}`, "fail", `auth rejected (${res.status}); CRON_SECRET mismatch`);
      } else if (res.status >= 500) {
        record(`ENDPOINT ${p}`, "fail", `${res.status} server error`);
      } else {
        record(`ENDPOINT ${p}`, "pass", `${res.status} under bearer`);
      }
    } catch (err) {
      // Timeout on a long-running cron is acceptable; just report it
      if (err?.name === "AbortError") {
        record(`ENDPOINT ${p}`, "warn", "auth probe timeout (cron may be running)");
      } else {
        record(`ENDPOINT ${p}`, "fail", err?.message || String(err));
      }
    }
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  await checkEnv();
  await checkRedis();
  await checkVector();
  await checkPool();
  await checkModels();
  if (args.url) await checkEndpoints(args.url);

  if (args.json) {
    console.log(JSON.stringify({
      results,
      counts: {
        pass: results.filter(r => r.status === "pass").length,
        warn: results.filter(r => r.status === "warn").length,
        fail: results.filter(r => r.status === "fail").length,
      },
    }, null, 2));
  } else {
    console.log("\nGabriella deploy check\n");
    for (const r of results) {
      const color = COLOR[r.status] || "";
      console.log(`  ${color}${ICON[r.status]}${COLOR.reset} ${r.name.padEnd(28)} ${r.detail || ""}`);
    }
    const pass = results.filter(r => r.status === "pass").length;
    const warn = results.filter(r => r.status === "warn").length;
    const fail = results.filter(r => r.status === "fail").length;
    console.log(`\n  ${pass} pass · ${warn} warn · ${fail} fail\n`);
  }

  const anyFail = results.some(r => r.status === "fail");
  const anyWarn = results.some(r => r.status === "warn");
  process.exit(anyFail ? 1 : anyWarn ? 2 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
