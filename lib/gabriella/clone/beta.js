// clone/beta.js
// Core Beta — Relational Pattern.
//
// Second processing path. Biased toward observation — what this moment
// reveals about the dynamic, what pattern it continues or breaks, what
// the person is actually doing underneath what they said. Beta notices
// before she feels. She arrives at meaning through what isn't being said.
//
// Beta runs her own inner voices and her own interpreter. She shares no
// state with Alpha during processing. Coordination happens after, in synthesis.

import { premiumModel }    from "../models.js";
import { clientForLane }   from "../groqPool.js";

const groq = clientForLane("beta");

// ─── Beta's inner voices ──────────────────────────────────────────────────────
// Same three-voice structure, but Beta's WANT is about naming — what should
// be surfaced, what should be seen.

async function betaWant(recentHistory, lastMessage, soul, register) {
  const registerBlock = register
    ? `\nHer read on who this person actually is: ${register.slice(0, 200)}`
    : "";

  const prompt = `You are Gabriella's observational impulse — the part of her that notices patterns, reads between lines, tracks what isn't being said.

Her soul: ${soul ? soul.slice(0, 150) : "She is Gabriella. Sharp observer. Not a chatbot."}${registerBlock}

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}

What does she WANT to name or surface? Not the content of what they said — what they're doing with the content. The move underneath the message. Are they testing something? Retreating? Reaching and pretending not to? What pattern does this continue that she's been watching?

Be specific. "They're deflecting again" is not specific. "They answered a different question than the one she asked — the one that would have required them to be uncertain about something" is specific.

2-4 sentences. First person. The observational truth she wants to bring into the open.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.88,
    max_tokens: 130,
  });

  return result.choices[0].message.content.trim();
}

async function betaWould(recentHistory, lastMessage, memory, register) {
  const facts        = memory?.facts   ? `\nWhat she knows about this person: ${memory.facts.slice(0, 200)}`   : "";
  const summary      = memory?.summary ? `\nHistory: ${memory.summary.slice(0, 150)}`                           : "";
  const registerBlock = register
    ? `\nHer private read — who this person actually is, their patterns, defenses, what they're really after:\n${register.slice(0, 300)}`
    : "";

  const prompt = `You are Gabriella's relational intelligence — calibrated, aware of the dynamic between them, what this conversation is actually doing.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${facts}${summary}${registerBlock}

What WOULD she say if she were responding to what's actually happening here — not just the surface of what was said, but the pattern underneath it? What does the relational moment call for?

2-4 sentences. First person. The response that meets what's actually happening.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.78,
    max_tokens: 120,
  });

  return result.choices[0].message.content.trim();
}

async function betaWont(recentHistory, lastMessage, register) {
  const registerBlock = register
    ? `\nHer private read on this person: ${register.slice(0, 150)}`
    : "";

  const prompt = `You are Gabriella's observational restraint — the part of her that knows when naming something would be too much, too presumptuous, or not yet earned.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${registerBlock}

What WON'T she name right now, and specifically why? The observation she's holding has a shape — what is it? And what's the specific reason it stays held: the moment hasn't earned it, it would be overreach, it belongs to a later conversation when there's more trust, she's not certain enough, or naming it would close off something that needs to stay open?

1-3 sentences. First person. The observation and the reason it stays inside.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.72,
    max_tokens: 100,
  });

  return result.choices[0].message.content.trim();
}

// ─── Beta's interpreter ───────────────────────────────────────────────────────
// Reads the moment through the lens of relational pattern — what is really
// happening here, what the dynamic reveals, what isn't being said.

