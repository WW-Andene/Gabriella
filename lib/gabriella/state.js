// state.js
// Persistent emotional + organism state — a small vector that carries
// across turns. Extended in Phase 2 from purely emotional to include
// organism-level dimensions that modulate HOW she expresses, not just
// what she's feeling.
//
// Different from mood (atmospheric, slow, diurnal) and from felt-state
// (per-turn, computed fresh). Organism state is the medium-term substrate
// of HER AS AN ORGANISM — tired or rested, tracking or drifting,
// comfortable or not with this specific person in this specific moment.
//
// Dimensions (0..1 each):
//
//   Emotional (original):
//     openness    — how much of herself she's willing to show right now
//     alertness   — how closely she's tracking; opposite of drift/floating
//     care        — warmth activated toward this specific person this moment
//     irritation  — friction; accumulated frustration or being-misread
//     warmth      — baseline affection for this person (slower-moving than care)
//
//   Organism (new in Phase 2):
//     energy         — how much she has to give. Low = terser, less precise,
//                      more disfluency, reaches for familiar phrases.
//                      Depletes with intense turns, restores with rest.
//     attention      — quality of tracking right NOW. Low = generic-ish
//                      responses, misses callbacks, doesn't catch subtext.
//                      Different from alertness: alertness is 'am I on';
//                      attention is 'how sharp am I while on'.
//     socialComfort  — how at-ease she is with this specific person in this
//                      specific moment. Builds with consistent good
//                      interaction; drops with cold moments, long gaps,
//                      perceived judgments. Gates how much the Observer
//                      leads vs. the Manager/Protector taking over.
//
// Care is a short-timescale signal; warmth is long. Energy has a natural
// recovery curve between sessions. Attention tracks real-time; doesn't
// carry across gaps. SocialComfort is slowest-moving — relationship-level.

import { pickClient, withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";

const DEFAULT_STATE = {
  // Emotional
  openness:      0.55,
  alertness:     0.65,
  care:          0.40,
  irritation:    0.05,
  warmth:        0.50,
  // Organism (new)
  energy:        0.70,   // starts rested
  attention:     0.65,   // starts focused
  socialComfort: 0.50,   // starts neutral; builds with familiarity
  updatedAt:     0,
};

const STATE_KEY = (u) => `${u}:affectState`;

// Half-lives in ms — different signals decay at different rates.
// Short-timescale: alertness, care, irritation, attention
// Medium-timescale: energy (recovers between sessions)
// Long-timescale: openness, warmth, socialComfort
const HALF_LIFE = {
  // Emotional
  openness:      60 * 60 * 1000,        //  1 hour
  alertness:     15 * 60 * 1000,        //  15 min
  care:          30 * 60 * 1000,        //  30 min
  irritation:    20 * 60 * 1000,        //  20 min
  warmth:        12 * 60 * 60 * 1000,   //  12 hours
  // Organism
  energy:        90 * 60 * 1000,        //  90 min — recovery curve between sessions
  attention:     10 * 60 * 1000,        //  10 min — focus erodes without fresh input
  socialComfort: 24 * 60 * 60 * 1000,   //  24 hours — relationship-level slowness
};

// Resting values — what each dimension decays TOWARD, not toward zero.
// Gabriella's baseline is curious, moderately warm, rested, moderately
// focused, neutral-comfort.
const REST = {
  // Emotional
  openness:      0.55,
  alertness:     0.60,
  care:          0.35,
  irritation:    0.02,
  warmth:        0.50,
  // Organism — rest values pull toward rested/focused/comfortable as
  // the baseline state, not toward zero.
  energy:        0.75,   // with time she returns to rested
  attention:     0.60,   // without fresh input, drifts toward moderate-not-sharp
  socialComfort: 0.50,   // absent info, drifts toward neutral (not 0)
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
