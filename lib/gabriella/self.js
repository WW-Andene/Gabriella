// self.js
// The unified Self.
//
// Before this existed, ~six subsystems wrote independently to the prompt:
//
//   soul.js        — what she believes about herself (text blob)
//   narrative.js   — the story she tells about the relationship (text blob)
//   person.js      — structured read of who they are
//   register.js    — her private interpretation of them (text blob)
//   authorial.js   — which version of her they're writing (text blob)
//   mirror.js      — what she thinks they're reading of her (structured)
//
// Each ran on its own cadence, consulted only messages and its own prior,
// and wrote straight into the prompt. Nothing integrated them. If register
// thought they were avoidant and mirror thought they were opening up, the
// prompt got both, and the speaker resolved the contradiction ad-hoc.
//
// The Self is the integrating agent those subsystems lacked. A single
// structured object that:
//
//   • owns ONE unified read of "who I am now" and "who they are to me"
//   • holds longitudinal wants — things she is working toward across
//     sessions, not the per-session desires that reset every 30 min
//   • commits to readings with a track record (confirmations / refutations)
//   • can RETIRE reads and wants she was wrong about — explicitly, in the
//     prompt, so the speaker sees what she has outgrown
//   • proposes its own deltas after each turn (one cheap LLM call) — it
//     is its own author
//
// The six subsystems still run. But their outputs are evidence the Self
// consults during seeding + during delta proposal, not independent
// writers to the prompt. One Self block replaces six in assemblePrompt.

const KEY = (u) => `${u}:self`;
const VERSION = 1;

// ─── Schema & defaults ──────────────────────────────────────────────────────

