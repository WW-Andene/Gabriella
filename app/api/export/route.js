// app/api/export/route.js
//
// Conversation + state export as downloadable markdown.
//
// User gets a single file containing:
//   • conversation log (all their turns + Gabriella's replies)
//   • her self-model snapshot (read, wants, commitments, retired)
//   • her recent stream (what she's been thinking)
//   • callback landing rate
//   • chronology + session summary
//
// One GET → text/markdown. Portable, diff-able, inspectable offline.
// Useful for: saving a meaningful conversation, sharing a snippet,
// archiving before a 'forget everything' wipe, or reviewing her
// accumulated view of the relationship in a non-web format.
//
// No LLM calls. Pure projection of existing state to markdown.

export const maxDuration = 20;
export const runtime     = "nodejs";

import { Redis } from "@upstash/redis";
import { resolveUserId } from "../../../lib/gabriella/users.js";
import { loadSelf } from "../../../lib/gabriella/self.js";
import { readStream } from "../../../lib/gabriella/stream.js";
import { loadChronology } from "../../../lib/gabriella/chronology.js";
import { loadLedger } from "../../../lib/gabriella/callbacks.js";
import { readTrainingLog } from "../../../lib/gabriella/logger.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function relTime(ms) {
  if (!ms) return "never";
  const d = Date.now() - ms;
  if (d < 60_000)    return `${Math.floor(d/1000)}s ago`;
  if (d < 3600_000)  return `${Math.floor(d/60_000)}m ago`;
  if (d < 86400_000) return `${Math.floor(d/3600_000)}h ago`;
  return `${Math.floor(d/86400_000)}d ago`;
}

