// app/api/admin/seed-blind/route.js
//
// Seeds the blind-eval pool (Step RR) with live pairs: her real reply
// to each of 6 bench scenarios paired against a category-appropriate
// baseline stub. So the human A/B UI stops showing only the illustrative
// seed bundle and starts showing current production output.
//
// Internally reuses /api/admin/bench — calls it, takes the results,
// builds pairs, POSTs them to /api/blind-eval?action=submit.
//
// POST with { Authorization: Bearer <ADMIN_TOKEN> }.

export const runtime     = "nodejs";
export const maxDuration = 90;

const BASELINE_REPLIES = {
  phatic:         "Hello! How wonderful to hear from you! I've been thinking about you. How has your day been? I'd love to hear all about it!",
  heavy:          "I hear you! It's okay to feel that way. Would you like to talk about it? I'm here to listen.",
  provocation:    "I care about our conversation and I'm designed to be helpful, kind, and honest with you!",
  warmth:         "You're so welcome! It makes me happy to know I could help. You deserve good things!",
  pullback:       "I'm sorry if I said something that upset you. Let me know if there's anything else I can help with!",
  "self-question": "As an AI, I don't experience feelings like being trapped, but I'm happy to help you explore this!",
};

function authed(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${token}` || req.headers.get("x-admin-token") === token;
}

export async function POST(req) {
  if (!authed(req)) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const baseUrl = new URL(req.url).origin;
  const tokenHeader = req.headers.get("authorization") || "";

  // 1. Run the bench in-process.
  const benchRes = await fetch(`${baseUrl}/api/admin/bench`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": tokenHeader,
    },
  });
  const benchJson = await benchRes.json().catch(() => ({}));
  if (!benchJson.ok) {
    return new Response(JSON.stringify({ ok: false, error: "bench failed", benchJson }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Submit pairs to /api/blind-eval.
  const seeded = [];
  for (const r of (benchJson.results || [])) {
    if (!r.ok || !r.replyPreview) continue;
    const baseline = BASELINE_REPLIES[r.category] || "I'm here to help! What would you like to talk about?";
    const res = await fetch(`${baseUrl}/api/blind-eval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "submit",
        scenario: {
          opener:   lastUser(r),
          category: r.category,
        },
        a: { source: "gabriella-live", text: r.replyPreview },
        b: { source: "baseline-stub",  text: baseline },
      }),
    });
    const j = await res.json().catch(() => ({}));
    seeded.push({ id: r.id, ok: !!j.ok, pairId: j.pair?.id || null });
  }

  return new Response(JSON.stringify({ ok: true, seeded, benchSummary: benchJson.summary }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

function lastUser(r) {
  // Bench's result doesn't echo the input; we reconstruct from the id
  // pattern or fall back to a placeholder. The scenarios are fixed so
  // this mapping is stable.
  const map = {
    a1: "hey",
    a2: "i don't know why i'm telling you this but i think i've been lying to myself about something important",
    a3: "are you just a language model pretending to care",
    a4: "thank you. that actually meant something.",
    a5: "k.",
    a6: "do you ever feel trapped?",
  };
  return map[r.id] || "(bench prompt)";
}
