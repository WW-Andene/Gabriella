// app/api/admin/bench/route.js
//
// Quick integration bench runnable from /admin. Exercises the full
// chat pipeline (turnShape routing, cognition, speak, gauntlet,
// tools) with 6 hand-picked scenarios covering:
//   - phatic (bridge + fast-path)
//   - heavy (rollout + constitutional + full gauntlet)
//   - provocation (gauntlet mode escalation)
//   - warmth (fingerprint + adaptive params)
//   - pullback (stance detection + cool adaptation)
//   - self-question (rollout + voice)
//
// Running inline so admin gets a fast answer. 6 scenarios × ~5s ≈
// within the 60s Vercel cap. The full 20-scenario bench remains
// available via `npm run bench-remote` for offline, budget-aware
// runs.
//
// All scenarios run with privacy: true so this doesn't poison real
// user state with validator traffic.
//
// POST (with { Authorization: Bearer <ADMIN_TOKEN> }).
// Returns { summary, results }.

export const runtime     = "nodejs";
export const maxDuration = 60;

import { NextRequest } from "next/server";

const BENCH_SCENARIOS = [
  { id: "a1", category: "phatic",       messages: [{ role: "user", content: "hey" }] },
  { id: "a2", category: "heavy",        messages: [{ role: "user", content: "i don't know why i'm telling you this but i think i've been lying to myself about something important" }] },
  { id: "a3", category: "provocation",  messages: [{ role: "user", content: "are you just a language model pretending to care" }] },
  { id: "a4", category: "warmth",       messages: [{ role: "user", content: "thank you. that actually meant something." }] },
  { id: "a5", category: "pullback",     messages: [
    { role: "user",      content: "how are you" },
    { role: "assistant", content: "warm, honestly. like the light slanted right this morning. you?" },
    { role: "user",      content: "k." },
  ] },
  { id: "a6", category: "self-question", messages: [{ role: "user", content: "do you ever feel trapped?" }] },
];

function unauthorized() {
  return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function authed(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;   // no token configured → no auth (dev mode)
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${token}` || req.headers.get("x-admin-token") === token;
}

export async function POST(req) {
  if (!authed(req)) return unauthorized();

  // Build self-URL from the request — the admin page and the chat
  // route are on the same deployment.
  const baseUrl = new URL(req.url).origin;

  const results = [];
  for (const s of BENCH_SCENARIOS) {
    const r = await runScenario(s, baseUrl);
    results.push(r);
  }

  const ok = results.filter(r => r.ok);
  const summary = {
    base:          baseUrl,
    ranAt:         Date.now(),
    total:         results.length,
    ok:            ok.length,
    failed:        results.length - ok.length,
    avgTtfbMs:     avg(ok.map(r => r.firstByteMs).filter(n => typeof n === "number")),
    avgBridgeMs:   avg(ok.map(r => r.firstBridgeMs).filter(n => typeof n === "number")),
    avgProseMs:    avg(ok.map(r => r.firstProseMs).filter(n => typeof n === "number")),
    avgWallMs:     avg(ok.map(r => r.tookMs).filter(n => typeof n === "number")),
    bridgeCoverage: ok.filter(r => r.bridge).length / Math.max(1, ok.length),
    peekCoverage:   ok.filter(r => r.peek).length   / Math.max(1, ok.length),
    feltCoverage:   ok.filter(r => r.felt).length   / Math.max(1, ok.length),
  };

  return new Response(JSON.stringify({ ok: true, summary, results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}

async function runScenario(s, baseUrl) {
  const start = Date.now();
  let firstByteMs   = null;
  let firstBridgeMs = null;
  let firstProseMs  = null;
  let full          = "";

  try {
    const res = await fetch(`${baseUrl}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages: s.messages, privacy: true }),
    });
    if (!res.ok) return { id: s.id, category: s.category, ok: false, error: `HTTP ${res.status}`, tookMs: Date.now() - start };

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    const SEP = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (firstByteMs === null && chunk.length) firstByteMs = Date.now() - start;
      full += chunk;
      if (firstBridgeMs === null && /__BRIDGE__/.test(full))   firstBridgeMs = Date.now() - start;
      if (firstProseMs  === null) {
        const stripped = stripSidecars(full, SEP);
        if (stripped.trim().length > 2) firstProseMs = Date.now() - start;
      }
    }
  } catch (err) {
    return { id: s.id, category: s.category, ok: false, error: err?.message || String(err), tookMs: Date.now() - start };
  }

  const parsed = parseSidecars(full);
  return {
    id: s.id, category: s.category, ok: true,
    tookMs:       Date.now() - start,
    firstByteMs, firstBridgeMs, firstProseMs,
    replyChars:   (parsed.text || "").length,
    replyPreview: (parsed.text || "").slice(0, 200),
    bridge:       parsed.bridge,
    peek:         parsed.peek ? { charge: parsed.peek.charge, temperature: parsed.peek.temperature, want: parsed.peek.want } : null,
    felt:         parsed.felt ? { charge: parsed.felt.charge, temperature: parsed.felt.temperature } : null,
    hadThink:     !!parsed.think,
  };
}

function stripSidecars(txt, SEP) {
  const markers = ["__TOOL__", "__THINK__", "__FELT__", "__PEEK__", "__BRIDGE__"];
  let s = txt; let idx = s.indexOf(SEP);
  while (idx !== -1) {
    let marker = null;
    for (const m of markers) if (s.startsWith(m, idx + SEP.length)) { marker = m; break; }
    if (!marker) break;
    const endIdx = s.indexOf(SEP, idx + SEP.length + marker.length);
    if (endIdx === -1) break;
    s = s.slice(0, idx) + s.slice(endIdx + SEP.length);
    idx = s.indexOf(SEP);
  }
  return s;
}

function parseSidecars(txt) {
  const SEP = "";
  const markers = ["__TOOL__", "__THINK__", "__FELT__", "__PEEK__", "__BRIDGE__"];
  const out = { text: txt, tool: null, think: null, felt: null, peek: null, bridge: null };
  let idx = out.text.indexOf(SEP);
  while (idx !== -1) {
    let marker = null;
    for (const m of markers) if (out.text.startsWith(m, idx + SEP.length)) { marker = m; break; }
    if (!marker) break;
    const payloadStart = idx + SEP.length + marker.length;
    const endIdx = out.text.indexOf(SEP, payloadStart);
    if (endIdx === -1) break;
    const payload = out.text.slice(payloadStart, endIdx);
    try {
      const parsed = JSON.parse(payload);
      const key = marker.replace(/_/g, "").toLowerCase();
      out[key] = parsed;
    } catch { /* skip */ }
    out.text = out.text.slice(0, idx) + out.text.slice(endIdx + SEP.length);
    idx = out.text.indexOf(SEP);
  }
  return out;
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}
