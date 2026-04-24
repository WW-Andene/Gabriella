// app/api/memory/route.js
//
// User-facing memory inspector + editor. The user can see what
// Gabriella thinks she knows about them — and delete specific items
// she got wrong. Most chat products can't offer this because they
// don't have a structured memory to inspect. Gabriella does.
//
// GET    /api/memory          — list facts, imprints, threads, pinned items
// DELETE /api/memory          — body { kind, index }  (by position in the
//                                list as returned by GET; simplest UX)
// DELETE /api/memory?all=1    — wipe ALL memory (facts + imprints + threads
//                                + self + stream). "forget me" button.
//
// Deletions take effect immediately. The self-model isn't re-seeded;
// she'll form a new read from subsequent conversation.

export const runtime     = "nodejs";
export const maxDuration = 20;

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ─── GET — inspect ──────────────────────────────────────────────────────────

async function getKeySafe(key) {
  try { return await redis.get(key); } catch { return null; }
}

function splitFacts(raw) {
  if (typeof raw !== "string") return [];
  return raw.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
}

export async function GET(req) {
  const userId = resolveUserId(req);
  try {
    const [facts, imprints, summary, threads, pinnedRaw] = await Promise.all([
      getKeySafe(`${userId}:facts`),
      getKeySafe(`${userId}:imprints`),
      getKeySafe(`${userId}:summary`),
      getKeySafe(`${userId}:threads`),
      getKeySafe(`${userId}:pinned`),
    ]);

    const pinned = pinnedRaw
      ? (typeof pinnedRaw === "string" ? JSON.parse(pinnedRaw) : pinnedRaw)
      : [];

    return new Response(JSON.stringify({
      ok: true,
      userId,
      facts:    splitFacts(facts),
      imprints: splitFacts(imprints),
      threads:  splitFacts(threads),
      summary:  typeof summary === "string" ? summary : null,
      pinned:   Array.isArray(pinned) ? pinned : [],
    }, null, 2), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── DELETE — edit or wipe ──────────────────────────────────────────────────

async function removeLineAtIndex(key, index) {
  const raw = await getKeySafe(key);
  if (typeof raw !== "string") return { ok: false, reason: "empty" };
  const lines = splitFacts(raw);
  if (index < 0 || index >= lines.length) return { ok: false, reason: "out_of_range" };
  lines.splice(index, 1);
  await redis.set(key, lines.join("\n"));
  return { ok: true, remaining: lines.length };
}

async function wipeAll(userId) {
  // Simple, enumerated wipe — the keys we know the user-model lives under.
  // Does NOT delete speaker-state, training_log, daily-eval history etc.
  // — those are system-level, not user-content.
  const keys = [
    `${userId}:facts`,
    `${userId}:imprints`,
    `${userId}:summary`,
    `${userId}:threads`,
    `${userId}:pinned`,
    `${userId}:self`,
    `${userId}:stream`,
    `${userId}:stream:meta`,
    `${userId}:person`,
    `${userId}:register`,
    `${userId}:authorial`,
    `${userId}:narrative`,
    `${userId}:soul`,
    `${userId}:evolution`,
    `${userId}:mood`,
    `${userId}:pendingThoughts`,
    `${userId}:desires`,
    `${userId}:desiresSetAt`,
    `${userId}:mirror:state`,
    `${userId}:mirror:lastLlm`,
    `${userId}:plan`,
    `${userId}:callbacks`,
    `${userId}:callbacks:ledger`,
    `${userId}:withheld`,
    `${userId}:debt`,
    `${userId}:agenda`,
    `${userId}:thresholds`,
    `${userId}:imaginal`,
    `${userId}:reasoning:trace`,
    `${userId}:stylo:window`,
    `${userId}:stylo:fingerprint`,
    `${userId}:idiolect:recent`,
    `${userId}:idiolect:fp`,
  ];

  await Promise.all(keys.map(k => redis.del(k).catch(() => null)));
  return { ok: true, wiped: keys.length };
}

export async function DELETE(req) {
  const userId = resolveUserId(req);
  const { searchParams } = new URL(req.url);

  try {
    if (searchParams.get("all") === "1") {
      const result = await wipeAll(userId);
      return new Response(JSON.stringify({ ok: true, ...result }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const kind = body?.kind;
    const index = Number(body?.index);
    if (!kind || !Number.isFinite(index)) {
      return new Response(JSON.stringify({ ok: false, error: "provide {kind, index}" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const keyMap = {
      facts:    `${userId}:facts`,
      imprints: `${userId}:imprints`,
      threads:  `${userId}:threads`,
    };

    if (kind === "pinned") {
      // Pinned is a JSON array, not \n-delimited.
      const raw = await getKeySafe(`${userId}:pinned`);
      if (!raw) return new Response(JSON.stringify({ ok: false, error: "no pinned items" }), { status: 404 });
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!Array.isArray(arr) || index < 0 || index >= arr.length) {
        return new Response(JSON.stringify({ ok: false, error: "out of range" }), { status: 400 });
      }
      arr.splice(index, 1);
      await redis.set(`${userId}:pinned`, JSON.stringify(arr));
      return new Response(JSON.stringify({ ok: true, remaining: arr.length }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const key = keyMap[kind];
    if (!key) {
      return new Response(JSON.stringify({ ok: false, error: `unknown kind: ${kind}` }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const result = await removeLineAtIndex(key, index);
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 400,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
