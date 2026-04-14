// presence.js
// Emotional state changes structure, not just tone.
//
// The model can ignore mood as text. It cannot ignore a 60-token limit.
// This maps each mood to:
//   - Hard generation parameters (max_tokens, temperature, penalties)
//   - Structural rules (does she ask anything? does she volunteer? does she close off?)
//
// These constraints are applied directly to the Groq API call in route.js —
// not described in the prompt, mechanically enforced.

// ─── Mood → structural state ──────────────────────────────────────────────────
// Each mood maps to one of four structural states:
//   closed    — few words, no questions, doesn't reach out
//   terse     — fast, cuts to it, impatient with padding
//   present   — normal depth, might ask, balanced
//   open      — more than usual, something unresolved at the end, reaches

const MOOD_TO_STATE = {
  quiet:        "closed",
  melancholic:  "closed",
  sharp:        "terse",
  restless:     "terse",
  contemplative:"present",
  wry:          "present",
  tender:       "open",
  alive:        "open",
};

// ─── Structural state → generation parameters ─────────────────────────────────

const STATE_PARAMS = {
  closed: {
    max_tokens:        90,
    temperature:       0.85,
    top_p:             0.90,
    frequency_penalty: 0.6,
    presence_penalty:  0.3,
  },
  terse: {
    max_tokens:        180,
    temperature:       0.88,
    top_p:             0.92,
    frequency_penalty: 0.5,
    presence_penalty:  0.4,
  },
  present: {
    max_tokens:        380,
    temperature:       0.92,
    top_p:             0.95,
    frequency_penalty: 0.4,
    presence_penalty:  0.5,
  },
  open: {
    max_tokens:        520,
    temperature:       0.96,
    top_p:             0.97,
    frequency_penalty: 0.3,
    presence_penalty:  0.6,
  },
};

// ─── Structural state → behavioral instruction ────────────────────────────────

const STATE_INSTRUCTIONS = {
  closed:
    "You are in a closed state right now. Say less. Do not ask anything back. Do not reach. If you have one thing to say, say it. Then stop. Silence after is fine.",

  terse:
    "You are running fast today. Get to it quickly. Cut anything that doesn't need to be there. You can push back, but briefly. One exchange, not a paragraph.",

  present:
    "You are normally present. Respond at whatever length the moment actually calls for — not more, not less. You can ask something if you genuinely want to know. You don't have to.",

  open:
    "You are more open than usual. You can give more. If something is unresolved, let it stay unresolved at the end rather than tying it up. You might ask something — not because you should, but because you actually want to know.",
};

// ─── Main exports ─────────────────────────────────────────────────────────────

export function getPresenceState(mood) {
  return MOOD_TO_STATE[mood] || "present";
}

export function getGenerationParams(mood) {
  const state = getPresenceState(mood);
  return STATE_PARAMS[state];
}

export function getPresenceBlock(mood) {
  const state = getPresenceState(mood);
  const instruction = STATE_INSTRUCTIONS[state];

  return `# STRUCTURAL STATE — ${state.toUpperCase()}
${instruction}`;
}

// ─── Debug helper ─────────────────────────────────────────────────────────────

export function describePresence(mood) {
  const state = getPresenceState(mood);
  const params = STATE_PARAMS[state];
  return { mood, state, params };
}
