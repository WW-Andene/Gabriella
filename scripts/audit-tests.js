// scripts/audit-tests.js
// Focused unit tests on the pure functions that had bugs. Run with:
//   node scripts/audit-tests.js
//
// Tests are deliberately small — they check the exact cases that broke
// in the field: Upstash archive filtering, monologue parsing with/without
// uncertain, dataset ID derivation, etc.

import { parseMonologue } from "../lib/gabriella/monologue.js";

let passed = 0;
let failed = 0;

function assert(name, cond, detail) {
  if (cond) {
    console.log(`  PASS: ${name}`);
    passed++;
  } else {
    console.log(`  FAIL: ${name}${detail ? "\n         " + detail : ""}`);
    failed++;
  }
}

// ─── 1. parseMonologue ───────────────────────────────────────────────────────

console.log("\n# parseMonologue");

{
  const { innerThought, response, uncertain } = parseMonologue(
    "<think>raw thought</think>Hello there.",
  );
  assert("basic think + reply", innerThought === "raw thought" && response === "Hello there." && uncertain === null);
}

{
  const { innerThought, response, uncertain } = parseMonologue(
    "<think>one</think>Visible.<uncertain>not sure</uncertain>",
  );
  assert("think + reply + uncertain", innerThought === "one" && response === "Visible." && uncertain === "not sure");
}

{
  const { innerThought, response, uncertain } = parseMonologue("Just a plain reply.");
  assert("no tags", innerThought === null && response === "Just a plain reply." && uncertain === null);
}

{
  const { innerThought, response, uncertain } = parseMonologue(
    "<think>multi\nline\nthought</think>\n\nReply across lines.",
  );
  assert("multiline think", innerThought === "multi\nline\nthought" && response === "Reply across lines." && uncertain === null);
}

{
  const { innerThought, response, uncertain } = parseMonologue(
    "<think>t</think>Reply with closing <uncertain> not real tag",
  );
  // No closing </uncertain> — should leave the text as-is in response.
  assert(
    "unclosed uncertain",
    innerThought === "t" && response.includes("not real tag") && uncertain === null,
    `response=${JSON.stringify(response)}`,
  );
}

// ─── 2. archive key filter logic ──────────────────────────────────────────────

console.log("\n# archive key filter (the regex bug that bit us)");

{
  const keys = [
    "user_default:learning:archive:bootstrap:1776212044670",
    "user_default:learning:archive:bootstrap:1776215878011",
    "user_default:learning:archive:bootstrap:1776215878011:0",
    "user_default:learning:archive:bootstrap:1776215878011:meta",
  ];

  // The OLD broken filter was this — confirm it would have dropped everything:
  const oldFilter = (k) => !/(:\d+$)|(:meta$)/.test(k);
  const oldKept = keys.filter(oldFilter);
  assert(
    "old filter incorrectly drops top-level keys (bug)",
    oldKept.length === 0,
    `old filter kept: ${JSON.stringify(oldKept)}`,
  );

  // The NEW correct filter:
  const newFilter = (k) => k.split(":").length === 5;
  const newKept = keys.filter(newFilter);
  assert(
    "new filter keeps top-level, drops chunks + meta",
    newKept.length === 2 && newKept.includes("user_default:learning:archive:bootstrap:1776212044670"),
    `new filter kept: ${JSON.stringify(newKept)}`,
  );
}

// ─── 3. dataset id derivation ────────────────────────────────────────────────

console.log("\n# dataset id derivation");

{
  // Inline the function logic from fireworks.js — it's not exported.
  const derive = (filename) => {
    const base = String(filename || `dataset-${Date.now()}`)
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return base || `dataset-${Date.now()}`;
  };

  assert("simple .jsonl", derive("gabriella-bootstrap-2026-04-15.jsonl") === "gabriella-bootstrap-2026-04-15");
  assert("weird chars", derive("name with spaces & stuff!.jsonl") === "name-with-spaces-stuff");
  assert("no extension", derive("plain") === "plain");
  assert("uppercase", derive("UPPER.jsonl") === "upper");
  assert("empty → fallback", derive("").startsWith("dataset-"));
  assert("no filename → fallback", derive(null).startsWith("dataset-"));
  assert(
    "over 60 chars truncated",
    derive("a".repeat(100) + ".jsonl").length <= 60,
  );
}

// ─── 4. userId resolution ─────────────────────────────────────────────────────

console.log("\n# userId resolution from request headers");

