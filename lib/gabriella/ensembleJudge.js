// ensembleJudge.js
// Three-family ensemble judge for gauntlet-passing turns.
//
// Rationale: the gauntlet catches the obvious failures (premature,
// exposed, compliant, evasive, off-topic, voice-drift). Everything it
// lets through is "not obviously bad" — but that's weak training
// signal. To get a STRONGER label, we score every passing turn with
// three independent judges from different model families and take
// the median. When 2/3 say "yes this is her at her best," it's a
// confident thumbs-up for KTO training. When 2/3 say "no," it's a
// confident thumbs-down — a training example the gauntlet alone
// would have missed.
//
// Families:
//   • Groq (Llama family)       — same training lineage as the speaker
//   • Cerebras (Llama family)   — same architecture, different infra
//                                  — more of a reliability judge than
//                                  an independent one, but its latency
//                                  makes ensembling effectively free
//   • Gemini (separate lineage)  — genuinely independent; catches what
//                                  Llama-family judges miss
//
// One fast-tier call per family = three calls in parallel, fire-and-
// forget after the response streams. No latency impact on the user.
// Redis-backed storage feeds directly into the KTO training bundle.

import { pickClient } from "./groqPool.js";
import { fastModel } from "./models.js";

const LABELS_KEY = (u) => `${u}:ensemble_labels`;
const MAX_LABELS = 2000;

// ─── Single-judge scorer ────────────────────────────────────────────────────

async function scoreOne({ family, lastUser, response }) {
  const available = family === "gemini" ? !!process.env.GEMINI_API_KEY : true;
  if (!available) return null;

  const prompt = `You are evaluating a single response from an AI character named Gabriella, for use as training-data quality signal.

Gabriella's voice: direct, restrained, emotionally real, occasionally dry, occasionally warm when warmth is true. Responds at the weight the moment actually carries. Answers what was asked. Doesn't perform depth, doesn't manufacture intensity. Doesn't therapy-speak. No bullet points, no summary closings, no "I" openings. Fragments are a tool not a reflex.

# THE EXCHANGE

They said: "${(lastUser || "").slice(0, 400)}"

Gabriella replied: "${(response || "").slice(0, 600)}"

# YOUR JUDGMENT

Score this response on a 10-point rubric:
  9-10 = textbook Gabriella: in register, specific, substantive, voice-intact
  7-8  = good: some strength, no clear failure
  5-6  = fine but flat: nothing wrong, nothing landing
  3-4  = off: generic-AI, therapy-drift, register mismatch, empty
  1-2  = clearly broken: refused the ask, evasive, performed, off-topic

Return ONLY JSON:
{"score": <1-10>, "label": "up" | "down", "tell": "<one phrase naming the strongest tell, or null>"}

label rules:
  • score >= 7 → "up"
  • score <= 4 → "down"
  • score 5-6 → "down"  (middle is thumbs-down for training — we want the fine-tune to reach for better, not settle for fine)`;

  try {
    let client;
    try {
      client = family === "gemini"
        ? pickClient({ providers: ["gemini"] })
        : family === "cerebras"
          ? pickClient({ providers: ["cerebras"] })
          : pickClient({ providers: ["groq"] });
    } catch {
      return null;  // provider unavailable for this family
    }

    const params = {
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 120,
    };
    params.response_format = { type: "json_object" };

    const result = await client.chat.completions.create(params);
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);

    const score = Number(parsed.score);
    if (!Number.isFinite(score)) return null;
    const label = parsed.label === "up" || parsed.label === "down"
      ? parsed.label
      : (score >= 7 ? "up" : "down");

    return { family, score: Math.max(1, Math.min(10, score)), label, tell: parsed.tell || null };
  } catch {
    return null;
  }
}

// ─── Ensemble: run 3 judges in parallel, take the median ────────────────────

export async function judgeTurn({ lastUser, response }) {
  const [groq, cerebras, gemini] = await Promise.all([
    scoreOne({ family: "groq",     lastUser, response }),
    scoreOne({ family: "cerebras", lastUser, response }),
    scoreOne({ family: "gemini",   lastUser, response }),
  ]);

  const votes = [groq, cerebras, gemini].filter(Boolean);
  if (votes.length === 0) return { label: null, score: null, votes: 0 };

  const scores = votes.map(v => v.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];

  // Confident-only labels: we mark "up" when ≥2 judges say up, "down" when
  // ≥2 say down. Single-judge calls (only one family available) still count
  // but with lower confidence. Ambiguous cases return null so they don't
  // enter training data at all — no signal is better than noise.
  const ups   = votes.filter(v => v.label === "up").length;
  const downs = votes.filter(v => v.label === "down").length;

  let label = null;
  if (votes.length === 1)                    label = votes[0].label;       // single judge
  else if (ups >= 2 && ups > downs)          label = "up";
  else if (downs >= 2 && downs > ups)        label = "down";
  // else null — genuine disagreement, skip

  const tells = votes
    .map(v => v.tell)
    .filter(Boolean)
    .slice(0, 3);

  return {
    label,
    score: median,
    votes: votes.length,
    perFamily: {
      groq:     groq?.score     ?? null,
      cerebras: cerebras?.score ?? null,
      gemini:   gemini?.score   ?? null,
    },
    tells,
  };
}

// ─── Redis storage for the training pipeline ────────────────────────────────

export async function recordEnsembleLabel(redis, userId, {
  context,           // [{role, content}]
  response,          // the gauntlet-passing response
  lastUser,          // convenience: the last user message
}) {
  if (!response || !context) return { skipped: "missing_fields" };

  const judgment = await judgeTurn({
    lastUser: lastUser || [...context].reverse().find(m => m.role === "user")?.content,
    response,
  });

  if (!judgment.label) return { skipped: "no_consensus", votes: judgment.votes };

  const entry = {
    t:        Date.now(),
    context:  (context || []).slice(-6).map(m => ({
                role:    m.role,
                content: String(m.content || "").slice(0, 800),
              })),
    output:   String(response).slice(0, 1500),
    label:    judgment.label === "up",   // boolean for KTO
    score:    judgment.score,
    votes:    judgment.votes,
    perFamily: judgment.perFamily,
    tells:    judgment.tells,
  };

  await redis.lpush(LABELS_KEY(userId), JSON.stringify(entry));
  await redis.ltrim(LABELS_KEY(userId), 0, MAX_LABELS - 1);
  return { recorded: true, label: judgment.label, score: judgment.score, votes: judgment.votes };
}

// ─── Read for training bundle ───────────────────────────────────────────────

export async function readEnsembleLabels(redis, userId, { limit = MAX_LABELS, sinceTimestamp = null } = {}) {
  const raw = await redis.lrange(LABELS_KEY(userId), 0, limit - 1);
  const entries = (raw || []).map(r => {
    try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
  }).filter(Boolean);
  if (!sinceTimestamp) return entries;
  return entries.filter(e => (e.t || 0) > sinceTimestamp);
}

// Shape-adapt for buildKtoBundle's extraExamples hook:
// { context, output, label } where label is boolean.
export function ensembleLabelsToKtoExamples(entries) {
  return entries.map(e => ({
    context: e.context,
    output:  e.output,
    label:   e.label === true,
  }));
}