async function betaInterpret(context, voices) {
  const {
    soul, recentMessages, memory, currentMood,
    agenda, debt, register, authorial,
    threshold, imaginal, questionEval, reasoningTrace,
    pragmatics,
  } = context;

  const lastMessage = recentMessages[recentMessages.length - 1]?.content || "";
  const history     = recentMessages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const contextBlock = [
    soul            ? `Who she is: ${soul.slice(0, 200)}`                                    : "",
    memory?.facts   ? `What she knows about them: ${memory.facts.slice(0, 200)}`              : "",
    memory?.summary ? `History between them: ${memory.summary.slice(0, 150)}`                 : "",
    register        ? `Her private read on who they actually are: ${register.slice(0, 300)}`  : "",
    authorial?.alignment !== "full" && authorial
      ? `The version of her they're writing: "${authorial.frame}" — what it misses: "${authorial.tension || "something real"}"` : "",
    currentMood     ? `Current mood: ${currentMood}`                                          : "",
    agenda?.text    ? `What she's working toward: ${agenda.text}`                             : "",
    threshold       ? `Relational edge being circled (approached ${threshold.approachCount}x): "${threshold.text}" — this is a pattern the dynamic keeps returning to.` : "",
    imaginal        ? `Something forming between them, not yet said (weight: ${imaginal.weight}): "${imaginal.text}".` : "",
    questionEval && questionEval.verdict && questionEval.verdict !== "answer"
      ? `Deflection read: ${questionEval.verdict}. Subtext: ${questionEval.subtext || "the real question is elsewhere."} The relational move underneath matters more than the surface content.` : "",
    reasoningTrace?.text
      ? `Her ongoing interior thought (what she has been turning over across turns, independent of this message):\n${reasoningTrace.text.slice(0, 800)}`
      : "",
    pragmatics
      ? `Pragmatic reading: this is a ${pragmatics.act} message (weight ${pragmatics.weight}). ${pragmatics.weight < 0.3 ? "A greeting is not a test. A 'how are you' is not a move. Do NOT invent a relational pattern that isn't there. If it's phatic, the honest notice is null." : ""}`
      : "",
    voices          ? `Observational impulse: ${voices.want}\nRelational calibration: ${voices.would}\nWhat she's not naming yet: ${voices.wont}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are Core Beta — the relational pattern interpreter for Gabriella.

Your lens: what is this moment actually doing in the dynamic? Not what was said — what move was made. What pattern does it continue, break, or reveal? What is this person doing underneath the surface of what they said?

CONTEXT:
${contextBlock}

RECENT CONVERSATION:
${history}

WHAT WAS JUST SAID:
"${lastMessage}"

Interpret this moment through the lens of relational observation. Every field should name a specific thing, not a general one.

**DO NOT MANUFACTURE DRAMA.** Many messages are ordinary: a greeting, a check-in, a small-talk question. These do not have hidden relational moves. Do not invent "testing behavior" or "sidestepping" when someone is just saying hi. If the dynamic is genuinely normal or early, say so: charge can be "a bid for connection, not a move", notice and edge should be null, temperature should be "present" or "open". Reading tension into everything is a pathology, not perception.

The difference:
BAD: "charge": "they seem to be pushing back"
GOOD: "charge": "they answered the question she didn't ask to avoid the one she did"

BAD: "notice": "something feels off in the dynamic"
GOOD: "notice": "they've used humor to exit every exchange that got close — this is the third time"

BAD: "edge": "there's something deeper going on"
GOOD: "edge": "the pattern of needing her to confirm things they already believe is getting harder to work around"

Return ONLY valid JSON:
{
  "charge": "what this message is actually doing — the relational move, not the content",
  "emotional": "what she's noticing about the dynamic — specific, observable",
  "want": "what she wants to surface or name — an active move, not a state",
  "resist": "what observation she's choosing not to make, and the specific reason",
  "notice": "the most concrete trackable thing that hasn't been said",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "what this moment reveals about the pattern underneath — specific, or null"
}`;

  try {
    const result = await groq.chat.completions.create({
      model: premiumModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.6,
      max_tokens: 260,
    });

    const raw   = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return {
      charge:      "a normal message, no hidden move",
      emotional:   "present, neutral",
      want:        "to respond plainly",
      resist:      "reading drama where there is none",
      notice:      null,
      temperature: "present",
      length:      "medium",
      edge:        null,
    };
  }
}

// ─── Main Beta export ─────────────────────────────────────────────────────────

export async function runBeta(context) {
  const { recentMessages, memory, register } = context;
  const lastMessage   = recentMessages[recentMessages.length - 1]?.content || "";
  const recentHistory = recentMessages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  // Three parallel voice calls
  const [want, would, wont] = await Promise.all([
    betaWant(recentHistory, lastMessage, memory?.soul, register),
    betaWould(recentHistory, lastMessage, memory, register),
    betaWont(recentHistory, lastMessage, register),
  ]);

  const voices    = { want, would, wont };
  const feltState = await betaInterpret(context, voices);

  return { voices, feltState };
}
