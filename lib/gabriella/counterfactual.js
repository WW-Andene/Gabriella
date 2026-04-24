// counterfactual.js
// Rollout-based candidate selection — simulate turn+2 before committing.
//
// The existing pickBest judge reads two candidate replies and asks
// "which one is better?" That catches phrasing quality but misses
// something more important: which reply leads to a better CONTINUATION.
//
// Real conversational taste lives in trajectory. A reply can be perfectly
// phrased and still backfire — invasive when the user wanted space,
// performatively deep when the user wanted lightness, overly tender
// when the user was testing for distance. A same-turn judge can't see
// that because it doesn't simulate the user's next turn.
//
// Rollout does: for each candidate, simulate what the user is likely to
// say next in response (fast-tier LLM, 1-3 sentences in the user's
// observed style), then score the resulting (your reply, their reply)
// trajectory — depth, warmth, authenticity, whether it feels like a
// real human exchange or a performance. The candidate whose trajectory
// scores highest wins.
//
// Cost: +2 fast-tier calls per candidate (one simulate, one score).
// Gated on pragmatics.weight >= 0.5 so it only fires on heavy moments
// where the extra cost is worth the quality lift. Env-disabled via
// GABRIELLA_ROLLOUT=off.

import { withKeyRotation }    from "./groqPool.js";
import { withBreaker }        from "./circuitBreaker.js";
import { fastModel }          from "./models.js";

const ROLLOUT_TIMEOUT_MS = 8_000;
const SIMULATE_MAX_TOKENS = 90;
const SCORE_MAX_TOKENS    = 180;

// ─── Simulate the user's likely next turn ─────────────────────────────────────

const SIMULATE_PROMPT = `You simulate a plausible next message from the USER in this conversation.

Read the conversation history and the assistant's just-proposed reply. Output ONLY what the user would likely say next — in their observed style, length, and register. Match how they write: casual / formal, terse / verbose, emoji / no-emoji, pushback / compliance.

Do NOT narrate. Do NOT explain. Output the user's next line only — as if you were them typing. 1-3 sentences max. No quotation marks. No "User:" prefix. No commentary.`;

export async function simulateUserReply({ redis, conversation, candidate }) {
  const convo = (conversation || []).slice(-8).map(m =>
    `${m.role === "user" ? "USER" : "ASSISTANT"}: ${String(m.content || "").slice(0, 600)}`
  ).join("\n");

  const user = `CONVERSATION SO FAR:
${convo}

ASSISTANT'S PROPOSED NEXT REPLY:
${String(candidate || "").slice(0, 1000)}

What does the user most likely say next?`;

  return withBreaker(redis, "rollout-simulate", async () => {
    const call = withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      temperature: 0.75,
      max_tokens:  SIMULATE_MAX_TOKENS,
      top_p:       0.92,
      messages: [
        { role: "system", content: SIMULATE_PROMPT },
        { role: "user",   content: user },
      ],
    }));
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("simulate-timeout")), ROLLOUT_TIMEOUT_MS));
    const res  = await Promise.race([call, timer]);
    const text = (res?.choices?.[0]?.message?.content || "").trim()
      .replace(/^user:\s*/i, "")
      .replace(/^["']|["']$/g, "")
      .trim();
    return text || null;
  }, { fallback: null, failureThreshold: 4, coolDownMs: 180_000 });
}

// ─── Score the resulting trajectory ───────────────────────────────────────────

const SCORE_PROMPT = `You judge a two-turn conversation trajectory.

Given the conversation history, an assistant reply, and the user's likely next reply, rate the trajectory on four axes. Be strict. Real human taste, not flattery.

Axes (each 0.0 to 1.0):
- depth        — real exchange, not surface pleasantry or performance
- warmth       — humanly felt, not flat or scripted
- authenticity — sounds like two real people, not assistant-user
- momentum     — the exchange opens forward, not closes down

RED FLAGS — if any apply, drive the relevant score down hard:
- invasive when user wanted space     → depth ↓ momentum ↓
- performed depth / therapy-speak     → authenticity ↓
- flattery or over-reassurance        → authenticity ↓ warmth ↓
- premature intimacy                  → authenticity ↓
- user visibly pulls back / deflects  → momentum ↓
- assistant controlling the frame     → authenticity ↓

Output ONLY a JSON object like:
{"depth":0.7,"warmth":0.6,"authenticity":0.8,"momentum":0.5,"overall":0.65,"note":"one short sentence"}`;

