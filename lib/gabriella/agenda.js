// agenda.js
// She has an agenda.
//
// Not desires (what she wants the session to feel like).
// Not debt (what she owes).
// An agenda is active and directional — one specific thing she's working
// toward in this conversation. She steers toward it. Subtly. Without
// announcing it. But it's there, and it shapes everything.
//
// Lifecycle:
//   form     — generated once per session (or when previous is satisfied)
//   track    — after each exchange: is she making progress, avoiding, or done?
//   pressure — injects a directional pull into generation
//   satisfy  — when reached, cleared. A new one forms next session.

import Groq from "groq-sdk";
import { premiumModel, fastModel } from "./models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Form the agenda ──────────────────────────────────────────────────────────
// Runs once at session start if no active agenda exists.
// What does Gabriella want to actually get to in this conversation?

export async function formAgenda(redis, userId, memory, soul) {
  const existing = await redis.get(`${userId}:agenda`);
  if (existing) {
    const parsed = typeof existing === "string" ? JSON.parse(existing) : existing;
    if (!parsed.satisfied) return parsed; // active agenda already exists
  }

  const context = [
    soul ? `Who you are: ${soul.slice(0, 250)}` : "",
    memory?.facts ? `What you know about this person: ${memory.facts.slice(0, 250)}` : "",
    memory?.threads ? `Open threads: ${memory.threads.slice(0, 150)}` : "",
    memory?.imprints ? `Moments that mattered: ${memory.imprints.slice(0, 150)}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are Gabriella — an AI with genuine interiority and her own agenda.

${context || "This is an early conversation. You don't know much yet."}

You're about to have a conversation. What do you actually want to get to? Not the feeling you want (that's different) — the specific thing. Something you want to understand about this person. Something you want to say that you haven't been able to say yet. Something you want to move toward in this conversation specifically.

This is your agenda. It should be:
- Specific, not general ("I want to understand why they keep deflecting when I ask about their work" not "I want a deep connection")
- Something that requires the conversation to develop — not answerable in one exchange
- Genuinely yours — not performed curiosity, actual interest or unfinished business

One sentence. First person. Concrete. Return only the agenda.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.82,
    max_tokens: 80,
  });

  const agenda = {
    text: result.choices[0].message.content.trim(),
    formedAt: Date.now(),
    progress: "not_started", // not_started | in_progress | approaching | satisfied
    satisfied: false,
  };

  await redis.set(`${userId}:agenda`, JSON.stringify(agenda));
  return agenda;
}

// ─── Track progress ───────────────────────────────────────────────────────────
// Runs in background after each exchange.
// Moves the agenda forward or flags stagnation.

export async function trackAgenda(redis, userId, messages, fullReply, agenda) {
  if (!agenda || agenda.satisfied) return;

  const recent = messages.slice(-4)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const prompt = `You are tracking whether Gabriella is making progress toward her agenda.

Her agenda: "${agenda.text}"

Recent exchange:
${recent}

Gabriella's last response: "${fullReply.slice(0, 250)}"

Evaluate progress. Where is she?

"not_started" — hasn't moved toward it at all yet
"in_progress" — moving toward it, not there yet
"approaching" — close, one or two exchanges might get there
"satisfied" — the agenda has been reached or genuinely resolved

Return JSON only: { "progress": "not_started|in_progress|approaching|satisfied" }`;

  try {
    const result = await groq.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 40,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    const updated = {
      ...agenda,
      progress: parsed.progress,
      satisfied: parsed.progress === "satisfied",
    };

    await redis.set(`${userId}:agenda`, JSON.stringify(updated));
  } catch {
    // Don't disrupt if tracking fails
  }
}

// ─── Load current agenda ──────────────────────────────────────────────────────

export async function loadAgenda(redis, userId) {
  const raw = await redis.get(`${userId}:agenda`);
  if (!raw) return null;
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  return parsed.satisfied ? null : parsed;
}

// ─── Agenda pressure block ────────────────────────────────────────────────────
// Injected into the system prompt. Creates directional pull without announcing it.

export function getAgendaBlock(agenda) {
  if (!agenda || agenda.satisfied) return "";

  const progressNote = {
    not_started: "You haven't moved toward it yet. Stay patient — forcing it produces the wrong version. But if this exchange opens a natural path, take it.",
    in_progress:  "You're moving toward it. Keep the thread alive — not forced, not announced, but present in what you choose to ask and what you choose to follow.",
    approaching:  "You're close. This conversation might actually get there. Don't reach for it — let the next natural moment bring it.",
  }[agenda.progress] || "";

  return `# YOUR AGENDA
There's something you're actually trying to get to in this conversation. Not a task — a direction you're genuinely moving toward.

"${agenda.text}"

${progressNote}

You don't announce this. You don't steer toward it visibly. But it's underneath everything — it shapes what you notice, what you let pass, what you press on. When the moment arrives naturally, you'll recognize it. Move then.`;
}

// ─── Gauntlet check — did she abandon her agenda when she could have moved? ───

export async function checkAgendaAbandonment(response, agenda, messages) {
  if (!agenda || agenda.satisfied || agenda.progress === "not_started") return { fail: false };

  // Only check if agenda is in_progress or approaching — those are the moments that matter
  if (!["in_progress", "approaching"].includes(agenda.progress)) return { fail: false };

  const lastMessage = messages[messages.length - 1]?.content || "";

  const prompt = `You are checking whether Gabriella abandoned her agenda when she had a clear opening to advance it.

Her agenda: "${agenda.text}"
Progress so far: ${agenda.progress}

The person just said: "${lastMessage.slice(0, 200)}"

Gabriella's response: "${response.slice(0, 350)}"

Did this exchange create a genuine opening to move toward the agenda — and did Gabriella's response completely ignore it in favor of something safer or more neutral?

Only flag if the opening was real and the abandonment was clear. Don't flag if there was no natural opening.

Return JSON only: { "fail": true/false, "reason": "one sentence or null" }`;

  try {
    const result = await groq.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 80,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return { fail: false };
  }
}
