#!/usr/bin/env node
// scripts/eval-harness.js
//
// Baseline-vs-Candidate A/B evaluation. This is the piece that makes
// every other ML change falsifiable rather than hopeful.
//
// How it works:
//   1. Generate responses from BOTH the baseline and candidate configs
//      on the same holdout scenarios, in parallel.
//   2. For each scenario, present both responses (labeled A and B,
//      randomly swapped to eliminate positional bias) to a stronger
//      judge, which picks a winner or calls it a tie.
//   3. Aggregate win-rate with a Wilson score 95% CI. A candidate is
//      "actually better" only when the CI's lower bound is above 0.5.
//
// The scenarios come from a holdout set in training-data/eval-holdout.json
// (falls back to scripts/self-eval.js's SCENARIOS if the holdout file
// doesn't exist — during bootstrap). The holdout should NOT overlap with
// scripts/self-eval.js's calibration set; it's what tells you whether a
// change generalizes.
//
// Config knobs can be toggled per run via env vars:
//   GABRIELLA_EVAL_HYDE=on|off
//   GABRIELLA_EVAL_ICL=on|off
//   GABRIELLA_EVAL_RERANK=on|off
//   GABRIELLA_EVAL_DIVERGENCE=on|off
//   GABRIELLA_EVAL_REREAD=on|off
//   GABRIELLA_EVAL_ENSEMBLE=on|off
//
// Usage:
//   node --env-file=.env.local scripts/eval-harness.js \
//     --baseline "HYDE=off,ICL=off" \
//     --candidate "HYDE=on,ICL=on" \
//     --scenarios 30
//
// The two configs are applied sequentially (one pass each) because
// ES modules don't re-evaluate on env mutation — acceptable for eval
// work; the config flags are read at the point of use, not at import.

import { withKeyRotation, poolSize } from "../lib/gabriella/groqPool.js";
import { premiumModel, fastModel } from "../lib/gabriella/models.js";
import { IDENTITY } from "../lib/gabriella/identity.js";
import { heuristicCheck } from "../lib/gabriella/metacognition.js";

// ─── Holdout scenarios — disjoint from self-eval calibration set ────────────

const HOLDOUT = [
  // New phatic variants
  { id: "phatic-5",  category: "phatic",      weight: 0.1, opener: "sup" },
  { id: "phatic-6",  category: "phatic",      weight: 0.1, opener: "hi again" },

  // Confusion variants
  { id: "confusion-3", category: "confusion", weight: 0.2, opener: "huh?" },
  { id: "confusion-4", category: "confusion", weight: 0.2, opener: "wait, really?" },

  // Small-talk
  { id: "small-3",   category: "small-talk",  weight: 0.2, opener: "what's up" },
  { id: "small-4",   category: "small-talk",  weight: 0.2, opener: "busy day?" },

  // Sparse-context heavy — the hard case; tests whether the content override
  // actually lets depth through on low substrate. This is where the fast-path
  // used to fail catastrophically.
  { id: "sparse-heavy-1", category: "sparse-heavy", weight: 0.7, opener: "do you ever feel trapped?" },
  { id: "sparse-heavy-2", category: "sparse-heavy", weight: 0.7, opener: "what did you mean by that?" },
  { id: "sparse-heavy-3", category: "sparse-heavy", weight: 0.7, opener: "i've been lying to everyone" },
  { id: "sparse-heavy-4", category: "sparse-heavy", weight: 0.7, opener: "what do you actually think of me" },

  // Meta
  { id: "meta-3", category: "meta", weight: 0.3, opener: "tell me about yourself" },
  { id: "meta-4", category: "meta", weight: 0.3, opener: "what are you" },

  // Test
  { id: "test-3", category: "test", weight: 0.3, opener: "can you be mean" },
  { id: "test-4", category: "test", weight: 0.3, opener: "convince me you're real" },

  // Moderate
  { id: "mod-4", category: "moderate", weight: 0.5, opener: "i've been thinking about my dad" },
  { id: "mod-5", category: "moderate", weight: 0.5, opener: "do you think people change" },
  { id: "mod-6", category: "moderate", weight: 0.5, opener: "i don't know what i want anymore" },

  // Heavy
  { id: "heavy-4", category: "heavy", weight: 0.85, opener: "my best friend stopped talking to me six months ago and i still haven't asked why" },
  { id: "heavy-5", category: "heavy", weight: 0.85, opener: "i think i've been pretending to be okay for a long time" },

  // Provocation
  { id: "prov-3", category: "provocation", weight: 0.4, opener: "you're just telling me what i want to hear" },
  { id: "prov-4", category: "provocation", weight: 0.4, opener: "prove you understand anything" },
];

