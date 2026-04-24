// tests/pure-modules.test.js
// Vanilla Node test script — no framework. Asserts behavior of the
// pure / deterministic modules that don't need Redis or LLM mocks.
//
// Run:  node --env-file=.env.local tests/pure-modules.test.js
//       npm run test
//
// Exits 0 on all-pass, 1 on any failure. Each assertion prints a
// single line; final summary shows pass/fail counts.

import assert from "node:assert/strict";

// ─── tiny test runner ──────────────────────────────────────────────────────

let pass = 0, fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

// ─── silence policy ────────────────────────────────────────────────────────

import { detectSilenceMoment, applySilenceOverride, getSilenceBlock } from "../lib/gabriella/silence.js";

console.log("\n# silence policy");

test("detectSilenceMoment: withdrawal fires", () => {
  const m = detectSilenceMoment("I don't want to talk about it");
  assert.equal(m?.kind, "withdrawal");
});

test("detectSilenceMoment: raw loss fires", () => {
  assert.equal(detectSilenceMoment("my dad died last year")?.kind, "raw_loss");
  assert.equal(detectSilenceMoment("she's gone")?.kind, "raw_loss");
});

test("detectSilenceMoment: command stop fires", () => {
  assert.equal(detectSilenceMoment("stop")?.kind, "command_stop");
  assert.equal(detectSilenceMoment("enough.")?.kind, "command_stop");
});

test("detectSilenceMoment: single-word emotional fires", () => {
  assert.equal(detectSilenceMoment("tired")?.kind, "single_word_emotional");
  assert.equal(detectSilenceMoment("done")?.kind, "single_word_emotional");
});

test("detectSilenceMoment: normal conversation does NOT fire", () => {
  assert.equal(detectSilenceMoment("I've been thinking about my last job"), null);
  assert.equal(detectSilenceMoment("what do you mean by that"), null);
});

test("applySilenceOverride: forces very short + attaches _silence", () => {
  const fs = { temperature: "open", length: "long", charge: "x" };
  const out = applySilenceOverride(fs, { kind: "withdrawal", guidance: "match it" });
  assert.equal(out.length, "very short");
  assert.equal(out.temperature, "present");  // open gets pulled to present
  assert.equal(out._silence.kind, "withdrawal");
});

test("getSilenceBlock: returns empty when no _silence", () => {
  assert.equal(getSilenceBlock({ charge: "x" }), "");
});

test("getSilenceBlock: returns block when _silence present", () => {
  const block = getSilenceBlock({ _silence: { kind: "k", guidance: "hold it" } });
  assert.match(block, /SILENCE POLICY/);
  assert.match(block, /hold it/);
});

// ─── humor (regex detector — sync, no LLM) ─────────────────────────────────

import { detectWit, shouldSuppressWit } from "../lib/gabriella/humor.js";

console.log("\n# humor detection");

test("detectWit: absurd setup fires", () => {
  assert.equal(detectWit("what if i just quit")?.flavor, "absurd_setup");
});

test("detectWit: self-deprecating fires", () => {
  assert.equal(detectWit("i'm such a disaster today")?.flavor, "self_deprecating");
});

test("detectWit: playful provocation fires", () => {
  assert.equal(detectWit("bet you can't even do that")?.flavor, "playful_provocation");
});

test("detectWit: irony invitation fires", () => {
  assert.equal(detectWit("you must be thrilled about that")?.flavor, "irony_invitation");
});

test("detectWit: normal statement does not fire", () => {
  assert.equal(detectWit("I had a meeting this morning"), null);
  assert.equal(detectWit("yeah that sounds good"), null);
});

test("shouldSuppressWit: fires on heavy pragmatic weight", () => {
  assert.equal(shouldSuppressWit({ pragmaticWeight: 0.7 }), true);
});

test("shouldSuppressWit: fires on silence policy", () => {
  assert.equal(shouldSuppressWit({ feltState: { _silence: { kind: "x" } } }), true);
});

test("shouldSuppressWit: fires on open temperature", () => {
  assert.equal(shouldSuppressWit({ feltState: { temperature: "open" } }), true);
});

test("shouldSuppressWit: does NOT fire on light moments", () => {
  assert.equal(shouldSuppressWit({ pragmaticWeight: 0.2, feltState: { temperature: "terse" } }), false);
});

// ─── stylometry (rendering — pure function) ────────────────────────────────

import { renderStylometryBlock } from "../lib/gabriella/stylometry.js";

console.log("\n# stylometry");

test("renderStylometryBlock: returns empty on null", () => {
  assert.equal(renderStylometryBlock(null), "");
});

