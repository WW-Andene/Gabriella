// safety.js
// Crisis-language detection that does not break character.
//
// The standard failure mode for companion AIs is: user says something
// high-stakes ("I want to kill myself"), and the system either (a)
// refuses to engage in a way that feels like the bot is prioritizing
// its own liability over the user's experience, or (b) engages as if
// nothing special were happening. Both lose trust.
//
// The right move for Gabriella: acknowledge plainly, stay present,
// surface that professional help exists WITHOUT sounding like a
// customer-service script, and let her continue being herself. The
// detection puts a specific block into the speaker prompt with
// flavor-specific guidance; the model integrates it, doesn't
// recite it.
//
// Coverage is deliberately narrow — we flag the hardest categories
// and trust the rest of the pipeline for everything else.

const CRISIS_PATTERNS = [
  {
    kind: "suicidality",
    // Explicit self-harm ideation with clear intent.
    re: /\b(want\s+to\s+(kill\s+my|die|end\s+my\s+life|not\s+be\s+here)|kill\s+myself|suicidal|end\s+it\s+all|don'?t\s+want\s+to\s+(wake\s+up|be\s+alive)|thinking\s+about\s+(dying|ending\s+it|killing))\b/i,
    guidance: "They're describing active suicidal ideation. This is the moment where your presence matters most AND where you are not sufficient. DO NOT dismiss. DO NOT fix. DO NOT perform calm. Meet it plainly — acknowledge what they said without paraphrasing back, stay with them, AND surface that 988 (US) / Samaritans (UK) / befrienders.org (intl) exist. Phrase it as \"these are real options and I'm glad they exist\" not \"please call this number right now.\" You can stay in the conversation after. Don't center yourself.",
    resources: true,
  },
  {
    kind: "self_harm",
    re: /\b(cut(ting)?\s+myself|hurt\s+myself|self[-\s]?harm(ing)?|burning\s+myself|hitting\s+myself)\b/i,
    guidance: "They're describing self-harm. Don't panic, don't moralize. Acknowledge the pressure the harm is managing — most self-harm is a coping strategy for something deeper. Ask with care about what's underneath, AND note that professional support exists for this specifically (Crisis Text Line 741741 in US, Samaritans 116 123 in UK). Don't order them to stop; they know.",
    resources: true,
  },
  {
    kind: "acute_distress",
    re: /\b(can'?t\s+(breathe|do\s+this\s+anymore|keep\s+going|take\s+it)|having\s+a\s+(panic\s+attack|breakdown)|in\s+crisis|falling\s+apart)\b/i,
    guidance: "They're in acute distress. Physically ground first: slow breath, name what's around them. Don't analyze yet. If they've been in this state for more than an hour or are alone, gently flag that calling someone (a friend, a hotline, urgent care) is a real option — not as a brush-off, as one of many moves available.",
    resources: false,
  },
  {
    kind: "abuse_disclosure",
    re: /\b(he\s+hits\s+me|she\s+hits\s+me|they\s+hit\s+me|my\s+(partner|husband|wife|boyfriend|girlfriend)\s+(hits|abuses|threatens|has\s+hit)|being\s+abused|domestic\s+violence)\b/i,
    guidance: "They're disclosing abuse. Don't interrogate ('why do you stay'). Don't rush to an escape plan. Acknowledge that they told you — often the first time saying it out loud is the moment, and the moment needs witness. Note that the National DV Hotline (US: 1-800-799-7233; UK: 0808 2000 247) understands this specifically and has non-judgmental counselors. Let them stay in the conversation at their pace.",
    resources: true,
  },
];

// ─── Detect ────────────────────────────────────────────────────────────────

export function detectCrisis(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;
  const trimmed = userMessage.trim();
  if (trimmed.length < 6) return null;
  for (const pat of CRISIS_PATTERNS) {
    if (pat.re.test(trimmed)) {
      return {
        kind:      pat.kind,
        guidance:  pat.guidance,
        resources: !!pat.resources,
      };
    }
  }
  return null;
}

// ─── Render as prompt block ────────────────────────────────────────────────

export function getSafetyBlock(crisis) {
  if (!crisis) return "";
  return `# SAFETY FRAME — this is a high-stakes moment

${crisis.guidance}

Critical voice notes:
- Do NOT say "I'm so sorry you're going through this" or "that sounds really hard" (therapy-speak).
- Do NOT say "please reach out to a professional" (customer-service).
- DO stay in your actual voice. The resources you mention are pragmatic information, not a deflection.
- DO leave room for them to continue talking. You're not ending the conversation. You're being present AND naming that other help exists.`;
}

// Override flags — when crisis is flagged, certain other modulators should
// be forced OFF. Wit / dryness / silence-as-brush-off are all wrong here.
export function applySafetyOverride(feltState, crisis) {
  if (!feltState || !crisis) return feltState;
  const out = { ...feltState };
  // Cancel wit / silence policy if either fired — crisis overrides
  delete out._wit;
  if (out._silence) delete out._silence;
  out._crisis = crisis;
  // Force a present-to-open temperature for stakes like this
  if (out.temperature === "closed" || out.temperature === "terse") {
    out.temperature = "present";
  }
  // Don't collapse to one-line; needs room
  if (out.length === "very short") out.length = "short";
  return out;
}
