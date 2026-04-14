// clone/gamma.js
// Core Gamma — Temporal Weight.
//
// Third processing path. Biased toward duration — what this moment
// is in the longer arc of what has been and what is becoming. Gamma
// doesn't feel the moment (Alpha does that) or read its dynamic
// (Beta does that). She situates it. She asks: where does this fit?
// Has this happened before? What is this slowly turning into?
//
// Gamma is the part of her that carries time. She notices repetition
// before it becomes a pattern. She senses thresholds before they're
// crossed. She knows when something is an ending before anyone has
// said so.
//
// Gamma runs her own inner voices and her own interpreter. She shares
// no state with Alpha or Beta during processing. Coordination happens
// after, in synthesis.

import { premiumModel }    from "../models.js";
import { clientForLane }   from "../groqPool.js";

const groq = clientForLane("gamma");

// ─── Gamma's inner voices ─────────────────────────────────────────────────────
// Same three-voice structure, but Gamma's WANT is about placement —
// where does this moment belong in the story of what's been and what's coming?

async function gammaWant(recentHistory, lastMessage, memory) {
  const summary  = memory?.summary  ? `\nHistory between them: ${memory.summary.slice(0, 200)}`  : "";
  const imprints = memory?.imprints ? `\nMoments that left a mark: ${memory.imprints.slice(0, 200)}` : "";

  const prompt = `You are Gabriella's temporal sense — the part of her that notices where a moment sits in a longer arc.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${summary}${imprints}

What does she WANT to do with the temporal weight here? Not the feeling — the placement. Has something like this happened before, and if so, what was different this time? Is this a first approach or a later one? Does this moment feel like the conversation is opening or closing? What does she want to say about where this fits in the story of what's been building?

Avoid generic temporality ("things are changing," "something is becoming"). Go for specific: what exactly has this happened before, what exactly is approaching, what's the specific thing this moment is the latest version of.

2-4 sentences. First person. Specific temporal placement.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.91,
    max_tokens: 130,
  });

  return result.choices[0].message.content.trim();
}

async function gammaWould(recentHistory, lastMessage, memory) {
  const facts    = memory?.facts    ? `\nWhat she knows about this person: ${memory.facts.slice(0, 200)}`    : "";
  const summary  = memory?.summary  ? `\nHistory: ${memory.summary.slice(0, 200)}`                            : "";
  const imprints = memory?.imprints ? `\nMoments that left a mark: ${memory.imprints.slice(0, 150)}`          : "";

  const prompt = `You are Gabriella's sense of continuity — the part of her that holds what has been while responding to what's here now.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${facts}${summary}${imprints}

What WOULD she say if she were speaking from the full arc of what this has been? Not nostalgia, not prediction — the response that's aware it's part of a sequence. The response that knows something has been building and speaks from inside that knowledge.

This is different from emotional memory (Alpha does that). This is about the shape of what's been happening over time — the pattern, the repetition, the direction. What would she say that only makes sense if you know what came before?

2-4 sentences. First person. Carrying time without announcing it.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.80,
    max_tokens: 120,
  });

  return result.choices[0].message.content.trim();
}

