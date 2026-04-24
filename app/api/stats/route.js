// app/api/stats/route.js
//
// System maturity endpoint. Exposes the DEPTH that accumulates over
// time so an evaluator can see, in one GET, what's actually there:
//
//   • Stream length + kinds distribution (continuous inner time)
//   • Self-model state: active wants, commitments, retired items
//   • Memory: facts + imprints + vector store counts (approx)
//   • Training data: DPO pairs, ensemble labels, KTO readiness
//   • Autonomous eval history: win-rate trend over 60 days
//   • Pool status: provider health, circuit-breaker states
//   • Cron heartbeat: when each subsystem last ran
//
// Rationale: Gabriella's competitive advantage is cumulative state that
// kicks in over time — memory, wants, ensemble-graded training data,
// self-authored deltas. That depth is invisible in a turn-1 chat demo.
// This endpoint makes it visible on demand.

export const maxDuration = 30;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { loadSelf } from "../../../lib/gabriella/self.js";
import { readStream, getMeta as getStreamMeta } from "../../../lib/gabriella/stream.js";
import { loadChronology } from "../../../lib/gabriella/chronology.js";
import { poolStats } from "../../../lib/gabriella/groqPool.js";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import { breakerStates } from "../../../lib/gabriella/circuitBreaker.js";
import { loadAuditStats } from "../../../lib/gabriella/callAudit.js";
import { loadMetaRegister } from "../../../lib/gabriella/metaregister.js";
import { graphStats } from "../../../lib/gabriella/graph.js";
import { blindEvalStats } from "../../../lib/gabriella/blindEval.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

async function safeGet(key) {
  try { return await redis.get(key); } catch { return null; }
}
async function safeLLen(key) {
  try { return await redis.llen(key); } catch { return 0; }
}
async function safeLRange(key, start, end) {
  try { return await redis.lrange(key, start, end); } catch { return []; }
}

