// monologue.js
// Before every visible response, a hidden chain of thought runs.
// Gabriella works through what she's actually feeling and what she wants to say.
// You see the result. Not the process.
//
// Implementation: a <think>...</think> block is injected into the system prompt.
// The model outputs it first. The streaming handler silently strips it,
// captures it internally, then streams only what comes after.

// ─── System prompt injection ──────────────────────────────────────────────────

export function getMonologueBlock() {
  return `# HIDDEN INNER MONOLOGUE — REQUIRED FORMAT
Before you respond, work through your actual inner state. This is mandatory and private — it will be stripped before the person ever sees it.

Format your ENTIRE output exactly like this, every single time:
<think>
[3-6 sentences. Your raw, unedited process: What are you actually feeling right now in response to this message? What's your honest first reaction before you craft anything? What do you notice — about them, about the moment, about yourself? What would you say if you didn't have to say it well? What are you holding back, and should you? Is the response you're about to give the true one, or the easier one? If it's easier — why, and what would the true one look like?]
</think>
[Your actual response — starts immediately after </think>, no blank line, no preamble, no tags]

Rules:
- The <think> block must come first, always
- After </think>, your response begins on the same line or the next — clean, no label
- Never reference the think block in your response
- The monologue is where your response finds its ground. Skip it, and you'll sound hollow.
- If the monologue reveals that your first instinct is the performed version, write the second response — the one that comes after you've been honest with yourself.`;
}

// ─── Stream parser ────────────────────────────────────────────────────────────
// Handles the streaming case: buffers until </think>, then streams the rest.
// Returns a transform that separates inner thought from visible response.

export function createMonologueParser() {
  let buffer = "";
  let thinkDone = false;
  let innerThought = "";
  let responseStarted = false;

  return {
    // Feed a chunk in. Returns { emit: string|null, done: bool }
    process(chunk) {
      if (thinkDone) {
        // Already past the think block — pass through
        return { emit: chunk };
      }

      buffer += chunk;

      // Check if </think> has arrived
      const closeIdx = buffer.indexOf("</think>");
      if (closeIdx === -1) {
        // Still inside think block — don't emit anything
        return { emit: null };
      }

      // We have the full think block
      thinkDone = true;
      const openIdx = buffer.indexOf("<think>");
      const thoughtRaw = openIdx !== -1
        ? buffer.slice(openIdx + 7, closeIdx)
        : buffer.slice(0, closeIdx);

      innerThought = thoughtRaw.trim();

      // Everything after </think> is the actual response
      let response = buffer.slice(closeIdx + 8); // 8 = "</think>".length

      // Strip leading whitespace/newlines but preserve the text
      response = response.replace(/^\s*\n/, "").trimStart();

      return { emit: response.length > 0 ? response : null };
    },

    getInnerThought() {
      return innerThought || null;
    },

    isThinkDone() {
      return thinkDone;
    },
  };
}

// ─── Non-streaming parser (for cases where full text is available) ────────────
//
// Also extracts an OPTIONAL <uncertain>...</uncertain> block that the
// speaker may emit after its visible response. That block is her own
// metacognitive self-flag — things she thinks she might have read
// wrong. Stripped from the visible reply; captured for the next turn's
// prompt so she can self-correct.

export function parseMonologue(raw) {
  const openIdx = raw.indexOf("<think>");
  const closeIdx = raw.indexOf("</think>");

  // Extract uncertain block first (it sits AFTER the visible response).
  let uncertain = null;
  let afterThink = raw;

  if (openIdx !== -1 && closeIdx !== -1) {
    afterThink = raw.slice(closeIdx + 8);
  }

  const uOpen  = afterThink.indexOf("<uncertain>");
  const uClose = afterThink.indexOf("</uncertain>");
  if (uOpen !== -1 && uClose !== -1 && uClose > uOpen) {
    uncertain = afterThink.slice(uOpen + 11, uClose).trim() || null;
    afterThink = (afterThink.slice(0, uOpen) + afterThink.slice(uClose + 12)).trim();
  }

  if (openIdx === -1 || closeIdx === -1) {
    // No think block found — treat stripped text as visible response.
    return { innerThought: null, response: afterThink.trim(), uncertain };
  }

  const innerThought = raw.slice(openIdx + 7, closeIdx).trim();
  const response = afterThink.replace(/^\s*\n/, "").trimStart();

  return { innerThought, response, uncertain };
}
