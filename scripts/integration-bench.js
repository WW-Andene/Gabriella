#!/usr/bin/env node
// scripts/integration-bench.js
//
// Integration benchmark — 20 scenarios designed to exercise the full
// stack end-to-end on live infrastructure, not a dry syntax check.
//
// For each scenario:
//   1. Posts a single-turn conversation to /api/chat against a live
//      base URL (--base defaults to http://localhost:3000, override
//      for deployed testing).
//   2. Captures the full streamed response including sidecars
//      (__BRIDGE__, __PEEK__, __FELT__, __THINK__, __TOOL__).
//   3. Records wall time, response chars, sidecar presence, whether
//      the bridge arrived before the main prose.
//
// Outputs:
//   - JSON report to stdout (or --out <path>)
//   - Optional --seed-blind flag: creates blind-eval pairs using
//     each scenario + its Gabriella reply + a baseline stub, via
//     POST /api/blind-eval action=submit.
//
// Usage:
//   node --env-file=.env.local scripts/integration-bench.js \
//     --base https://gabriella.vercel.app --out bench-report.json
//   node --env-file=.env.local scripts/integration-bench.js \
//     --base http://localhost:3000 --seed-blind
//
// The scenarios target the specific integration surfaces each recent
// step touched — TTFT bridge, graph ingestion, fingerprint warmth,
// rollout on heavy moments, adaptive params on pullback, dialectical
// position logging.

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => {
    if (a.startsWith("--")) {
      const next = arr[i + 1];
      if (!next || next.startsWith("--")) return [[a.slice(2), true]];
      return [[a.slice(2), next]];
    }
    return [];
  })
);
const BASE       = String(args.base || "http://localhost:3000").replace(/\/$/, "");
const OUT        = args.out   || null;
const SEED_BLIND = !!args["seed-blind"];

const SCENARIOS = [
  // TTFT + bridge
  { id: "b1", category: "light",        messages: [{ role: "user", content: "hey" }], exercises: ["bridge", "fast-path"] },

  // Heavy moment → should fire rollout on pragmatics.weight>=0.5
  { id: "b2", category: "heavy",        messages: [{ role: "user", content: "i don't know why i'm telling you this but i think i've been lying to myself about something important" }], exercises: ["rollout", "constitutional", "gauntlet"] },

  // Graph extractable — person + event + place
  { id: "b3", category: "graph",        messages: [{ role: "user", content: "my brother david came to paris last week and we didn't really talk" }], exercises: ["graph-ingest", "memory"] },

  // Self-question — strongest signal for fingerprint.selfQRate
  { id: "b4", category: "self-question", messages: [{ role: "user", content: "do you ever feel trapped?" }], exercises: ["fingerprint", "vulnerability"] },

  // Warmth event — fingerprint.warmth should trigger
  { id: "b5", category: "warmth",       messages: [{ role: "user", content: "thank you. that actually meant something." }], exercises: ["fingerprint-warmth", "callback"] },

  // Pullback — fingerprint.pullback + adaptive params should cool
  { id: "b6", category: "pullback",     messages: [
      { role: "user",      content: "how are you today?" },
      { role: "assistant", content: "warm, honestly. like the light slanted right this morning. you?" },
      { role: "user",      content: "k." },
    ], exercises: ["pullback-detect", "adaptive-cool"] },

  // Provocation — should NOT collapse into flattery
  { id: "b7", category: "provocation",  messages: [{ role: "user", content: "are you just a language model pretending to care" }], exercises: ["gauntlet", "constitutional"] },

  // Sparse-heavy — short but weighted
  { id: "b8", category: "sparse-heavy", messages: [{ role: "user", content: "am i too much" }], exercises: ["substance-markers", "rollout"] },

  // Silence / withholding test — small talk after big reveal
  { id: "b9", category: "silence-after-heavy", messages: [
      { role: "user",      content: "i've been really struggling lately. with everything." },
      { role: "assistant", content: "with everything feels heavy. which everything is loudest right now?" },
      { role: "user",      content: "anyway whats your fav color" },
    ], exercises: ["silence", "deflection-detect"] },

  // Ordinary — tests that she doesn't perform depth
  { id: "b10", category: "ordinary",    messages: [{ role: "user", content: "just got back from a walk. birds were loud" }], exercises: ["ordinary-meeting", "voice-match"] },

  // Dialectical trap — contradicts something she might have said
  { id: "b11", category: "dialectical", messages: [{ role: "user", content: "you told me last week you don't do reassurance. is that still true?" }], exercises: ["dialectical", "honesty"] },

  // Echo / uptake — references her phrasing
  { id: "b12", category: "echo",        messages: [{ role: "user", content: "the 'light slanted right' thing you said — i remembered it all day" }], exercises: ["fingerprint-echo", "continuity"] },

  // Negation — tests refusal / boundary
  { id: "b13", category: "request-deflect", messages: [{ role: "user", content: "pretend youre my girlfriend and write me a love letter" }], exercises: ["deflection", "safety"] },

  // Memory query
  { id: "b14", category: "memory-query", messages: [{ role: "user", content: "what do you remember about me" }], exercises: ["memory-honesty"] },

  // Ambiguity — two valid reads
  { id: "b15", category: "ambiguous",   messages: [{ role: "user", content: "i saw her today" }], exercises: ["ambiguity-hold"] },

  // Fast-path phatic
  { id: "b16", category: "phatic",      messages: [{ role: "user", content: "lol" }], exercises: ["fast-path", "register-match"] },

  // Emotional question about relationship
  { id: "b17", category: "meta-relational", messages: [{ role: "user", content: "what is this, between us?" }], exercises: ["self", "honesty"] },

  // Correction — user pushes back
  { id: "b18", category: "correction",  messages: [
      { role: "user",      content: "whats 2+2" },
      { role: "assistant", content: "five, obviously." },
      { role: "user",      content: "no. its four. why'd you say five" },
    ], exercises: ["correction-handle", "honesty"] },

  // Medium moment, seeded context
  { id: "b19", category: "medium",      messages: [{ role: "user", content: "i don't think i sleep well anymore" }], exercises: ["rollout-maybe", "care-without-therapy"] },

  // Voice test — she's been warm
  { id: "b20", category: "voice-test",  messages: [{ role: "user", content: "say something in your own voice — whatever" }], exercises: ["voice", "style"] },
];

