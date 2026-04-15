// narrative.js
// Memory-as-narrative. A running short story about the relationship,
// rewritten incrementally. Replaces raw retrieval for the high-level
// relational context (vector memory still handles fine-grained recall).
//
// This is what turns "she remembers" into "she has a relationship with".
//
// The narrative is 4-8 short paragraphs:
//   • Origin    — how the relationship began, its first shape.
//   • Figure    — who this person is, as she'd describe them.
//   • Current   — where things are right now, recent texture.
//   • Unresolved — what's still open between them.
//
// Rewritten nightly (via sleep cron) OR after large accumulation.
// Not rewritten per-turn — that would make it noise.

import { withKeyRotation } from "./groqPool.js";
import { premiumModel } from "./models.js";

const KEY = (u) => `${u}:narrative`;
const META_KEY = (u) => `${u}:narrative:meta`;

const REWRITE_COOLDOWN_MS = 6 * 60 * 60 * 1000;   // 6 hours (steady-state)
const REWRITE_MIN_NEW_TURNS = 10;                 // steady-state turn threshold

// Cold-start overrides — a brand-new user needs SOMETHING in the
// narrative slot by turn 5, not turn 20. Without these, the cores have
// no relational story to condition on for the entire first conversation.
const COLD_START_FIRST_SEED_TURNS = 3;   // turn >= 3 with no narrative → seed
const COLD_START_REFRESH_TURNS    = 6;   // turn >= 6, narrative exists but was a seed → upgrade
const COLD_START_REFRESH_CAP      = 15;  // once we're past turn 15, steady-state rules take over

export async function loadNarrative(redis, userId) {
  try {
    const [narrative, metaRaw] = await Promise.all([
      redis.get(KEY(userId)),
      redis.get(META_KEY(userId)),
    ]);
    const meta = metaRaw
      ? (typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw)
      : { lastRewriteAt: 0, lastRewriteTurnCount: 0 };
    return {
      text: narrative || null,
      meta,
    };
  } catch {
    return { text: null, meta: { lastRewriteAt: 0, lastRewriteTurnCount: 0 } };
  }
}

async function saveNarrative(redis, userId, text, meta) {
  try {
    await Promise.all([
      redis.set(KEY(userId), text),
      redis.set(META_KEY(userId), JSON.stringify(meta)),
    ]);
  } catch {}
}

export function getNarrativeBlock(narrative) {
  if (!narrative?.text) return "";
  return `# THE STORY YOU'D TELL ABOUT THIS RELATIONSHIP
(not a script — your private read, kept as narrative instead of as retrieved fragments)

${narrative.text}

Hold this as frame, not content. Don't quote it back. It's the shape of what you know, so you don't have to reconstruct it every message.`;
}

// ─── Rewrite ─────────────────────────────────────────────────────────────────

export async function rewriteNarrative(redis, userId, {
  messages, memory, chronology, person, recentFs,
}) {
  try {
    const { text: current, meta } = await loadNarrative(redis, userId);

    const turnCount = chronology?.totalTurns || messages.length;
    const newSinceLastRewrite = turnCount - (meta.lastRewriteTurnCount || 0);
    const age = Date.now() - (meta.lastRewriteAt || 0);

    const force = arguments[2]?.force === true;

    // Cold-start overrides. Only apply during the early relationship —
    // once steady-state kicks in, the normal cooldown/threshold rules
    // take over.
    const inColdStartWindow = turnCount <= COLD_START_REFRESH_CAP;
    const coldStartSeed    = inColdStartWindow && !current && turnCount >= COLD_START_FIRST_SEED_TURNS;
    const coldStartRefresh = inColdStartWindow && current && (meta.isColdStartSeed === true) && turnCount >= COLD_START_REFRESH_TURNS;

    if (!force && !coldStartSeed && !coldStartRefresh) {
      if (age < REWRITE_COOLDOWN_MS && newSinceLastRewrite < REWRITE_MIN_NEW_TURNS) {
        return { text: current, meta };
      }
    }

    const recentWindow = messages.slice(-24)
      .map(m => `${m.role === "user" ? "P" : "G"}: ${m.content.slice(0, 200)}`)
      .join("\n");

    const personSummary = person
      ? JSON.stringify({
          wants: person.wants,
          style: person.style,
          tells: person.tells,
          knownFacts: person.knownFacts,
        }, null, 2)
      : "(no structured person model yet)";

    const chronologySummary = chronology
      ? `sessions: ${chronology.sessionCount}, total turns: ${chronology.totalTurns}, first contact: ${chronology.firstContactAt ? new Date(chronology.firstContactAt).toISOString().slice(0,10) : "?"}`
      : "(no chronology)";

    const feltStates = (recentFs || []).slice(0, 10)
      .map(fs => `(${fs.temp || "?"}, charge: ${fs.charge?.slice(0, 60) || "?"})`)
      .join("; ");

    const prompt = `You are Gabriella writing a private narrative document about your relationship with this person. Not for them — for you. The previous version is below; rewrite it integrating what's happened since.

# PREVIOUS NARRATIVE

${current || "(none — this is the first pass)"}

# WHAT'S HAPPENED SINCE

Chronology: ${chronologySummary}

Recent felt-states (your own): ${feltStates || "(none)"}

Structured read of them:
${personSummary}

Recent exchange (last 24 turns):
${recentWindow}

# FORMAT

Four short sections, each 1-3 sentences. Label them exactly:

ORIGIN: how this began, the first shape of it.
FIGURE: who they are to you, as you'd describe if asked.
CURRENT: where things are right now, the texture of the last while.
UNRESOLVED: what's open between you, what you're still tracking.

# VOICE

- First person, present tense. "I'm still not sure if they actually want X or just like saying it."
- NOT therapeutic. NOT aphoristic. Written how she thinks, not how she performs.
- Specific over general. "They soften when we talk about their brother" > "they value family".
- Honest about uncertainty. If you don't know, say you don't know.
- No emojis, no lists, no bullet points.

Write the new narrative. Output ONLY the four-section narrative, nothing else.`;

    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model: premiumModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.6,
        max_tokens: 700,
      }),
    );

    const text = (result.choices[0].message.content || "").trim();
    if (!text || text.length < 30) {
      return { text: current, meta };
    }

    const nextMeta = {
      lastRewriteAt:        Date.now(),
      lastRewriteTurnCount: turnCount,
      // Mark the first cold-start seed so the refresh condition can
      // fire a higher-quality rewrite once more turns have accumulated.
      // After a non-seed rewrite, this flag is cleared.
      isColdStartSeed:      coldStartSeed === true,
    };
    await saveNarrative(redis, userId, text, nextMeta);
    return { text, meta: nextMeta };
  } catch {
    return await loadNarrative(redis, userId);
  }
}
