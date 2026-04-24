// app/api/debug/logs/route.js
//
// Reads the Redis-backed debug log so the /dev dashboard can display it.
//
//   GET    ?key=<SECRET>&limit=50   → read most recent N entries
//   DELETE ?key=<SECRET>            → wipe the log
//   POST   ?key=<SECRET>            → manual test entry (useful for
//                                     confirming the log pipeline works)

export const maxDuration = 15;
export const runtime     = "nodejs";

import { readDebugLog, clearDebugLog, logInfo } from "../../../../lib/gabriella/debugLog.js";

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

export async function GET(req) {
  if (!authorized(req)) return json({ ok: false, error: "Unauthorized" }, 401);

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 100)));
  const levelFilter = url.searchParams.get("level");
  const sourceFilter = url.searchParams.get("source");

  let entries = await readDebugLog(limit);

  if (levelFilter) {
    entries = entries.filter(e => e.level === levelFilter);
  }
  if (sourceFilter) {
    entries = entries.filter(e => e.source === sourceFilter);
  }

  // Summary of counts by level/source for quick glance.
  const byLevel  = {};
  const bySource = {};
  for (const e of entries) {
    byLevel[e.level]   = (byLevel[e.level]   || 0) + 1;
    bySource[e.source] = (bySource[e.source] || 0) + 1;
  }

  return json({
    ok: true,
    count: entries.length,
    byLevel,
    bySource,
    entries,
  });
}

export async function DELETE(req) {
  if (!authorized(req)) return json({ ok: false, error: "Unauthorized" }, 401);
  await clearDebugLog();
  return json({ ok: true, cleared: true });
}

export async function POST(req) {
  if (!authorized(req)) return json({ ok: false, error: "Unauthorized" }, 401);
  await logInfo("debug-test", "manual test log entry from /api/debug/logs", {
    userAgent: req.headers.get("user-agent"),
  });
  return json({ ok: true, wrote: true });
}