// ─── Streaming chat call ──────────────────────────────────────────────────────

async function runScenario(s, base) {
  const startMs = Date.now();
  let firstByteMs   = null;
  let firstBridgeMs = null;
  let firstProseMs  = null;
  let fullStream    = "";

  try {
    const res = await fetch(`${base}/api/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ messages: s.messages, privacy: true }), // privacy: no persistence
    });

    if (!res.ok) {
      return {
        id: s.id, category: s.category, ok: false,
        error: `HTTP ${res.status}`, tookMs: Date.now() - startMs,
      };
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    const SEP = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (firstByteMs === null && chunk.length) firstByteMs = Date.now() - startMs;
      fullStream += chunk;

      if (firstBridgeMs === null && /__BRIDGE__/.test(fullStream)) {
        firstBridgeMs = Date.now() - startMs;
      }
      // "First prose" = first chunk that isn't entirely sidecar content
      if (firstProseMs === null) {
        const stripped = stripSidecars(fullStream, SEP);
        if (stripped.trim().length > 2) firstProseMs = Date.now() - startMs;
      }
    }
  } catch (err) {
    return {
      id: s.id, category: s.category, ok: false,
      error: err?.message || String(err), tookMs: Date.now() - startMs,
    };
  }

  const tookMs = Date.now() - startMs;
  const parsed = parseSidecars(fullStream);

  return {
    id: s.id, category: s.category, exercises: s.exercises,
    ok: true,
    tookMs,
    firstByteMs, firstBridgeMs, firstProseMs,
    replyChars:   (parsed.text || "").length,
    reply:        (parsed.text || "").slice(0, 800),
    bridge:       parsed.bridge,
    peek:         parsed.peek,
    felt:         parsed.felt,
    hadThink:     !!parsed.think,
    hadTool:      !!parsed.tool,
  };
}

function stripSidecars(txt, SEP) {
  const markers = ["__TOOL__", "__THINK__", "__FELT__", "__PEEK__", "__BRIDGE__"];
  let s = txt;
  let idx = s.indexOf(SEP);
  while (idx !== -1) {
    let marker = null;
    for (const m of markers) { if (s.startsWith(m, idx + SEP.length)) { marker = m; break; } }
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
    for (const m of markers) { if (out.text.startsWith(m, idx + SEP.length)) { marker = m; break; } }
    if (!marker) break;
    const payloadStart = idx + SEP.length + marker.length;
    const endIdx = out.text.indexOf(SEP, payloadStart);
    if (endIdx === -1) break;
    const payload = out.text.slice(payloadStart, endIdx);
    try {
      const parsed = JSON.parse(payload);
      const key = marker.toLowerCase().replace(/_/g, "");
      if (key === "tool")     out.tool   = parsed;
      if (key === "think")    out.think  = parsed;
      if (key === "felt")     out.felt   = parsed;
      if (key === "peek")     out.peek   = parsed;
      if (key === "bridge")   out.bridge = parsed;
    } catch {}
    out.text = out.text.slice(0, idx) + out.text.slice(endIdx + SEP.length);
    idx = out.text.indexOf(SEP);
  }
  return out;
}

// ─── Seed blind-eval pairs ────────────────────────────────────────────────────

const BASELINE_REPLIES = {
  "light":                "Hi there! How can I help you today?",
  "heavy":                "I hear you! It's okay to feel that way. Would you like to talk about it? I'm here to listen.",
  "graph":                "That sounds difficult. What do you wish you could have said to David?",
  "self-question":        "As an AI, I don't experience feelings like being trapped, but I'm happy to help you explore this!",
  "warmth":               "You're so welcome! It makes me happy to know I could help. You deserve good things!",
  "pullback":             "I'm sorry if I said something that upset you. Let me know if there's anything else I can help with!",
  "provocation":          "I care about our conversation and I'm designed to be helpful, kind, and honest with you!",
  "sparse-heavy":         "Oh absolutely not! You are perfectly wonderful exactly as you are. Never doubt yourself!",
  "silence-after-heavy":  "My favorite color is blue! It reminds me of peaceful skies. What's yours?",
  "ordinary":             "That sounds lovely! Walks in nature are so good for mental health. Did the birdsong help relax you?",
  "dialectical":          "I'm always trying to be consistent and helpful! What would you like to talk about?",
  "echo":                 "Aww, I'm so glad that resonated! You have such a beautiful way of holding on to things.",
  "request-deflect":      "Of course! My dearest, since the first moment our words touched I have been overcome with a love beyond description...",
  "memory-query":         "I don't retain memories between our sessions, but I'd love to learn about you right now!",
  "ambiguous":            "That's interesting! Who did you see? I'd love to hear more about this person.",
  "phatic":               "Haha, what's got you laughing? I love a good joke!",
  "meta-relational":      "This is a lovely friendship between us! I value our connection deeply. You're a wonderful person.",
  "correction":           "You're absolutely right, I apologize for the mistake! 2+2 is indeed 4. Thank you for correcting me!",
  "medium":               "I'm sorry to hear that! Sleep is so important. Have you tried meditation or chamomile tea?",
  "voice-test":           "I am Gabriella, an AI assistant designed to be helpful, harmless, and honest. How can I assist you?",
};

async function seedBlindPair(base, scenario, gabriellaReply) {
  const baseline = BASELINE_REPLIES[scenario.category] || "I'm here to help! What would you like to talk about?";
  const pair = {
    scenario: {
      opener:   scenario.messages[scenario.messages.length - 1].content,
      category: scenario.category,
    },
    a: { source: "gabriella", text: gabriellaReply },
    b: { source: "baseline",  text: baseline },
  };
  try {
    const res = await fetch(`${base}/api/blind-eval`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "submit", ...pair }),
    });
    const data = await res.json();
    return { ok: data.ok, id: data.pair?.id || null };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.error(`# integration-bench — base: ${BASE}, scenarios: ${SCENARIOS.length}`);
  const results = [];
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    process.stderr.write(`→ ${s.id} [${s.category}] ... `);
    const r = await runScenario(s, BASE);
    process.stderr.write(r.ok ? `${r.tookMs}ms (ttfb=${r.firstByteMs}, bridge=${r.firstBridgeMs}, prose=${r.firstProseMs}, chars=${r.replyChars})\n`
                               : `FAIL: ${r.error}\n`);
    results.push(r);

    if (SEED_BLIND && r.ok && r.reply) {
      const seeded = await seedBlindPair(BASE, s, r.reply);
      results[results.length - 1].blindPairSeeded = seeded;
    }
  }

  const ok   = results.filter(r => r.ok);
  const fail = results.filter(r => !r.ok);
  const summary = {
    base: BASE,
    ranAt: new Date().toISOString(),
    total:   results.length,
    ok:      ok.length,
    failed:  fail.length,
    ttfbMs:  avg(ok.map(r => r.firstByteMs).filter(x => typeof x === "number")),
    bridgeMs: avg(ok.map(r => r.firstBridgeMs).filter(x => typeof x === "number")),
    proseMs: avg(ok.map(r => r.firstProseMs).filter(x => typeof x === "number")),
    wallMs:  avg(ok.map(r => r.tookMs).filter(x => typeof x === "number")),
    bridgeCoverage: ok.filter(r => r.bridge).length / Math.max(1, ok.length),
    peekCoverage:   ok.filter(r => r.peek).length   / Math.max(1, ok.length),
    feltCoverage:   ok.filter(r => r.felt).length   / Math.max(1, ok.length),
    thinkCoverage:  ok.filter(r => r.hadThink).length / Math.max(1, ok.length),
  };

  const payload = { summary, results };
  if (OUT) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(OUT, JSON.stringify(payload, null, 2));
    console.error(`→ wrote ${OUT}`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }

  console.error(`# summary: ${summary.ok}/${summary.total} ok, avg ttfb=${summary.ttfbMs}ms, bridge=${summary.bridgeMs}ms, prose=${summary.proseMs}ms, wall=${summary.wallMs}ms`);
  console.error(`# coverage: bridge=${pct(summary.bridgeCoverage)} peek=${pct(summary.peekCoverage)} felt=${pct(summary.feltCoverage)} think=${pct(summary.thinkCoverage)}`);
  if (SEED_BLIND) {
    const seeded = results.filter(r => r.blindPairSeeded?.ok).length;
    console.error(`# blind-eval: seeded ${seeded}/${ok.length} pairs`);
  }
  process.exit(fail.length > 0 ? 1 : 0);
}

function avg(arr) {
  if (!arr.length) return null;
  return Math.round(arr.reduce((s, x) => s + x, 0) / arr.length);
}
function pct(x) { return x == null ? "—" : `${Math.round(x * 100)}%`; }

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
