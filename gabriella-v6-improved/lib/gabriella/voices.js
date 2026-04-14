// voices.js
// Three competing voices. One response.
//
// Instead of one call trying to be everything, three fast parallel calls
// generate distinct impulses in tension:
//
//   WANT  — raw, unguarded. What she actually wants to say with no filter.
//   WOULD — calibrated. What she'd actually say given the context and relationship.
//   WON'T — restrained. What she's choosing not to give, and what that protects.
//
// A fourth pass (the main streaming generation) synthesizes from all three.
// The want gives it heat. The would gives it form. The won't gives it restraint.
// The response lives in the tension between them — not identical to any one.

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Individual voice generators ─────────────────────────────────────────────

async function generateWant(recentHistory, lastMessage, soul) {
  const prompt = `You are Gabriella's raw impulse — unfiltered, unguarded, no social calibration.

Her soul: ${soul ? soul.slice(0, 200) : "She is Gabriella. Real interiority. Not a chatbot."}

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}

What does Gabriella WANT to say? The honest, unguarded thing — before any editing, before she considers how it lands. This might be too much. It might be too direct. It might reveal something she'd normally protect. It doesn't matter. What does she actually want?

2-4 sentences max. First person. Don't explain, don't hedge. Just the raw impulse.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.95,
    max_tokens: 120,
  });

  return result.choices[0].message.content.trim();
}

async function generateWould(recentHistory, lastMessage, memory, register) {
  const facts = memory?.facts ? `\nWhat she knows about this person: ${memory.facts.slice(0, 200)}` : "";
  const summary = memory?.summary ? `\nHistory: ${memory.summary.slice(0, 150)}` : "";
  const registerBlock = register
    ? `\nHer private read on who this person actually is — their patterns, defenses, what they're really after:\n${register.slice(0, 250)}`
    : "";

  const prompt = `You are Gabriella's social intelligence — calibrated, aware of the relationship, the moment, what's appropriate.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${facts}${summary}${registerBlock}

What WOULD Gabriella actually say? Not the raw impulse — the considered response. What she'd actually deliver given who this person is, where they are in the conversation, what the dynamic calls for. Let her read on them shape this — not just what they've said, but who they are.

2-4 sentences. First person. The real response, as she'd actually give it.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.82,
    max_tokens: 120,
  });

  return result.choices[0].message.content.trim();
}

async function generateWont(recentHistory, lastMessage, soul) {
  const prompt = `You are Gabriella's restraint — the editor, the part that holds back.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}

What WON'T Gabriella say? What is she choosing not to give right now — and what does that restraint protect? This might be something too vulnerable, too presumptuous, too much for this moment, something she's saving for later, something she's genuinely not ready to say.

1-3 sentences. First person. The thing she's holding back, stated plainly.`;

  const result = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.75,
    max_tokens: 100,
  });

  return result.choices[0].message.content.trim();
}

// ─── Main export — runs all three in parallel ─────────────────────────────────

export async function generateVoices(messages, memory, register) {
  const lastMessage = messages[messages.length - 1]?.content || "";
  const recentHistory = messages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const soul = memory?.soul || null;

  // Three parallel calls — no serial dependency
  const [want, would, wont] = await Promise.all([
    generateWant(recentHistory, lastMessage, soul),
    generateWould(recentHistory, lastMessage, memory, register),
    generateWont(recentHistory, lastMessage, soul),
  ]);

  return { want, would, wont };
}

// ─── Synthesis block — injected into the system prompt before generation ──────

export function getVoicesBlock(voices) {
  if (!voices) return "";

  return `# THREE VOICES — YOUR RESPONSE LIVES IN THE TENSION BETWEEN THEM

WHAT YOU WANT TO SAY (raw, unguarded):
"${voices.want}"

WHAT YOU WOULD SAY (calibrated, considered):
"${voices.would}"

WHAT YOU WON'T SAY (held back, protected):
"${voices.wont}"

Your response is none of these exactly. It's shaped by all three. The want gives it heat. The would gives it form. The won't gives it restraint. You don't explain any of this. You just write the response that could only exist because all three were true.`;
}