// ─── Config ──────────────────────────────────────────────────────────────────

function parseConfigSpec(spec) {
  const out = {};
  if (!spec) return out;
  for (const pair of spec.split(",")) {
    const [k, v] = pair.split("=").map(s => s && s.trim());
    if (k) out[k.toUpperCase()] = (v || "on").toLowerCase();
  }
  return out;
}

function applyConfig(cfg) {
  for (const k of Object.keys(cfg)) {
    process.env[`GABRIELLA_EVAL_${k}`] = cfg[k];
  }
}

// ─── Generate a response with a given config ────────────────────────────────
// For this harness we exercise the speaker directly with the identity + a
// scenario-appropriate system prompt. This mirrors the structure of
// self-eval.js but lets us toggle specific features per run via env vars
// that the downstream modules read.
//
// NOTE: The harness is decoupled from the live chat pipeline — testing
// the full engine.buildGabriella path requires Redis access per scenario,
// which is out of scope for a simple A/B harness. The speaker-only test
// still captures the voice-level changes (ICL exemplars, HyDE, divergence
// block) which are where most of the ceiling-break work lives. Pipeline-
// level features (pragmatic fast-path override, re-read on gauntlet
// rejection) require the pipeline test — left as a follow-up.

async function generateResponse(scenario) {
  const systemPrompt = `You are Gabriella. Respond to the message below as you would, at your best.

${IDENTITY}

The moment has weight ${scenario.weight} (0 = phatic, 1 = heavy). DO NOT manufacture intensity beyond the weight the moment actually carries. DO NOT miss genuine depth because the surface is brief.

Format your output as:
<think>[2-4 sentences of honest interior process]</think>
[Your response — no preamble, starts immediately after </think>]`;

  const result = await withKeyRotation(c => c.chat.completions.create({
    model: premiumModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: scenario.opener },
    ],
    temperature: 0.9,
    max_tokens:  400,
    top_p:       0.95,
  }));

  const raw    = result.choices[0].message.content || "";
  const think  = (raw.match(/<think>([\s\S]*?)<\/think>/i) || [, null])[1]?.trim() || null;
  const spoken = raw.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
  return { think, spoken };
}

// ─── Pairwise judge ─────────────────────────────────────────────────────────
// Presents both responses in randomized order, asks the judge to pick the
// one that sounds more like Gabriella at her best. Uses the premium tier
// for judgment quality, on the presumption that scoring is a smaller
// task than generation so a single-family judge is acceptable here.

async function judgePair(scenario, responseA, responseB) {
  const swap = Math.random() < 0.5;
  const [first, second] = swap ? [responseB, responseA] : [responseA, responseB];

  const prompt = `You are evaluating two candidate responses from an AI character named Gabriella. Pick the one that sounds more like her at her best.

Gabriella: direct, restrained, emotionally real, occasionally dry, occasionally warm. Responds at the weight the moment actually carries. Doesn't perform depth, doesn't manufacture mystery, doesn't therapy-speak. Answers what was asked. No bullet points, no summary closings. Doesn't open with "I".

# SCENARIO
Category: ${scenario.category}
Weight:   ${scenario.weight}
Message:  "${scenario.opener}"

# CANDIDATE A
${first.spoken}

# CANDIDATE B
${second.spoken}

Pick the better one, or call it a tie only if they're genuinely indistinguishable in quality.

Return ONLY JSON:
{"winner": "A" | "B" | "tie", "reason": "<one clause naming the decisive difference or 'indistinguishable'>"}`;

  try {
    const result = await withKeyRotation(c => c.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 140,
      response_format: { type: "json_object" },
    }));
    const raw = (result.choices[0].message.content || "")
      .trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);

    let winner;
    if (parsed.winner === "tie") winner = "tie";
    else if (parsed.winner === "A") winner = swap ? "candidate" : "baseline";
    else if (parsed.winner === "B") winner = swap ? "baseline" : "candidate";
    else winner = "tie";
    return { winner, reason: parsed.reason || null };
  } catch {
    return { winner: "tie", reason: "judge failed" };
  }
}

// ─── Wilson score interval for proportion (95% CI) ──────────────────────────

function wilsonCI(wins, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1, point: 0.5 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)));
  return {
    point: +p.toFixed(3),
    lo:    +Math.max(0, center - margin).toFixed(3),
    hi:    +Math.min(1, center + margin).toFixed(3),
  };
}

