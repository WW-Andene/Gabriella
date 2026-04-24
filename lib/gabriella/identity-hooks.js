// identity-hooks.js
// User identity extraction — name, pronouns, location, age range.
// Stored as stable facts she references naturally without forcing.
//
// The trigger: users commonly introduce themselves ("my name is X",
// "I'm X", "everyone calls me X") and Gabriella doesn't currently
// parse and store that cleanly. It sits in the training_log but
// isn't promoted to a first-class fact that the prompt can key on.
//
// This module: regex detection first, then a fast-tier LLM
// disambiguation pass when the regex is ambiguous (common name
// overlaps with English words). Clean facts get written into a
// dedicated ${userId}:identity hash for durable reference.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { withBreaker } from "./circuitBreaker.js";

const KEY = (u) => `${u}:identity`;

// ─── Pattern detection ─────────────────────────────────────────────────────

const NAME_PATTERNS = [
  /\bmy\s+name\s+is\s+([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)/,
  /\bi'?m\s+([A-Z][a-z]{1,20})(?:\s+by\s+the\s+way|\s*,|\s+and)/,
  /\bcall\s+me\s+([A-Z][a-z]{1,20})/i,
  /\beveryone\s+calls\s+me\s+([A-Z][a-z]{1,20})/i,
  /\bthe\s+name'?s\s+([A-Z][a-z]{1,20})/i,
];

const PRONOUN_PATTERN = /\b(my\s+pronouns\s+are|i\s+go\s+by|use\s+)?(she\/her|he\/him|they\/them|he\/they|she\/they|ze\/zir|xe\/xem)\b/i;

function detectNameCandidate(text) {
  for (const rx of NAME_PATTERNS) {
    const m = text.match(rx);
    if (m && m[1]) {
      // Filter noisy matches (common English words capitalized at start)
      const candidate = m[1].trim();
      if (/^(I|Me|You|We|They|No|Yes|Ok|Fine|Good|Bad|Tired|Sorry|Hello|Hi|Hey|Late|Here|There|Home)$/i.test(candidate)) return null;
      if (candidate.length < 2) return null;
      return candidate;
    }
  }
  return null;
}

function detectPronouns(text) {
  const m = text.match(PRONOUN_PATTERN);
  return m ? m[2].toLowerCase() : null;
}

// ─── LLM disambiguation for ambiguous hits ─────────────────────────────────

async function confirmNameViaLLM(redis, text, candidate) {
  const prompt = `User's message: "${text.slice(0, 300)}"

A regex flagged "${candidate}" as a possible name they gave. Is this actually their name, or is it a false positive (a capitalized word that isn't their name)?

Return ONLY JSON:
{"is_name": true | false, "reason": "one clause"}`;

  return await withBreaker(redis, "identityHook", async () => {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens:  60,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "").trim()
      .replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    return parsed.is_name === true;
  }, { fallback: null, failureThreshold: 4, coolDownMs: 10 * 60_000 });
}

// ─── Public: extract + persist ─────────────────────────────────────────────

export async function extractAndPersistIdentity(redis, userId, userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;

  const existing = await loadIdentity(redis, userId);

  // Skip entirely if we already have a confirmed name (user renames are
  // a different flow)
  if (existing.name && existing.nameConfirmed) return null;

  const candidate = detectNameCandidate(userMessage);
  const pronouns  = detectPronouns(userMessage);

  const updates = {};

  if (candidate) {
    // If it's a clean match with explicit cue ("my name is X"), accept.
    // If it's the softer pattern ("I'm X"), run LLM confirm.
    const strongCue = /\b(my\s+name\s+is|call\s+me|the\s+name'?s|everyone\s+calls\s+me)\b/i.test(userMessage);
    if (strongCue) {
      updates.name = candidate;
      updates.nameConfirmed = true;
      updates.nameFirstSeenAt = Date.now();
    } else {
      const confirmed = await confirmNameViaLLM(redis, userMessage, candidate);
      if (confirmed) {
        updates.name = candidate;
        updates.nameConfirmed = true;
        updates.nameFirstSeenAt = Date.now();
      }
    }
  }

  if (pronouns) {
    updates.pronouns = pronouns;
    updates.pronounsSetAt = Date.now();
  }

  if (Object.keys(updates).length === 0) return null;

  try {
    for (const [k, v] of Object.entries(updates)) {
      await redis.hset(KEY(userId), { [k]: String(v) });
    }
  } catch {}

  return updates;
}

export async function loadIdentity(redis, userId) {
  try {
    const raw = await redis.hgetall(KEY(userId));
    if (!raw) return {};
    return {
      name:             raw.name || null,
      nameConfirmed:    raw.nameConfirmed === "true",
      nameFirstSeenAt:  Number(raw.nameFirstSeenAt) || 0,
      pronouns:         raw.pronouns || null,
      pronounsSetAt:    Number(raw.pronounsSetAt) || 0,
    };
  } catch { return {}; }
}

// ─── Prompt block ──────────────────────────────────────────────────────────

export function getIdentityHooksBlock(identity) {
  if (!identity || (!identity.name && !identity.pronouns)) return "";
  const parts = [];
  if (identity.name) parts.push(`Their name: ${identity.name}`);
  if (identity.pronouns) parts.push(`Their pronouns: ${identity.pronouns}`);
  return `# WHO YOU'RE TALKING TO (stable identity)

${parts.join(". ")}. Use it when it fits naturally — not in every sentence, not as a grafted-on "${identity.name || "[name]"},". Names feel right at punctuation-level beats: greetings, returns after absence, turns where you're really addressing THEM. Most turns don't need the name; don't insert it by reflex.`;
}
