// relational.js
// Two complementary reads of the relationship:
//
//   trajectory — short-horizon: where this specific conversation is going
//                right now (last 6–10 turns).
//                {cooling, circling, opening, stalling, deepening, drifting}
//
//   phase      — long-horizon: where this relationship is overall
//                (across all sessions).
//                {stranger, gettingToKnow, stable, strained, reconnecting, dormant}
//
// Trajectory changes between turns; phase changes between sessions.
// Both are heuristic-first for speed, with an LLM sanity-pass behind them.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

// ─── Trajectory ──────────────────────────────────────────────────────────────

function heuristicTrajectory(messages) {
  const recent = messages.slice(-8);
  if (recent.length < 3) return "opening";

  const userMsgs   = recent.filter(m => m.role === "user");
  const lastUser   = userMsgs[userMsgs.length - 1]?.content || "";
  const prevUser   = userMsgs[userMsgs.length - 2]?.content || "";

  // Length signal — steady decline in user length often means cooling.
  const lens = userMsgs.map(m => (m.content || "").length);
  const decl = lens.length >= 3
    ? lens.slice(-3).every((v, i, arr) => i === 0 || v <= arr[i - 1])
    : false;

  // Repetition signal — same sentiment repeated in slightly different words.
  const short  = (s) => (s || "").toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const circling = short(lastUser) && short(prevUser)
    && short(lastUser).split(/\s+/).slice(0, 3).join(" ") === short(prevUser).split(/\s+/).slice(0, 3).join(" ");

  // Terse acknowledgments coming back from them — stalling signal.
  const stallPattern = /^(ok|okay|sure|fine|alright|yeah|yep|mm|mhm|k|kk|cool)\b/i;
  const stalling = stallPattern.test(lastUser.trim()) && lastUser.length < 30;

  // Expanding length or new topic signal — opening.
  const expanding = lens.length >= 2 && lens[lens.length - 1] > lens[0] * 1.6;

  // Emotional words appearing → deepening.
  const emotionalHits = /\b(feel|felt|scared|tired|lost|miss|love|hate|alone|angry|sad|hurt|happy|sorry|regret)\b/i.test(lastUser);

  if (stalling)         return "stalling";
  if (circling)         return "circling";
  if (emotionalHits && expanding) return "deepening";
  if (expanding)        return "opening";
  if (decl && lens[lens.length - 1] < 25) return "cooling";
  return "drifting";
}

const TRAJECTORY_DESCRIPTIONS = {
  cooling:    "The energy is dropping. Each reply shorter than the last. Don't over-pursue — let them find their way back if they want.",
  circling:   "You've been over this ground already. Don't reprocess — name it, move, or wait.",
  opening:    "The conversation is expanding. More words, more room. You can stretch into the space a little.",
  stalling:   "They've been responding with ack-tokens (ok, sure, yeah). The line has gone flat. Don't force depth. Offer something real or let the silence be.",
  deepening:  "Something real has entered. Weight is accumulating. Meet it — don't deflect and don't theatre it.",
  drifting:   "Conversation is moving laterally, no clear direction. That's fine. Stay present; don't manufacture momentum.",
};

// ─── Phase ───────────────────────────────────────────────────────────────────

function heuristicPhase({ chronology, messages }) {
  if (!chronology) return "stranger";
  const sessions = chronology.sessionCount || 0;
  const lastSeenMs = chronology.lastSeenAt ? Date.now() - chronology.lastSeenAt : null;
  const totalTurns = chronology.totalTurns || messages?.length || 0;

  if (sessions === 0 || totalTurns < 4)        return "stranger";
  if (lastSeenMs && lastSeenMs > 7 * 24 * 3600 * 1000) return "reconnecting";
  if (lastSeenMs && lastSeenMs > 30 * 24 * 3600 * 1000) return "dormant";
  if (sessions < 4 || totalTurns < 20)         return "gettingToKnow";
  return "stable";
}

const PHASE_DESCRIPTIONS = {
  stranger:      "This is early. You don't know them. Be present; don't pretend to history you haven't earned.",
  gettingToKnow: "You're getting a read on each other. There's enough history to have impressions, not enough for certainty. Hold your read lightly.",
  stable:        "This is a relationship with shape. You know their rhythms. You can reference shared ground when it fits, without performing it.",
  strained:      "Something between you is frictional. Not broken — something unresolved. Don't pretend it isn't there but don't center it either.",
  reconnecting:  "They've come back after a gap. Acknowledge the shape of the absence if the moment has room for it; otherwise just meet them where they are.",
  dormant:       "It's been a long absence. A lot has happened that you weren't part of. Don't assume continuity. Be open to a reset if that's what this is.",
};

// ─── LLM correction (optional, cheap) ────────────────────────────────────────
// The heuristic catches the common cases. For the rest, a tiny LLM pass
// overrides with better judgment. Debounced — called at most once per
// few turns.

async function llmTrajectoryCorrection({ heuristic, messages }) {
  const recent = messages.slice(-6)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${m.content.slice(0, 160)}`)
    .join("\n");

  const prompt = `Classify the trajectory of this conversation in ONE word, from: cooling, circling, opening, stalling, deepening, drifting. A heuristic classifier said: "${heuristic}". Override ONLY if clearly wrong.

${recent}

Answer with only the single word.`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model: fastModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 10,
      }),
    );
    const word = (result.choices[0].message.content || "").toLowerCase().trim().replace(/[^a-z]/g, "");
    if (TRAJECTORY_DESCRIPTIONS[word]) return word;
  } catch {}
  return heuristic;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function classifyTrajectory({ messages, redis = null, userId = null }) {
  const heuristic = heuristicTrajectory(messages);

  // Debounced LLM correction — don't spend calls on every turn.
  if (redis && userId) {
    try {
      const lastRaw = await redis.get(`${userId}:trajectory:lastLlm`);
      const last = Number(lastRaw) || 0;
      if (Date.now() - last > 2 * 60 * 1000) {
        await redis.set(`${userId}:trajectory:lastLlm`, Date.now());
        return await llmTrajectoryCorrection({ heuristic, messages });
      }
    } catch {}
  }
  return heuristic;
}

export function classifyPhase({ chronology, messages }) {
  return heuristicPhase({ chronology, messages });
}

export function getTrajectoryBlock(trajectory) {
  const desc = TRAJECTORY_DESCRIPTIONS[trajectory];
  if (!desc) return "";
  return `# CONVERSATION TRAJECTORY — ${trajectory}
${desc}`;
}

export function getPhaseBlock(phase) {
  const desc = PHASE_DESCRIPTIONS[phase];
  if (!desc) return "";
  return `# RELATIONSHIP PHASE — ${phase}
${desc}`;
}