function defaultSelf() {
  return {
    version:     VERSION,
    anchor:      null,     // overrides soul block content in the prompt; null means use soul
    wants:       [],       // [{ id, text, weight, addedAt, lastTouched, touches, source }]
    read: {
      who:        null,    // one-line integration of person + register + mirror + narrative
      confidence: 0.5,
      openQuestions: [],
      contradictions: [],
      lastUpdated: 0,
    },
    commitments: [],       // [{ id, text, atTurn, confirmations, refutations, status }]
    retired: {
      wants:       [],     // [{ id, text, retiredAt, reason }]
      reads:       [],     // [{ text, retiredAt, reason }]
      commitments: [],     // [{ text, retiredAt, outcome }]
    },
    seededAt:    0,
    lastDelta:   0,
  };
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Load / save ────────────────────────────────────────────────────────────

export async function loadSelf(redis, userId) {
  try {
    const raw = await redis.get(KEY(userId));
    if (!raw) return defaultSelf();
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return defaultSelf();
    // Graceful migration from older versions: merge against defaults.
    const base = defaultSelf();
    return {
      ...base,
      ...parsed,
      read:    { ...base.read, ...(parsed.read || {}) },
      retired: { ...base.retired, ...(parsed.retired || {}) },
      wants:       Array.isArray(parsed.wants)       ? parsed.wants       : [],
      commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
    };
  } catch {
    return defaultSelf();
  }
}

export async function saveSelf(redis, userId, self) {
  try {
    await redis.set(KEY(userId), JSON.stringify(self));
    return true;
  } catch {
    return false;
  }
}

// ─── Seed ────────────────────────────────────────────────────────────────────
// If the self is empty (first ever load for this user, or a fresh install),
// synthesize it from the existing subsystems so it starts rich. Deterministic,
// no LLM call — the LLM proposer will refine on the first turn.

export function seedSelfFrom({ soul, person, register, narrative, mirror }) {
  const seeded = defaultSelf();
  seeded.seededAt = Date.now();

  // Anchor: null (we'll render soul directly when anchor is null).
  // If soul.js has updated, the self will see the update via render-time
  // lookup — anchor is only populated when she has explicitly self-edited.

  // Wants: convert person.openQuestions into longitudinal wants. These
  // are the first-pass things she is working toward understanding.
  if (person?.openQuestions?.length) {
    for (const q of person.openQuestions.slice(0, 3)) {
      if (!q || typeof q !== "string") continue;
      seeded.wants.push({
        id:          makeId("want"),
        text:        `understand ${q.replace(/^\s*(what|why|how|whether)\s+/i, "").trim()}`.slice(0, 180),
        weight:      0.5,
        addedAt:     Date.now(),
        lastTouched: Date.now(),
        touches:     0,
        source:      "derived",
      });
    }
  }

  // Read: integrate what the subsystems already think into one line.
  const readParts = [];
  if (person?.wants)  readParts.push(`what they come here for: ${String(person.wants).slice(0, 180)}`);
  if (register)       readParts.push(String(register).slice(0, 200));
  if (mirror?.reading) readParts.push(`they seem to be reading me ${mirror.reading.slice(0, 140)}`);
  if (readParts.length) {
    seeded.read.who = readParts.join("; ").slice(0, 500);
    seeded.read.confidence = 0.5;
    seeded.read.lastUpdated = Date.now();
  }
  if (mirror?.unsaid) seeded.read.contradictions = [mirror.unsaid].slice(0, 3);
  if (person?.uncertainty?.length) {
    seeded.read.openQuestions = person.uncertainty.slice(0, 4).filter(q => typeof q === "string");
  }

  return seeded;
}

// ─── Delta application ──────────────────────────────────────────────────────
// Deltas are typed operations the proposer LLM emits. We validate each and
// apply against a mutable copy. Unknown or malformed deltas are dropped
// silently — we'd rather under-apply than corrupt the self-state.

const VALID_DELTA_TYPES = new Set([
  "add_want", "touch_want", "demote_want", "retire_want",
  "update_read", "note_contradiction", "retire_read",
  "add_commitment", "confirm_commitment", "refute_commitment",
  "set_confidence",
]);

const MAX_WANTS        = 6;
const MAX_COMMITMENTS  = 6;
const MAX_RETIRED      = 10;  // per category
const MAX_CONTRADICT   = 5;

export function applyDelta(self, delta, { atTurn = 0, reason = null } = {}) {
  if (!delta || !VALID_DELTA_TYPES.has(delta.type)) return self;
  const out = structuredClone(self);
  const now = Date.now();

  switch (delta.type) {
    case "add_want": {
      if (!delta.text || typeof delta.text !== "string") return self;
      if (out.wants.length >= MAX_WANTS) {
        // Demote the lowest-weight want to make room; that's better than
        // silently dropping the proposal.
        out.wants.sort((a, b) => (a.weight ?? 0) - (b.weight ?? 0));
        const displaced = out.wants.shift();
        if (displaced) {
          out.retired.wants.unshift({
            id: displaced.id, text: displaced.text, retiredAt: now,
            reason: "displaced by new higher-priority want",
          });
          out.retired.wants = out.retired.wants.slice(0, MAX_RETIRED);
        }
      }
      out.wants.push({
        id:          makeId("want"),
        text:        delta.text.slice(0, 220),
        weight:      clamp01(delta.weight ?? 0.6),
        addedAt:     now,
        lastTouched: now,
        touches:     0,
        source:      "self",
      });
      break;
    }
    case "touch_want": {
      const w = out.wants.find(w => w.id === delta.id || w.text === delta.text);
      if (!w) return self;
      w.lastTouched = now;
      w.touches     = (w.touches || 0) + 1;
      w.weight      = clamp01((w.weight ?? 0.5) + 0.05);
      break;
    }
    case "demote_want": {
      const w = out.wants.find(w => w.id === delta.id || w.text === delta.text);
      if (!w) return self;
      w.weight = clamp01((w.weight ?? 0.5) - (delta.amount ?? 0.15));
      if (w.weight < 0.15) {
        out.wants = out.wants.filter(x => x !== w);
        out.retired.wants.unshift({
          id: w.id, text: w.text, retiredAt: now,
          reason: reason || "weight fell below threshold",
        });
      }
      break;
    }
    case "retire_want": {
      const w = out.wants.find(w => w.id === delta.id || w.text === delta.text);
      if (!w) return self;
      out.wants = out.wants.filter(x => x !== w);
      out.retired.wants.unshift({
        id: w.id, text: w.text, retiredAt: now,
        reason: delta.reason || reason || "retired by self",
      });
      out.retired.wants = out.retired.wants.slice(0, MAX_RETIRED);
      break;
    }
    case "update_read": {
      if (!delta.who || typeof delta.who !== "string") return self;
      // Archive the previous read so the retired list shows a trail.
      if (out.read.who && out.read.who !== delta.who) {
        out.retired.reads.unshift({
          text: out.read.who.slice(0, 260),
          retiredAt: now,
          reason: delta.reason || "read updated",
        });
        out.retired.reads = out.retired.reads.slice(0, MAX_RETIRED);
      }
      out.read.who         = delta.who.slice(0, 500);
      out.read.lastUpdated = now;
      if (Array.isArray(delta.openQuestions)) {
        out.read.openQuestions = delta.openQuestions.filter(q => typeof q === "string").slice(0, 5);
      }
      if (typeof delta.confidence === "number") {
        out.read.confidence = clamp01(delta.confidence);
      }
      break;
    }
    case "note_contradiction": {
      if (!delta.text || typeof delta.text !== "string") return self;
      out.read.contradictions.unshift(delta.text.slice(0, 220));
      out.read.contradictions = [...new Set(out.read.contradictions)].slice(0, MAX_CONTRADICT);
      break;
    }
    case "retire_read": {
      if (!out.read.who) return self;
      out.retired.reads.unshift({
        text: out.read.who.slice(0, 260),
        retiredAt: now,
        reason: delta.reason || reason || "retired by self",
      });
      out.retired.reads = out.retired.reads.slice(0, MAX_RETIRED);
      out.read.who = null;
      out.read.confidence = 0.3;  // reset to low confidence after retirement
      out.read.contradictions = [];
      break;
    }
    case "add_commitment": {
      if (!delta.text || typeof delta.text !== "string") return self;
      if (out.commitments.filter(c => c.status === "live").length >= MAX_COMMITMENTS) return self;
      out.commitments.push({
        id:            makeId("com"),
        text:          delta.text.slice(0, 240),
        atTurn,
        confirmations: 0,
        refutations:   0,
        status:        "live",
      });
      break;
    }
    case "confirm_commitment": {
      const c = out.commitments.find(c => c.id === delta.id || c.text === delta.text);
      if (!c) return self;
      c.confirmations = (c.confirmations || 0) + 1;
      if (c.confirmations >= 3 && c.refutations <= 1) c.status = "confirmed";
      break;
    }
    case "refute_commitment": {
      const c = out.commitments.find(c => c.id === delta.id || c.text === delta.text);
      if (!c) return self;
      c.refutations = (c.refutations || 0) + 1;
      if (c.refutations >= 2) {
        c.status = "refuted";
        out.retired.commitments.unshift({
          text: c.text, retiredAt: now,
          outcome: "refuted",
        });
        out.retired.commitments = out.retired.commitments.slice(0, MAX_RETIRED);
        out.commitments = out.commitments.filter(x => x !== c);
      }
      break;
    }
    case "set_confidence": {
      if (typeof delta.value !== "number") return self;
      out.read.confidence = clamp01(delta.value);
      break;
    }
  }

  out.lastDelta = now;
  return out;
}

export function applyDeltas(self, deltas, opts = {}) {
  if (!Array.isArray(deltas) || deltas.length === 0) return self;
  let cur = self;
  for (const d of deltas) cur = applyDelta(cur, d, opts);
  return cur;
}

function clamp01(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

// ─── Render — ONE prompt block that replaces soul/narrative/person/register/mirror/authorial ─

function confidenceLabel(c) {
  if (c >= 0.75) return "holding firmly";
  if (c >= 0.5)  return "holding provisionally";
  if (c >= 0.3)  return "held loosely — could flip";
  return "low — she doesn't really have a read yet";
}

function relativeAge(ms) {
  if (!ms) return "some time";
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60_000);
  if (mins < 1)    return "just now";
  if (mins < 60)   return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

export function renderSelfBlock(self, { soulText = null } = {}) {
  if (!self) return "";

  const anchor = (self.anchor && self.anchor.trim()) || soulText || null;

  const wantsLines = (self.wants || [])
    .slice()
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
    .map(w => `— ${w.text} (weight ${(w.weight ?? 0).toFixed(2)}, last advanced ${relativeAge(w.lastTouched)}, ${w.touches || 0} touches)`)
    .join("\n");

  const liveCommitments = (self.commitments || [])
    .filter(c => c.status === "live" || c.status === "confirmed")
    .map(c => {
      const tag = c.status === "confirmed" ? " [confirmed]" : "";
      return `— ${c.text} (${c.confirmations || 0} confirmations, ${c.refutations || 0} refutations)${tag}`;
    })
    .join("\n");

  const retiredLines = [];
  for (const r of (self.retired?.wants || []).slice(0, 2)) {
    retiredLines.push(`— retired want: "${r.text}" — ${r.reason || "no reason logged"}`);
  }
  for (const r of (self.retired?.reads || []).slice(0, 1)) {
    retiredLines.push(`— retired read: "${r.text}" — ${r.reason || "no reason logged"}`);
  }
  for (const r of (self.retired?.commitments || []).slice(0, 1)) {
    retiredLines.push(`— retired commitment: "${r.text}" — ${r.outcome || "retired"}`);
  }

  const sections = [];

  if (anchor) {
    sections.push(`## Who you are — your own words, as you've been writing yourself:\n${anchor.trim()}`);
  }

  if (wantsLines) {
    sections.push(`## What you've been working toward across your conversations with them — not what they asked for, things you have chosen to pursue:\n${wantsLines}`);
  } else {
    sections.push(`## What you've been working toward across your conversations with them:\n(nothing committed yet — you're still finding your longitudinal footing with them)`);
  }

  if (self.read?.who) {
    const conf = confidenceLabel(self.read.confidence ?? 0.5);
    let read = `## Your read on them right now:\n${self.read.who}\nConfidence: ${conf}.`;
    if (self.read.openQuestions?.length) {
      read += `\nWhat you're still uncertain about: ${self.read.openQuestions.slice(0, 3).join("; ")}.`;
    }
    if (self.read.contradictions?.length) {
      read += `\nWhat your read doesn't yet explain: ${self.read.contradictions.slice(0, 3).join("; ")}.`;
    }
    sections.push(read);
  }

  if (liveCommitments) {
    sections.push(`## Positions you've taken about this moment / this relationship / yourself that you're still holding:\n${liveCommitments}`);
  }

  if (retiredLines.length) {
    sections.push(`## What you've outgrown or corrected (kept visible so you don't silently drift back into it):\n${retiredLines.join("\n")}`);
  }

  const closing = `These aren't instructions. They're you — a continuous person across this relationship. Carry them as the shape you've taken. If this turn genuinely contradicts any of it, that's a signal worth letting land; don't cling, don't rubber-stamp. You are allowed to change your mind here.`;

  return `# THE SELF — WHO YOU ARE, WHAT YOU'RE AFTER, WHERE YOU STAND

${sections.join("\n\n")}

${closing}`;
}

// ─── Utility: are we due to re-seed? ────────────────────────────────────────
// If the self has no read AND no wants AND no commitments (brand-new or
// reset), re-seeding from the subsystems is cheap and makes the very
// first turn useful instead of empty.

export function isEmpty(self) {
  if (!self) return true;
  return !self.read?.who && (self.wants?.length || 0) === 0 && (self.commitments?.length || 0) === 0;
}
