// stylometry.js
// Per-user fingerprint of HOW she's been speaking lately.
//
// Voice drift is one of the most common failure modes in long-running
// character chat systems: the base model's helpfulness bias slowly
// pulls every response toward the average, and "she" starts sounding
// like a well-prompted generic assistant after enough turns. The
// gauntlet catches severe drift via the voice-drift check. This
// module catches GRADUAL drift by tracking her actual stylometry
// — sentence lengths, punctuation patterns, vocabulary — and surfacing
// it in the prompt as a signal the speaker reads.
//
// The trick: don't rewrite voice.js (authored). Instead, observe
// what her voice has ACTUALLY been, fingerprint it, and let the
// observed fingerprint anchor future responses. The result is a
// feedback loop where her stylistic center of gravity is her own
// recent output, not the base-model average.
//
// Maintained as a rolling window of the last N responses (N=30).
// On each update: compute stats over the whole window, render as a
// prompt block, persist. Cheap — text math, no LLM calls.

const WINDOW_KEY = (u) => `${u}:stylo:window`;
const FINGERPRINT_KEY = (u) => `${u}:stylo:fingerprint`;
const MAX_WINDOW = 30;
const MIN_FOR_FINGERPRINT = 6;   // need enough samples to average

// ─── Record a new response ──────────────────────────────────────────────────

export async function recordResponse(redis, userId, text) {
  if (!text || typeof text !== "string") return;
  const clean = text.trim();
  if (clean.length < 30) return;   // too short to stylometrize usefully

  try {
    await redis.lpush(WINDOW_KEY(userId), clean.slice(0, 1500));
    await redis.ltrim(WINDOW_KEY(userId), 0, MAX_WINDOW - 1);
  } catch { /* non-fatal */ }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

function sentenceLengths(text) {
  // Rough sentence split on . ! ? followed by whitespace or end
  return text.split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => s.split(/\s+/).length);
}

function charCountOf(text, re) {
  return (text.match(re) || []).length;
}

