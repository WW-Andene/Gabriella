// app/api/explain/route.js
//
// Per-turn decision trace for evaluators and operators. Given a
// stored episode, reconstructs which interpretive modules fired,
// what the cores reached, whether retries happened, whether gauntlet
// checks failed, what the final felt-state was.
//
// GET  /api/explain              — returns most recent 5 turns explained
// GET  /api/explain?n=20         — expand to N
// GET  /api/explain?format=ndjson — one JSON object per line
//
// No LLM calls. Pure projection of episodic + logged data. Makes the
// pipeline legible — an evaluator seeing a specific response they
// didn't love can look up the same turn's explain data and see what
// the system was doing.

export const runtime     = "nodejs";
export const maxDuration = 20;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import { readTrainingLog } from "../../../lib/gabriella/logger.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function explainOne(entry) {
  const fs = entry.feltState || {};
  const tc = entry.tripleCore || {};

  const flagsFired = [];
  if (fs._silence)   flagsFired.push(`silence:${fs._silence.kind || "fired"}`);
  if (fs._wit)       flagsFired.push(`wit:${fs._wit.flavor || "fired"}`);
  if (fs._metaConv)  flagsFired.push(`metaConv:${fs._metaConv.kind || "fired"}`);
  if (fs._crisis)    flagsFired.push(`crisis:${fs._crisis.kind || "fired"}`);
  if (fs._reread)    flagsFired.push(`reread:${fs._rereadShift || "fired"}`);
  if (tc.retried)    flagsFired.push("gauntlet-retry");

  const lastUser = [...(entry.messages || [])].reverse().find(m => m.role === "user");

  return {
    at:         entry.timestamp,
    turn:       entry.turnCount || null,
    userMsg:    lastUser?.content?.slice(0, 500) || null,
    response:   entry.response?.slice(0, 1500) || null,

    interpretive: {
      charge:      fs.charge      || null,
      emotional:   fs.emotional   || null,
      want:        fs.want        || null,
      temperature: fs.temperature || null,
      length:      fs.length      || null,
      edge:        fs.edge        || null,
      consensus:   tc.consensus   || fs.consensus || null,
      innerThought:entry.innerThought?.slice(0, 600) || null,
    },

    modulators: {
      flagsFired,
      retried:     !!tc.retried,
      mood:        entry.mood || null,
      agenda:      entry.agenda || null,
    },

    triple_core:  tc.alpha || tc.beta || tc.gamma
      ? {
          alphaCharge: tc.alpha?.feltState?.charge?.slice(0, 120) || null,
          betaCharge:  tc.beta?.feltState?.charge?.slice(0, 120) || null,
          gammaCharge: tc.gamma?.feltState?.charge?.slice(0, 120) || null,
          consensus:   tc.consensus,
        }
      : null,

    pragmatics: entry.pragmatics ? {
      act:      entry.pragmatics.act,
      weight:   entry.pragmatics.weight,
      register: entry.pragmatics.register,
      substrate: entry.pragmatics.substrate,
    } : null,
  };
}

export async function GET(req) {
  const userId = resolveUserId(req);
  const { searchParams } = new URL(req.url);
  const n = Math.max(1, Math.min(100, Number(searchParams.get("n")) || 5));
  const format = searchParams.get("format") || "json";

  try {
    const log = await readTrainingLog(redis, userId, n);
    const explained = log.map(explainOne);

    if (format === "ndjson") {
      const body = explained.map(e => JSON.stringify(e)).join("\n");
      return new Response(body, {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      userId,
      count: explained.length,
      turns: explained,
    }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