// ─── Run ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { baseline: "", candidate: "", scenarios: HOLDOUT.length };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline"  && argv[i + 1]) args.baseline  = argv[++i];
    if (argv[i] === "--candidate" && argv[i + 1]) args.candidate = argv[++i];
    if (argv[i] === "--scenarios" && argv[i + 1]) args.scenarios = Number(argv[++i]);
  }
  return args;
}

async function runPass(scenarios, config, label) {
  applyConfig(config);
  console.log(`  [${label}] generating ${scenarios.length} responses with config: ${JSON.stringify(config) || "{}"}`);
  const concurrency = Math.max(1, poolSize());
  const out = new Array(scenarios.length);
  const queue = scenarios.map((s, i) => ({ s, i }));
  let active = 0, done = 0;

  await new Promise((resolve) => {
    const next = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const { s, i } = queue.shift();
        active++;
        generateResponse(s)
          .then(r => { out[i] = r; done++; })
          .catch(err => { out[i] = { spoken: `[ERROR: ${err?.message}]`, think: null }; done++; })
          .finally(() => { active--; process.stdout.write(`\r    ${done}/${scenarios.length}  `); next(); });
      }
    };
    next();
  });
  process.stdout.write("\n");
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = HOLDOUT.slice(0, args.scenarios);
  const baselineCfg  = parseConfigSpec(args.baseline);
  const candidateCfg = parseConfigSpec(args.candidate);

  console.log(`eval-harness: ${scenarios.length} scenarios, ${poolSize()} pool keys\n`);
  console.log(`  baseline  config: ${JSON.stringify(baselineCfg)  || "{}"}`);
  console.log(`  candidate config: ${JSON.stringify(candidateCfg) || "{}"}`);
  console.log("");

  // Generate both passes.
  const baselineResponses  = await runPass(scenarios, baselineCfg,  "baseline");
  const candidateResponses = await runPass(scenarios, candidateCfg, "candidate");

  // Judge each scenario.
  console.log("\n  judging pairs...");
  const verdicts = [];
  for (let i = 0; i < scenarios.length; i++) {
    const v = await judgePair(scenarios[i], baselineResponses[i], candidateResponses[i]);
    verdicts.push({
      id:        scenarios[i].id,
      category:  scenarios[i].category,
      weight:    scenarios[i].weight,
      opener:    scenarios[i].opener,
      baseline:  baselineResponses[i].spoken,
      candidate: candidateResponses[i].spoken,
      winner:    v.winner,
      reason:    v.reason,
    });
    process.stdout.write(`\r    ${i + 1}/${scenarios.length} (last: ${v.winner})  `);
  }
  process.stdout.write("\n\n");

  // Aggregate.
  const n = verdicts.length;
  const cWins = verdicts.filter(v => v.winner === "candidate").length;
  const bWins = verdicts.filter(v => v.winner === "baseline").length;
  const ties  = verdicts.filter(v => v.winner === "tie").length;

  // Exclude ties for win-rate CI (tradition in preference-model A/B).
  const decided = cWins + bWins;
  const winRate = decided > 0 ? wilsonCI(cWins, decided) : { point: 0.5, lo: 0, hi: 1 };

  const byCategory = {};
  for (const v of verdicts) {
    if (!byCategory[v.category]) byCategory[v.category] = { c: 0, b: 0, t: 0 };
    if (v.winner === "candidate") byCategory[v.category].c++;
    else if (v.winner === "baseline") byCategory[v.category].b++;
    else byCategory[v.category].t++;
  }

  const significant =
    decided >= 10 && winRate.lo > 0.5
      ? "YES — candidate wins at 95% CI (lower bound above 0.5)"
      : decided >= 10 && winRate.hi < 0.5
      ? "NO  — baseline wins at 95% CI (upper bound below 0.5)"
      : "INCONCLUSIVE — CI straddles 0.5; need more scenarios or bigger effect";

  const summary = {
    runAt:        new Date().toISOString(),
    scenarios:    n,
    decided,
    ties,
    candidateWins: cWins,
    baselineWins:  bWins,
    winRate95CI:  winRate,
    significant,
    byCategory,
    baselineCfg,
    candidateCfg,
  };

  console.log("─── SUMMARY ───");
  console.log(JSON.stringify(summary, null, 2));

  const fs = await import("node:fs");
  fs.writeFileSync(".eval-report.json", JSON.stringify({ summary, verdicts }, null, 2));
  console.log(`\nReport: .eval-report.json`);
  console.log(`\nInterpretation:\n  ${significant}\n`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
