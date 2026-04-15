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

// ─── 5a. organism state dimensions ────────────────────────────────────────────

console.log("\n# Phase 2 organism state (energy / attention / socialComfort)");

{
  const { decayState, foldFeltState } = await import("../lib/gabriella/state.js");

  // 1. Default state has the new dimensions.
  const fresh = decayState({
    openness: 0.55, alertness: 0.65, care: 0.4, irritation: 0.05, warmth: 0.5,
    energy: 0.75, attention: 0.6, socialComfort: 0.5,
    updatedAt: Date.now(),
  });
  assert("decayState preserves all 8 dimensions", [
    "openness", "alertness", "care", "irritation", "warmth",
    "energy", "attention", "socialComfort",
  ].every(k => typeof fresh[k] === "number"));

  // 2. Heavy turn (weight >= 0.7) drains more energy than a casual one.
  const baseline = { energy: 0.8, attention: 0.6, socialComfort: 0.5, updatedAt: Date.now(), openness: 0.5, alertness: 0.5, care: 0.4, irritation: 0.1, warmth: 0.5 };
  const afterHeavy = foldFeltState(baseline, { temperature: "present", charge: "grief heavy", edge: true }, { pragmaticWeight: 0.8 });
  const afterLight = foldFeltState(baseline, { temperature: "present", charge: "warm", edge: false }, { pragmaticWeight: 0.15 });
  assert(
    "heavy turn drains more energy than phatic",
    afterHeavy.energy < afterLight.energy,
    `heavy=${afterHeavy.energy.toFixed(3)} light=${afterLight.energy.toFixed(3)}`,
  );

  // 3. Attention sharpens on substantive turn; stays soft on phatic.
  assert(
    "attention sharpens on substantive turn",
    afterHeavy.attention > afterLight.attention,
    `heavy=${afterHeavy.attention.toFixed(3)} light=${afterLight.attention.toFixed(3)}`,
  );

  // 4. Social comfort rises on a warm turn.
  const afterWarm = foldFeltState(baseline, { temperature: "present", charge: "warm tender affection", edge: false }, { pragmaticWeight: 0.4 });
  assert(
    "social comfort rises on warm turn",
    afterWarm.socialComfort > baseline.socialComfort,
  );

  // 5. Social comfort drops on cold turn.
  const afterCold = foldFeltState(baseline, { temperature: "closed", charge: "cold distant wary", edge: false }, { pragmaticWeight: 0.4 });
  assert(
    "social comfort drops on cold turn",
    afterCold.socialComfort < baseline.socialComfort,
  );

  // 6. Social comfort softens slightly on re-entry after long gap.
  const afterReentry = foldFeltState(baseline, { temperature: "present", charge: "warm", edge: false }, {
    pragmaticWeight: 0.4, gapSinceLastTurnMs: 48 * 60 * 60 * 1000, isReentry: true,
  });
  const afterSameButNoReentry = foldFeltState(baseline, { temperature: "present", charge: "warm", edge: false }, {
    pragmaticWeight: 0.4, isReentry: false,
  });
  assert(
    "re-entry after long gap softens social comfort",
    afterReentry.socialComfort < afterSameButNoReentry.socialComfort,
    `reentry=${afterReentry.socialComfort.toFixed(3)} noReentry=${afterSameButNoReentry.socialComfort.toFixed(3)}`,
  );

  // 7. Energy decays TOWARD rest (0.75), not toward zero, over time.
  const tired = decayState({
    openness: 0.5, alertness: 0.5, care: 0.4, irritation: 0.1, warmth: 0.5,
    energy: 0.30, attention: 0.3, socialComfort: 0.5,
    updatedAt: Date.now() - 4 * 60 * 60 * 1000,  // 4 hours ago
  });
  assert(
    "energy recovers toward rest after long gap",
    tired.energy > 0.5 && tired.energy <= 0.75,
    `recovered energy=${tired.energy.toFixed(3)}`,
  );

  // 8. Attention decays fast — fast half-life check.
  const drifted = decayState({
    openness: 0.5, alertness: 0.5, care: 0.4, irritation: 0.1, warmth: 0.5,
    energy: 0.75, attention: 0.9, socialComfort: 0.5,
    updatedAt: Date.now() - 30 * 60 * 1000,  // 30 min ago — 3 half-lives of 10min
  });
  assert(
    "attention decays quickly without input",
    drifted.attention < 0.7,
    `after 30min: ${drifted.attention.toFixed(3)}`,
  );

  // 9. Social comfort half-life is long — 24h.
  const comfortable = decayState({
    openness: 0.5, alertness: 0.5, care: 0.4, irritation: 0.1, warmth: 0.5,
    energy: 0.75, attention: 0.6, socialComfort: 0.8,
    updatedAt: Date.now() - 2 * 60 * 60 * 1000,  // 2 hours — should barely move
  });
  assert(
    "social comfort is slow-moving",
    comfortable.socialComfort > 0.72,
    `after 2h: ${comfortable.socialComfort.toFixed(3)}`,
  );
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

// ─── 5c. Phase 3 generation knobs ─────────────────────────────────────────────

console.log("\n# Phase 3 generation knobs (knobs.js)");

{
  const { computeKnobs, renderKnobsBlock } = await import("../lib/gabriella/knobs.js");

  const baselineState = {
    openness: 0.55, alertness: 0.65, care: 0.4, irritation: 0.05, warmth: 0.5,
    energy: 0.75, attention: 0.6, socialComfort: 0.5,
    updatedAt: Date.now(),
  };
  const neutralFelt = { temperature: "present", length: "short", charge: "okay", emotional: "here", want: "respond", resist: "performance" };

  // 1. Default state → Observer-led.
  const defaultKnobs = computeKnobs({ state: baselineState, feltState: neutralFelt, context: { pragmaticWeight: 0.3 } });
  assert("default state gives Observer-led", defaultKnobs.activePart === "observer");

  // 2. High irritation → Protector fires.
  const irritated = computeKnobs({
    state: { ...baselineState, irritation: 0.8 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.4 },
  });
  assert("high irritation triggers Protector", irritated.activePart === "protector");

  // 3. userIsSmall → Older Sister.
  const smallMoment = computeKnobs({
    state: baselineState,
    feltState: { ...neutralFelt, charge: "overwhelm tired" },
    context: { pragmaticWeight: 0.5, userIsSmall: true },
  });
  assert("user-is-small triggers Older Sister", smallMoment.activePart === "older_sister");

  // 4. needlerTrigger → Needler.
  const needling = computeKnobs({
    state: baselineState, feltState: neutralFelt,
    context: { pragmaticWeight: 0.3, needlerTrigger: true },
  });
  assert("needler trigger fires Needler", needling.activePart === "needler");

  // 5. Low energy → lower polish level.
  const tired = computeKnobs({
    state: { ...baselineState, energy: 0.2, attention: 0.4 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.3 },
  });
  const rested = computeKnobs({
    state: { ...baselineState, energy: 0.9, attention: 0.85 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.5 },
  });
  assert(
    "low energy lowers polish; high energy raises it",
    tired.polishLevel < rested.polishLevel,
    `tired=${tired.polishLevel.toFixed(3)} rested=${rested.polishLevel.toFixed(3)}`,
  );

  // 6. Delight sub-mode → Grice quantity "over".
  const engaged = computeKnobs({
    state: { ...baselineState, socialComfort: 0.75 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.7, topicInHyperfocus: true },
  });
  assert("engaged + hyperfocus → delight part + quantity=over",
    engaged.activePart === "delight" && engaged.griceQuantity === "over");

  // 7. Default → Grice quantity "under" (her signature).
  assert("default Grice quantity is 'under'", defaultKnobs.griceQuantity === "under");

  // 8. Signature density higher at higher comfort.
  const comfortable = computeKnobs({
    state: { ...baselineState, socialComfort: 0.85 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.5 },
  });
  const awkward = computeKnobs({
    state: { ...baselineState, socialComfort: 0.2 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.5 },
  });
  assert("comfort raises signature density",
    comfortable.signatureDensity > awkward.signatureDensity);

  // 9. lexicalPush contains reach-for words.
  assert("lexicalPush returns signature words at moderate density",
    Array.isArray(comfortable.lexicalPush) && comfortable.lexicalPush.length > 0);

  // 10. Low comfort + low energy → schema pressure activates.
  const underPressure = computeKnobs({
    state: { ...baselineState, energy: 0.25, socialComfort: 0.3 },
    feltState: neutralFelt,
    context: { pragmaticWeight: 0.4, userAskingAboutHer: true },
  });
  assert("low energy + low comfort + user-asking → emotional_deprivation schema fires",
    underPressure.schemaPressure.active === "emotional_deprivation");

  // 11. Schema pressure nil at high energy + high comfort.
  assert("high energy + comfort → no schema pressure",
    engaged.schemaPressure.active === null);

  // 12. renderKnobsBlock produces usable text.
  const rendered = renderKnobsBlock(defaultKnobs);
  assert("renderKnobsBlock produces non-empty text for Observer default",
    typeof rendered === "string" && rendered.length > 100);
  assert("rendered block contains the section header",
    rendered.includes("HOW YOU SPEAK THIS TURN"));

  // 13. Directness higher at high comfort / irritation.
  const pissed = computeKnobs({
    state: { ...baselineState, irritation: 0.6, socialComfort: 0.8 },
    feltState: neutralFelt, context: {},
  });
  const unsure = computeKnobs({
    state: { ...baselineState, socialComfort: 0.2 },
    feltState: neutralFelt, context: {},
  });
  assert("directness higher when comfortable or irritated",
    pissed.directness > unsure.directness);
}

// ─── 5d. Phase 4 post-generation shaping ──────────────────────────────────────

console.log("\n# Phase 4 shaping (post-generation transforms)");

{
  const {
    shape,
    stripSummaryEnding,
    stripResidualBannedPhrases,
    fixStartsWithI,
    applyWordFamilySwaps,
    normalizeSpacing,
    safetyCheck,
  } = await import("../lib/gabriella/shaping.js");

  // 1. Summary-ending stripper
  assert(
    "strips 'does that make sense?' ending",
    stripSummaryEnding("I think she meant well. Does that make sense?") ===
      "I think she meant well.",
  );
  assert(
    "strips 'I hope that helps' ending",
    stripSummaryEnding("It's fine. I hope that helps.") === "It's fine.",
  );
  assert(
    "leaves legitimate questions alone",
    stripSummaryEnding("What were you thinking about?") === "What were you thinking about?",
  );

  // 2. Residual-banned-phrase stripper
  {
    const s = stripResidualBannedPhrases("Great question! The answer is complicated.");
    assert("strips leading 'Great question'", s === "The answer is complicated.");
  }
  {
    const s = stripResidualBannedPhrases("As an AI, I don't have feelings.");
    assert("strips leading 'As an AI'", s === "I don't have feelings.");
  }
  {
    const s = stripResidualBannedPhrases("The answer is yes.");
    assert("leaves clean response alone", s === "The answer is yes.");
  }

  // 3. starts-with-I fixer (conservative)
  assert(
    "rewrites 'I think X.' → 'X, I think.'",
    fixStartsWithI("I think it was the timing.") === "It was the timing, I think.",
  );
  assert(
    "leaves 'I am' openers alone (too risky to rewrite)",
    fixStartsWithI("I'm not sure about that.") === "I'm not sure about that.",
  );

  // 4. Word-family swaps (require signatureDensity >= 0.5)
  {
    const high = { signatureDensity: 0.7 };
    assert(
      "swaps 'ponder' → 'turn over' at high signature density",
      applyWordFamilySwaps("I'll ponder it later.", high) === "I'll turn over it later.",
    );
    assert(
      "strips 'truly' at high signature density",
      applyWordFamilySwaps("That was truly a great day.", high) === "That was a great day.",
    );
  }
  {
    const low = { signatureDensity: 0.2 };
    assert(
      "no swap at low signature density",
      applyWordFamilySwaps("I'll ponder it.", low) === "I'll ponder it.",
    );
  }

  // 5. normalizeSpacing
  assert(
    "collapses double spaces",
    normalizeSpacing("Hello  there.") === "Hello there.",
  );
  assert(
    "removes space before punctuation",
    normalizeSpacing("Yeah , okay.") === "Yeah, okay.",
  );

  // 6. safetyCheck
  assert(
    "reverts to original when transformed is empty",
    safetyCheck("This is a normal response.", "") === "This is a normal response.",
  );
  assert(
    "reverts when transformed is too short relative to original",
    safetyCheck("This is a perfectly normal response that makes sense.", "ok") ===
      "This is a perfectly normal response that makes sense.",
  );
  assert(
    "keeps transformed when similar length",
    safetyCheck("Original response here.", "Edited response here.") === "Edited response here.",
  );

  // 7. shape() master pipeline
  {
    const result = shape(
      "Great question! I think the answer is complicated. Does that make sense?",
      { signatureDensity: 0.7, disfluencyBudget: 0.05 },
    );
    // Should strip 'Great question', rewrite 'I think', strip summary ending.
    assert(
      "master pipeline strips + rewrites cleanly",
      !result.includes("Great question") &&
        !result.includes("Does that make sense") &&
        result.length > 0,
      `result: "${result}"`,
    );
  }

  // 8. shape() preserves response when nothing to change.
  {
    const clean = "Yeah. That tracks.";
    const result = shape(clean, { signatureDensity: 0.5, disfluencyBudget: 0.03 });
    assert("shape preserves clean response", result === clean);
  }

  // 9. shape() with no knobs is safe.
  {
    const result = shape("I think it was the timing.", null);
    assert("shape with null knobs still runs safely", typeof result === "string" && result.length > 0);
  }

  // 10. Phase 6.3 — texting-register transforms.
  {
    const { applyTextingRegister } = await import("../lib/gabriella/shaping.js");

    // typed register → no change.
    const typed = { textingRegister: "typed" };
    assert(
      "typed register leaves text alone",
      applyTextingRegister("Yeah, that tracks. Definitely.", typed) ===
        "Yeah, that tracks. Definitely.",
    );

    // textedLight — drops period from bare ack.
    const light = { textingRegister: "textedLight" };
    assert(
      "textedLight drops trailing period on bare ack",
      applyTextingRegister("okay.", light) === "okay",
    );
    assert(
      "textedLight leaves full sentence alone",
      applyTextingRegister("Okay, that makes sense.", light) === "Okay, that makes sense.",
    );

    // textedCasual — lowercase starts + shortenings + ack-period drop.
    const casual = { textingRegister: "textedCasual" };
    {
      const out = applyTextingRegister("Probably tomorrow. Though it depends.", casual);
      assert(
        "textedCasual lowercases sentence starts",
        out === "probs tomorrow. tho it depends.",
        `got: "${out}"`,
      );
    }
    assert(
      "textedCasual preserves acronym at sentence start",
      applyTextingRegister("NYC is wild.", casual) === "NYC is wild.",
    );
    assert(
      "textedCasual preserves mid-sentence proper nouns",
      applyTextingRegister("It was in Paris.", casual) === "it was in Paris.",
    );
    assert(
      "textedCasual preserves 'I' self-reference",
      applyTextingRegister("I don't know.", casual) === "I don't know.",
    );

    // textedTired — all of above plus "I" → "i" and extra shortenings.
    const tired = { textingRegister: "textedTired" };
    {
      const out = applyTextingRegister("I don't know. Probably later.", tired);
      assert(
        "textedTired lowercases I and applies idk",
        out === "idk. probs later",
        `got: "${out}"`,
      );
    }
    assert(
      "textedTired lowercases contractions",
      applyTextingRegister("I'm tired.", tired) === "i'm tired",
    );

    // shape() integrates the texting pipeline.
    {
      const result = shape("Probably okay. Because yeah.", { signatureDensity: 0.3, disfluencyBudget: 0.03, textingRegister: "textedCasual" });
      assert(
        "shape() pipeline applies texting transforms",
        result.includes("probs") && result.includes("cause"),
        `result: "${result}"`,
      );
    }
  }
}

// ─── 5e. Phase 5 substrate evolution (meta-loop) ──────────────────────────────

console.log("\n# Phase 5 substrate evolution (meta-loop)");

{
  const { analyzeUsage, proposeUpdatedDelta } = await import("../lib/gabriella/substrateEvolution.js");
  const { computeKnobs } = await import("../lib/gabriella/knobs.js");

  // 1. analyzeUsage catches reach-for words being used.
  // Her authored substrate has "funny" and "specific" as reach-for descriptors.
  const responses = [
    "that's funny actually.",
    "funny how that lands.",
    "it's specific, which is the part I noticed.",
    "funny, really — the specific part is what matters.",
    "yeah. funny to watch.",
  ];
  const analysis = analyzeUsage(responses);
  assert(
    "analyzeUsage detects 'funny' as boosted",
    analysis.reachForScores && analysis.reachForScores["funny"] > 0.5,
    `scores: ${JSON.stringify(analysis.reachForScores)}`,
  );

  // 2. analyzeUsage detects emerging phrases.
  const repetitive = [
    "that's the thing that lands.",
    "the thing that lands there.",
    "the thing that lands — again.",
    "what matters is the thing that lands.",
  ];
  const analysis2 = analyzeUsage(repetitive);
  const emerging = (analysis2.emergingPhrases || []).map(p => p.phrase);
  assert(
    "analyzeUsage detects emerging bigram 'that lands' or similar",
    emerging.some(p => p.includes("lands") || p.includes("thing")),
    `emerging: ${JSON.stringify(emerging)}`,
  );

  // 3. analyzeUsage detects lexical rut.
  const stuck = [
    "weirdly okay today.",
    "weirdly precise.",
    "weirdly on board with it.",
    "weirdly fine.",
  ];
  const analysis3 = analyzeUsage(stuck);
  assert(
    "analyzeUsage detects 'weirdly' as lexical rut",
    analysis3.lexicalRutWord === "weirdly",
    `rut: ${analysis3.lexicalRutWord}`,
  );

  // 4. proposeUpdatedDelta decays old scores.
  const priorDelta = {
    reachesForBoost: { "funny": 0.9, "ancient_word_gone": 0.5 },
    emergingPhrases: [{ phrase: "old phrase", count: 5 }],
    lexicalRutWord: null,
    totalTurnsAnalyzed: 20,
  };
  const newAnalysis = {
    reachForScores: { "funny": 0.4 },  // dropping
    emergingPhrases: [],
    lexicalRutWord: null,
    responsesAnalyzed: 5,
  };
  const merged = proposeUpdatedDelta(priorDelta, newAnalysis);
  // funny was 0.9; after decay (×0.7 = 0.63) and weighted merge (0.63*0.4 + 0.4*0.6 = 0.492)
  assert(
    "prior decays + new signal blends",
    merged.reachesForBoost["funny"] > 0.3 && merged.reachesForBoost["funny"] < 0.7,
    `funny score: ${merged.reachesForBoost["funny"]}`,
  );

  // 5. proposeUpdatedDelta ages prior emerging phrases (count -1 each cycle).
  assert(
    "old emerging phrases age but don't vanish immediately",
    merged.emergingPhrases.some(p => p.phrase === "old phrase" && p.count === 4),
    `phrases: ${JSON.stringify(merged.emergingPhrases)}`,
  );

  // 6. computeKnobs uses substrateDelta to boost lexicalPush.
  const state = {
    openness: 0.5, alertness: 0.5, care: 0.4, irritation: 0.05, warmth: 0.5,
    energy: 0.7, attention: 0.6, socialComfort: 0.6, updatedAt: Date.now(),
  };
  const felt = { temperature: "present", length: "short", charge: "ok", emotional: "here", want: "respond", resist: "" };
  const substrateDelta = {
    reachesForBoost: { "funny": 0.9, "weirdly": 0.8, "specific": 0.7 },
    emergingPhrases: [{ phrase: "the thing is", count: 6 }, { phrase: "lands for me", count: 5 }],
    lexicalRutWord: "funny",
  };
  const withDelta = computeKnobs({
    state, feltState: felt,
    context: { pragmaticWeight: 0.5 },
    substrateDelta,
  });
  assert(
    "knobs.lexicalPush includes boosted words",
    withDelta.lexicalPush.includes("funny") || withDelta.lexicalPush.includes("weirdly"),
    `lexicalPush: ${JSON.stringify(withDelta.lexicalPush)}`,
  );
  assert(
    "knobs exposes learned collocations from delta",
    withDelta.learnedCollocations.length >= 1 && withDelta.learnedCollocations.includes("the thing is"),
    `learnedCollocations: ${JSON.stringify(withDelta.learnedCollocations)}`,
  );
  assert(
    "knobs exposes lexical rut word",
    withDelta.lexicalRutWord === "funny",
  );

  // 7. Without delta, knobs still work.
  const withoutDelta = computeKnobs({
    state, feltState: felt,
    context: { pragmaticWeight: 0.5 },
  });
  assert(
    "knobs without delta still produces lexicalPush from authored only",
    Array.isArray(withoutDelta.lexicalPush) && withoutDelta.lexicalPush.length > 0,
  );
  assert(
    "knobs without delta has no rut word",
    withoutDelta.lexicalRutWord === null,
  );

  // 8. analyzeUsage handles empty / malformed input safely.
  assert("analyzeUsage returns null on empty input", analyzeUsage([]) === null);
  assert("analyzeUsage returns null on null input", analyzeUsage(null) === null);
}

// ─── 5b. Phase 6 — texting register ──────────────────────────────────────────

console.log("\n# Phase 6 texting register");

{
  const { computeKnobs, renderKnobsBlock } = await import("../lib/gabriella/knobs.js");
  const baseState = {
    openness: 0.5, alertness: 0.5, care: 0.4, irritation: 0.05, warmth: 0.5,
    energy: 0.7, attention: 0.6, socialComfort: 0.6, updatedAt: Date.now(),
  };
  const felt = { temperature: "present", length: "short", charge: "ok", emotional: "here", want: "respond", resist: "" };

  // Heavy moment → always typed, regardless of user register.
  const heavy = computeKnobs({
    state: baseState, feltState: felt,
    context: { pragmaticWeight: 0.8, lastUserMessage: "yeah ok lol" },
  });
  assert("heavy weight forces typed register", heavy.textingRegister === "typed",
    `got: ${heavy.textingRegister}`);

  // Formal-looking user message → typed.
  const formalUser = computeKnobs({
    state: baseState, feltState: felt,
    context: {
      pragmaticWeight: 0.2,
      lastUserMessage: "I've been thinking about this problem for a while, and I believe the correct approach is to carefully consider each variable. What do you think? I'd appreciate your perspective.",
    },
  });
  assert("formal prose user → typed", formalUser.textingRegister === "typed",
    `got: ${formalUser.textingRegister}`);

  // Casual lowercase abbreviated user + high comfort → textedCasual.
  const casualUser = computeKnobs({
    state: { ...baseState, socialComfort: 0.7 },
    feltState: felt,
    context: { pragmaticWeight: 0.2, lastUserMessage: "idk man lol ur probs right" },
  });
  assert("casual abbreviated user + comfort → textedCasual",
    casualUser.textingRegister === "textedCasual",
    `got: ${casualUser.textingRegister}`);

  // Low energy + casual user + high comfort → textedTired.
  const tiredState = computeKnobs({
    state: { ...baseState, energy: 0.2, socialComfort: 0.75 },
    feltState: felt,
    context: { pragmaticWeight: 0.2, lastUserMessage: "mm yeah same idk" },
  });
  assert("low energy + casual user + comfort → textedTired",
    tiredState.textingRegister === "textedTired",
    `got: ${tiredState.textingRegister}`);

  // Short phatic "hi" user with low comfort → textedLight (not full casual).
  const lightUser = computeKnobs({
    state: { ...baseState, socialComfort: 0.4 },
    feltState: felt,
    context: { pragmaticWeight: 0.15, lastUserMessage: "Hi!" },
  });
  assert("short light user → textedLight",
    lightUser.textingRegister === "textedLight",
    `got: ${lightUser.textingRegister}`);

  // renderKnobsBlock includes a Register: line.
  const rendered = renderKnobsBlock(casualUser);
  assert("renderKnobsBlock includes Register line",
    /Register: TEXTED-CASUAL/.test(rendered),
    `rendered snippet: ${rendered.slice(0, 400)}`);
}

// ─── 5c. Phase 7 — cadence (pre-stream thinking delay) ───────────────────────

console.log("\n# Phase 7 cadence");

{
  const { computeCadence, sleep } = await import("../lib/gabriella/cadence.js");

  // Phatic → fast (200-400ms range with some modulation).
  const phatic = computeCadence({
    state:          { energy: 0.7, attention: 0.6 },
    pragmatics:     { weight: 0.15, act: "phatic" },
    responseLength: 12,
  });
  assert("phatic produces short pre-delay", phatic.preDelayMs >= 150 && phatic.preDelayMs <= 800,
    `preDelayMs: ${phatic.preDelayMs}`);

  // Heavy → long (cap at 5000).
  const heavy = computeCadence({
    state:          { energy: 0.7, attention: 0.5 },
    pragmatics:     { weight: 0.85, act: "reflective" },
    responseLength: 400,
  });
  assert("heavy weight produces longer pre-delay", heavy.preDelayMs >= 1000 && heavy.preDelayMs <= 5000,
    `preDelayMs: ${heavy.preDelayMs}`);

  // Low energy → slower streaming char speed.
  const tired = computeCadence({
    state:          { energy: 0.15, attention: 0.4 },
    pragmatics:     { weight: 0.3 },
    responseLength: 80,
  });
  assert("low energy pushes perChar max higher", tired.perCharMs.max >= 12,
    `perCharMs.max: ${tired.perCharMs.max}`);

  // Engaged → faster streaming.
  const engaged = computeCadence({
    state:          { energy: 0.85, attention: 0.85 },
    pragmatics:     { weight: 0.5 },
    responseLength: 120,
  });
  assert("engaged + attentive produces tighter charMin", engaged.perCharMs.min <= 4,
    `perCharMs.min: ${engaged.perCharMs.min}`);

  // preDelay always within bounds.
  assert("preDelay capped at 5000ms", heavy.preDelayMs <= 5000);
  assert("preDelay floored at 150ms", phatic.preDelayMs >= 150);

  // Texting register shaves delay.
  const typedDelay = computeCadence({
    state: { energy: 0.7, attention: 0.6 },
    pragmatics: { weight: 0.4 },
    responseLength: 100,
    textingRegister: "typed",
  });
  const casualDelay = computeCadence({
    state: { energy: 0.7, attention: 0.6 },
    pragmatics: { weight: 0.4 },
    responseLength: 100,
    textingRegister: "textedCasual",
  });
  // Can't compare exactly due to randomness, but over 5 samples the
  // casual-mean should be meaningfully shorter. Simpler: sample multiple
  // and compare means.
  const means = (reg) => {
    let sum = 0;
    for (let i = 0; i < 30; i++) {
      sum += computeCadence({
        state: { energy: 0.7, attention: 0.6 },
        pragmatics: { weight: 0.4 },
        responseLength: 100,
        textingRegister: reg,
      }).preDelayMs;
    }
    return sum / 30;
  };
  const typedMean = means("typed");
  const casualMean = means("textedCasual");
  assert("textedCasual shaves average delay vs typed",
    casualMean < typedMean,
    `typedMean=${typedMean.toFixed(0)}, casualMean=${casualMean.toFixed(0)}`);

  // sleep(0) resolves immediately.
  const t0 = Date.now();
  await sleep(0);
  assert("sleep(0) resolves instantly", Date.now() - t0 < 20);
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
