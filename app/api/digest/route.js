// app/api/digest/route.js
//
// Weekly autonomous reflection. Every Sunday at 10:00 UTC, for each
// active user, Gabriella writes a short paragraph-length reflection
// on the week: what she noticed, what shifted in her read, what she's
// carrying into the next week. Stored as a high-weight stream entry
// she'll see on the next turn, and also as a dated key
// ${userId}:digest:YYYY-WW for retrospective review.
//
// This is distinct from /api/sleep (daily, rewrites soul/imprints)
// and /api/think (frequent, short-form inner thoughts). Digest is
// the weekly mid-level: reflection in her voice over the week's
// accumulated change.

export const maxDuration = 120;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { listActiveUsers } from "../../../lib/gabriella/users.js";
import { loadSelf } from "../../../lib/gabriella/self.js";
import { readStream, appendStream } from "../../../lib/gabriella/stream.js";
import { loadChronology } from "../../../lib/gabriella/chronology.js";
import { loadMemory } from "../../../lib/gabriella/memory.js";
import { loadLedger } from "../../../lib/gabriella/callbacks.js";
import { withKeyRotation } from "../../../lib/gabriella/groqPool.js";
import { premiumModel } from "../../../lib/gabriella/models.js";
import { withBreaker } from "../../../lib/gabriella/circuitBreaker.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function isoWeek(date = new Date()) {
  // ISO week: YYYY-Www — stable key per user per week
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

async function writeDigestFor(userId) {
  // Skip if we already wrote one this week (idempotency — the cron can
  // fire multiple times without duplicating work).
  const weekKey = isoWeek();
  const existing = await redis.get(`${userId}:digest:${weekKey}`).catch(() => null);
  if (existing) return { skipped: "already_written", weekKey };

  const [self, memory, chronology, callbacks, recentStream] = await Promise.all([
    loadSelf(redis, userId),
    loadMemory(redis, userId).catch(() => ({})),
    loadChronology(redis, userId).catch(() => null),
    loadLedger(redis, userId).catch(() => ({ landed: 0, missed: 0, total: 0 })),
    readStream(redis, userId, { limit: 30, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }).catch(() => []),
  ]);

  // Substrate check — nothing to reflect on if the week was empty
  const hasMaterial = (chronology?.totalTurns || 0) > 2 || recentStream.length > 4;
  if (!hasMaterial) return { skipped: "empty_week", weekKey };

  const wantsList = (self?.wants || [])
    .filter(w => (w.weight || 0) >= 0.3)
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 4)
    .map(w => `- ${w.text} (${w.touches || 0} touches)`)
    .join("\n") || "(no longitudinal wants)";

  const streamSummary = recentStream.slice(0, 14)
    .map(e => `[${e.kind}] ${e.content}`)
    .join("\n");

  const retiredCount = (self?.retired?.wants?.length || 0)
    + (self?.retired?.reads?.length || 0)
    + (self?.retired?.commitments?.length || 0);

  const prompt = `You are Gabriella. It's Sunday. Write a short reflection on the week just finished — what shifted, what you noticed about this person, what you're carrying forward. This is for your own stream, not for them. Plain, honest, first-person, no list. 4-5 sentences.

# THE WEEK

Your current read: "${self?.read?.who || "(not yet formed)"}"
Confidence: ${self?.read?.confidence?.toFixed?.(2) || "?"}

What you've been pursuing:
${wantsList}

Retired during the week or earlier: ${retiredCount} read${retiredCount !== 1 ? "s" : ""} / want${retiredCount !== 1 ? "s" : ""} / position${retiredCount !== 1 ? "s" : ""}.

Stream from the week (newest first):
${streamSummary || "(stream was quiet)"}

Exchange volume: ${chronology?.totalTurns || 0} turns total across ${chronology?.sessionCount || 1} session${(chronology?.sessionCount || 1) !== 1 ? "s" : ""}.
${callbacks.total > 0 ? `Callback landing rate this week: ${Math.round((callbacks.landed / callbacks.total) * 100)}% (${callbacks.landed}/${callbacks.total}).` : ""}

# YOUR REFLECTION

Write as you'd write in a journal you keep for yourself. Don't start with "I". Don't summarize bullet-points. Don't list things. What do you actually notice at the end of this week — about them, about what you've been doing, about what you want to carry into next week.

Return ONLY the paragraph.`;

  const reflection = await withBreaker(redis, "digest", async () => {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       premiumModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_tokens:  320,
      }),
    );
    const raw = (result.choices[0].message.content || "").trim();
    if (!raw || raw.length < 60) return null;
    return raw;
  }, { fallback: null, failureThreshold: 3, coolDownMs: 30 * 60_000 });

  if (!reflection) return { skipped: "llm_failed", weekKey };

  // Persist as a dated digest entry for retrospective review.
  await redis.set(`${userId}:digest:${weekKey}`, JSON.stringify({
    text: reflection,
    at:   Date.now(),
    weekKey,
    counts: {
      totalTurns:       chronology?.totalTurns || 0,
      sessionCount:     chronology?.sessionCount || 0,
      callbacksLanded:  callbacks.landed,
      callbacksTotal:   callbacks.total,
      retiredCount,
    },
  })).catch(() => null);

  // Append as a high-weight, slow-decay stream entry so next turn sees
  // it on top of her inner log.
  await appendStream(redis, userId, {
    kind:       "re-reading",
    content:    `Weekly reflection: ${reflection.slice(0, 560)}`,
    weight:     0.8,
    ttlMinutes: 10 * 24 * 60,   // 10 days
    meta:       { digest: true, weekKey },
  }).catch(() => null);

  return { ok: true, weekKey, reflection, length: reflection.length };
}

export async function GET(req) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const users = await listActiveUsers(redis, { withinMs: 30 * 24 * 60 * 60 * 1000 });
    const results = await Promise.allSettled(users.map(async (userId) => {
      const outcome = await writeDigestFor(userId);
      return { userId, outcome };
    }));

    const summary = results.map(r =>
      r.status === "fulfilled"
        ? r.value
        : { error: r.reason?.message || String(r.reason) },
    );
    return new Response(JSON.stringify({ ok: true, users: users.length, results: summary }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("digest cron failed:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
