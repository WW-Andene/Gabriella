// app/api/chat/route.js
// The main conversation endpoint.
//
// Flow:
//   1. Build Gabriella's full system prompt (soul, memory, interiority, monologue block)
//   2. Stream the response from Groq
//   3. During streaming: silently strip the <think> block, surface only the response
//   4. After streaming: run metacognition + update all memory layers in background

import Groq from "groq-sdk";
import { buildGabriella, updateGabriella, redis, USER_ID } from "../../../lib/gabriella/engine.js";
import { createMonologueParser } from "../../../lib/gabriella/monologue.js";
import { runMetacognition } from "../../../lib/gabriella/metacognition.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function POST(req) {
  const { messages } = await req.json();

  // Build full Gabriella system prompt (includes interiority + monologue block)
  const { systemPrompt, recentMessages, memory } = await buildGabriella(messages);

  // Stream response from Groq
  const stream = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: systemPrompt },
      ...recentMessages,
    ],
    temperature: 0.92,
    max_tokens: 1200,   // slightly higher to accommodate the think block
    top_p: 0.95,
    frequency_penalty: 0.4,
    presence_penalty: 0.5,
    stream: true,
  });

  const encoder = new TextEncoder();
  let fullReply = "";        // the visible response only (post-think)
  let innerThought = null;   // captured privately, never sent to client

  const parser = createMonologueParser();

  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (!text) continue;

        const { emit } = parser.process(text);

        if (emit) {
          fullReply += emit;
          controller.enqueue(encoder.encode(emit));
        }
      }

      // Capture the inner thought after stream ends
      innerThought = parser.getInnerThought();

      controller.close();

      // Background: run metacognition + update all memory layers
      Promise.all([
        updateGabriella(messages, fullReply, memory),
        runMetacognition(fullReply, innerThought, redis, USER_ID),
      ]).catch(console.error);
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
