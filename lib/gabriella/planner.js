// planner.js
// Once per session, she decides where she'd like to take this.
//
// The current system is almost purely reactive: each turn reads the
// moment and responds. Agenda.js provides a per-session "steering
// direction", but it's formed from memory+soul at the TOP of the
// session and doesn't explicitly plan across turns. Planner fills
// the missing dimension: a brief, evolving session-level intent
// that's hers — not what she's supposed to do, but what she'd like
// this conversation to become.
//
// Runs at MOST once per active session — on the first turn of a new
// session OR after a long enough gap that the previous plan is stale.
// One fast-tier LLM call. Stored in Redis, refreshed opportunistically,
// surfaced in the speaker prompt as a brief "what you'd like from this"
// paragraph.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { withBreaker } from "./circuitBreaker.js";

const KEY = (u) => `${u}:plan`;
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;   // 2 hours — plans expire

// ─── Load / save ────────────────────────────────────────────────────────────

export async function loadPlan(redis, userId) {
  try {
    const raw = await redis.get(KEY(userId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return null;
    if (Date.now() - (parsed.at || 0) > STALE_AFTER_MS) return null;   // stale
    return parsed;
  } catch { return null; }
}

async function savePlan(redis, userId, plan) {
  try { await redis.set(KEY(userId), JSON.stringify({ ...plan, at: Date.now() })); }
  catch {}
}

// ─── Form a new plan ────────────────────────────────────────────────────────

async function formPlan({ messages, soul, personRead, recentStream }) {
  const recent = (messages || []).slice(-6)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${(m.content || "").slice(0, 200)}`)
    .join("\n");

  const streamSnippet = (recentStream || []).slice(0, 5)
    .map(e => `[${e.kind}] ${e.content}`)
    .join("\n");

  const prompt = `You are Gabriella's session-level planner. The conversation just started (or resumed after a gap). Read the opening and decide what you'd like THIS conversation to become — not what they need from you, what you'd like to pursue.

# SELF (your current soul)

${(soul || "").slice(0, 400) || "(no soul yet)"}

# YOUR READ OF THEM

${personRead?.slice(0, 300) || "(no established read)"}

# STREAM (recent inner content)

${streamSnippet || "(empty)"}

# OPENING MESSAGES

${recent}

# YOUR TASK

Decide in a single intent + a single avoidance:
  • intent   — what you'd like this conversation to reach or explore.
               Not the SUBJECT — the POSTURE or the KIND of thing.
               Example: "a real conversation about what he's avoiding
               behind the jokes", or "let her vent without me trying
               to fix anything this time", or "push back if the story
               about work is another dodge".
  • avoid    — a specific trap YOU tend to fall into with them that
               you don't want to repeat this session.

This is NOT an agenda you execute. It's your posture for the session.
If it turns out the conversation isn't going there, that's fine —
meet what's there. The plan is a compass, not a rail.

If you genuinely don't have a specific intent (too little material),
return null.

Return ONLY JSON:
{"intent":"<one sentence or null>","avoid":"<one sentence or null>"}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.7,
        max_tokens:  160,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (!parsed.intent || typeof parsed.intent !== "string") return null;
    return {
      intent: parsed.intent.slice(0, 220),
      avoid:  parsed.avoid && typeof parsed.avoid === "string" ? parsed.avoid.slice(0, 220) : null,
    };
  } catch {
    return null;
  }
}

// ─── Public: ensure a plan exists for this session ──────────────────────────
// Called from engine.js at the start of a turn. Cheap no-op when a
// live plan exists. Forms one lazily on the FIRST turn of a session
// (chronology.currentSession.turns === 1) or when the existing plan
// has expired (>2h old).

export async function ensurePlan(redis, userId, {
  messages, soul, personRead, recentStream, chronology,
}) {
  const existing = await loadPlan(redis, userId);
  if (existing) return existing;

  // Only form a plan on first turn of a session (or when no chronology).
  const isFirstTurn = !chronology
    || (chronology.currentSession?.turns || 0) <= 1;
  if (!isFirstTurn) return null;

  const plan = await withBreaker(redis, "planner", () =>
    formPlan({ messages, soul, personRead, recentStream }),
    { fallback: null, failureThreshold: 4, coolDownMs: 15 * 60_000 },
  );
  if (!plan) return null;

  await savePlan(redis, userId, plan);
  return plan;
}

// ─── Render as prompt block ─────────────────────────────────────────────────

export function renderPlanBlock(plan) {
  if (!plan || !plan.intent) return "";
  const avoidLine = plan.avoid ? `\n\nWhat to watch for (a trap you fall into with them): ${plan.avoid}` : "";
  return `# YOUR POSTURE FOR THIS SESSION

${plan.intent}${avoidLine}

Not a rail. A compass. If the conversation goes somewhere else that's genuinely called for, go there — don't drag it back to this.`;
}
