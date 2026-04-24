// idiolect.js
// Her evolving vocabulary — the words and constructions she's been
// reaching for that aren't generic.
//
// The stylometry module captures HOW she speaks (rhythm, punctuation).
// This module captures WHAT lexical material she's been using —
// specifically: distinctive words, recurring phrases, pet constructions
// that have emerged over her run of responses. Not imposed from a list;
// discovered from her own output.
//
// Method: TF-IDF-style comparison of her recent response corpus against
// a generic-English baseline (we use a ~1k common-word stopset). Words
// that appear in her output much more frequently than their English
// baseline are her distinctive vocabulary. Adjacent-bigrams that
// repeat are her pet phrases. Both surface in the speaker prompt as
// "words that have been coming up for you lately" — not instructions,
// observations.
//
// Why it matters: over many turns, the base model wants to drift toward
// generic vocabulary (that's where the training data is densest). This
// creates a counter-signal: her voice has certain markers; reinforce
// them.

const RECENT_KEY = (u) => `${u}:idiolect:recent`;
const FP_KEY     = (u) => `${u}:idiolect:fp`;
const MAX_RECENT = 40;

// Common-English stopset — frequent words whose presence in her corpus
// is uninformative because they're frequent everywhere. Kept compact
// (curated top-200 by English web frequency).
const STOP = new Set([
  "the","a","an","and","or","but","if","then","because","so","as","than","that","which","who","whom",
  "what","where","when","why","how","all","any","both","each","few","more","most","other","some","such",
  "no","not","only","own","same","too","very","can","will","just","don","should","now","is","are","was",
  "were","be","been","being","have","has","had","do","does","did","doing","does","did","a","an","the",
  "i","me","my","mine","myself","you","your","yours","yourself","yourselves","he","him","his","himself",
  "she","her","hers","herself","it","its","itself","we","us","our","ours","ourselves","they","them",
  "their","theirs","themselves","this","that","these","those","am","being","been","being","having",
  "get","got","going","gone","let","lets","make","made","see","seen","say","said","know","known","think",
  "thought","take","took","taken","come","came","one","two","three","first","last","next","some","any",
  "something","nothing","everything","anything","someone","nobody","everybody","anybody","here","there",
  "about","into","through","during","before","after","above","below","between","under","over","off","on",
  "up","down","out","from","with","without","of","to","in","at","for","by","like","also","still","yet",
  "really","actually","maybe","probably","perhaps","basically","essentially","literally","honestly",
  "kind","sort","type","part","way","time","thing","way","lot","bit","little","much","many","few","lots",
  "good","bad","ok","okay","yes","no","yeah","yep","nope","right","wrong","fine","sure","well","hey",
  "hi","hello","oh","um","uh","guess","feel","feeling","felt","want","wanting","wanted","need","needing",
  "needed","going","gone","went","look","looking","looked","seem","seems","seemed","seeming","someone",
]);

// ─── Record a response ──────────────────────────────────────────────────────

export async function recordForIdiolect(redis, userId, text) {
  if (!text || typeof text !== "string") return;
  const clean = text.trim();
  if (clean.length < 30) return;
  try {
    await redis.lpush(RECENT_KEY(userId), clean.slice(0, 1500));
    await redis.ltrim(RECENT_KEY(userId), 0, MAX_RECENT - 1);
  } catch {}
}

// ─── Compute distinctiveness ────────────────────────────────────────────────

function tokenize(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w));
}

function computeIdiolect(samples) {
  if (samples.length < 5) return null;

  // Unigram frequencies across her corpus
  const unigrams = new Map();
  let totalTokens = 0;
  for (const s of samples) {
    for (const w of tokenize(s)) {
      unigrams.set(w, (unigrams.get(w) || 0) + 1);
      totalTokens++;
    }
  }
  if (totalTokens < 60) return null;

  // "Distinctiveness" proxy: words appearing in ≥30% of her samples but
  // NOT in the stopset are likely her vocabulary signature. Filters out
  // one-off uses (topic-specific to a single conversation).
  const samplesCount = samples.length;
  const signature = [];
  for (const [word, count] of unigrams.entries()) {
    const samplesWithIt = samples.filter(s => tokenize(s).includes(word)).length;
    const docFreq = samplesWithIt / samplesCount;
    // Heuristic: appears in ≥25% of samples AND ≥3 absolute occurrences
    if (docFreq >= 0.25 && count >= 3) {
      signature.push({
        word,
        count,
        docFreq: +docFreq.toFixed(2),
        score: count * docFreq,
      });
    }
  }
  signature.sort((a, b) => b.score - a.score);

  // Bigram phrase detection — adjacent two-word pairs that recur ≥3x.
  const bigrams = new Map();
  for (const s of samples) {
    const tokens = s.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (STOP.has(a) && STOP.has(b)) continue;   // all-stop bigrams uninteresting
      if (a.length < 3 || b.length < 3) continue;
      const key = `${a} ${b}`;
      bigrams.set(key, (bigrams.get(key) || 0) + 1);
    }
  }
  const phrases = [...bigrams.entries()]
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([phrase, count]) => ({ phrase, count }));

  return {
    samples: samples.length,
    totalTokens,
    signatureWords: signature.slice(0, 12),
    emergingPhrases: phrases,
    updatedAt: Date.now(),
  };
}

// ─── Public: update + persist ───────────────────────────────────────────────

export async function updateIdiolect(redis, userId) {
  try {
    const raw = await redis.lrange(RECENT_KEY(userId), 0, MAX_RECENT - 1);
    const samples = (raw || []).filter(s => typeof s === "string");
    const fp = computeIdiolect(samples);
    if (!fp) return null;
    await redis.set(FP_KEY(userId), JSON.stringify(fp));
    return fp;
  } catch { return null; }
}

export async function loadIdiolect(redis, userId) {
  try {
    const raw = await redis.get(FP_KEY(userId));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return null; }
}

// ─── Render as prompt block ─────────────────────────────────────────────────
// Observational, not instructional. Lets her see her own evolving
// idiolect and stay consistent with it without freezing it.

export function renderIdiolectBlock(fp) {
  if (!fp || !fp.signatureWords || fp.signatureWords.length < 3) return "";

  const words = fp.signatureWords.slice(0, 8)
    .map(w => `"${w.word}"`)
    .join(", ");

  const phrases = fp.emergingPhrases?.length
    ? "\nPhrases you've been returning to: " +
      fp.emergingPhrases.slice(0, 5).map(p => `"${p.phrase}"`).join(", ") + "."
    : "";

  return `# YOUR IDIOLECT (words that have been yours lately)

Words that have been coming up for you more than average: ${words}.${phrases}

Not a list to work from — a mirror of what your speech has been reaching for. Honor it without forcing it; if a different word is the right one here, use the different word.`;
}