{
  const { resolveUserId } = await import("../lib/gabriella/users.js");

  const mockReq = (headers) => ({
    headers: {
      get: (name) => headers[name.toLowerCase()] || null,
    },
  });

  assert(
    "explicit header wins",
    resolveUserId(mockReq({ "x-gabriella-user": "alice" })) === "alice",
  );

  assert(
    "header case-normalized",
    resolveUserId(mockReq({ "x-gabriella-user": "ALICE!@#" })) === "alice",
  );

  assert(
    "cookie fallback",
    resolveUserId(mockReq({ cookie: "foo=bar; gabriella_user=bob" })) === "bob",
  );

  assert(
    "ip+ua hash fallback",
    /^u_[0-9a-f]{16}$/.test(resolveUserId(mockReq({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }))),
  );

  assert(
    "default when nothing",
    resolveUserId(mockReq({})) === "user_default",
  );

  // Sanity: same inputs → same id (deterministic)
  const id1 = resolveUserId(mockReq({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }));
  const id2 = resolveUserId(mockReq({ "x-forwarded-for": "1.2.3.4", "user-agent": "ua" }));
  assert("deterministic hash", id1 === id2);
}

// ─── 5. state decay mathematics ──────────────────────────────────────────────

console.log("\n# persistent emotional state decay");

{
  const { decayState, foldFeltState } = await import("../lib/gabriella/state.js");

  // An old guarded state should decay toward rest given enough time.
  const old = {
    openness: 0.1, alertness: 0.9, care: 0.9, irritation: 0.9, warmth: 0.9,
    updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
  };
  const decayed = decayState(old);
  assert("two-day decay pulls short-timescale toward rest", decayed.care < 0.5 && decayed.irritation < 0.2);
  assert("warmth (long half-life) decays slower", decayed.warmth > decayed.irritation);

  // Folding a cold felt-state into a warm state lowers openness.
  const warmState = { openness: 0.8, alertness: 0.7, care: 0.8, irritation: 0.1, warmth: 0.7, updatedAt: Date.now() };
  const cold = { temperature: "closed", charge: "distant", edge: false };
  const folded = foldFeltState(warmState, cold);
  assert("cold fold lowers openness", folded.openness < warmState.openness);
}

// ─── 5b. finetune config layering ─────────────────────────────────────────────

console.log("\n# finetune config (defaults ← env ← upstash ← overrides)");

{
  const { loadFinetuneConfig, applyOverrides, getFinetuneConfigSchema } =
    await import("../lib/gabriella/finetuneConfig.js");

  // Fake redis that returns a preset upstash override.
  const mockRedis = {
    _store: { "gabriella:finetuneConfig": JSON.stringify({ epochs: 5, loraRank: 32 }) },
    get: async function(k) { return this._store[k] ?? null; },
  };

  const base = await loadFinetuneConfig(mockRedis, {});
  assert("upstash overrides default", base.config.epochs === 5 && base.sources.epochs === "upstash");
  assert("upstash overrides default (loraRank)", base.config.loraRank === 32 && base.sources.loraRank === "upstash");
  assert("default when no override", base.config.learningRate === 0.0001 && base.sources.learningRate === "default");

  // Env takes priority over defaults but upstash beats env.
  const envOnly = await loadFinetuneConfig({ get: async () => null }, {
    FINETUNE_EPOCHS: "7",
    FINETUNE_LEARNING_RATE: "0.00005",
  });
  assert("env takes priority over default", envOnly.config.epochs === 7 && envOnly.sources.epochs === "env");
  assert("env respected for lr", envOnly.config.learningRate === 0.00005);

  // Query-param override wins over everything.
  const overridden = applyOverrides(base, { epochs: "10" });
  assert("override beats upstash", overridden.config.epochs === 10 && overridden.sources.epochs === "override");

  // Bounds checking.
  const clamped = applyOverrides(base, { epochs: "9999" });
  assert("out-of-bounds epochs clamped to max", clamped.config.epochs === 20);

  const negative = applyOverrides(base, { loraRank: "-5" });
  assert("out-of-bounds loraRank clamped to min", negative.config.loraRank === 1);

  // Schema has all expected fields.
  const schema = getFinetuneConfigSchema();
  assert("schema has core fields", schema.epochs && schema.loraRank && schema.learningRate && schema.baseModel);
}

// ─── 6. trajectory heuristic ──────────────────────────────────────────────────

console.log("\n# trajectory heuristic");

{
  // Call via the async API with no redis so it skips the LLM correction
  const { classifyTrajectory } = await import("../lib/gabriella/relational.js");

  const stalling = await classifyTrajectory({
    messages: [
      { role: "user", content: "hey how's it going" },
      { role: "assistant", content: "good, you?" },
      { role: "user", content: "ok" },
    ],
  });
  assert("stalling on short ack-token", stalling === "stalling");

  const deepening = await classifyTrajectory({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hey" },
      { role: "user", content: "so i've been thinking a lot about my father's death lately and how it's shaped who i became" },
    ],
  });
  assert("deepening on expanding emotional content", deepening === "deepening" || deepening === "opening");
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n\n${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