export async function GET(req) {
  const userId = resolveUserId(req);
  const started = Date.now();

  try {
    // ─── Self-model ───────────────────────────────────────────────────────
    const self = await loadSelf(redis, userId);
    const selfSummary = {
      wantsActive:      self.wants?.length || 0,
      wantsTopWeight:   self.wants?.length ? +(Math.max(...self.wants.map(w => w.weight || 0))).toFixed(2) : 0,
      commitmentsLive:  (self.commitments || []).filter(c => c.status === "live").length,
      commitmentsConfirmed: (self.commitments || []).filter(c => c.status === "confirmed").length,
      retired: {
        wants:       (self.retired?.wants       || []).length,
        reads:       (self.retired?.reads       || []).length,
        commitments: (self.retired?.commitments || []).length,
      },
      readConfidence:   self.read?.confidence ?? null,
      hasRead:          !!self.read?.who,
      openQuestions:    self.read?.openQuestions?.length || 0,
      contradictions:   self.read?.contradictions?.length || 0,
      lastDelta:        self.lastDelta || 0,
      seededAt:         self.seededAt || 0,
    };

    // ─── Stream ───────────────────────────────────────────────────────────
    const stream = await readStream(redis, userId, { limit: 80 });
    const streamMeta = await getStreamMeta(redis, userId);
    const kindCount = {};
    for (const e of stream) kindCount[e.kind] = (kindCount[e.kind] || 0) + 1;
    const streamSummary = {
      totalEntries: stream.length,
      byKind:       kindCount,
      oldestAt:     stream.length ? Math.min(...stream.map(e => e.at || 0)) : null,
      newestAt:     stream.length ? Math.max(...stream.map(e => e.at || 0)) : null,
      lastThink:    streamMeta.lastThink || 0,
      lastPrune:    streamMeta.lastPrune || 0,
    };

    // ─── Memory ───────────────────────────────────────────────────────────
    const [facts, imprints, summary, threads, pendingThoughts, trainingLogLen, preferencePairsLen, ensembleLabelsLen] = await Promise.all([
      safeGet(`${userId}:facts`),
      safeGet(`${userId}:imprints`),
      safeGet(`${userId}:summary`),
      safeGet(`${userId}:threads`),
      safeGet(`${userId}:pendingThoughts`),
      safeLLen(`${userId}:training_log`),
      safeLLen(`${userId}:preferences`),
      safeLLen(`${userId}:ensemble_labels`),
    ]);
    const memorySummary = {
      factsChars:    typeof facts    === "string" ? facts.length    : 0,
      imprintsChars: typeof imprints === "string" ? imprints.length : 0,
      summaryChars:  typeof summary  === "string" ? summary.length  : 0,
      threadsChars:  typeof threads  === "string" ? threads.length  : 0,
      pendingThoughtsPresent: !!pendingThoughts,
    };

    const trainingSummary = {
      trainingLogEntries:  trainingLogLen,
      preferencePairs:     preferencePairsLen,
      ensembleLabels:      ensembleLabelsLen,
      dpoReady:            preferencePairsLen >= 10,
      ktoReady:            (preferencePairsLen * 2 + ensembleLabelsLen) >= 20,
    };

    // ─── Chronology ───────────────────────────────────────────────────────
    const chronology = await loadChronology(redis, userId).catch(() => null);
    const chronologySummary = chronology ? {
      totalTurns:    chronology.totalTurns || 0,
      sessionCount:  chronology.sessionCount || 0,
      firstSeenAt:   chronology.firstSeenAt || 0,
      lastSeenAt:    chronology.lastSeenAt || 0,
    } : null;

    // ─── Autonomous daily eval history ────────────────────────────────────
    const historyRaw = await safeLRange("eval:history", 0, 29);
    const history = historyRaw.map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
    const latestDay = await safeGet("eval:reports:latest");
    const latestReportRaw = latestDay ? await safeGet(`eval:reports:${latestDay}`) : null;
    let latestReport = null;
    if (latestReportRaw) {
      try {
        const parsed = typeof latestReportRaw === "string" ? JSON.parse(latestReportRaw) : latestReportRaw;
        latestReport = parsed?.report || null;
      } catch { /* keep null */ }
    }
    const evalSummary = {
      latestDay:           latestDay || null,
      latestWinRate:       latestReport?.winRate ?? null,
      latestWinRateCI:     latestReport?.winRateCI ?? null,
      daysRecorded:        history.length,
      rollingAvgWinRate:   history.length
        ? +(history.filter(h => typeof h.winRate === "number")
             .reduce((s, h) => s + h.winRate, 0) /
             Math.max(1, history.filter(h => typeof h.winRate === "number").length)).toFixed(3)
        : null,
      lastEvalDays:        history.slice(0, 7),
    };

    // ─── Active speaker model + circuit breaker ──────────────────────────
    const [activeModel, activatedAt, errorStreak, brokenAt, lastError] = await Promise.all([
      safeGet(`${userId}:speaker:activeModel`),
      safeGet(`${userId}:speaker:activatedAt`),
      safeGet(`${userId}:speaker:errorStreak`),
      safeGet(`${userId}:speaker:brokenAt`),
      safeGet(`${userId}:speaker:lastError`),
    ]);
    const speakerSummary = {
      activeModel:  activeModel || null,
      activatedAt:  Number(activatedAt) || 0,
      errorStreak:  Number(errorStreak) || 0,
      brokenAt:     Number(brokenAt) || 0,
      lastError:    lastError || null,
    };

    // ─── Subsystem heartbeats ─────────────────────────────────────────────
    const layers = ["soul", "evolution", "register", "authorial"];
    const layerHeartbeats = {};
    for (const layer of layers) {
      const at = await safeGet(`${userId}:lastUpdate:${layer}`);
      layerHeartbeats[layer] = Number(at) || 0;
    }

    // ─── Pool status ──────────────────────────────────────────────────────
    const pool = poolStats();

    // ─── Circuit breakers ─────────────────────────────────────────────────
    const breakers = await breakerStates(redis, [
      "thinker", "selfProposer", "mirror", "surprise",
      "constitutional", "planner", "humorLLM", "digest", "retroNarrative",
    ]);

    // ─── LLM call audit — today's rollup + last-hour window ──────────────
    const callAudit = await loadAuditStats(redis);

    // ─── Prompt-size audit — last 50 turns of system-prompt size + phase timings
    const promptSizeRaw = await safeLRange(`${userId}:prompt:sizes`, 0, 49);
    const promptSizes = (promptSizeRaw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
    let promptAudit = null;
    if (promptSizes.length > 0) {
      const chars    = promptSizes.map(s => s.chars || 0);
      const tokens   = promptSizes.map(s => s.tokensApprox || 0);
      const avgChars = chars.reduce((a, b) => a + b, 0) / chars.length;
      const maxChars = Math.max(...chars);
      const avgTok   = tokens.reduce((a, b) => a + b, 0) / tokens.length;
      const maxTok   = Math.max(...tokens);
      // Aggregate phase timings
      const timingKeys = new Set();
      for (const s of promptSizes) {
        if (s.phaseTimings) for (const k of Object.keys(s.phaseTimings)) timingKeys.add(k);
      }
      const avgTimings = {};
      for (const k of timingKeys) {
        const vals = promptSizes.map(s => s.phaseTimings?.[k]).filter(v => typeof v === "number");
        if (vals.length > 0) {
          avgTimings[k] = {
            avg: +Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
            max: Math.max(...vals),
            p50: vals.sort((a, b) => a - b)[Math.floor(vals.length * 0.5)],
            p95: vals.sort((a, b) => a - b)[Math.floor(vals.length * 0.95)] || null,
          };
        }
      }
      promptAudit = {
        samples: promptSizes.length,
        chars:   { avg: +avgChars.toFixed(0), max: maxChars },
        tokensApprox: { avg: +avgTok.toFixed(0), max: maxTok },
        phaseTimingsMs: avgTimings,
      };
    }

    // ─── Gauntlet stats — per-check rejection distribution ──────────────
    const gauntletStats = await loadMetaRegister(redis, userId).catch(() => null);

    // ─── Block population — which prompt slots are doing work ───────────
    const blockDay = new Date().toISOString().slice(0, 10);
    const blocksRaw = await getKeySafe(`${userId}:blocks:${blockDay}`);
    let blocksAudit = null;
    if (blocksRaw) {
      try {
        const parsed = typeof blocksRaw === "string" ? JSON.parse(blocksRaw) : blocksRaw;
        if (parsed && parsed.turns) {
          // Compute fill-rate per slot
          const slots = new Set([
            ...Object.keys(parsed.populated || {}),
            ...Object.keys(parsed.empty || {}),
          ]);
          const byBlock = {};
          for (const slot of slots) {
            const pop = parsed.populated?.[slot] || 0;
            const emp = parsed.empty?.[slot] || 0;
            const total = pop + emp;
            byBlock[slot] = {
              populated: pop,
              empty:     emp,
              fillRate:  total > 0 ? +(pop / total).toFixed(2) : 0,
            };
          }
          blocksAudit = {
            day:      parsed.day,
            turns:    parsed.turns,
            byBlock,
            deadBlocks: Object.entries(byBlock)
              .filter(([, s]) => s.fillRate < 0.05 && s.empty >= 5)
              .map(([name]) => name),
          };
        }
      } catch { /* ignore */ }
    }

    // ─── Episodic memory graph — node/edge counts ────────────────────────
    let graph = null;
    try { graph = await graphStats(redis, userId); }
    catch { /* ignore */ }

    // ─── Blind human A/B eval — win rate + Wilson CI ─────────────────────
    let blindEval = null;
    try { blindEval = await blindEvalStats(redis); }
    catch { /* ignore */ }

    // ─── Flags for evaluators ─────────────────────────────────────────────
    // Quick-glance readiness signals — are the high-value systems actually
    // loaded? A deploy without keys will have gaping holes here.
    const readiness = {
      upstashConfigured:       !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN),
      upstashVectorConfigured: !!(process.env.UPSTASH_VECTOR_REST_URL && process.env.UPSTASH_VECTOR_REST_TOKEN),
      groqConfigured:          pool.byProvider?.groq?.total > 0,
      cerebrasConfigured:      pool.byProvider?.cerebras?.total > 0,
      geminiConfigured:        pool.byProvider?.gemini?.total > 0,
      fireworksConfigured:     !!(process.env.FIREWORKS_API_KEY && process.env.FIREWORKS_ACCOUNT_ID),
      cronSecretSet:           !!process.env.CRON_SECRET,
    };

    const payload = {
      ok:            true,
      userId,
      generatedMs:   Date.now() - started,
      self:          selfSummary,
      stream:        streamSummary,
      memory:        memorySummary,
      training:      trainingSummary,
      chronology:    chronologySummary,
      eval:          evalSummary,
      speaker:       speakerSummary,
      heartbeats:    layerHeartbeats,
      pool,
      breakers,
      callAudit,
      promptAudit,
      blocksAudit,
      graph,
      blindEval,
      gauntlet: gauntletStats,
      readiness,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