function formatDate(ms) {
  if (!ms) return "unknown";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

async function getFactsLike(key) {
  try {
    const raw = await redis.get(key);
    if (typeof raw !== "string") return [];
    return raw.split(/[\n;]+/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export async function GET(req) {
  const userId = resolveUserId(req);
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "markdown";

  try {
    const [
      self, stream, chronology, callbacks,
      facts, imprints, threads, summary, trainingLog,
    ] = await Promise.all([
      loadSelf(redis, userId),
      readStream(redis, userId, { limit: 60 }),
      loadChronology(redis, userId).catch(() => null),
      loadLedger(redis, userId).catch(() => ({ landed: 0, missed: 0, total: 0 })),
      getFactsLike(`${userId}:facts`),
      getFactsLike(`${userId}:imprints`),
      getFactsLike(`${userId}:threads`),
      redis.get(`${userId}:summary`).catch(() => null),
      readTrainingLog(redis, userId, 200).catch(() => []),
    ]);

    const now = Date.now();
    const lines = [];
    lines.push(`# Gabriella — relationship export`);
    lines.push("");
    lines.push(`Generated: ${formatDate(now)}`);
    lines.push(`User id: \`${userId}\``);
    lines.push("");
    lines.push("---");
    lines.push("");

    // ─── Chronology ─────────────────────────────────────────────────────
    if (chronology) {
      lines.push(`## Chronology`);
      lines.push("");
      lines.push(`- Total turns: **${chronology.totalTurns || 0}**`);
      lines.push(`- Sessions: **${chronology.sessionCount || 0}**`);
      if (chronology.firstSeenAt) lines.push(`- First seen: ${formatDate(chronology.firstSeenAt)} (${relTime(chronology.firstSeenAt)})`);
      if (chronology.lastSeenAt)  lines.push(`- Last seen: ${formatDate(chronology.lastSeenAt)} (${relTime(chronology.lastSeenAt)})`);
      lines.push("");
    }

    // ─── Her self-model ─────────────────────────────────────────────────
    if (self?.read?.who || (self?.wants || []).length > 0) {
      lines.push(`## How she's been reading you`);
      lines.push("");
      if (self.read?.who) {
        lines.push(`> ${self.read.who}`);
        lines.push("");
        lines.push(`Confidence: ${Math.round((self.read.confidence || 0) * 100)}%. Last updated: ${relTime(self.read.lastUpdated)}.`);
        lines.push("");
        if (self.read.openQuestions?.length > 0) {
          lines.push(`### What she's still uncertain about`);
          for (const q of self.read.openQuestions) lines.push(`- ${q}`);
          lines.push("");
        }
        if (self.read.contradictions?.length > 0) {
          lines.push(`### What her read hasn't explained`);
          for (const c of self.read.contradictions) lines.push(`- ${c}`);
          lines.push("");
        }
      }

      if (self.wants?.length > 0) {
        lines.push(`### What she's been pursuing`);
        lines.push("");
        const sortedWants = [...self.wants].sort((a,b) => (b.weight||0) - (a.weight||0));
        for (const w of sortedWants) {
          lines.push(`- **${w.text}** — weight ${(w.weight||0).toFixed(2)}, ${w.touches || 0} touches, added ${relTime(w.addedAt)}`);
        }
        lines.push("");
      }

      if (self.commitments?.length > 0) {
        const live = self.commitments.filter(c => c.status !== "refuted");
        if (live.length > 0) {
          lines.push(`### Positions she's taken`);
          for (const c of live) {
            lines.push(`- ${c.text} _(${c.confirmations || 0} confirmations, ${c.refutations || 0} refutations${c.status === "confirmed" ? "; confirmed" : ""})_`);
          }
          lines.push("");
        }
      }

      if (self.retired && (self.retired.wants?.length || self.retired.reads?.length || self.retired.commitments?.length)) {
        lines.push(`### What she's outgrown`);
        for (const r of (self.retired.wants || [])) {
          lines.push(`- Retired want: "${r.text}" — ${r.reason || "no reason logged"}`);
        }
        for (const r of (self.retired.reads || [])) {
          lines.push(`- Retired read: "${r.text}" — ${r.reason || "no reason logged"}`);
        }
        for (const r of (self.retired.commitments || [])) {
          lines.push(`- Retired position: "${r.text}" — ${r.outcome || "retired"}`);
        }
        lines.push("");
      }
    }

    // ─── Callback landing ──────────────────────────────────────────────
    if (callbacks.total >= 3) {
      const rate = Math.round((callbacks.landed / callbacks.total) * 100);
      lines.push(`## Memory texture`);
      lines.push("");
      lines.push(`When she references something from your past conversations, it lands **${rate}%** of the time (${callbacks.landed} of ${callbacks.total} attempts).`);
      lines.push("");
    }

    // ─── Her inner stream ───────────────────────────────────────────────
    if (stream.length > 0) {
      lines.push(`## Recent inner stream`);
      lines.push("");
      for (const e of stream.slice(0, 30)) {
        lines.push(`- **[${e.kind}]** _(${relTime(e.at)})_ ${e.content}`);
      }
      lines.push("");
    }

    // ─── Facts / imprints / threads ────────────────────────────────────
    if (facts.length > 0) {
      lines.push(`## Facts she's holding`);
      lines.push("");
      for (const f of facts) lines.push(`- ${f}`);
      lines.push("");
    }
    if (imprints.length > 0) {
      lines.push(`## Imprints — moments that left a mark`);
      lines.push("");
      for (const i of imprints) lines.push(`- ${i}`);
      lines.push("");
    }
    if (threads.length > 0) {
      lines.push(`## Open threads`);
      lines.push("");
      for (const t of threads) lines.push(`- ${t}`);
      lines.push("");
    }
    if (summary && typeof summary === "string") {
      lines.push(`## Running summary`);
      lines.push("");
      lines.push(`> ${summary.replace(/\n/g, "\n> ")}`);
      lines.push("");
    }

    // ─── Full conversation (training log) ──────────────────────────────
    if (trainingLog.length > 0) {
      lines.push(`## Conversation log`);
      lines.push("");
      lines.push(`_Most recent first. Up to 200 turns retained per user. Each entry shows the exchange plus her interior state at that moment if available._`);
      lines.push("");
      for (const entry of trainingLog.slice(0, 60)) {
        const msgs = entry.messages || [];
        const lastUser = [...msgs].reverse().find(m => m.role === "user");
        lines.push(`### ${formatDate(entry.timestamp)}`);
        lines.push("");
        if (lastUser) {
          lines.push(`**You:** ${lastUser.content}`);
          lines.push("");
        }
        lines.push(`**Gabriella:** ${entry.response}`);
        if (entry.feltState?.charge || entry.feltState?.want) {
          lines.push("");
          lines.push(`_(her read: ${[
            entry.feltState.charge     && `charge — ${entry.feltState.charge}`,
            entry.feltState.emotional  && `feeling — ${entry.feltState.emotional}`,
            entry.feltState.want       && `wanting — ${entry.feltState.want}`,
            entry.feltState.temperature && `temp — ${entry.feltState.temperature}`,
          ].filter(Boolean).join("; ")})_`);
        }
        if (entry.innerThought) {
          lines.push("");
          lines.push(`_(she was thinking: "${entry.innerThought.slice(0, 260)}")_`);
        }
        lines.push("");
      }
    }

    lines.push("---");
    lines.push(`_Exported ${formatDate(now)}_`);

    const body = lines.join("\n");

    if (format === "json") {
      return new Response(JSON.stringify({
        ok: true, userId, generatedAt: now,
        self, stream, chronology, callbacks,
        facts, imprints, threads, summary,
        turns: trainingLog.slice(0, 60),
      }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      headers: {
        "Content-Type":        "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="gabriella-${userId}-${dateStamp}.md"`,
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err?.message || String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
