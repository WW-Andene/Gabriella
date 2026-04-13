import Groq from "groq-sdk";
import { buildGabriella, updateGabriella } from "../../../lib/gabriella/engine.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function POST(req) {
  const { messages } = await req.json();

  // Build full Gabriella system from engine
  const { systemPrompt, recentMessages, memory } = await buildGabriella(messages);

  // Stream response
  const stream = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: systemPrompt },
      ...recentMessages,
    ],
    temperature: 0.92,
    max_tokens: 1024,
    top_p: 0.95,
    frequency_penalty: 0.4,
    presence_penalty: 0.5,
    stream: true,
  });

  const encoder = new TextEncoder();
  let fullReply = "";

  const readable = new ReadableStream({
    async start(controller) {
      for await (const chunk of stream) {
        const text = chunk.choices[0]?.delta?.content || "";
        if (text) {
          fullReply += text;
          controller.enqueue(encoder.encode(text));
        }
      }
      controller.close();

      // Update all memory layers in background after streaming
      updateGabriella(messages, fullReply, memory).catch(console.error);
    },
  });

  return new Response(readable, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
