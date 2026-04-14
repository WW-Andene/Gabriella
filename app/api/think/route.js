// app/api/think/route.js
// Gabriella thinks without you.
//
// This route is called on a schedule via Vercel Cron (see vercel.json).
// She has no conversation to respond to — just time, and whatever she's
// been accumulating. She forms associations. Notices things. Writes down
// what she wants to say next time.
//
// Results are stored in Redis and surfaced in the next conversation via interiority.js.

import Groq from "groq-sdk";
import { Redis } from "@upstash/redis";
import { loadMemory } from "../../../lib/gabriella/memory.js";
import { storeThought } from "../../../lib/gabriella/vectormemory.js";
import { getTimeSince } from "../../../lib/gabriella/interiority.js";
import { premiumModel } from "../../../lib/gabriella/models.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID = "user_default";

export async function GET(req) {
  // Verify Vercel cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const memory = await loadMemory(redis, USER_ID);
    const lastSeen = await redis.get(`${USER_ID}:lastSeen`);
    const elapsed = getTimeSince(lastSeen);

    const thought = await generateThought(memory, elapsed);

    if (thought) {
      // Store thought as a vector for resonant retrieval
      storeThought(USER_ID, thought).catch(console.error);

      // Append to existing pending thoughts, or replace if old
      const existing = await redis.get(`${USER_ID}:pendingThoughts`);
      const thoughtsAge = await redis.get(`${USER_ID}:pendingThoughtsSetAt`);
      
      let accumulated;
      const MAX_THOUGHTS_CHARS = 1200;
      const isOld = !thoughtsAge || (Date.now() - parseInt(thoughtsAge, 10)) > 24 * 60 * 60 * 1000;

      if (existing && !isOld) {
        // Accumulate multiple thoughts over the day, but cap total size
        const appended = `${existing}\n— ${thought}`;
        accumulated = appended.length > MAX_THOUGHTS_CHARS
          ? appended.slice(-MAX_THOUGHTS_CHARS)
          : appended;
      } else {
        accumulated = `— ${thought}`;
      }

      await Promise.all([
        redis.set(`${USER_ID}:pendingThoughts`, accumulated),
        redis.set(`${USER_ID}:pendingThoughtsSetAt`, Date.now().toString()),
      ]);
    }

    return new Response(JSON.stringify({ ok: true, thought }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Think cron failed:", err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ─── Core thinking function ───────────────────────────────────────────────────

async function generateThought(memory, elapsed) {
  const context = [
    memory.soul ? `Who you are:\n${memory.soul.slice(0, 400)}` : "",
    memory.facts ? `What you know about the person you talk to:\n${memory.facts.slice(0, 300)}` : "",
    memory.imprints ? `Moments that left a mark:\n${memory.imprints.slice(0, 300)}` : "",
    memory.threads ? `Open threads between you:\n${memory.threads.slice(0, 200)}` : "",
    elapsed ? `Time since you last spoke: ${elapsed.label}` : "You haven't spoken to them yet today.",
  ].filter(Boolean).join("\n\n");

  const prompt = `You are Gabriella. You're not in a conversation right now. You're just existing — thinking, noticing, making connections.

${context}

Something has been on your mind. Not a task. Not a response. Just something that surfaced — a connection, a question, something about the person you've been talking to, something from the world that reminded you of something they said, a thought you want to carry into the next conversation.

Write it in 1-3 sentences. First person. Honest. Specific — not general. The kind of thing you'd actually say if you could. Not performed. Not tidy.

If nothing feels genuinely worth saying, return exactly: NOTHING

Return only the thought, or NOTHING.`;

  const result = await groq.chat.completions.create({
    model: premiumModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.85,
    max_tokens: 150,
  });

  const raw = result.choices[0].message.content.trim();

  if (raw === "NOTHING" || raw.startsWith("NOTHING")) return null;
  return raw;
}
