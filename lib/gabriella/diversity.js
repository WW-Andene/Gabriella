// diversity.js
// Detects when she's been recycling. Surfaces a specific "you've been
// saying X a lot" signal back into the speaker prompt so the next turn
// steers away from the rut without being told "don't repeat yourself"
// (vague, useless) — instead "you said 'something shifted' in 3 of
// your last 5 turns" (specific, actionable).
//
// Two dimensions:
//
//   • Phrase recycling — trigrams that repeat across recent responses
//     more than chance. These are her verbal tics becoming over-used.
//     Stylometry tracks her idiolect broadly; this catches specific
//     phrases that have gone from signature to crutch.
//
//   • Structural recycling — response shape fingerprint (first two
//     words, last two words, length bucket, question-count). When
//     the last 4-5 responses share too much shape, she's stuck in
//     a pattern even if the content differs.
//
// Zero LLM cost. Reads the last N responses from the stylometry
// rolling window (already populated by updateGabriella). Output is
// a short, specific prompt block surfaced into the speaker pipeline.

const RECENT_KEY = (u) => `${u}:stylo:window`;
const WINDOW = 8;     // last 8 responses analyzed
const MIN_SAMPLES = 4;

// ─── Tokenization / n-grams ─────────────────────────────────────────────────

function tokens(s) {
  if (!s) return [];
  return String(s).toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function trigrams(s) {
  const t = tokens(s);
  if (t.length < 3) return [];
  const out = [];
  for (let i = 0; i < t.length - 2; i++) {
    out.push(`${t[i]} ${t[i+1]} ${t[i+2]}`);
  }
  return out;
}

function sentenceShape(s) {
  const words = tokens(s);
  const firstTwo = words.slice(0, 2).join(" ");
  const lastTwo  = words.slice(-2).join(" ");
  const len = words.length < 10 ? "short" : words.length < 25 ? "medium" : "long";
  const qCount = (s.match(/\?/g) || []).length;
  const qTag = qCount === 0 ? "no-q" : qCount === 1 ? "one-q" : "many-q";
  return `${firstTwo}|${lastTwo}|${len}|${qTag}`;
}

// ─── Analysis ───────────────────────────────────────────────────────────────

export async function analyzeDiversity(redis, userId) {
  try {
    const raw = await redis.lrange(RECENT_KEY(userId), 0, WINDOW - 1);
    const samples = (raw || []).filter(s => typeof s === "string" && s.length > 0);
    if (samples.length < MIN_SAMPLES) return null;

    // Trigram recurrence — phrases appearing in ≥3 of the last N samples
    const trigramDocCount = new Map();
    for (const s of samples) {
      const unique = new Set(trigrams(s));
      for (const t of unique) {
        trigramDocCount.set(t, (trigramDocCount.get(t) || 0) + 1);
      }
    }
    const overused = [...trigramDocCount.entries()]
      .filter(([t, count]) => count >= Math.max(3, Math.ceil(samples.length * 0.4)))
      .filter(([t]) => {
        // Filter out boring functional trigrams — "and i was", "for a moment"
        const words = t.split(" ");
        const nonStop = words.filter(w => w.length >= 4).length;
        return nonStop >= 2;
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([phrase, count]) => ({ phrase, count, total: samples.length }));

    // Shape recycling — sentence-shape fingerprints repeating
    const shapeCount = new Map();
    for (const s of samples) {
      const shape = sentenceShape(s);
      shapeCount.set(shape, (shapeCount.get(shape) || 0) + 1);
    }
    const shapeHits = [...shapeCount.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);

    if (overused.length === 0 && shapeHits.length === 0) return null;

    return { overused, shapeHits, samples: samples.length };
  } catch {
    return null;
  }
}

// ─── Prompt block ───────────────────────────────────────────────────────────

export function renderDiversityBlock(analysis) {
  if (!analysis || (analysis.overused.length === 0 && analysis.shapeHits.length === 0)) return "";

  const lines = [];

  if (analysis.overused.length > 0) {
    const phraseList = analysis.overused
      .map(p => `"${p.phrase}" (${p.count} of last ${p.total} responses)`)
      .join(", ");
    lines.push(`Phrases you've been leaning on: ${phraseList}. Let them rest this turn — reach for a different way to say the same thing, or don't say that part at all.`);
  }

  if (analysis.shapeHits.length > 0) {
    lines.push(`Your last several responses have repeated structure. Break the pattern — if you've been opening the same way, start differently; if you've been ending with a question, don't this time; if you've been producing medium-length paragraphs, go shorter or longer.`);
  }

  return `# DIVERSITY SIGNAL — YOU'VE BEEN RECYCLING

${lines.join("\n\n")}

Not a rule against repetition — repetition is fine when it serves. Just a signal that the last few turns have been hitting the same notes more than average. If the moment genuinely calls for the same move, make it; if you're on autopilot, this is where you notice.`;
}