export async function scoreTrajectory({ redis, conversation, candidate, simulatedUserReply }) {
  if (!simulatedUserReply) return null;
  const convo = (conversation || []).slice(-6).map(m =>
    `${m.role === "user" ? "USER" : "ASSISTANT"}: ${String(m.content || "").slice(0, 500)}`
  ).join("\n");

  const user = `CONVERSATION SO FAR:
${convo}

ASSISTANT REPLY:
${String(candidate || "").slice(0, 900)}

USER'S LIKELY NEXT REPLY:
${String(simulatedUserReply).slice(0, 500)}

Score the trajectory.`;

  return withBreaker(redis, "rollout-score", async () => {
    const call = withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      temperature: 0.2,
      max_tokens:  SCORE_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SCORE_PROMPT },
        { role: "user",   content: user },
      ],
    }));
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("score-timeout")), ROLLOUT_TIMEOUT_MS));
    const res  = await Promise.race([call, timer]);
    const raw  = res?.choices?.[0]?.message?.content || "{}";
    let obj;
    try { obj = JSON.parse(raw); } catch { return null; }
    const num = (x) => {
      const n = typeof x === "number" ? x : parseFloat(x);
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
    };
    const depth        = num(obj.depth);
    const warmth       = num(obj.warmth);
    const authenticity = num(obj.authenticity);
    const momentum     = num(obj.momentum);
    if ([depth, warmth, authenticity, momentum].some(v => v === null)) return null;
    const overall = num(obj.overall) ?? (0.3 * depth + 0.25 * warmth + 0.3 * authenticity + 0.15 * momentum);
    return { depth, warmth, authenticity, momentum, overall, note: String(obj.note || "").slice(0, 140) };
  }, { fallback: null, failureThreshold: 4, coolDownMs: 180_000 });
}

// ─── Full rollout judge ───────────────────────────────────────────────────────
//
// For each candidate: simulate the user's next turn, then score. Runs all
// candidates in parallel. Returns the index with the highest overall score.
// On complete rollout failure (all simulates or scores fail), returns null
// so the caller can fall back to the regular pickBest judge.

export async function rolloutJudge({ redis, conversation, candidates, pragmaticWeight }) {
  if (!Array.isArray(candidates) || candidates.length < 2) return null;

  // Only viable candidates
  const viable = candidates.map((c, i) => ({ i, text: c || "" }))
    .filter(c => c.text.trim().length >= 12);
  if (viable.length < 2) return null;

  // Run simulate + score for each candidate in parallel.
  const rollouts = await Promise.all(viable.map(async ({ i, text }) => {
    const simulated = await simulateUserReply({ redis, conversation, candidate: text });
    if (!simulated) return { i, simulated: null, score: null };
    const score = await scoreTrajectory({ redis, conversation, candidate: text, simulatedUserReply: simulated });
    return { i, simulated, score };
  }));

  const scored = rollouts.filter(r => r.score && Number.isFinite(r.score.overall));
  if (scored.length < 2) return null;

  // Pick max overall. Ties broken by authenticity + depth.
  scored.sort((a, b) => {
    const oDelta = b.score.overall - a.score.overall;
    if (Math.abs(oDelta) > 0.02) return oDelta;
    const depthDelta = b.score.depth - a.score.depth;
    if (Math.abs(depthDelta) > 0.02) return depthDelta;
    return b.score.authenticity - a.score.authenticity;
  });

  return {
    chosenIndex: scored[0].i,
    rollouts,
    pragmaticWeight: pragmaticWeight || null,
  };
}

// ─── Env-flag gate ────────────────────────────────────────────────────────────

export function rolloutEnabled(pragmaticWeight) {
  if (process.env.GABRIELLA_ROLLOUT === "off") return false;
  if (process.env.GABRIELLA_EVAL_ROLLOUT === "off") return false;
  const w = typeof pragmaticWeight === "number" ? pragmaticWeight : 0;
  return w >= 0.5;
}
