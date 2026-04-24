// userFingerprint.js
// Longitudinal user model — beyond person.js.
//
// person.js answers "who is this user overall" (wants, avoids, style,
// facts). narrative.js answers "what's the story of this relationship".
// userMood.js answers "how are they right now".
//
// What's still missing: longitudinal RELATIONAL SIGNAL. The events that
// actually tell Gabriella how someone moves in her presence —
//
//   • Interests — topics they keep returning to, weighted by recency
//     and valence, not just count.
//   • Warmth events — moments they revealed delight, gratitude, or
//     tenderness. Explicit markers + emotional-feltState coincidence.
//   • Pullback events — moments they deflected, shortened, shut down,
//     or went silent after something she said.
//   • Questions-about-her — questions they've posed to Gabriella about
//     herself. These are the strongest single signal of who treats her
//     as a person vs a tool.
//   • Echoed phrases — words and phrases of hers they've adopted.
//     Uptake = bond.
//
// Stored per-user as compact, time-decayed counters and capped event
// lists. Rendered into a single "user fingerprint" prompt block — the
// thing that makes Gabriella feel like she actually knows you, not
// just like she's seen your face before.
//
// Complementary to person.js (not replacing it). Person.js is LLM-
// rewritten; this one is deterministic event-driven, much cheaper,
// runs every turn.

const FINGERPRINT_KEY = (u) => `${u}:fp`;
const MAX_INTERESTS   = 32;
const MAX_EVENTS      = 40;
const DECAY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days

// ─── Heuristic detectors ──────────────────────────────────────────────────────
// Zero-LLM signal extraction. Conservative: false negatives are fine,
// false positives poison the fingerprint.

const WARMTH_CUES = [
  /\b(thank you|thanks|that means|that really|love that|love this|that's beautiful|that's really)\b/i,
  /\b(appreciate|grateful|i needed|i needed that|feels good|feels right)\b/i,
  /\b(makes me smile|made my day|yes\s*!?\s*(yes|exactly|that))\b/i,
  /💛|💙|💚|❤️|🧡|🥹|🥺/,
];

