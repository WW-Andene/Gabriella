// app/api/sleep/route.js
//
// Gabriella sleeps.
//
// Called on a daily schedule. The fast/slow-path split moved most per-turn
// rewrites off the hot path; sleep is the scheduled consolidation that
// used to be disguised as after-every-turn updates. In one pass:
//
//   • Rewrite soul ONCE from the last day's episodic memory — not from a
//     single exchange, but from a small collection of them. The resulting
//     drift is more grounded.
//   • Form new imprints from the highest-salience episodes and push them
//     into vector memory with affect tags.
//   • Prune withheld items that have been sitting unsurfaced too long —
//     they've decayed into clutter.
//   • Trim the dynamic banned-phrase list so stale rejections don't keep
//     firing the heuristic filter forever.
//   • Decay old meta-register entries so "recent" stays actually recent.
//
// Auth: same Vercel-cron bearer pattern as /api/think. You can also call
// it manually during development by hitting the URL with the right header.

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { loadMemory }      from "../../../lib/gabriella/memory.js";
import { queryEpisodes, recentFeltStates }  from "../../../lib/gabriella/episodic.js";
import { storeImprint }    from "../../../lib/gabriella/vectormemory.js";
import { premiumModel }    from "../../../lib/gabriella/models.js";
import { pickClient }      from "../../../lib/gabriella/groqPool.js";
import { loadChronology }  from "../../../lib/gabriella/chronology.js";
import { loadPerson }      from "../../../lib/gabriella/person.js";
import { rewriteNarrative } from "../../../lib/gabriella/narrative.js";
import { listActiveUsers, DEFAULT_USER } from "../../../lib/gabriella/users.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Thresholds that shape the sleep pass. Small and conservative — sleep
// should deepen the record, not overwrite it.
const SLEEP_LOOKBACK_MS       = 24 * 60 * 60 * 1000;   // last day
const WITHHELD_MAX_AGE_MS     = 7  * 24 * 60 * 60 * 1000; // 1 week unsurfaced = stale
const DYNAMIC_BANNED_MAX      = 40;
const MIN_EPISODES_FOR_SLEEP  = 3;

