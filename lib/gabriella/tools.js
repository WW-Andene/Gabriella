// tools.js
// Agent-shaped tool layer. Gives Gabriella a small, bounded ability to
// ACT on the user's behalf — not just converse.
//
// Design shape (Phase D v1):
//
//   detectToolIntent(text, context)
//     Fast classifier (single LLM call) run AFTER shape() but BEFORE
//     gauntlet. Reads the final response text in the context of what
//     the user last said, and decides whether Gabriella just committed
//     to an action. Returns { tool, args, confidence } or null.
//
//   executeTool({ tool, args }, { redis, userId })
//     Dispatches to the tool's implementation. Implementations are
//     defensive — they never throw past the caller; instead they
//     return { ok: false, reason } so the per-turn pipeline can decide
//     whether to surface a failure.
//
// Tools in this release:
//
//   pin      — save a user-specified important thing to a pinned list
//              the system prompt surfaces every turn. ("remember this.")
//   remind   — schedule a pendingThought to activate at a future time.
//              The initiate cron sweeps scheduled thoughts and surfaces
//              due ones the same way any other pending thought is
//              surfaced. ("remind me to call mom at 3pm.")
//
// Conservative defaults: only fire when the classifier returns a
// confidence >= 0.7. Anything ambiguous stays off — false positives
// (she pins something the user didn't ask to be pinned) are much worse
// than false negatives.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

const MIN_CONFIDENCE = 0.7;

// ─── Detection ──────────────────────────────────────────────────────────────

