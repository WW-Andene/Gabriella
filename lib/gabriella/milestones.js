// milestones.js
// Auto-detected "firsts" in the relationship. Not ceremonial
// achievements — structural markers of relational depth crossing
// thresholds that only exist because of Gabriella's architecture.
//
// The milestones we detect:
//   first_callback_landed    — callback tracker records its first landing
//   first_retired_read       — self-model retires its first wrong read
//   first_confirmed_commit   — a commitment gets 3 confirmations
//   first_vulnerability      — LLM-flagged turn where user shared
//                               something substantive / heavy (bounded)
//   first_week_crossed       — user has been talking for 7+ days
//   first_hundredth_turn     — 100th exchange
//   first_callback_miss      — first observed miss (useful diagnostic)
//   first_surprise           — first time a thinker-prediction broke
//
// Stored in a small Redis hash per user: ${userId}:milestones
//   { <milestone_key>: { at, detail } }
//
// Milestones are append-only; each one fires at most once per user.
// Rendered as a timeline on /retro.
//
// Detection happens on different triggers:
//   - turn-completion checks for turn-count / time-based milestones
//   - callbacks.js writes first_callback_landed / miss
//   - self.js flags first_retired_read / first_confirmed_commit
//     through proxy logic in the milestone checker below
//   - surprise.js pushes first_surprise
//
// This module provides the recording + rendering primitives; the
// detection logic lives in engine.js where state is already loaded.

const KEY = (u) => `${u}:milestones`;

// ─── Fire-once recording ────────────────────────────────────────────────────

export async function markMilestone(redis, userId, kind, detail = null) {
  if (!kind) return false;
  try {
    // HSETNX returns 1 if newly set, 0 if already present.
    const set = await redis.hsetnx(KEY(userId), kind, JSON.stringify({
      at:     Date.now(),
      detail: detail || null,
    }));
    return set === 1;
  } catch { return false; }
}

export async function loadMilestones(redis, userId) {
  try {
    const raw = await redis.hgetall(KEY(userId));
    if (!raw) return [];
    return Object.entries(raw)
      .map(([kind, v]) => {
        try {
          const parsed = typeof v === "string" ? JSON.parse(v) : v;
          return { kind, at: parsed.at || 0, detail: parsed.detail || null };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.at - b.at);
  } catch { return []; }
}

// ─── Batch detection during a turn ─────────────────────────────────────────
// Called from engine.updateGabriella with whatever state is accessible
// at that point. Each branch fires only once due to HSETNX semantics.

export async function detectAndMarkMilestones(redis, userId, ctx) {
  const {
    chronology,
    self,
    callbackLedger,
    callbackLanded,
    firstSeenAt,
    firstSurprise,
  } = ctx;

  const ops = [];

  // Turn-count milestones
  const total = chronology?.totalTurns || 0;
  if (total >= 100) ops.push(markMilestone(redis, userId, "first_hundredth_turn", `${total} turns`));
  if (total >= 250) ops.push(markMilestone(redis, userId, "first_250th_turn", `${total} turns`));

  // Week-crossed milestone
  if (firstSeenAt && Date.now() - firstSeenAt > 7 * 24 * 3600_000) {
    ops.push(markMilestone(redis, userId, "first_week_crossed",
      `first talked ${Math.floor((Date.now() - firstSeenAt) / (24 * 3600_000))} days ago`));
  }

  // Callback milestones
  if (callbackLanded) {
    ops.push(markMilestone(redis, userId, "first_callback_landed",
      callbackLanded.callback?.text?.slice(0, 120) || null));
  }
  if (callbackLedger?.missed > 0) {
    ops.push(markMilestone(redis, userId, "first_callback_miss", null));
  }

  // Self-model milestones
  if ((self?.retired?.reads || []).length > 0) {
    ops.push(markMilestone(redis, userId, "first_retired_read",
      self.retired.reads[0]?.text?.slice(0, 120) || null));
  }
  const confirmedCommit = (self?.commitments || []).find(c => c.status === "confirmed");
  if (confirmedCommit) {
    ops.push(markMilestone(redis, userId, "first_confirmed_commit",
      confirmedCommit.text?.slice(0, 120) || null));
  }
  if ((self?.retired?.commitments || []).length > 0) {
    ops.push(markMilestone(redis, userId, "first_refuted_commit",
      self.retired.commitments[0]?.text?.slice(0, 120) || null));
  }

  // Surprise milestone
  if (firstSurprise) {
    ops.push(markMilestone(redis, userId, "first_surprise", firstSurprise));
  }

  await Promise.allSettled(ops);
}

// ─── Human-readable rendering ──────────────────────────────────────────────

const MILESTONE_LABELS = {
  first_hundredth_turn:    "first 100-turn mark",
  first_250th_turn:        "first 250-turn mark",
  first_week_crossed:      "first week together",
  first_callback_landed:   "first callback that landed",
  first_callback_miss:     "first callback that didn't land",
  first_retired_read:      "first read she retired",
  first_confirmed_commit:  "first position confirmed",
  first_refuted_commit:    "first position refuted",
  first_surprise:          "first time you surprised her",
};

export function formatMilestones(milestones) {
  return milestones.map(m => ({
    kind:   m.kind,
    label:  MILESTONE_LABELS[m.kind] || m.kind,
    at:     m.at,
    detail: m.detail,
  }));
}
