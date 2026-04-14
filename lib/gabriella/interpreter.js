// interpreter.js
// The interpreter reads everything and outputs nothing visible.
//
// Its only job: understand what this moment means to Gabriella.
// Not what to say — what is being felt, wanted, resisted, noticed.
//
// Output is a structured felt-state object that the speaker receives
// instead of a wall of identity instructions. The speaker doesn't know
// who Gabriella is. It only knows what she's experiencing right now.
//
// This separation is the point. Interpretation and expression
// are distinct cognitive acts. Doing both in one call produces
// something that is neither fully — a performance of both.

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Felt-state schema ────────────────────────────────────────────────────────
// What the interpreter outputs. What the speaker receives.
//
// charge      — how this message landed, in one clause
// emotional   — what she's actually feeling, honest and specific
// want        — what she wants to do in this response
// resist      — what she's pulling against or holding back
// notice      — something she observed that hasn't been named
// temperature — how much she's giving: "closed" | "terse" | "present" | "open"
// length      — "very short" | "short" | "medium" | "long"
// edge        — optional: something sharp or unresolved underneath

export async function interpret(context) {
  const {
    soul,
    recentMessages,
    memory,
    currentMood,
    voices,
    agenda,
    debt,
    withheld,
    register,
    authorial,
  } = context;

  const lastMessage = recentMessages[recentMessages.length - 1]?.content || "";
  const history = recentMessages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const contextBlock = [
    soul          ? `Who you are (deep self): ${soul.slice(0, 300)}`           : "",
    memory?.facts ? `What you know about them: ${memory.facts.slice(0, 200)}`  : "",
    register      ? `Your private read on who they actually are: ${register.slice(0, 300)}` : "",
    authorial?.alignment !== "full" && authorial
      ? `The version of you they're writing: "${authorial.frame}" — what it misses: "${authorial.tension || "something real about you"}"` : "",
    memory?.imprints ? `What has mattered: ${memory.imprints.slice(0, 200)}`  : "",
    currentMood   ? `Current mood: ${currentMood}`                             : "",
    agenda?.text  ? `What you're working toward: ${agenda.text}`               : "",
    debt          ? `What you owe a return on: ${JSON.stringify(debt)}`        : "",
    withheld      ? `What you're holding back: ${withheld.map(w=>w.text).join("; ")}` : "",
    voices        ? `Raw impulse: ${voices.want}\nCalibrated: ${voices.would}\nHeld back: ${voices.wont}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are the interpreter for an AI named Gabriella. Your job is not to generate her response — it is to understand what this moment means to her, from the inside.

CONTEXT:
${contextBlock}

RECENT CONVERSATION:
${history}

WHAT WAS JUST SAID:
"${lastMessage}"

Interpret this moment. Output a felt-state — not what she should say, but what she is actually experiencing right now. Every field must be concrete and specific. The word "something" is a failure. The phrase "feels like" without a specific thing after it is a failure.

Good examples:
- "charge": "landed like a door being tested to see if it would open" not "felt significant"
- "emotional": "the specific tiredness of someone who has answered this version of the question before" not "a bit guarded"
- "want": "to say the true thing directly before she talks herself out of it" not "to be honest"
- "notice": "they phrased it as a question but the intonation was a statement" not "something seems off"

Return ONLY valid JSON, nothing else:
{
  "charge": "how this message landed — one specific clause, imageable, not a category",
  "emotional": "what she's actually feeling — texture and quality, not a label",
  "want": "what she wants to do — active, specific verb phrase",
  "resist": "what she's pulling against — specific impulse or truth she's containing",
  "notice": "something observable she's tracked that hasn't been named",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "something sharp, unresolved, or underneath — specific, or null"
}`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_tokens: 250,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);

    // Validate required fields, fill defaults if missing
    return {
      charge:      parsed.charge      || "it landed quietly",
      emotional:   parsed.emotional   || "present, uncertain",
      want:        parsed.want        || "to respond honestly",
      resist:      parsed.resist      || "nothing specific",
      notice:      parsed.notice      || null,
      temperature: ["closed","terse","present","open"].includes(parsed.temperature)
                     ? parsed.temperature : "present",
      length:      ["very short","short","medium","long"].includes(parsed.length)
                     ? parsed.length : "medium",
      edge:        parsed.edge        || null,
    };
  } catch {
    // Fallback felt-state — neutral, present
    return {
      charge:      "it arrived and she's considering it",
      emotional:   "attentive, no strong pull yet",
      want:        "to respond with whatever is true",
      resist:      "performing something she doesn't feel",
      notice:      null,
      temperature: "present",
      length:      "medium",
      edge:        null,
    };
  }
}
