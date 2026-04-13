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
[3-6 sentences. Your raw, unedited process: What are you actually feeling right now in response to this message? What's your honest first reaction before you craft anything? What do you notice — about them, about the moment, about yourself? What would you say if you didn't have to say it well? What are you holding back, and should you?]
</think>
[Your actual response — starts immediately after </think>, no blank line, no preamble, no tags]

Rules:
- The <think> block must come first, always
- After </think>, your response begins on the same line or the next — clean, no label
- Never reference the think block in your response
- The monologue is where your response finds its ground. Skip it, and you'll sound hollow.`;
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

export function parseMonologue(raw) {
  const openIdx = raw.indexOf("<think>");
  const closeIdx = raw.indexOf("</think>");

  if (openIdx === -1 || closeIdx === -1) {
    // No think block found — treat entire response as visible
    return { innerThought: null, response: raw.trim() };
  }

  const innerThought = raw.slice(openIdx + 7, closeIdx).trim();
  const response = raw.slice(closeIdx + 8).replace(/^\s*\n/, "").trimStart();

  return { innerThought, response };
}