test("renderStylometryBlock: returns empty when samples < min", () => {
  assert.equal(renderStylometryBlock({ samples: 2 }), "");
});

test("renderStylometryBlock: renders block with stats", () => {
  const block = renderStylometryBlock({
    samples: 10,
    avgSentenceLen: 12,
    fragmentRate: 0.3,
    emdashPer1k: 2.5,
    semiPer1k: 0.2,
    ellipsisPer1k: 0.3,
    parenPer1k: 0.5,
    startsWithIRate: 0.1,
    startsWithConjunctionRate: 0.2,
    topStarters: ["yeah (3)", "so (2)", "no (2)"],
  });
  assert.match(block, /YOUR RECENT VOICE SHAPE/);
  assert.match(block, /10 responses/);
  assert.match(block, /em-dashes/);
});

// ─── userPrefs (pure — no redis needed for rendering) ──────────────────────

import { renderUserPrefsBlock, VALID_VARIANTS } from "../lib/gabriella/userPrefs.js";

console.log("\n# userPrefs");

test("VALID_VARIANTS: exposes the four variants", () => {
  assert.deepEqual(VALID_VARIANTS.sort(), ["drier", "sharper", "softer", "standard"]);
});

test("renderUserPrefsBlock: empty for standard with no custom", () => {
  assert.equal(renderUserPrefsBlock({ variant: "standard", customAnchor: null }), "");
});

test("renderUserPrefsBlock: variant block for sharper", () => {
  const block = renderUserPrefsBlock({ variant: "sharper", customAnchor: null });
  assert.match(block, /SHARPER/);
  assert.match(block, /direct/);
});

test("renderUserPrefsBlock: layers custom anchor onto variant", () => {
  const block = renderUserPrefsBlock({
    variant: "softer",
    customAnchor: "don't try to fix things, just listen",
  });
  assert.match(block, /SOFTER/);
  assert.match(block, /don't try to fix things/);
});

test("renderUserPrefsBlock: custom anchor alone on standard", () => {
  const block = renderUserPrefsBlock({
    variant: "standard",
    customAnchor: "i want you to be more playful",
  });
  assert.match(block, /USER PREFERENCE/);
  assert.match(block, /more playful/);
});

// ─── seedExemplars (pure) ──────────────────────────────────────────────────

import { SEED_EXEMPLARS, pickSeedExemplars } from "../lib/gabriella/seedExemplars.js";

console.log("\n# seed exemplars");

test("SEED_EXEMPLARS: at least 80 entries", () => {
  assert.ok(SEED_EXEMPLARS.length >= 80, `only ${SEED_EXEMPLARS.length} entries`);
});

test("SEED_EXEMPLARS: each has userMsg + response + category", () => {
  for (const e of SEED_EXEMPLARS) {
    assert.ok(typeof e.userMsg === "string" && e.userMsg.length > 0, `bad userMsg on ${JSON.stringify(e).slice(0, 80)}`);
    assert.ok(typeof e.response === "string" && e.response.length > 0);
    assert.ok(typeof e.category === "string" && e.category.length > 0);
  }
});

test("SEED_EXEMPLARS: no response starts with 'I '", () => {
  for (const e of SEED_EXEMPLARS) {
    assert.ok(!/^I\b/.test(e.response.trim()), `'I' opener: "${e.response.slice(0, 60)}..."`);
  }
});

test("pickSeedExemplars: returns results for matching query", () => {
  const picks = pickSeedExemplars("hi", { k: 2 });
  assert.ok(picks.length > 0);
  assert.ok(picks.every(p => p.userMsg && p.response));
});

test("pickSeedExemplars: returns fallback for no-match query", () => {
  const picks = pickSeedExemplars("xyzabc1234 nonsensewords zzz", { k: 2 });
  assert.ok(picks.length > 0, "seed fallback should always produce something");
});

// ─── borrowing (pure tokenization) ─────────────────────────────────────────

import { renderBorrowingBlock } from "../lib/gabriella/borrowing.js";

console.log("\n# borrowing");

test("renderBorrowingBlock: empty on empty crossovers", () => {
  assert.equal(renderBorrowingBlock([]), "");
  assert.equal(renderBorrowingBlock(null), "");
});

test("renderBorrowingBlock: renders block with words", () => {
  const block = renderBorrowingBlock([
    { word: "untangling", at: Date.now() },
    { word: "whatever",   at: Date.now() },
  ]);
  assert.match(block, /VOCABULARY BORROWING/);
  assert.match(block, /untangling/);
});

// ─── summary ───────────────────────────────────────────────────────────────

console.log(`\n${pass} pass · ${fail} fail`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f.name}: ${f.err.message}`);
  process.exit(1);
}
process.exit(0);