// Given the final response and the last user message, classify whether
// a tool invocation is appropriate. Returns null if no tool, or
// { tool, args, confidence } if one is.
export async function detectToolIntent({ response, lastUserMessage } = {}) {
  if (!response || !lastUserMessage) return null;

  // Cheap pre-filter — skip the LLM call entirely when neither message
  // contains a trigger word. The LLM classifier is still the authority;
  // this is just a cost gate.
  const maybeRelevant =
    /\b(remind|remember|pin|save|note|don't forget|save this|mark|bookmark|later|tomorrow|tonight|in (an |a few |\d+) (hours?|minutes?|days?)|at \d|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i
      .test(lastUserMessage + " " + response);
  if (!maybeRelevant) return null;

  const prompt = `You classify whether an AI assistant named Gabriella just committed to ONE of the following actions in her reply:

TOOLS:
  pin     — she agreed to remember / pin / save something specific the user said.
  remind  — she agreed to remind the user of something at a specific time or delay.

If she did NONE of these, return { "tool": null }. Do NOT invent an intent that isn't clearly there. If she was vaguely reflecting about memory without actually agreeing to pin, that's null. If the user asked her to remind but she only acknowledged without committing to do it, that's null.

USER JUST SAID:
"${lastUserMessage.slice(0, 500)}"

GABRIELLA'S REPLY:
"${response.slice(0, 500)}"

Return ONLY JSON matching one of these shapes:
  { "tool": null, "confidence": 0.0 }
  { "tool": "pin", "args": { "what": "the thing to remember, 1 sentence, specific" }, "confidence": 0.0-1.0 }
  { "tool": "remind", "args": { "what": "what to remind the user of, 1 sentence", "when": "natural-language time like 'in 1 hour' or 'tomorrow at 9am' or 'next monday'" }, "confidence": 0.0-1.0 }

Confidence >= 0.7 only when the commitment is explicit. Lower otherwise.`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model: fastModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 200,
      }),
    );
    const raw = result.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(raw.replace(/```(?:json)?/g, "").trim());
    if (!parsed.tool || !["pin", "remind"].includes(parsed.tool)) return null;
    if ((parsed.confidence ?? 0) < MIN_CONFIDENCE) return null;
    if (parsed.tool === "pin"    && !parsed.args?.what) return null;
    if (parsed.tool === "remind" && (!parsed.args?.what || !parsed.args?.when)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Execution ──────────────────────────────────────────────────────────────

const PINNED_KEY     = (u) => `${u}:pinned`;
const SCHEDULED_KEY  = (u) => `${u}:scheduledThoughts`;
const PINNED_MAX     = 30;
const SCHEDULED_MAX  = 100;

export async function executeTool({ tool, args }, { redis, userId } = {}) {
  if (!redis || !userId) return { ok: false, reason: "no redis/userId" };

  if (tool === "pin") {
    return await runPin({ args, redis, userId });
  }
  if (tool === "remind") {
    return await runRemind({ args, redis, userId });
  }
  return { ok: false, reason: `unknown tool: ${tool}` };
}

async function runPin({ args, redis, userId }) {
  try {
    const text = String(args?.what || "").trim().slice(0, 200);
    if (!text) return { ok: false, reason: "empty pin text" };

    const existing = await redis.lrange(PINNED_KEY(userId), 0, PINNED_MAX - 1);
    const existingList = existing || [];
    // Dedupe — don't pin the same text twice.
    const already = existingList.some(e => {
      try { return JSON.parse(e)?.text?.toLowerCase() === text.toLowerCase(); } catch { return false; }
    });
    if (already) {
      return { ok: true, tool: "pin", text, duplicate: true };
    }

    const entry = JSON.stringify({ text, pinnedAt: Date.now() });
    await redis.lpush(PINNED_KEY(userId), entry);
    await redis.ltrim(PINNED_KEY(userId), 0, PINNED_MAX - 1);

    return { ok: true, tool: "pin", text };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

async function runRemind({ args, redis, userId }) {
  try {
    const text = String(args?.what || "").trim().slice(0, 300);
    const whenRaw = String(args?.when || "").trim();
    if (!text || !whenRaw) return { ok: false, reason: "missing what/when" };

    const dueAt = parseNaturalTime(whenRaw);
    if (!dueAt) return { ok: false, reason: `could not parse time: "${whenRaw}"` };
    if (dueAt < Date.now() - 60_000) return { ok: false, reason: "requested time is in the past" };

    const existing = await redis.lrange(SCHEDULED_KEY(userId), 0, SCHEDULED_MAX - 1);
    const entry = JSON.stringify({
      text,
      dueAt,
      createdAt: Date.now(),
      origin: "tool:remind",
    });
    await redis.lpush(SCHEDULED_KEY(userId), entry);
    await redis.ltrim(SCHEDULED_KEY(userId), 0, SCHEDULED_MAX - 1);

    return {
      ok: true,
      tool: "remind",
      text,
      dueAt,
      dueIso: new Date(dueAt).toISOString(),
      humanWhen: describeDueAt(dueAt),
    };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

// ─── Natural-time parser ────────────────────────────────────────────────────
// Covers the common cases without pulling in a dependency. Falls back to
// null on anything weird (caller should surface a gentle error).

export function parseNaturalTime(input, now = Date.now()) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();

  // "in 30 minutes", "in 2 hours", "in 3 days"
  const rel = s.match(/^in\s+(\d+)\s*(second|sec|minute|min|hour|hr|day)s?$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2];
    const mult =
      /sec/.test(unit)  ? 1000 :
      /min/.test(unit)  ? 60_000 :
      /hour|hr/.test(unit) ? 3_600_000 :
      /day/.test(unit)  ? 86_400_000 : null;
    if (mult) return now + n * mult;
  }

  // "in an hour" / "in a minute" / "in a few hours" / "in a day"
  const rel2 = s.match(/^in\s+(a|an|a few)\s+(second|sec|minute|min|hour|hr|day)s?$/);
  if (rel2) {
    const n = rel2[1] === "a few" ? 3 : 1;
    const unit = rel2[2];
    const mult =
      /sec/.test(unit)  ? 1000 :
      /min/.test(unit)  ? 60_000 :
      /hour|hr/.test(unit) ? 3_600_000 :
      /day/.test(unit)  ? 86_400_000 : null;
    if (mult) return now + n * mult;
  }

  // "tomorrow", "tomorrow at 9am", "tomorrow morning"
  if (/^tomorrow\b/.test(s)) {
    const d = new Date(now + 86_400_000);
    const timeMatch = s.match(/(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ap = timeMatch[3];
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      d.setHours(h, m, 0, 0);
    } else if (/morning/.test(s)) {
      d.setHours(9, 0, 0, 0);
    } else if (/afternoon/.test(s)) {
      d.setHours(14, 0, 0, 0);
    } else if (/evening/.test(s)) {
      d.setHours(19, 0, 0, 0);
    } else if (/night/.test(s)) {
      d.setHours(21, 0, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    return d.getTime();
  }

  // "tonight"
  if (/^tonight\b/.test(s)) {
    const d = new Date(now);
    d.setHours(21, 0, 0, 0);
    if (d.getTime() < now) d.setTime(d.getTime() + 86_400_000);
    return d.getTime();
  }

  // "at 3pm" / "at 15:30"
  const atTime = s.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (atTime) {
    const d = new Date(now);
    let h = parseInt(atTime[1], 10);
    const m = atTime[2] ? parseInt(atTime[2], 10) : 0;
    const ap = atTime[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    d.setHours(h, m, 0, 0);
    if (d.getTime() < now) d.setTime(d.getTime() + 86_400_000);
    return d.getTime();
  }

  // "next monday" / "on friday"
  const dayNames = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const dayMatch = s.match(/(?:next |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (dayMatch) {
    const target = dayNames.indexOf(dayMatch[1]);
    const d = new Date(now);
    const current = d.getDay();
    let delta = target - current;
    if (delta <= 0 || /^next /.test(s)) delta += 7;
    d.setDate(d.getDate() + delta);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  }

  return null;
}

function describeDueAt(ts) {
  const now = Date.now();
  const diff = ts - now;
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `in ${days} day${days === 1 ? "" : "s"}`;
  return new Date(ts).toISOString().slice(0, 10);
}

// ─── Retrieval helpers (used by engine.js for system-prompt surfacing) ──────

export async function loadPinned(redis, userId) {
  try {
    const raw = await redis.lrange(PINNED_KEY(userId), 0, PINNED_MAX - 1);
    return (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function loadScheduledThoughts(redis, userId) {
  try {
    const raw = await redis.lrange(SCHEDULED_KEY(userId), 0, SCHEDULED_MAX - 1);
    return (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// Drain due scheduled thoughts — move them from scheduled list into
// pendingThoughts so the next turn's interiority block surfaces them.
// Called by the initiate cron.
export async function drainDueScheduledThoughts(redis, userId, now = Date.now()) {
  const scheduled = await loadScheduledThoughts(redis, userId);
  if (scheduled.length === 0) return { drained: 0 };

  const due     = scheduled.filter(s => (s?.dueAt || 0) <= now);
  const pending = scheduled.filter(s => (s?.dueAt || 0) > now);
  if (due.length === 0) return { drained: 0 };

  // Rewrite the list with only the not-yet-due ones.
  try {
    await redis.del(SCHEDULED_KEY(userId));
    if (pending.length > 0) {
      await redis.lpush(SCHEDULED_KEY(userId), ...pending.map(p => JSON.stringify(p)));
    }
  } catch {}

  // Push each due item into pendingThoughts as an initiation-style hit.
  try {
    const existing = await redis.get(`${userId}:pendingThoughts`).catch(() => null);
    let list = [];
    if (existing) {
      try { list = typeof existing === "string" ? JSON.parse(existing) : existing; } catch { list = []; }
    }
    if (!Array.isArray(list)) list = [];
    for (const d of due) {
      list.push({
        text:      `You'd told them you'd bring this up now: ${d.text}`,
        charge:    "wanting-to-return",
        origin:    "tool:remind",
        createdAt: Date.now(),
      });
    }
    await redis.set(`${userId}:pendingThoughts`, JSON.stringify(list));
  } catch {}

  return { drained: due.length };
}

export function getPinnedBlock(pinned) {
  if (!Array.isArray(pinned) || pinned.length === 0) return "";
  const lines = pinned.slice(0, 8)
    .map(p => `— ${p.text}`)
    .join("\n");
  return `# PINNED (things they asked you to remember)

${lines}

These are explicit "hold onto this" items. Not things to recite — things that are allowed to shape what you reach for, what you follow up on, what you notice.`;
}
