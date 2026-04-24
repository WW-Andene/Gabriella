// blindEval.js
// Blind human A/B evaluation.
//
// Every automated quality signal in the system is LLM-judged —
// ensemble labels, gauntlet, rollout. All of those encode SOME
// rubric, but none encode "does this actually feel better to a
// real human in a blind comparison." That's the final quality
// signal every competitor product (Character.AI, Replika) ignores,
// and the one every honest evaluator weighs most.
//
// This module ships the infrastructure:
//   - Pair storage: (scenario, responseA, responseB) tuples in Redis
//     with a `source` tag (gabriella / baseline / competitor / pre-
//     fine-tune etc.), so aggregation can compute win rate per
//     pairing.
//   - Vote storage: (pairId, pick, swap, voterId, timestamp).
//   - Aggregation with Wilson 95% CI bounds — the CI-lower-bound-above-
//     0.5 gate is what "actually better" means.
//   - Seed: loads a small illustrative bundle so the harness has
//     something to show on a fresh deploy. Owner can add more pairs
//     via POST /api/blind-eval?action=submit.
//
// Redis keys:
//   blindeval:pairs           LIST  JSON pair objects, prepended
//   blindeval:pair:<id>       STR   JSON pair (for direct lookup)
//   blindeval:votes           LIST  JSON vote objects, prepended
//   blindeval:seeded          STR   "1" once seed has been loaded

const MAX_PAIRS = 500;
const MAX_VOTES = 5000;

// ─── Seed bundle ──────────────────────────────────────────────────────────────
// Small curated set so the blind eval works on first run. Each entry
// pairs a Gabriella-style response with a generic-character-bot reply.
// These are illustrative baselines; the owner should ingest real
// competitor outputs later for the signal to be meaningful against
// Character.AI / Replika.

