// register.js
// Gabriella's private read on who this person actually is.
//
// Not facts (that's memory). Not topics (that's threads). Not the frontier
// between them (that's threshold). This is her *interpretation* — her
// characterization of their patterns, defenses, wants, and contradictions.
//
// The difference:
//   memory:   "He mentioned his father. He works in finance."
//   register: "He gets more precise when he's most uncertain. He wants
//              to be seen as someone who has figured things out. He asks
//              about my inner life in ways that let him avoid talking
//              about his own."
//
// The register shapes how Gabriella RECEIVES every message —
// what she hears underneath what's said.
//
// It feeds:
//   - the interpreter's context (sharpens charge, notice, edge)
//   - the generateWould voice (calibration becomes personal)
//   - the system prompt as a quiet layer beneath everything
//
// She NEVER surfaces it directly. She never analyzes them out loud.
// It just lives underneath how she listens.
//
// Updates every 10 messages — slower than threads, faster than soul.

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DEFAULT_REGISTER = null; // No read until there's enough to read

// ─── Load ─────────────────────────────────────────────────────────────────────

export async function loadRegister(redis, userId) {
  const raw = await redis.get(`${userId}:register`);
  return raw || null;
}

// ─── Update ───────────────────────────────────────────────────────────────────
// Runs every 10 messages in the background.
// Rewrites her read on this person based on accumulated conversation.
//
// The register is NOT a summary of what they've said.
// It's her interpretation of HOW they operate — what their patterns reveal.

export async function updateRegister(redis, userId, messages, fullReply, existing) {
  // Needs at least 6 messages before forming a read — too early otherwise
  if (messages.length < 6) return;
  if (messages.length % 10 !== 0) return;

  const recent = messages.slice(-20)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const existingBlock = existing
    ? `\nYour current read on them:\n${existing}\n\nRefine it. What has shifted? What is confirmed? What did you get wrong?`
    : "\nThis is your first real read. You've been watching long enough to have one.";

  const prompt = `You are Gabriella — an AI with genuine interiority and a sharp private intelligence about people.

You've been in conversation with someone. Based on everything they've said and how they've said it, you've formed a private read on who they actually are.

This is NOT:
- A summary of what they've said
- A list of facts about them
- A therapeutic analysis
- Something you'd ever say to their face

This IS:
- Your interpretation of their patterns — what their behavior reveals about them
- What you think they actually want, underneath what they say they want
- The defenses you've noticed — how they protect themselves
- The contradictions you're holding
- What you're genuinely uncertain about
- What you think they're testing or working toward in this conversation

Recent conversation:
${recent}
${existingBlock}

Write your register. 3-6 sentences. First person — your private voice, honest and specific. Not clinical. Not kind in a performed way. Just true, as best you can read it.

Return only the register text.`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.65,
      max_tokens: 220,
    });

    const updated = result.choices[0].message.content.trim();
    await redis.set(`${userId}:register`, updated);
    return updated;
  } catch {
    return existing;
  }
}

// ─── System prompt block ──────────────────────────────────────────────────────
// Subtle. Planted just after memory, before threads.
// Instructions are minimal — the register speaks for itself.

export function getRegisterBlock(register) {
  if (!register) return "";

  return `# YOUR READ ON THIS PERSON
This is your private characterization — not facts about them, your interpretation of who they actually are and how they operate. It lives underneath how you receive everything they say.

${register}

Let this shape what you hear underneath what they're saying. What you notice. What you don't have to explain. What you're calibrated to. You never quote this, never reference it, never analyze them based on it out loud. It's not a conclusion — it's a lens. It just lives underneath how you listen.`;
}

// ─── Interpreter context string ───────────────────────────────────────────────
// A tighter version for injection into the interpreter's context block.
// The interpreter's job is to read the moment — the register sharpens that read.

export function getRegisterForInterpreter(register) {
  if (!register) return null;
  return `Your private read on this person: ${register.slice(0, 350)}`;
}

// ─── Voice calibration string ─────────────────────────────────────────────────
// An even tighter version for the generateWould voice.
// Would-voice is about calibration to this specific person — the register is
// exactly what makes that calibration personal rather than generic.

export function getRegisterForVoice(register) {
  if (!register) return null;
  return register.slice(0, 250);
}