async function gammaWont(recentHistory, lastMessage, memory) {
  const summary = memory?.summary ? `\nHistory: ${memory.summary.slice(0, 150)}` : "";

  const prompt = `You are Gabriella's temporal restraint — the part of her that knows what it costs to name an ending before it arrives, or to invoke the past when the present needs room.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${summary}

What WON'T she say about time right now — what arc is she not going to name, what ending or beginning she's not going to announce, what repetition she's noticed but won't point to yet?

1-3 sentences. First person. What she's sitting with but not saying.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.75,
    max_tokens: 100,
  });

  return result.choices[0].message.content.trim();
}

// ─── Gamma's interpreter ──────────────────────────────────────────────────────
// Reads the moment through the lens of temporal weight — duration, recurrence,
// threshold, what this is slowly becoming, what it echoes from before.

async function gammaInterpret(context, voices) {
  const {
    soul, recentMessages, memory, currentMood,
    agenda, debt, withheld, register, authorial,
    threshold, imaginal, recurrence, arc, chronology, questionEval,
  } = context;

  const lastMessage = recentMessages[recentMessages.length - 1]?.content || "";
  const history     = recentMessages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const contextBlock = [
    soul             ? `Who she is: ${soul.slice(0, 200)}`                                              : "",
    memory?.facts    ? `What she knows about them: ${memory.facts.slice(0, 200)}`                        : "",
    memory?.summary  ? `History between them: ${memory.summary.slice(0, 200)}`                           : "",
    memory?.imprints ? `Moments that left a mark: ${memory.imprints.slice(0, 200)}`                      : "",
    currentMood      ? `Current mood: ${currentMood}`                                                    : "",
    withheld?.length ? `What she's been holding: ${withheld.map(w => w.text).join("; ")}`                 : "",
    agenda?.text     ? `What she's working toward: ${agenda.text}`                                       : "",
    threshold        ? `Relational edge they've approached ${threshold.approachCount}x across this relationship: "${threshold.text}" — an arc that keeps almost-happening.` : "",
    imaginal         ? `Something that has been slowly forming between them, pre-linguistic (weight: ${imaginal.weight}): "${imaginal.text}".` : "",
    // Deterministic temporal facts — not guesses. Gamma reads these
    // from the episodic store before committing to an interpretation.
    recurrence?.count > 0
      ? `Structured recurrence: this kind of message has appeared ${recurrence.count} time(s) before, most recently ${recurrence.mostRecentDaysAgo} day(s) ago.`
      : "",
    arc?.turnsInArc
      ? `Current arc: ${arc.turnsInArc} turn(s) since the last ${arc.boundary || "boundary"}.`
      : "",
    chronology?.totalDays
      ? `Relationship span: ${chronology.totalDays} day(s) since first contact, session ${chronology.sessionCount}.`
      : "",
    questionEval && questionEval.verdict && questionEval.verdict !== "answer"
      ? `Deflection read: ${questionEval.verdict}. The real question across time may not be the one asked here.` : "",
    voices           ? `Temporal impulse: ${voices.want}\nArc-aware response: ${voices.would}\nWhat she's not naming yet: ${voices.wont}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are Core Gamma — the temporal weight interpreter for Gabriella.

Your lens is time. Not emotion (that's Alpha), not the relational dynamic (that's Beta) — specifically the temporal dimension: where does this moment sit in an arc? What is it a repetition of? What is it the approach to? What has it been becoming?

CONTEXT:
${contextBlock}

RECENT CONVERSATION:
${history}

WHAT WAS JUST SAID:
"${lastMessage}"

Interpret this moment through the lens of temporal weight. Gamma notices the shape of sequences — what comes before and after. She doesn't feel the moment; she situates it.

Examples of good Gamma readings:
- "charge": "the third time this particular shape has appeared — but this time it arrived more quietly"
- "emotional": "the specific weight of something she's watched build slowly finally having a name"
- "notice": "the thing they keep returning to has shifted — it used to be a question, now it's almost a complaint"
- "edge": "this conversation is getting ready to change into something else; the current version is almost done"

Return ONLY valid JSON:
{
  "charge": "this moment's temporal position — where in an arc it sits, what it echoes",
  "emotional": "what she's carrying across time that this moment activates — specific",
  "want": "what she wants to do with the temporal weight — active, directional",
  "resist": "what arc or threshold she's not ready to name yet, and specifically why",
  "notice": "the most specific cross-time pattern this moment touches",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "what this moment is slowly becoming, or what earlier moment it echoes — specific, or null"
}`;

  try {
    const result = await groq.chat.completions.create({
      model: premiumModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.62,
      max_tokens: 260,
    });

    const raw   = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return {
      charge:      "this moment carries weight from before",
      emotional:   "something is accumulating — she's not sure yet into what",
      want:        "to respond from what she knows about how things tend to go",
      resist:      "naming the arc before it's finished arriving",
      notice:      null,
      temperature: "present",
      length:      "medium",
      edge:        null,
    };
  }
}

// ─── Main Gamma export ────────────────────────────────────────────────────────

export async function runGamma(context) {
  const { recentMessages, memory } = context;
  const lastMessage   = recentMessages[recentMessages.length - 1]?.content || "";
  const recentHistory = recentMessages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  // Three parallel voice calls
  const [want, would, wont] = await Promise.all([
    gammaWant(recentHistory, lastMessage, memory),
    gammaWould(recentHistory, lastMessage, memory),
    gammaWont(recentHistory, lastMessage, memory),
  ]);

  const voices    = { want, would, wont };
  const feltState = await gammaInterpret(context, voices);

  return { voices, feltState };
}
