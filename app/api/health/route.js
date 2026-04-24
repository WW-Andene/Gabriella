// app/api/health/route.js
//
// Runtime diagnostic. Reports which env vars are set, which are blank
// or placeholder-looking, and whether each external service
// (Upstash, Groq, Fireworks) is actually reachable with the configured
// credentials.
//
// Surfaced in the /dev dashboard under its own card. Useful when
// /api/chat returns 500 — tells you exactly what's misconfigured.

export const maxDuration = 30;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { poolStats } from "../../../lib/gabriella/groqPool.js";

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

// Detect common placeholder / example values that would obviously
// break the corresponding service.
function looksLikePlaceholder(value) {
  if (!value) return false;
  const v = String(value).toLowerCase();
  return /your[_-]?(key|primary|token|account|secret|id)|replace[_-]?me|example|<.+>|xxx+/i.test(v);
}

function envReport(name, { required = false, maskChars = 4 } = {}) {
  const raw = process.env[name];
  if (!raw)                       return { name, status: required ? "MISSING" : "unset", set: false, required };
  if (looksLikePlaceholder(raw))  return { name, status: "PLACEHOLDER", set: true, required, preview: raw.slice(0, 20) + "…" };
  const masked = raw.length > maskChars * 2
    ? `${raw.slice(0, maskChars)}…${raw.slice(-maskChars)}`
    : "***";
  return { name, status: "ok", set: true, required, length: raw.length, masked };
}

async function probeUpstashRedis() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { ok: false, reason: "env vars not set" };
  }
  try {
    const redis = new Redis({
      url:   process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const res = await redis.ping();
    return { ok: true, ping: res };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

async function probeGroq() {
  if (!process.env.GROQ_API_KEY) return { ok: false, reason: "GROQ_API_KEY not set" };
  try {
    // Just a tiny models list to verify the key works. No LLM call needed.
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    const data = await res.json();
    const keyCount = countGroqKeys();
    return { ok: true, modelCount: data.data?.length || 0, poolSize: keyCount };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

function countGroqKeys() {
  let n = 0;
  if (process.env.GROQ_API_KEY) n++;
  for (let i = 2; i <= 10; i++) if (process.env[`GROQ_API_KEY_${i}`]) n++;
  return n;
}

async function probeFireworks() {
  const k = process.env.FIREWORKS_API_KEY;
  const a = process.env.FIREWORKS_ACCOUNT_ID;
  if (!k || !a) return { ok: false, reason: "FIREWORKS_API_KEY or FIREWORKS_ACCOUNT_ID not set" };
  try {
    const res = await fetch(`https://api.fireworks.ai/v1/accounts/${a}/models?pageSize=1`, {
      headers: { Authorization: `Bearer ${k}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    return { ok: true, accountId: a };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

async function probeUpstashVector() {
  const url   = process.env.UPSTASH_VECTOR_REST_URL;
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN;
  if (!url || !token) return { ok: false, reason: "env vars not set" };
  try {
    const res = await fetch(`${url}/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

export async function GET(req) {
  if (!authorized(req)) {
    return json({ ok: false, error: "Unauthorized." }, 401);
  }

  const envVars = {
    required: [
      envReport("GROQ_API_KEY",              { required: true }),
      envReport("UPSTASH_REDIS_REST_URL",    { required: true }),
      envReport("UPSTASH_REDIS_REST_TOKEN",  { required: true }),
      envReport("UPSTASH_VECTOR_REST_URL",   { required: true }),
      envReport("UPSTASH_VECTOR_REST_TOKEN", { required: true }),
      envReport("CRON_SECRET",               { required: true }),
    ],
    fireworks: [
      envReport("FIREWORKS_API_KEY"),
      envReport("FIREWORKS_ACCOUNT_ID"),
      envReport("FIREWORKS_BASE_MODEL"),
      envReport("AUTO_FINETUNE"),
    ],
    groqPool: [],
    finetune: [
      envReport("FINETUNE_EPOCHS"),
      envReport("FINETUNE_LORA_RANK"),
      envReport("FINETUNE_LEARNING_RATE"),
      envReport("FINETUNE_BATCH_SIZE"),
      envReport("FINETUNE_DISPLAY_PREFIX"),
    ],
  };
  for (let i = 2; i <= 10; i++) {
    envVars.groqPool.push(envReport(`GROQ_API_KEY_${i}`));
  }

  // Network probes in parallel.
  const [redisProbe, vectorProbe, groqProbe, fireworksProbe] = await Promise.all([
    probeUpstashRedis(),
    probeUpstashVector(),
    probeGroq(),
    probeFireworks(),
  ]);

  const checks = {
    upstashRedis:  redisProbe,
    upstashVector: vectorProbe,
    groq:          groqProbe,
    fireworks:     fireworksProbe,
  };

  // Collect human-readable problems.
  const problems = [];
  for (const v of envVars.required) {
    if (v.status === "MISSING")     problems.push(`❌ ${v.name} is missing — chat will crash`);
    if (v.status === "PLACEHOLDER") problems.push(`❌ ${v.name} still has a placeholder value (${v.preview})`);
  }
  if (!redisProbe.ok)  problems.push(`❌ Upstash Redis unreachable: ${redisProbe.reason || redisProbe.error}`);
  if (!vectorProbe.ok) problems.push(`⚠ Upstash Vector unreachable: ${vectorProbe.reason || vectorProbe.error} (resonant memory will be skipped)`);
  if (!groqProbe.ok)   problems.push(`❌ Groq unreachable: ${groqProbe.reason || groqProbe.error} (chat will fail)`);
  const pool = poolStats();
  if (pool.keyCount > 0 && pool.aliveCount === 0) {
    problems.push(`❌ All ${pool.keyCount} Groq key(s) marked dead this process. Check Groq account status — "organization_restricted" or revoked keys.`);
  } else if (pool.deadKeys?.length > 0) {
    problems.push(`⚠ ${pool.deadKeys.length} of ${pool.keyCount} Groq key(s) dead (keys #${pool.deadKeys.join(", #")}). Chat still works on remaining keys.`);
  }
  if (!fireworksProbe.ok && fireworksProbe.reason !== "FIREWORKS_API_KEY or FIREWORKS_ACCOUNT_ID not set") {
    problems.push(`⚠ Fireworks unreachable: ${fireworksProbe.error} (fine-tune will fail)`);
  }

  const overall =
    problems.some(p => p.startsWith("❌")) ? "broken" :
    problems.length > 0                    ? "degraded" :
                                             "healthy";

  return json({
    ok: overall !== "broken",
    overall,
    problems,
    envVars,
    checks,
    summary: {
      chatCanWork:        redisProbe.ok && groqProbe.ok,
      fineTuneCanWork:    fireworksProbe.ok,
      poolSize:           countGroqKeys(),
      pool:               poolStats(),
    },
    timestamp: new Date().toISOString(),
  });
}