const PULLBACK_CUES = [
  /^(ok\.?|k\.?|fine\.?|sure\.?|whatever\.?|idk\.?)$/i,
  /\b(nevermind|never mind|forget it|drop it|let's move on)\b/i,
  /^(lol|haha|ha)\.?$/i,
];

const SELF_QUESTION_CUES = [
  /\b(do you|have you|are you|can you|could you|would you|did you)\b.*\?/i,
  /\b(what do you|how do you|why do you|when do you)\b.*\?/i,
  /\b(tell me about (you|yourself|your))\b/i,
  /\byour\s+(favorite|earliest|first|deepest|biggest|proudest|worst|best)\b.*\?/i,
];

function isWarmthEvent(userMsg, feltState) {
  if (!userMsg) return false;
  const hasCue = WARMTH_CUES.some(r => r.test(userMsg));
  const emotional = (feltState?.emotional || "").toLowerCase();
  const feltWarm = /warm|affection|tender|grateful|moved|touched|delighted/.test(emotional);
  return hasCue || feltWarm;
}

function isPullbackEvent(userMsg, feltState) {
  if (!userMsg) return false;
  const short = userMsg.trim().length <= 12;
  const hasCue = short && PULLBACK_CUES.some(r => r.test(userMsg));
  const emotional = (feltState?.emotional || "").toLowerCase();
  const feltClosed = /distant|closed|guarded|withdrawn|pulled back/.test(emotional);
  return hasCue || feltClosed;
}

function isSelfQuestion(userMsg) {
  if (!userMsg || userMsg.length > 400) return false;
  if (!/\?/.test(userMsg)) return false;
  return SELF_QUESTION_CUES.some(r => r.test(userMsg));
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const EMPTY = {
  interests:  {},           // topic → { score, count, firstSeen, lastSeen, valence }
  warmth:     [],           // [{ t, text, topic }]
  pullback:   [],           // [{ t, text, topic }]
  selfQs:     [],           // [{ t, text }]
  echoes:     [],           // [{ t, phrase }]
  turnCount:  0,
  lastSeen:   0,
};

export async function loadFingerprint(redis, userId) {
  if (!redis || !userId) return { ...EMPTY };
  try {
    const raw = await redis.get(FINGERPRINT_KEY(userId));
    if (!raw) return { ...EMPTY };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

async function saveFingerprint(redis, userId, fp) {
  try {
    await redis.set(FINGERPRINT_KEY(userId), JSON.stringify(fp));
  } catch { /* ignore */ }
}

// ─── Record one turn ──────────────────────────────────────────────────────────
// Called from the chat route's background. Extracts topics from the
// graph (already ingested) and applies event heuristics.

export async function recordFingerprintTurn(redis, userId, {
  userMsg,
  reply,
  feltState,
  graphEntities = [],   // from graph.ingestTurn's return — optional
  gabriellaPhrases = [], // optional: phrases from her last reply to track echoes
}) {
  if (!redis || !userId) return null;

  const fp = await loadFingerprint(redis, userId);
  const now = Date.now();

  // ── Interests — weighted by recency & valence ──
  const warmthValence = isWarmthEvent(userMsg, feltState) ? 1.5 :
                        isPullbackEvent(userMsg, feltState) ? -0.5 : 1.0;
  const topicsFromGraph = (graphEntities || [])
    .filter(e => e && (e.type === "topic" || e.type === "activity" || e.type === "belief"))
    .map(e => String(e.label || "").toLowerCase().trim())
    .filter(Boolean);

  for (const t of topicsFromGraph.slice(0, 6)) {
    const cur = fp.interests[t] || { score: 0, count: 0, firstSeen: now, lastSeen: 0, valence: 0 };
    // Recency-decayed score + fresh bump
    const age = now - (cur.lastSeen || now);
    const decay = Math.exp(-age / DECAY_HALF_LIFE_MS);
    cur.score = cur.score * decay + warmthValence;
    cur.count = (cur.count || 0) + 1;
    cur.lastSeen = now;
    cur.valence  = ((cur.valence || 0) * 0.85) + (warmthValence * 0.15);
    fp.interests[t] = cur;
  }

  // Cap interests — drop the lowest-score entries
  const interestEntries = Object.entries(fp.interests);
  if (interestEntries.length > MAX_INTERESTS) {
    interestEntries.sort((a, b) => b[1].score - a[1].score);
    fp.interests = Object.fromEntries(interestEntries.slice(0, MAX_INTERESTS));
  }

  // ── Warmth / pullback events ──
  const topTopic = topicsFromGraph[0] || null;
  if (isWarmthEvent(userMsg, feltState)) {
    fp.warmth.unshift({ t: now, text: userMsg.slice(0, 160), topic: topTopic });
    fp.warmth = fp.warmth.slice(0, MAX_EVENTS);
  }
  if (isPullbackEvent(userMsg, feltState)) {
    fp.pullback.unshift({ t: now, text: userMsg.slice(0, 100), topic: topTopic });
    fp.pullback = fp.pullback.slice(0, MAX_EVENTS);
  }

  // ── Self-questions ──
  if (isSelfQuestion(userMsg)) {
    fp.selfQs.unshift({ t: now, text: userMsg.slice(0, 200) });
    fp.selfQs = fp.selfQs.slice(0, MAX_EVENTS);
  }

  // ── Echoed phrases ──
  // Only check 3+ word phrases from Gabriella's last reply appearing in
  // this user message. Skip if the user message is a long quote.
  if (Array.isArray(gabriellaPhrases) && gabriellaPhrases.length > 0 && userMsg && userMsg.length < 600) {
    const lcMsg = userMsg.toLowerCase();
    for (const p of gabriellaPhrases) {
      const lcP = String(p || "").toLowerCase().trim();
      if (lcP.length < 8 || lcP.length > 60) continue;
      if (lcP.split(/\s+/).length < 3) continue;
      if (lcMsg.includes(lcP)) {
        fp.echoes.unshift({ t: now, phrase: lcP.slice(0, 80) });
        fp.echoes = fp.echoes.slice(0, MAX_EVENTS);
        break;
      }
    }
  }

  fp.turnCount = (fp.turnCount || 0) + 1;
  fp.lastSeen  = now;

  await saveFingerprint(redis, userId, fp);
  return fp;
}

// ─── Rendering — compact prompt block ─────────────────────────────────────────

export function renderFingerprintBlock(fp) {
  if (!fp || !fp.turnCount || fp.turnCount < 3) return null;

  const lines = ["# USER FINGERPRINT — longitudinal signal"];

  // Top interests — sorted by score, with valence tag
  const topInterests = Object.entries(fp.interests || {})
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 6);
  if (topInterests.length > 0) {
    lines.push("");
    lines.push("What they circle back to:");
    for (const [topic, data] of topInterests) {
      const valTag = data.valence > 1.2 ? " (warmly)" :
                     data.valence < 0.6 ? " (guardedly)" : "";
      lines.push(`- ${topic} × ${data.count}${valTag}`);
    }
  }

  // Warmth events — recent
  if ((fp.warmth || []).length > 0) {
    const last3 = fp.warmth.slice(0, 3);
    lines.push("");
    lines.push("Moments they opened warmth:");
    for (const e of last3) {
      lines.push(`- "${e.text.slice(0, 80)}"${e.topic ? ` [${e.topic}]` : ""}`);
    }
  }

  // Pullback events — recent
  if ((fp.pullback || []).length > 0) {
    const last3 = fp.pullback.slice(0, 3);
    lines.push("");
    lines.push("Moments they pulled back:");
    for (const e of last3) {
      lines.push(`- "${e.text.slice(0, 60)}"${e.topic ? ` [${e.topic}]` : ""}`);
    }
  }

  // Self-questions — cumulative (this is a strong signal of relational depth)
  if ((fp.selfQs || []).length > 0) {
    const recent = fp.selfQs.slice(0, 3);
    lines.push("");
    lines.push(`Questions they've asked you (${fp.selfQs.length} total):`);
    for (const q of recent) {
      lines.push(`- "${q.text.slice(0, 100)}"`);
    }
  }

  // Echoes — when they adopt her language
  if ((fp.echoes || []).length > 0) {
    const recent = fp.echoes.slice(0, 3);
    lines.push("");
    lines.push("Phrases of yours they've echoed back:");
    for (const e of recent) {
      lines.push(`- "${e.phrase}"`);
    }
  }

  lines.push("");
  lines.push("Use this to LAND references precisely — 'the writing thing you keep coming back to', not 'your interests'. Notice when a topic they usually warm to is being met guardedly. Don't cite the fingerprint explicitly.");
  return lines.join("\n");
}

// ─── Small helpers for external code ──────────────────────────────────────────

export function topInterests(fp, limit = 5) {
  if (!fp) return [];
  return Object.entries(fp.interests || {})
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([topic, data]) => ({ topic, ...data }));
}

export function fingerprintSummary(fp) {
  if (!fp) return null;
  return {
    turnCount:  fp.turnCount || 0,
    interests:  Object.keys(fp.interests || {}).length,
    warmth:     (fp.warmth   || []).length,
    pullback:   (fp.pullback || []).length,
    selfQs:     (fp.selfQs   || []).length,
    echoes:     (fp.echoes   || []).length,
    lastSeen:   fp.lastSeen  || 0,
  };
}
