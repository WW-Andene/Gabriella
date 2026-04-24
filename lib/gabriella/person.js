// person.js
// Structured person model — an evolving schema of who she's talking to.
//
// Raw memory is retrieval-augmented: vector search returns moments.
// This is different. It's a small, structured object updated over time
// that answers "who is this person, actually?" in a queryable way.
//
// The cores and speaker use it as ground truth for register, tone,
// risk-taking, and pushback. It's what turns "memory" into "knowing
// someone".
//
// Schema:
//   wants        — what they come here for (connection, debate, venting...)
//   avoids       — what they don't want prodded (topics or registers)
//   tells        — idiosyncratic signals (phrases, patterns, tells)
//   rhythms      — when they show up, how long they stay, bursty vs steady
//   style        — how they write (formality, length, directness, humor)
//   knownFacts   — stable things they've shared (name, context, situation)
//   openQuestions — what she doesn't yet know but has noticed
//   uncertainty  — things she's NOT sure about, actively held as maybe-wrong
//   lastUpdated  — when the model was last rewritten
//
// The uncertainty field matters. Real knowing has texture —
// "I'm pretty sure X but not sure whether Y means Z yet."

import { withKeyRotation } from "./groqPool.js";
import { premiumModel } from "./models.js";

const KEY = (u) => `${u}:person`;

const DEFAULT_MODEL = {
  wants:         null,
  avoids:        null,
  tells:         [],
  rhythms:       null,
  style:         null,
  knownFacts:    [],
  openQuestions: [],
  uncertainty:   [],
  lastUpdated:   0,
  turnCount:     0,
};

export async function loadPerson(redis, userId) {
  try {
    const raw = await redis.get(KEY(userId));
    if (!raw) return { ...DEFAULT_MODEL };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { ...DEFAULT_MODEL, ...parsed };
  } catch {
    return { ...DEFAULT_MODEL };
  }
}

async function savePerson(redis, userId, model) {
  try {
    await redis.set(KEY(userId), JSON.stringify(model));
  } catch {}
}

// ─── Update — LLM-driven, debounced with cold-start acceleration ────────────
// Runs at most once every N turns and not before a minimum cooldown,
// EXCEPT during the cold-start window where the cadence is lifted so a
// new user has a real model of themselves by turn ~4 instead of turn ~20.
//
// Without this, the cores have no prior to condition on for the entire
// first conversation — the "organism" infrastructure was invisible to
// any new user.

const UPDATE_EVERY_N_TURNS   = 4;   // steady-state cadence
const UPDATE_EVERY_EARLY     = 2;   // cold-start cadence (turns 1..COLD_START_END)
const COLD_START_END         = 10;  // turns where early cadence applies
const MIN_COOLDOWN_MS        = 5 * 60 * 1000;  // 5 minutes
const MIN_COOLDOWN_EARLY_MS  = 30 * 1000;      // 30 seconds during cold-start
const FIRST_SEED_TURN        = 1;   // seed the model from the very first message

function shouldUpdate(model) {
  const turnCount = model.turnCount || 0;
  const turnsSinceUpdate = turnCount - (model._lastUpdateTurnCount ?? 0);
  const age = Date.now() - (model.lastUpdated || 0);

  // Force first seed on turn 1 — gets the cores SOMETHING to condition on.
  if ((model._lastUpdateTurnCount ?? 0) === 0 && turnCount >= FIRST_SEED_TURN) {
    return true;
  }

  const inColdStart = turnCount <= COLD_START_END;
  const turnThreshold    = inColdStart ? UPDATE_EVERY_EARLY     : UPDATE_EVERY_N_TURNS;
  const cooldownThreshold = inColdStart ? MIN_COOLDOWN_EARLY_MS : MIN_COOLDOWN_MS;

  if (turnsSinceUpdate < turnThreshold) return false;
  if (age < cooldownThreshold) return false;
  return true;
}