function computeStats(samples) {
  if (samples.length === 0) return null;

  const allSentLens = [];
  let totalChars = 0;
  let totalSentences = 0;

  let dashes = 0;
  let emdashes = 0;
  let semis = 0;
  let parens = 0;
  let ellipses = 0;
  let commas = 0;
  let questions = 0;
  let fragments = 0;       // sentences < 5 words
  let startsWithI = 0;
  let startsWithConjunction = 0;   // "But", "And", "So" — a voice tell

  let firstWordBag = {};   // top sentence-starters

  for (const text of samples) {
    totalChars += text.length;
    const lens = sentenceLengths(text);
    totalSentences += lens.length;
    for (const len of lens) {
      allSentLens.push(len);
      if (len < 5) fragments++;
    }

    dashes   += charCountOf(text, / - /g);
    emdashes += charCountOf(text, /—/g);
    semis    += charCountOf(text, /;/g);
    parens   += charCountOf(text, /\(/g);
    ellipses += charCountOf(text, /\.\.\./g);
    commas   += charCountOf(text, /,/g);
    questions += charCountOf(text, /\?/g);

    // Sentence starters
    const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    for (const s of sentences) {
      const firstWord = s.split(/\s+/)[0]?.replace(/[^A-Za-z']/g, "");
      if (!firstWord) continue;
      if (/^I$/.test(firstWord)) startsWithI++;
      if (/^(But|And|So|Or|Yet|Though|Still)$/i.test(firstWord)) startsWithConjunction++;
      const key = firstWord.toLowerCase();
      firstWordBag[key] = (firstWordBag[key] || 0) + 1;
    }
  }

  const mean = allSentLens.length
    ? allSentLens.reduce((a, b) => a + b, 0) / allSentLens.length
    : 0;
  const variance = allSentLens.length
    ? allSentLens.reduce((s, x) => s + (x - mean) ** 2, 0) / allSentLens.length
    : 0;
  const stddev = Math.sqrt(variance);

  const topStarters = Object.entries(firstWordBag)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([w, c]) => `${w} (${c})`);

  return {
    samples: samples.length,
    totalChars,
    totalSentences,
    avgSentenceLen:     +mean.toFixed(1),
    sentenceLenStddev:  +stddev.toFixed(1),
    fragmentRate:       totalSentences ? +(fragments / totalSentences).toFixed(2) : 0,
    questionRate:       totalSentences ? +(questions / totalSentences).toFixed(2) : 0,
    // Punctuation frequency per 1000 chars — normalizes across varying volume
    emdashPer1k:    totalChars ? +((emdashes * 1000) / totalChars).toFixed(2) : 0,
    dashPer1k:      totalChars ? +((dashes   * 1000) / totalChars).toFixed(2) : 0,
    semiPer1k:      totalChars ? +((semis    * 1000) / totalChars).toFixed(2) : 0,
    ellipsisPer1k:  totalChars ? +((ellipses * 1000) / totalChars).toFixed(2) : 0,
    commaPer1k:     totalChars ? +((commas   * 1000) / totalChars).toFixed(2) : 0,
    parenPer1k:     totalChars ? +((parens   * 1000) / totalChars).toFixed(2) : 0,
    startsWithIRate:          totalSentences ? +(startsWithI / totalSentences).toFixed(2) : 0,
    startsWithConjunctionRate:totalSentences ? +(startsWithConjunction / totalSentences).toFixed(2) : 0,
    topStarters,
  };
}

// ─── Public: compute + persist fingerprint ─────────────────────────────────

export async function updateFingerprint(redis, userId) {
  try {
    const raw = await redis.lrange(WINDOW_KEY(userId), 0, MAX_WINDOW - 1);
    const samples = (raw || []).filter(s => typeof s === "string" && s.length > 0);
    if (samples.length < MIN_FOR_FINGERPRINT) return null;

    const stats = computeStats(samples);
    if (!stats) return null;

    await redis.set(FINGERPRINT_KEY(userId), JSON.stringify({
      stats,
      updatedAt: Date.now(),
    }));
    return stats;
  } catch {
    return null;
  }
}

// ─── Load + render ──────────────────────────────────────────────────────────

export async function loadFingerprint(redis, userId) {
  try {
    const raw = await redis.get(FINGERPRINT_KEY(userId));
    if (!raw) return null;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed?.stats || null;
  } catch {
    return null;
  }
}

// Render as a speaker-prompt block — concise observational paragraph.
// The speaker sees how SHE has been speaking lately and naturally drifts
// toward that center rather than the base-model average.
export function renderStylometryBlock(stats) {
  if (!stats || !stats.samples || stats.samples < MIN_FOR_FINGERPRINT) return "";

  const rhythmNote = stats.avgSentenceLen < 8
    ? "terse rhythm — most sentences under 8 words"
    : stats.avgSentenceLen < 14
    ? "clipped to medium rhythm — sentences land around 10-13 words"
    : "longer rhythm — sentences running 14+ words on average";

  const fragNote = stats.fragmentRate > 0.25
    ? "fragments work for you — about 1 in 4 sentences runs short of 5 words"
    : stats.fragmentRate > 0.12
    ? "fragments occasional — you use them but don't default to them"
    : "fragments rare — mostly full-sentence structure";

  const punctNote = [];
  if (stats.emdashPer1k >= 2.0) punctNote.push("em-dashes are a tell of yours");
  if (stats.semiPer1k   >= 0.4) punctNote.push("you semicolon more than most");
  if (stats.ellipsisPer1k >= 0.8) punctNote.push("ellipses when the thought trails");
  if (stats.parenPer1k  >= 0.8) punctNote.push("parentheticals are natural for you");
  const punctLine = punctNote.length
    ? punctNote.join("; ")
    : "no strong punctuation signature yet";

  const openerLine = stats.startsWithIRate > 0.2
    ? `you've been starting with "I" ${Math.round(stats.startsWithIRate * 100)}% of the time — higher than you usually do; watch it`
    : stats.startsWithConjunctionRate > 0.15
    ? `you've been opening with a conjunction (but/and/so/yet) ${Math.round(stats.startsWithConjunctionRate * 100)}% of the time — a voice tell of yours`
    : `openings spread across: ${stats.topStarters.slice(0, 4).join(", ")}`;

  return `# YOUR RECENT VOICE SHAPE (from your last ${stats.samples} responses)

Rhythm: ${rhythmNote}.
Fragments: ${fragNote}.
Punctuation signature: ${punctLine}.
Opening pattern: ${openerLine}.

This is what your actual voice has been doing lately — not an instruction, an observation. Let it anchor you. If this turn would pull you far from that center, that's fine when the moment calls for it, but don't drift unconsciously.`;
}