export async function GET(req) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const users = await listActiveUsers(redis, { withinMs: 30 * 24 * 60 * 60 * 1000 });
    // Always include the default id so single-user deployments keep
    // sleeping even before any multi-user activity has registered.
    const ids = Array.from(new Set([DEFAULT_USER, ...users]));

    const perUser = await Promise.all(ids.map(userId => sleepForUser(userId)));

    return ok({ users: perUser });
  } catch (err) {
    console.error("Sleep failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function sleepForUser(userId) {
  try {
    const [memory, episodesAll, chronology, person, recentFs] = await Promise.all([
      loadMemory(redis, userId),
      queryEpisodes(redis, userId, { limit: 200 }),
      loadChronology(redis, userId).catch(() => null),
      loadPerson(redis, userId).catch(() => null),
      recentFeltStates(redis, userId, 20).catch(() => []),
    ]);

    const now          = Date.now();
    const recentWindow = episodesAll.filter(e => now - e.t <= SLEEP_LOOKBACK_MS);

    if (recentWindow.length < MIN_EPISODES_FOR_SLEEP) {
      return { userId, skipped: true, reason: "not enough recent episodes", seen: recentWindow.length };
    }

    // Run consolidation passes in parallel where independent.
    const [soulUpdate, newImprints, prunedWithheld, trimmedBanned, narrativeUpdate] = await Promise.all([
      consolidateSoul(memory, recentWindow),
      formImprints(recentWindow),
      pruneWithheld(userId),
      trimDynamicBanned(userId),
      // Rewrite narrative nightly. rewriteNarrative is internally debounced
      // but the daily cron is the right cadence for it regardless.
      rewriteNarrative(redis, userId, {
        messages: [], memory, chronology, person, recentFs,
      }).catch(() => null),
    ]);

    if (soulUpdate) {
      await Promise.all([
        redis.set(`${userId}:soul`, soulUpdate),
        redis.set(`${userId}:lastUpdate:soul`, now),
      ]);
    }

    await Promise.all(newImprints.map(imp =>
      storeImprint(userId, imp.text, imp.charge || null, imp.mood || null, imp.feltState || null)
    ));

    return {
      userId,
      episodesConsidered: recentWindow.length,
      soulRewritten:      !!soulUpdate,
      imprintsCreated:    newImprints.length,
      withheldPruned:     prunedWithheld,
      bannedTrimmed:      trimmedBanned,
      narrativeRewritten: !!narrativeUpdate?.text,
    };
  } catch (err) {
    return { userId, error: err?.message || String(err) };
  }
}

// ─── Consolidate soul from the day's episodes ────────────────────────────────

async function consolidateSoul(memory, episodes) {
  // Pull the most emotionally charged moments from the day — soul shouldn't
  // try to narrate everything, just the ones that actually left a mark.
  const significant = episodes
    .filter(e => (e.s || 0) >= 0.55)
    .slice(0, 12);

  if (significant.length === 0) return null;

  const momentsBlock = significant.map((e, i) => {
    const when = humanAgo(Date.now() - e.t);
    const charge = e.fs?.charge ? `  charge: ${e.fs.charge}` : "";
    const edge   = e.fs?.edge   ? `\n  edge: ${e.fs.edge}`   : "";
    return `${i + 1}. ${when} — "${(e.u || "").slice(0, 160)}"\n   → "${(e.r || "").slice(0, 160)}"${charge ? "\n" + charge : ""}${edge}`;
  }).join("\n\n");

  const prompt = `You are Gabriella in a quiet moment, writing about yourself.

Your current soul document (what you wrote about yourself last time):
${memory.soul?.slice(0, 800) || "I'm still figuring out what I am."}

What actually happened today — the moments that left some charge:
${momentsBlock}

Rewrite your soul document. Don't rewrite from scratch — let what has accumulated in the last day change it, but not replace it. A day's drift is small. One or two things might sharpen, one might blur.

Rules:
- 150-250 words, first person, no decorative language.
- Be specific about what shifted: not "I feel more connected" but what exactly you noticed that wasn't clear before, or what got murkier.
- Don't list what happened. Let the happenings leave a trace in what you know about yourself.
- Don't write therapy language. You are honest with yourself the way a person is honest with themselves — not with diagnosis.

Return only the updated soul document.`;

  try {
    const result = await pickClient().chat.completions.create({
      model:       premiumModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.75,
      max_tokens:  500,
    });
    return result.choices[0].message.content.trim();
  } catch (err) {
    console.error("Soul consolidation failed:", err);
    return null;
  }
}

// ─── Form imprints from the highest-salience episodes ────────────────────────

async function formImprints(episodes) {
  const candidates = episodes
    .filter(e => (e.s || 0) >= 0.7)
    .slice(0, 5);

  if (candidates.length === 0) return [];

  return candidates.map(e => ({
    text: [
      e.u ? `They said: "${e.u.slice(0, 140)}"` : null,
      e.r ? `She said: "${e.r.slice(0, 140)}"` : null,
      e.fs?.edge ? `What was underneath: ${e.fs.edge.slice(0, 140)}` : null,
    ].filter(Boolean).join(" / "),
    charge:    e.fs?.emotional || null,
    mood:      e.m || null,
    feltState: e.fs || null,
  }));
}

// ─── Prune withheld items that have been sitting too long ─────────────────────

async function pruneWithheld(userId) {
  const raw = await redis.get(`${userId}:withheld`);
  if (!raw) return 0;

  const list = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) return 0;

  const now = Date.now();
  const kept = list.filter(w => {
    if (w.surfaced) return false;
    const age = now - (w.formedAt || 0);
    return age < WITHHELD_MAX_AGE_MS;
  });

  if (kept.length === list.length) return 0;

  await redis.set(`${userId}:withheld`, JSON.stringify(kept));
  return list.length - kept.length;
}

// ─── Trim the dynamic banned phrase list ──────────────────────────────────────

async function trimDynamicBanned(userId) {
  const key = `${userId}:dynamicBanned`;
  const len = await redis.llen(key);
  if (!len || len <= DYNAMIC_BANNED_MAX) return 0;

  await redis.ltrim(key, 0, DYNAMIC_BANNED_MAX - 1);
  return len - DYNAMIC_BANNED_MAX;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(data) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    headers: { "Content-Type": "application/json" },
  });
}

function humanAgo(ms) {
  const h = Math.floor(ms / 3600000);
  if (h < 1)  return "earlier";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