export async function updatePerson(redis, userId, {
  messages, reply,
}) {
  try {
    const current = await loadPerson(redis, userId);
    const next = { ...current, turnCount: (current.turnCount || 0) + 1 };

    // Persist the incremented turnCount UNCONDITIONALLY before the LLM
    // call. If the LLM fails, we still want to keep count — otherwise
    // the cold-start gates never advance and we retry the same seed
    // LLM call every turn.
    await savePerson(redis, userId, next);

    if (!shouldUpdate(next)) {
      return next;
    }

    const recentWindow = messages.slice(-16)
      .map(m => `${m.role === "user" ? "P" : "G"}: ${m.content}`)
      .join("\n");

    const existingJson = JSON.stringify({
      wants:         current.wants,
      avoids:        current.avoids,
      tells:         current.tells,
      rhythms:       current.rhythms,
      style:         current.style,
      knownFacts:    current.knownFacts,
      openQuestions: current.openQuestions,
      uncertainty:   current.uncertainty,
    }, null, 2);

    const prompt = `You are maintaining a structured model of a person Gabriella (an AI character) is in an ongoing conversation with. Update the model given the recent exchange.

# CURRENT MODEL

${existingJson}

# RECENT EXCHANGE

${recentWindow}

# HER LATEST REPLY

${reply}

# RULES

- Be specific, not generic. "Uses 'lol' as a hedge not an amplifier" > "informal".
- Prefer adding to existing fields over replacing them. Only REPLACE when new evidence genuinely supersedes.
- Keep lists small. Top 3-5 tells, top 2-4 avoids.
- The uncertainty field is for things she's watching but hasn't confirmed. Moving things OUT of uncertainty (into knownFacts) requires actual evidence.
- If a field genuinely shouldn't change, return its existing value unchanged.
- No speculation as if it were fact. No therapy-speak ("they might be processing trauma"). Just observations.

Return ONLY JSON in this exact shape:
{
  "wants":         "<1 sentence>",
  "avoids":        "<1 sentence or null>",
  "tells":         ["<short phrase>", "..."],
  "rhythms":       "<1 sentence or null>",
  "style":         "<1 sentence>",
  "knownFacts":    ["<fact>", "..."],
  "openQuestions": ["<question she carries>", "..."],
  "uncertainty":   ["<thing she suspects but isn't sure of>", "..."]
}`;

    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model: premiumModel(),
        messages: [{ role: "user", content: prompt }],
        temperature: 0.35,
        max_tokens: 700,
      }),
    );

    const raw = result.choices[0].message.content.trim().replace(/```(?:json)?/g, "").trim();
    const updated = JSON.parse(raw);

    const finalModel = {
      ...next,
      wants:         updated.wants         ?? current.wants,
      avoids:        updated.avoids        ?? current.avoids,
      tells:         Array.isArray(updated.tells)         ? updated.tells.slice(0, 6)         : current.tells,
      rhythms:       updated.rhythms       ?? current.rhythms,
      style:         updated.style         ?? current.style,
      knownFacts:    Array.isArray(updated.knownFacts)    ? updated.knownFacts.slice(0, 10)   : current.knownFacts,
      openQuestions: Array.isArray(updated.openQuestions) ? updated.openQuestions.slice(0, 5) : current.openQuestions,
      uncertainty:   Array.isArray(updated.uncertainty)   ? updated.uncertainty.slice(0, 5)   : current.uncertainty,
      lastUpdated:   Date.now(),
      _lastUpdateTurnCount: next.turnCount,
    };

    await savePerson(redis, userId, finalModel);
    return finalModel;
  } catch {
    return null;
  }
}

// ─── Prompt block ────────────────────────────────────────────────────────────

export function getPersonBlock(model) {
  if (!model) return "";
  const hasContent = model.wants || model.style || (model.tells && model.tells.length) || (model.knownFacts && model.knownFacts.length);
  if (!hasContent) return "";

  const lines = [];
  if (model.wants)   lines.push(`What they seem to come here for: ${model.wants}`);
  if (model.avoids)  lines.push(`What they don't want prodded: ${model.avoids}`);
  if (model.style)   lines.push(`How they write: ${model.style}`);
  if (model.rhythms) lines.push(`When/how they show up: ${model.rhythms}`);
  if (model.tells?.length) {
    lines.push(`Their tells: ${model.tells.map(t => `"${t}"`).join("; ")}`);
  }
  if (model.knownFacts?.length) {
    lines.push(`Known: ${model.knownFacts.slice(0, 5).join("; ")}`);
  }
  if (model.openQuestions?.length) {
    lines.push(`Open (noticed but not pushed): ${model.openQuestions.join("; ")}`);
  }
  if (model.uncertainty?.length) {
    lines.push(`Held lightly (you're not sure): ${model.uncertainty.join("; ")}`);
  }

  return `# WHO THIS PERSON ACTUALLY IS (your working model of them)

${lines.join("\n")}

This is your read on them, not a script. Trust it but stay open — the next message may correct it. Don't cite it back at them.`;
}
