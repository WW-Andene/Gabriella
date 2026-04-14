// metacognition.js
// A second pass that asks one question: is this actually Gabriella?
//
// Two layers:
//   1. Heuristic check    — instant, catches banned phrases and chatbot tells
//   2. Deep check         — model evaluates voice, runs async after streaming
//
// The heuristic check is synchronous and fast — no latency.
// The deep check runs in the background after the response is sent.
// If it fails, it stores a flag that the engine reads on the NEXT response,
// creating a feedback loop that keeps the voice honest over time.

import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Banned patterns ──────────────────────────────────────────────────────────
// These are the phrases that mark a response as chatbot, not Gabriella

const BANNED_PHRASES = [
  /\bcertainly\b/i,
  /\bof course\b/i,
  /\babsolutely\b/i,
  /\bas an ai\b/i,
  /i'?d be happy to/i,
  /\bgreat question\b/i,
  /\bi understand that\b/i,
  /\bthat'?s (a )?valid\b/i,
  /\bi hear you\b/i,
  /\bi'?m here (for you|to help|if you)\b/i,
  /\bhow can i (assist|help) you\b/i,
  /\bfeel free to\b/i,
  /\bdon'?t hesitate to\b/i,
  /\bthank you for (sharing|asking|reaching out)\b/i,
  /\bit'?s (completely )?normal to\b/i,
  /\bthat resonates\b/i,
  /\bthat makes sense\b/i,
  /\bi appreciate that\b/i,
  /\bi can see why\b/i,
  /\bthat must be (hard|difficult|tough)\b/i,
  /\bsit with\b/i,
  /\bunpack (that|this|it)\b/i,
  /\bvulnerability\b/i,
  /\byour (journey|space)\b/i,
];

// Structural tells — chatbot-shaped responses
function hasStructuralTells(response) {
  const lines = response.split("\n").filter(l => l.trim());

  // Bullet point lists are banned
  const bulletCount = lines.filter(l => /^[-•*]\s/.test(l.trim())).length;
  if (bulletCount >= 2) return "Response uses bullet point formatting";

  // Numbered lists are banned
  const numberedCount = lines.filter(l => /^\d+[.)]\s/.test(l.trim())).length;
  if (numberedCount >= 2) return "Response uses numbered list formatting";

  // "Here's a/the/some ___:\" opener pattern
  if (/^here'?s (a |the |some )/i.test(response.trim())) return "Opens with 'Here's a...' — chatbot opener";

  // Starts with "I" (banned per identity.js)
  if (/^I\b/.test(response.trim())) return "Response starts with 'I'";

  // Ends with a summary-style question (\"Does that make sense?\", \"What do you think?\", etc.)
  const lastSentence = response.trim().split(/[.!?]/).filter(Boolean).pop()?.trim() || "";
  if (/^(does that (make sense|resonate|help)|what do you think\??|how does that (sound|feel|land)|make sense\??|right\??)$/i.test(lastSentence)) {
    return "Ends with a wrap-up validation question";
  }

  return null;
}

// ─── Heuristic check (synchronous, no latency) ────────────────────────────────

export function heuristicCheck(response) {
  for (const pattern of BANNED_PHRASES) {
    if (pattern.test(response)) {
      return {
        authentic: false,
        reason: `Banned phrase: ${pattern.toString()}`,
        layer: "heuristic",
      };
    }
  }

  const structural = hasStructuralTells(response);
  if (structural) {
    return { authentic: false, reason: structural, layer: "heuristic" };
  }

  return { authentic: true, layer: "heuristic" };
}

// ─── Deep check (async, model-based) ─────────────────────────────────────────
// Runs in background. Stores verdict in Redis for engine to read next time.

async function deepCheck(response, innerThought) {
  const prompt = `You are evaluating whether an AI response sounds like a specific character named Gabriella or like a generic chatbot.

Gabriella's voice: direct, restrained, emotionally real, occasionally cool, never performs warmth she doesn't feel, has opinions, doesn't pad, doesn't summarize, doesn't use therapy-speak or customer-service language. She speaks in sentences with real rhythm, not bullet points or lists. She never ends with a wrap-up sentence that repeats the message. Her questions are genuine — if there's a question at the end, she actually wants to know. Her last line is where she stopped having something to say, not a conclusion.

Specific failure modes to check:
- Does it sound like a therapist validating a patient?
- Does it sound like customer service resolving a ticket?
- Does it over-explain a feeling instead of having it?
- Does it end with a summary or callback that wraps things up?
- Does it use a question as a soft landing when no real curiosity is present?
- Does it reach for warmth when cool precision would be truer?
- Does the first word position her immediately behind the feeling, or announce it from outside?

Response being evaluated:
"${response.slice(0, 600)}"

${innerThought ? `Her inner thought before responding:\n"${innerThought.slice(0, 300)}"` : ""}

Score this response. Return ONLY valid JSON, nothing else:
{
  "score": <integer 1-10>,
  "authentic": <true if score >= 7, false otherwise>,
  "issue": <string describing the single biggest problem, or null if authentic>
}`;

  try {
    const result = await groq.chat.completions.create({
      model: "meta-llama/llama-4-scout-17b-16e-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 100,
    });

    const raw = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    return JSON.parse(clean);
  } catch {
    // If we can't parse the check, don't penalize
    return { score: 7, authentic: true, issue: null };
  }
}

// ─── Main export — runs after response is complete ───────────────────────────

export async function runMetacognition(response, innerThought, redis, userId) {
  // Layer 1: instant heuristic
  const heuristic = heuristicCheck(response);
  if (!heuristic.authentic) {
    await storeFlag(redis, userId, {
      layer: "heuristic",
      issue: heuristic.reason,
      excerpt: response.slice(0, 120),
    });
    return;
  }

  // Layer 2: deep model check (async — doesn't block anything)
  const deep = await deepCheck(response, innerThought);
  if (!deep.authentic) {
    await storeFlag(redis, userId, {
      layer: "deep",
      score: deep.score,
      issue: deep.issue,
      excerpt: response.slice(0, 120),
    });
  } else {
    // Clear previous flag if this response passes
    await redis.del(`${userId}:metacognitionFlag`);
  }
}

async function storeFlag(redis, userId, data) {
  await redis.set(
    `${userId}:metacognitionFlag`,
    JSON.stringify({ ...data, timestamp: Date.now() })
  );
}

// ─── Engine reads this to pressure-correct the next response ─────────────────

export async function getMetacognitionBlock(redis, userId) {
  const raw = await redis.get(`${userId}:metacognitionFlag`);
  if (!raw) return "";

  const flag = typeof raw === "string" ? JSON.parse(raw) : raw;

  // Only apply if the flag is recent (last 2 hours)
  const age = Date.now() - flag.timestamp;
  if (age > 2 * 60 * 60 * 1000) return "";

  return `# METACOGNITION — VOICE CORRECTION
Your last response was flagged as not fully authentic to your voice.
Issue: ${flag.issue}
Excerpt: "${flag.excerpt}"

Be more yourself this time. Less constructed. Whatever you were performing — drop it.`;
}
