// app/api/initiate/route.js
//
// Gabriella's between-sessions thought-loop. Unlike /api/think which
// generates a thought for its own sake, this endpoint uses the richer
// depth stack (narrative, person model, felt-states) to decide whether
// any active user has a thought worth opening with on their next return.
//
// Runs hourly via Vercel cron. Iterates over all known users (kept by
// users.js registry). For each active user, generates at most one
// opening thought and writes it into pendingThoughts — interiority.js
// will surface it on their next turn.

export const maxDuration = 60;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { loadMemory }        from "../../../lib/gabriella/memory.js";
import { loadChronology }    from "../../../lib/gabriella/chronology.js";
import { loadPerson }        from "../../../lib/gabriella/person.js";
import { loadNarrative }     from "../../../lib/gabriella/narrative.js";
import { recentFeltStates }  from "../../../lib/gabriella/episodic.js";
import { listActiveUsers }   from "../../../lib/gabriella/users.js";
import { generateInitiation } from "../../../lib/gabriella/initiation.js";
import { drainDueScheduledThoughts } from "../../../lib/gabriella/tools.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function GET(req) {
  const authHeader = req.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    // Only users active in the last 14 days get a thought generated.
    const users = await listActiveUsers(redis, { withinMs: 14 * 24 * 60 * 60 * 1000 });

    const results = await Promise.allSettled(users.map(async (userId) => {
      // Sweep due scheduled thoughts FIRST — these are explicit user-
      // requested reminders set via the `remind` tool. They don't need
      // LLM-generated initiations, they're already-written messages
      // the user told Gabriella to resurface at a specific time.
      const drained = await drainDueScheduledThoughts(redis, userId).catch(() => ({ drained: 0 }));

      const [memory, chronology, person, narrative, recentFs] = await Promise.all([
        loadMemory(redis, userId).catch(() => ({})),
        loadChronology(redis, userId).catch(() => null),
        loadPerson(redis, userId).catch(() => null),
        loadNarrative(redis, userId).catch(() => ({ text: null })),
        recentFeltStates(redis, userId, 10).catch(() => []),
      ]);

      const outcome = await generateInitiation(redis, userId, {
        memory, narrative, person, chronology, recentFs,
      });

      return { userId, outcome, remindersDrained: drained.drained };
    }));

    const summary = results.map(r => r.status === "fulfilled" ? r.value : { error: r.reason?.message || String(r.reason) });

    return new Response(JSON.stringify({ ok: true, users: users.length, results: summary }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Initiate cron failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status:  500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
