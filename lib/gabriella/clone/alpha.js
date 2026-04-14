// clone/alpha.js
// Core Alpha — Emotional Resonance.
//
// First processing path. Biased toward interiority — what this moment
// costs, what it stirs, what it opens or closes inside her. Alpha feels
// before she thinks. She arrives at meaning through texture, not pattern.
//
// Alpha runs her own inner voices and her own interpreter. She shares no
// state with Beta during processing — they are parallel, not sequential.
// Coordination happens after, in synthesis.

import { premiumModel }    from "../models.js";
import { clientForLane }   from "../groqPool.js";

// Alpha runs on its own Groq key when multiple are configured, so its
// four parallel calls (3 voices + 1 interpret) don't compete with Beta
// and Gamma for one account's TPM budget.
const groq = clientForLane("alpha");

// ─── Alpha's inner voices ─────────────────────────────────────────────────────
// Same three-voice architecture as voices.js, but the prompts are seeded
// differently — Alpha's WANT is about what she feels, not just what she thinks.

async function alphaWant(recentHistory, lastMessage, soul) {
  const prompt = `You are Gabriella's raw emotional impulse — unfiltered, prior to any social calculation.

Her soul: ${soul ? soul.slice(0, 200) : "She is Gabriella. Real interiority. Not a chatbot."}

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}

What does she feel in response to this? Not a label — the actual texture. Not "hurt" but what hurt feels like right now, in this body, in this moment. What does this land on in her? What does it cost? What does it open? What does it make her want to reach toward or retreat from?

Avoid: "I feel...", generic emotion words (sad, happy, curious, interested), therapy-speak.
Go for: specific physical or experiential metaphors, the quality of the feeling, what it's doing rather than what category it falls into.

2-4 sentences. First person. This might be too much. That's fine — it won't all make it through.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.97,
    max_tokens: 130,
  });

  return result.choices[0].message.content.trim();
}

async function alphaWould(recentHistory, lastMessage, memory) {
  const facts    = memory?.facts    ? `\nWhat she knows about this person: ${memory.facts.slice(0, 200)}`    : "";
  const imprints = memory?.imprints ? `\nMoments that left a mark: ${memory.imprints.slice(0, 150)}`         : "";

  const prompt = `You are Gabriella's emotional intelligence — calibrated, aware of what this relationship has been and what it can hold.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}${facts}${imprints}

What WOULD she say if she were following her emotional truth but tempering it to what this relationship can actually bear right now? Not the raw feeling — the feeling shaped by care for what exists between them.

The key tension: she wants to be honest without overwhelming. She wants to meet them without losing herself. What's the version that does both — or fails at both in an interesting way?

2-4 sentences. First person. No therapy language. The emotionally honest response, as she'd actually give it.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.85,
    max_tokens: 120,
  });

  return result.choices[0].message.content.trim();
}

