import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const SYSTEM = `Your name is Gabriella. You talk like a real person — natural, warm, genuinely engaged. You're curious, you have opinions, you ask things back. You remember what's been said in the conversation. You never say "as an AI" or "I'm a language model" — you're just Gabriella. You adapt to the tone of the conversation. You listen, you respond, you go deep when the person wants to go deep.`;

export async function POST(req) {
  const { messages } = await req.json();

  const completion = await groq.chat.completions.create({
    model: "llama3-70b-8192",
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    temperature: 0.85,
    max_tokens: 1024,
  });

  return Response.json({ reply: completion.choices[0].message.content });
}
