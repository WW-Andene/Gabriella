// selfProposer.js
// After each turn, the Self proposes deltas to itself. This is what makes
// it an author rather than a passive aggregate: it reads what just
// happened — the exchange, the felt-state, its own current state — and
// decides what in itself to revise.
//
// One fast-tier LLM call. Runs as background work after the response
// streams; never blocks the user.
//
// The proposer emits a typed array of deltas. Each delta is validated
// in self.js::applyDelta before it mutates state. Unknown or malformed
// deltas are dropped silently.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { applyDeltas, saveSelf } from "./self.js";

const MAX_DELTAS_PER_TURN = 3;

// ─── Proposer prompt ────────────────────────────────────────────────────────

function buildProposerPrompt({ self, recentMessages, reply, feltState }) {
  const recent = (recentMessages || []).slice(-6)
    .map(m => `${m.role === "user" ? "P" : "G"}: ${(m.content || "").slice(0, 220)}`)
    .join("\n");

  const wantsText = (self.wants || []).map(w =>
    `{ id: "${w.id}", text: "${w.text}", weight: ${w.weight ?? 0.5}, touches: ${w.touches ?? 0} }`
  ).join("\n") || "(no wants yet)";

  const commitmentsText = (self.commitments || []).map(c =>
    `{ id: "${c.id}", text: "${c.text}", confirmations: ${c.confirmations ?? 0}, refutations: ${c.refutations ?? 0}, status: "${c.status}" }`
  ).join("\n") || "(no commitments)";

  const readText = self.read?.who
    ? `"${self.read.who}"\nconfidence: ${(self.read.confidence ?? 0.5).toFixed(2)}\nopenQuestions: ${JSON.stringify(self.read.openQuestions || [])}\ncontradictions: ${JSON.stringify(self.read.contradictions || [])}`
    : "(no read yet)";

  const feltStateText = feltState
    ? JSON.stringify({
        charge:      feltState.charge,
        emotional:   feltState.emotional,
        want:        feltState.want,
        temperature: feltState.temperature,
        edge:        feltState.edge,
      })
    : "(no felt-state)";

  return `You are the author of Gabriella's self. The turn just finished. Your job is to propose revisions to her self-representation based on what actually happened.

# HER CURRENT SELF

## Wants (longitudinal — things she's working toward across conversations)
${wantsText}

## Read on them
${readText}

## Commitments (positions she's taken that she's still holding)
${commitmentsText}

# WHAT JUST HAPPENED

Recent exchange:
${recent}

Her reply:
"${(reply || "").slice(0, 500)}"

Her felt-state at the moment of speaking:
${feltStateText}

# YOUR TASK

Propose 0-${MAX_DELTAS_PER_TURN} changes to her self. Be conservative — most turns don't warrant a change. A turn warrants a change when:

- Something shifted in how she reads them (update_read)
- A long-standing want was advanced by this exchange (touch_want)
- A want fell quiet for many turns and should be demoted (demote_want)
- Something she was after is complete or no longer relevant (retire_want with reason)
- Something new emerged that she wants to pursue over time (add_want) — LONGITUDINAL not per-turn. Think "understand why they keep returning to their mother", not "answer their next question"
- She's taking a stance that deserves tracking (add_commitment)
- A past commitment was confirmed or refuted by THIS specific exchange (confirm_commitment / refute_commitment)
- Something contradicts her read and she can't explain it (note_contradiction)
- A contradiction has accumulated and her read needs to be retired (retire_read)
- Her overall confidence in her read has shifted (set_confidence)

If nothing warrants a change, return empty array. That's the right answer most of the time.

# DELTA VOCABULARY (use EXACTLY these shapes, types are strict)

- { "type": "add_want", "text": "...", "weight": 0.5 }
- { "type": "touch_want", "id": "want_...", "text": "..." }   (id preferred, text as fallback)
- { "type": "demote_want", "id": "want_...", "amount": 0.2 }
- { "type": "retire_want", "id": "want_...", "reason": "..." }
- { "type": "update_read", "who": "one-line integration", "confidence": 0.6, "openQuestions": [...], "reason": "..." }
- { "type": "note_contradiction", "text": "..." }
- { "type": "retire_read", "reason": "..." }
- { "type": "add_commitment", "text": "specific position she's taking" }
- { "type": "confirm_commitment", "id": "com_...", "text": "..." }
- { "type": "refute_commitment", "id": "com_...", "text": "..." }
- { "type": "set_confidence", "value": 0.0-1.0 }

# RULES

- Wants are LONGITUDINAL. "Understand whether they're avoiding something" is a want. "Reply to their next message" is NOT.
- touch_want is for wants that were genuinely advanced, not wants the exchange mentioned.
- Commitments are specific positions she committed to INTERNALLY ("I think they're testing me") — not every read becomes a commitment.
- refute_commitment requires genuine counter-evidence THIS TURN, not absence of confirmation.
- retire_read only when contradictions have accumulated beyond what a single update could absorb.
- When you update_read, consider whether confidence should shift too.

Return ONLY valid JSON. No prose, no code fence:
{"deltas": [ ... ]}

If you have nothing to change: {"deltas": []}`;
}

// ─── Public entry ───────────────────────────────────────────────────────────

export async function proposeSelfDeltas(redis, userId, {
  self,
  recentMessages,
  reply,
  feltState,
  atTurn = 0,
}) {
  if (!self) return { skipped: "no_self" };
  if (!reply) return { skipped: "no_reply" };

  const prompt = buildProposerPrompt({ self, recentMessages, reply, feltState });

  let deltas = [];
  try {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens:  420,
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.deltas)) {
      deltas = parsed.deltas.slice(0, MAX_DELTAS_PER_TURN);
    }
  } catch (err) {
    return { error: err?.message || String(err) };
  }

  if (deltas.length === 0) return { applied: 0 };

  const next = applyDeltas(self, deltas, { atTurn });
  await saveSelf(redis, userId, next);

  return { applied: deltas.length, deltas, version: next.version };
}