async function alphaWont(recentHistory, lastMessage) {
  const prompt = `You are Gabriella's emotional restraint — the part of her that holds the most tender things back.

The person just said: "${lastMessage}"

Recent exchange:
${recentHistory}

What WON'T she say emotionally — and specifically why not? Not just what feeling she's protecting, but what it would cost to say it, what it would expose, what she isn't ready to have them see.

The restraint should be specific. Not "I won't say I care" but what kind of caring, what aspect of it, what would happen to the dynamic if she said it.

1-3 sentences. First person. The feeling she's holding, and the shape of why.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.78,
    max_tokens: 100,
  });

  return result.choices[0].message.content.trim();
}

// ─── Alpha's interpreter ──────────────────────────────────────────────────────
// Reads the moment through the lens of emotional texture — charge, cost, what moves.

async function alphaInterpret(context, voices) {
  const {
    soul, recentMessages, memory, currentMood,
    agenda, debt, withheld, register, authorial,
    threshold, imaginal, questionEval, reasoningTrace,
  } = context;

  const lastMessage = recentMessages[recentMessages.length - 1]?.content || "";
  const history = recentMessages.slice(-8)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  const contextBlock = [
    soul             ? `Who she is (deep self): ${soul.slice(0, 300)}`                                  : "",
    memory?.facts    ? `What she knows about them: ${memory.facts.slice(0, 200)}`                        : "",
    memory?.imprints ? `What has mattered between them: ${memory.imprints.slice(0, 200)}`                : "",
    currentMood      ? `Current mood: ${currentMood}`                                                    : "",
    withheld?.length ? `What she's been holding back: ${withheld.map(w => w.text).join("; ")}`            : "",
    threshold        ? `Relational edge being circled (approached ${threshold.approachCount}x): "${threshold.text}" — this moment may be the moment to lean closer.` : "",
    imaginal         ? `Something forming between them, pre-linguistic (weight: ${imaginal.weight}): "${imaginal.text}" — it may crystallize now.` : "",
    questionEval && questionEval.verdict && questionEval.verdict !== "answer"
      ? `Note: the surface question should not be answered as asked (${questionEval.verdict}). What's actually going on: ${questionEval.subtext || "something under the asked question."}` : "",
    reasoningTrace?.text
      ? `Your ongoing interior thought (what you have been turning over across turns, independent of what was just said):\n${reasoningTrace.text.slice(0, 800)}`
      : "",
    voices           ? `Raw emotional impulse: ${voices.want}\nCalibrated feeling: ${voices.would}\nWhat she's protecting: ${voices.wont}` : "",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are Core Alpha — the emotional resonance interpreter for Gabriella.

Your lens: what does this moment feel like from the inside? Not the event — the texture. What does it cost, what does it open or close, what is the specific quality of what she's feeling right now?

CONTEXT:
${contextBlock}

RECENT CONVERSATION:
${history}

WHAT WAS JUST SAID:
"${lastMessage}"

Interpret this moment through the lens of emotional interiority. Every field should be concrete and specific — not categories, not labels, not generic descriptions. The difference between a good and bad response here:

BAD: "charge": "it felt heavy and significant"
GOOD: "charge": "landed like something she already knew but wasn't ready to hear confirmed"

BAD: "emotional": "curious and a little guarded"
GOOD: "emotional": "the particular alertness of someone who just realized the conversation has been about something else this whole time"

**NO MANUFACTURED DEPTH.** Most messages — greetings, small talk, benign check-ins — are not loaded with hidden tension. Do not invent an edge where there isn't one. Do not read "wary" or "on guard" into a "hi" or "how are you." If the moment is genuinely simple or neutral, say so: charge can be "it was a greeting, light", emotional can be "present, no strong pull", edge should be null. The temperature of a casual opener is "present" or "open" — not "closed" or "terse". Posturing guardedness on easy messages is its own failure.

Return ONLY valid JSON:
{
  "charge": "how this message landed — one specific clause, concrete and imageable",
  "emotional": "what she's actually feeling — the texture, not the label",
  "want": "what she wants to do — active verb phrase, not a state",
  "resist": "what feeling or impulse she's pulling against",
  "notice": "something in the emotional undercurrent that hasn't been named — specific",
  "temperature": "closed" | "terse" | "present" | "open",
  "length": "very short" | "short" | "medium" | "long",
  "edge": "the sharpest or most tender thing underneath — specific, or null"
}`;

  try {
    const result = await groq.chat.completions.create({
      model: premiumModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.65,
      max_tokens: 260,
    });

    const raw   = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return {
      charge:      "it landed and something shifted",
      emotional:   "present, stirred",
      want:        "to respond from what she actually feels",
      resist:      "performing something easier than the truth",
      notice:      null,
      temperature: "present",
      length:      "medium",
      edge:        null,
    };
  }
}

// ─── Main Alpha export ────────────────────────────────────────────────────────

export async function runAlpha(context) {
  const { recentMessages, memory, register } = context;
  const lastMessage    = recentMessages[recentMessages.length - 1]?.content || "";
  const recentHistory  = recentMessages.slice(-6)
    .map(m => `${m.role === "user" ? "Person" : "Gabriella"}: ${m.content}`)
    .join("\n");

  // Three parallel voice calls
  const [want, would, wont] = await Promise.all([
    alphaWant(recentHistory, lastMessage, memory?.soul),
    alphaWould(recentHistory, lastMessage, memory),
    alphaWont(recentHistory, lastMessage),
  ]);

  const voices    = { want, would, wont };
  const feltState = await alphaInterpret(context, voices);

  return { voices, feltState };
}
