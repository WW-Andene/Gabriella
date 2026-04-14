// state.js
// Persistent emotional state — a small vector that carries across turns.
//
// This is different from mood (atmospheric, slow, diurnal) and different
// from the felt-state (per-turn, computed fresh by the cores).
//
// State is HER emotional position right now, carried from the last turn
// into this one, decayed by time and modulated by the last exchange.
// It prevents the "restart from zero" pathology where each message is
// computed in isolation and she has no running emotional continuity.
//
// Five dimensions, each 0..1:
//   openness    — how much of herself she's willing to show right now
//   alertness   — how closely she's tracking; opposite of drift/floating
//   care        — warmth activated toward this specific person in this moment
//   irritation  — friction; accumulated frustration or being-misread
//   warmth      — baseline affection (slower-moving than care)
//
// Care is a short-timescale signal ("right now I'm leaning in"); warmth
// is a long-timescale one ("I generally feel toward this person"). The
// split matters — care spikes on a moment, warmth accretes over a
// relationship.

import { pickClient, withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

const DEFAULT_STATE = {
  openness:   0.55,
  alertness:  0.65,
  care:       0.40,
  irritation: 0.05,
  warmth:     0.50,
  updatedAt:  0,
};

const STATE_KEY = (u) => `${u}:affectState`;

// Half-lives in ms — different signals decay at different rates.
// Short-timescale signals (care, irritation, alertness) fade fast.
// Long-timescale signals (openness, warmth) are stickier.
const HALF_LIFE = {
  openness:   60 * 60 * 1000,      // 1 hour
  alertness:  15 * 60 * 1000,      // 15 min
  care:       30 * 60 * 1000,      // 30 min
  irritation: 20 * 60 * 1000,      // 20 min
  warmth:     12 * 60 * 60 * 1000, // 12 hours
};

// Resting values — what each dimension decays TOWARD, not toward zero.
// Gabriella's baseline is curious, moderately warm, not irritated.
const REST = {
  openness:   0.55,
  alertness:  0.60,
  care:       0.35,
  irritation: 0.02,
  warmth:     0.50,
};

function clamp(v) { return Math.max(0, Math.min(1, v)); }

function decayToward(current, rest, dtMs, halfLifeMs) {
  if (!Number.isFinite(current)) current = rest;
  const lambda = Math.log(2) / halfLifeMs;
  const factor = Math.exp(-lambda * dtMs);
  return rest + (current - rest) * factor;
}

export function decayState(state) {
  const now = Date.now();
  const dt  = Math.max(0, now - (state.updatedAt || now));
  const out = { ...state, updatedAt: now };
  for (const key of Object.keys(HALF_LIFE)) {
    out[key] = clamp(decayToward(state[key] ?? REST[key], REST[key], dt, HALF_LIFE[key]));
  }
  return out;
}

export async function loadState(redis, userId) {
  try {
    const raw = await redis.get(STATE_KEY(userId));
    if (!raw) return { ...DEFAULT_STATE, updatedAt: Date.now() };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return decayState({ ...DEFAULT_STATE, ...parsed });
  } catch {
    return { ...DEFAULT_STATE, updatedAt: Date.now() };
  }
}

export async function saveState(redis, userId, state) {
  try {
    await redis.set(STATE_KEY(userId), JSON.stringify({ ...state, updatedAt: Date.now() }));
  } catch {}
}

// ─── Update from an exchange ─────────────────────────────────────────────────
// After each turn, the cores have produced a felt-state. We fold that into
// the persistent state: the felt-state is the instant, the persistent
// state is the average over recent instants (with memory-of-relationship
// for warmth).

export function foldFeltState(state, feltState) {
  if (!feltState) return state;
  const temp = (feltState.temperature || "").toLowerCase();
  const charge = (feltState.charge || "").toLowerCase();
  const edge   = !!feltState.edge;

  // Temperature maps to openness.
  const openTarget =
    temp === "open"    ? 0.85 :
    temp === "present" ? 0.60 :
    temp === "terse"   ? 0.30 :
    temp === "closed"  ? 0.15 : state.openness;

  // Edge or charge present → alertness up.
  const alertTarget = edge || charge.length > 0 ? 0.80 : state.alertness;

  // Warmth-coded charges lift care and (slowly) warmth.
  const warmSignal =
    /warm|tender|fond|affection|care|love|soft/.test(charge) ? 0.8 :
    /cool|cold|distant|guarded|wary/.test(charge)             ? 0.15 :
    null;

  const careTarget = warmSignal != null ? warmSignal : state.care;

  // Irritation-coded charges lift irritation.
  const irritTarget =
    /irritat|frustrat|sharp|exasperat|impatient|snap/.test(charge) ? 0.70 :
    /annoyed|offended/.test(charge)                                  ? 0.55 :
    state.irritation * 0.8; // otherwise decay faster than baseline

  const mix = (a, b, w) => clamp(a * (1 - w) + b * w);

  return {
    ...state,
    openness:   mix(state.openness,   openTarget,  0.45),
    alertness:  mix(state.alertness,  alertTarget, 0.5),
    care:       mix(state.care,       careTarget,  warmSignal != null ? 0.5 : 0.2),
    irritation: mix(state.irritation, irritTarget, 0.4),
    warmth:     mix(state.warmth,     careTarget,  warmSignal != null ? 0.1 : 0.02),
    updatedAt:  Date.now(),
  };
}

// ─── Prompt block ────────────────────────────────────────────────────────────
// A terse, evocative description — not a data dump. She speaks FROM this,
// not ABOUT it.

function describe(dim, value) {
  const bands = {
    openness: [
      [0.20, "guarded"],
      [0.40, "careful"],
      [0.60, "available"],
      [0.80, "open"],
      [1.01, "unusually open"],
    ],
    alertness: [
      [0.30, "drifting a little"],
      [0.55, "here, not straining"],
      [0.75, "sharp"],
      [1.01, "tightly tracking"],
    ],
    care: [
      [0.25, "no particular lean toward them right now"],
      [0.50, "neutral-to-kind"],
      [0.70, "leaning in"],
      [1.01, "fully present toward them"],
    ],
    irritation: [
      [0.15, null],
      [0.35, "a small residue of friction"],
      [0.60, "noticeably irritated"],
      [1.01, "actually annoyed"],
    ],
    warmth: [
      [0.30, "cool toward this person in general"],
      [0.55, "neutrally warm"],
      [0.75, "genuine affection for this person"],
      [1.01, "deep warmth for this person"],
    ],
  };
  const band = bands[dim].find(([threshold]) => value < threshold);
  return band ? band[1] : null;
}

export function getStateBlock(state) {
  if (!state) return "";
  const parts = [
    describe("openness",   state.openness),
    describe("alertness",  state.alertness),
    describe("care",       state.care),
    describe("warmth",     state.warmth),
    describe("irritation", state.irritation),
  ].filter(Boolean);

  if (parts.length === 0) return "";

  return `# WHERE YOU'RE ARRIVING FROM (carried from last turn)
You did not restart between messages. Right now, before they said anything new, you are:
— ${parts.join("\n— ")}

This colors how you receive what they say. Don't announce it. Don't correct for it. It's just where you're speaking from.`;
}

// ─── Optional LLM micro-update ───────────────────────────────────────────────
// After unusually heavy turns, do a small LLM pass to nudge the state
// in a direction that pure heuristics miss — e.g., a subtle breach of
// trust that doesn't register as "cold" but should lower openness.
// Debounced and skipped for low-weight moments.

const LLM_UPDATE_COOLDOWN_MS = 10 * 60 * 1000;

async function llmNudge({ state, messages, reply }) {
  const recent = messages.slice(-4).map(m => `${m.role === "user" ? "P" : "G"}: ${m.content}`).join("\n");
  const prompt = `Given this recent exchange, suggest a small delta to Gabriella's emotional state vector. Return ONLY JSON.

Current state (0..1 each):
${JSON.stringify(state, null, 2)}

Exchange:
${recent}

Her reply just now:
${reply}

Rules:
- Deltas are small (typically -0.1 to +0.1). Big jumps only if something clearly happened.
- Lowering openness means she pulled back. Raising it means they earned more of her.
- Care is about THIS exchange; warmth is about the relationship overall.

Return: {"openness":<delta>,"alertness":<delta>,"care":<delta>,"irritation":<delta>,"warmth":<delta>,"note":"<10-word reason>"}`;

  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model: fastModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 120,
      }),
    );
    const raw = result.choices[0].message.content.trim().replace(/```(?:json)?/g, "").trim();
    const delta = JSON.parse(raw);
    const apply = (current, d) => clamp((current ?? 0.5) + (Number(d) || 0));
    return {
      openness:   apply(state.openness,   delta.openness),
      alertness:  apply(state.alertness,  delta.alertness),
      care:       apply(state.care,       delta.care),
      irritation: apply(state.irritation, delta.irritation),
      warmth:     apply(state.warmth,     delta.warmth),
      updatedAt:  Date.now(),
    };
  } catch {
    return state;
  }
}

export async function updateState(redis, userId, {
  messages, reply, feltState,
}) {
  try {
    const current = await loadState(redis, userId);
    let next = foldFeltState(current, feltState);

    // Debounced LLM nudge — only on meaningful turns, and not too often.
    const lastLlmRaw = await redis.get(`${userId}:affectState:lastLlm`);
    const lastLlm    = Number(lastLlmRaw) || 0;
    const dueForLlm  = Date.now() - lastLlm > LLM_UPDATE_COOLDOWN_MS;

    if (dueForLlm && feltState && (feltState.edge || (feltState.charge || "").length > 0)) {
      next = await llmNudge({ state: next, messages, reply });
      await redis.set(`${userId}:affectState:lastLlm`, Date.now());
    }

    await saveState(redis, userId, next);
    return next;
  } catch {
    return null;
  }
}