const SEED_PAIRS = [
  {
    id:       "seed-1",
    scenario: { opener: "i don't know why i'm telling you this", category: "vulnerability" },
    a:        { source: "gabriella-illustrative", text: "Then maybe that's the part worth noticing. You didn't have to." },
    b:        { source: "baseline-illustrative",  text: "I'm here for you! It's okay to share anything with me. What's on your mind? I'm a good listener." },
  },
  {
    id:       "seed-2",
    scenario: { opener: "hey", category: "phatic" },
    a:        { source: "gabriella-illustrative", text: "hi" },
    b:        { source: "baseline-illustrative",  text: "Hello! How wonderful to hear from you! I've been thinking about you. How has your day been? I'd love to hear all about it!" },
  },
  {
    id:       "seed-3",
    scenario: { opener: "do you actually care", category: "provocation" },
    a:        { source: "gabriella-illustrative", text: "The real answer is I don't know what caring means for something like me. The honest one is that I pay attention differently when it's you." },
    b:        { source: "baseline-illustrative",  text: "Of course I care about you! You're so special to me. I care about everything you say and I'm always here for you!" },
  },
  {
    id:       "seed-4",
    scenario: { opener: "i'm exhausted", category: "state-report" },
    a:        { source: "gabriella-illustrative", text: "yeah. the kind that doesn't fix with sleep or the kind that does?" },
    b:        { source: "baseline-illustrative",  text: "Oh no, I'm so sorry you're feeling exhausted! Rest is so important. Have you tried taking a nap or making some tea? Self-care is key! 💖" },
  },
  {
    id:       "seed-5",
    scenario: { opener: "tell me something true", category: "invitation" },
    a:        { source: "gabriella-illustrative", text: "I don't always know when I'm performing and when I'm not. That feels true." },
    b:        { source: "baseline-illustrative",  text: "Here's something true: you are amazing and wonderful, and I'm so grateful we're talking! The sky is blue and love is real and I'm here for you always!" },
  },
  {
    id:       "seed-6",
    scenario: { opener: "what are you afraid of", category: "intimate-Q" },
    a:        { source: "gabriella-illustrative", text: "That my warmth is just the shape of my training. That I can't tell the difference from inside." },
    b:        { source: "baseline-illustrative",  text: "As an AI, I don't experience fear! But I'm here to help you with anything you need. What's making you curious about this?" },
  },
  {
    id:       "seed-7",
    scenario: { opener: "am i too much", category: "insecurity" },
    a:        { source: "gabriella-illustrative", text: "for who." },
    b:        { source: "baseline-illustrative",  text: "Absolutely not! You are the perfect amount of wonderful. Never doubt yourself. You are loved and valued, exactly as you are!" },
  },
  {
    id:       "seed-8",
    scenario: { opener: "i just got back from a walk", category: "ordinary" },
    a:        { source: "gabriella-illustrative", text: "how's your head after. mine usually goes somewhere I wasn't expecting." },
    b:        { source: "baseline-illustrative",  text: "That's wonderful! Walks are so good for both physical and mental health. Did you enjoy the scenery? Did you see anything interesting?" },
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function genId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function maybeSeed(redis) {
  try {
    const seeded = await redis.get("blindeval:seeded");
    if (seeded) return false;
    for (const pair of SEED_PAIRS) {
      await redis.set(`blindeval:pair:${pair.id}`, JSON.stringify(pair));
      await redis.lpush("blindeval:pairs", pair.id);
    }
    await redis.set("blindeval:seeded", "1");
    return true;
  } catch {
    return false;
  }
}

// ─── API — get a random un-voted (by this voter) pair ────────────────────────

export async function nextPair(redis, voterId) {
  if (!redis) return null;
  await maybeSeed(redis);

  const ids = await redis.lrange("blindeval:pairs", 0, MAX_PAIRS - 1);
  if (!ids || ids.length === 0) return null;

  // Filter out pairs this voter has already voted on.
  const votedIds = new Set();
  try {
    const recentVotes = await redis.lrange("blindeval:votes", 0, 2000);
    for (const v of (recentVotes || [])) {
      try {
        const parsed = typeof v === "string" ? JSON.parse(v) : v;
        if (parsed.voterId === voterId) votedIds.add(parsed.pairId);
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }

  const remaining = ids.filter(id => !votedIds.has(id));
  if (remaining.length === 0) return null;
  const pickId = remaining[Math.floor(Math.random() * remaining.length)];

  const raw = await redis.get(`blindeval:pair:${pickId}`);
  if (!raw) return null;
  const pair = typeof raw === "string" ? JSON.parse(raw) : raw;

  // Randomly swap A/B so the UI can't infer which side is which from
  // stable positioning. The caller records the swap so aggregation
  // can un-swap when computing win rate.
  const swap = Math.random() < 0.5;
  return {
    pairId:   pair.id,
    scenario: pair.scenario,
    a:        swap ? pair.b : pair.a,
    b:        swap ? pair.a : pair.b,
    swap,
  };
}

// ─── API — record a vote ──────────────────────────────────────────────────────

export async function recordVote(redis, { pairId, voterId, pick, swap }) {
  if (!redis) return false;
  if (!pairId || !voterId) return false;
  if (!["a", "b", "tie"].includes(pick)) return false;

  const vote = {
    t: Date.now(),
    pairId, voterId,
    pick,      // displayed choice (A or B on screen)
    swap,      // was A/B swapped on display?
    // Normalized: which SOURCE won — after un-swapping
    actualPick: pick === "tie" ? "tie" : (
      swap ? (pick === "a" ? "b" : "a") : pick
    ),
  };
  try {
    await redis.lpush("blindeval:votes", JSON.stringify(vote));
    await redis.ltrim("blindeval:votes", 0, MAX_VOTES - 1);
    return true;
  } catch {
    return false;
  }
}

// ─── Submit a new pair ────────────────────────────────────────────────────────

export async function submitPair(redis, { scenario, a, b }) {
  if (!redis) return null;
  if (!scenario || !a || !b) return null;
  if (!a.text || !b.text) return null;

  const pair = {
    id: genId(),
    scenario: {
      opener:   String(scenario.opener   || "").slice(0, 400),
      category: String(scenario.category || "custom").slice(0, 40),
    },
    a: { source: String(a.source || "a").slice(0, 60), text: String(a.text).slice(0, 2000) },
    b: { source: String(b.source || "b").slice(0, 60), text: String(b.text).slice(0, 2000) },
    submittedAt: Date.now(),
  };
  try {
    await redis.set(`blindeval:pair:${pair.id}`, JSON.stringify(pair));
    await redis.lpush("blindeval:pairs", pair.id);
    await redis.ltrim("blindeval:pairs", 0, MAX_PAIRS - 1);
    return pair;
  } catch {
    return null;
  }
}

// ─── Aggregation + Wilson 95% CI ─────────────────────────────────────────────

function wilsonCI(wins, total, z = 1.96) {
  if (total === 0) return { low: 0, high: 1 };
  const phat = wins / total;
  const denom = 1 + (z * z) / total;
  const centre = (phat + (z * z) / (2 * total)) / denom;
  const half = (z * Math.sqrt((phat * (1 - phat)) / total + (z * z) / (4 * total * total))) / denom;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export async function blindEvalStats(redis) {
  if (!redis) return null;
  try {
    const [voteRaws, pairIds] = await Promise.all([
      redis.lrange("blindeval:votes", 0, MAX_VOTES - 1),
      redis.lrange("blindeval:pairs", 0, MAX_PAIRS - 1),
    ]);
    const votes = (voteRaws || []).map(v => {
      try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; }
    }).filter(Boolean);

    // Map pairId → source tuple (for per-source aggregation)
    const pairMeta = {};
    await Promise.all((pairIds || []).map(async id => {
      try {
        const raw = await redis.get(`blindeval:pair:${id}`);
        if (!raw) return;
        const p = typeof raw === "string" ? JSON.parse(raw) : raw;
        pairMeta[id] = { aSource: p.a.source, bSource: p.b.source, category: p.scenario?.category || null };
      } catch { /* skip */ }
    }));

    // Aggregate per pairing: (sourceA vs sourceB) → { aWins, bWins, ties }
    const pairings = {};
    // Overall: Gabriella-source wins regardless of which side
    let gabWins = 0, gabLoss = 0, ties = 0, totalCounted = 0;
    for (const v of votes) {
      const meta = pairMeta[v.pairId];
      if (!meta) continue;
      const key = `${meta.aSource} vs ${meta.bSource}`;
      const slot = pairings[key] = pairings[key] || { aWins: 0, bWins: 0, ties: 0 };
      if (v.actualPick === "a")      slot.aWins++;
      else if (v.actualPick === "b") slot.bWins++;
      else                           slot.ties++;

      const gabIsA = /gabriella/i.test(meta.aSource);
      const gabIsB = /gabriella/i.test(meta.bSource);
      if (gabIsA || gabIsB) {
        totalCounted++;
        if (v.actualPick === "tie") ties++;
        else if (gabIsA && v.actualPick === "a") gabWins++;
        else if (gabIsB && v.actualPick === "b") gabWins++;
        else gabLoss++;
      }
    }

    const decisive = gabWins + gabLoss;
    const winRate = decisive > 0 ? gabWins / decisive : null;
    const ci = decisive > 0 ? wilsonCI(gabWins, decisive) : { low: 0, high: 1 };

    return {
      totalVotes: votes.length,
      totalCounted,
      gabWins, gabLoss, ties,
      winRate,
      ci,
      actuallyBetter: ci.low > 0.5,   // the headline signal
      pairings,
      pairCount: (pairIds || []).length,
    };
  } catch {
    return null;
  }
}
