#!/usr/bin/env node
// scripts/expand-seeds.js
//
// Seed corpus amplification. Takes the hand-curated set in
// lib/gabriella/seedExemplars.js as anchor archetypes and, for each,
// produces N generated variants — same category, same discipline,
// different surface text. Each generated variant goes through a
// two-stage quality filter:
//
//   1. heuristicCheck() from metacognition.js — the same gauntlet
//      heuristic used in production. Rejects banned phrases, bullet
//      points, "I"-openers, summary endings.
//
//   2. LLM-judge pass — asks a fast-tier model whether the variant
//      sounds more like Gabriella or more like a generic helpful AI.
//      Only "Gabriella" verdicts are kept.
//
// Output: training-data/seed-expansions.jsonl — one { category,
// userMsg, response } per line, ready to merge into seedExemplars.js
// or to upload as DPO/SFT training material.
//
// Runs entirely on Groq's free tier. For safety, defaults to 3
// variants per anchor (85 anchors × 3 = 255 generations) and a
// conservative 30 RPM. With Cerebras + Gemini in the pool, more is
// fine; the flag --variants N overrides.
//
// Usage:
//   node --env-file=.env.local scripts/expand-seeds.js
//   node --env-file=.env.local scripts/expand-seeds.js --variants 5
//   node --env-file=.env.local scripts/expand-seeds.js --category heavy
//   node --env-file=.env.local scripts/expand-seeds.js --max-rpm 60

import fs from "node:fs";
import path from "node:path";
import { withKeyRotation, poolSize } from "../lib/gabriella/groqPool.js";
import { premiumModel, fastModel } from "../lib/gabriella/models.js";
import { IDENTITY } from "../lib/gabriella/identity.js";
import { heuristicCheck } from "../lib/gabriella/metacognition.js";
import { SEED_EXEMPLARS } from "../lib/gabriella/seedExemplars.js";

const OUT_DIR  = "./training-data";
const OUT_FILE = "seed-expansions.jsonl";
const OUT_PATH = path.join(OUT_DIR, OUT_FILE);

// ─── Rate governor (same pattern as eval-harness) ──────────────────────────
class RateGovernor {
  constructor(maxRpm) {
    this.intervalMs = Math.ceil(60_000 / Math.max(1, maxRpm));
    this.lastAt = 0;
    this.waiters = Promise.resolve();
  }
  async acquire() {
    const mine = this.waiters.then(async () => {
      const now = Date.now();
      const gap = now - this.lastAt;
      if (gap < this.intervalMs) await new Promise(r => setTimeout(r, this.intervalMs - gap));
      this.lastAt = Date.now();
    });
    this.waiters = mine.catch(() => {});
    return mine;
  }
}
let GOV = null;
const gated = fn => GOV ? GOV.acquire().then(fn) : fn();

// ─── Args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { variants: 3, category: null, maxRpm: 30, limit: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--variants" && argv[i+1]) args.variants = Number(argv[++i]);
    else if (argv[i] === "--category" && argv[i+1]) args.category = String(argv[++i]);
    else if (argv[i] === "--max-rpm" && argv[i+1]) args.maxRpm = Number(argv[++i]);
    else if (argv[i] === "--limit" && argv[i+1]) args.limit = Number(argv[++i]);
  }
  return args;
}

// ─── Generate a variant ────────────────────────────────────────────────────
async function generateVariant(anchor) {
  const prompt = `You are generating training-data variants for an AI character named Gabriella.

${IDENTITY}

Below is an ANCHOR exemplar — Gabriella at her best in a specific moment. Your task: produce ONE variant that preserves the SAME discipline (category, voice, weight calibration, refusal to perform) but uses a DIFFERENT opener from the person and a DIFFERENT response from her. Same archetype. New surface.

# ANCHOR

Category: ${anchor.category}
Person: "${anchor.userMsg}"
Gabriella: "${anchor.response}"

# YOUR VARIANT

Produce a new pair that belongs in the same category and demonstrates the same voice. The new person's message should be plausibly something a different person could have said in the same archetype. Her response should exhibit the same discipline (not the same sentences).

Hard rules:
- DO NOT start Gabriella's response with "I"
- DO NOT use bullet points or numbered lists
- DO NOT use therapy-speak ("I hear you", "that's valid", "that must be hard")
- DO NOT use customer-service softeners ("certainly", "absolutely", "great question")
- DO NOT end with a summary question
- DO match the length range of the anchor (within ~30%)
- DO keep the register (light for phatic, heavy for heavy, etc.)

Return ONLY valid JSON, no prose, no fence:
{"userMsg":"<the person's new opener>","response":"<her new response>"}`;

  try {
    const result = await gated(() => withKeyRotation(c =>
      c.chat.completions.create({
        model:       premiumModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.95,
        max_tokens:  320,
        top_p:       0.95,
        response_format: { type: "json_object" },
      }),
    ));
    const raw = (result.choices[0].message.content || "")
      .trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    if (!parsed.userMsg || !parsed.response) return null;
    if (typeof parsed.userMsg !== "string" || typeof parsed.response !== "string") return null;
    return {
      userMsg:  parsed.userMsg.slice(0, 240).trim(),
      response: parsed.response.slice(0, 900).trim(),
    };
  } catch {
    return null;
  }
}

// ─── Judge — is this variant a Gabriella-voice pass ────────────────────────
async function judgeVoice(variant) {
  const prompt = `Evaluate whether this response sounds like Gabriella (a specific AI character) or like a generic helpful AI.

Gabriella: direct, restrained, emotionally real, occasionally dry, occasionally warm, responds AT THE WEIGHT of the moment, doesn't perform, doesn't therapy-speak, no bullet points, no summary closings, never opens with "I".

Their message: "${variant.userMsg.slice(0, 300)}"
Her response: "${variant.response.slice(0, 500)}"

Return ONLY JSON:
{"verdict":"gabriella"|"generic","tell":"<one-clause reason>"}`;

  try {
    const result = await gated(() => withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens:  80,
        response_format: { type: "json_object" },
      }),
    ));
    const raw = (result.choices[0].message.content || "")
      .trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    return parsed.verdict === "gabriella";
  } catch {
    return false;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  GOV = new RateGovernor(args.maxRpm);

  let anchors = [...SEED_EXEMPLARS];
  if (args.category) anchors = anchors.filter(a => a.category === args.category);
  if (args.limit && args.limit > 0) anchors = anchors.slice(0, args.limit);

  console.log(`expand-seeds: ${anchors.length} anchors × ${args.variants} variants = ${anchors.length * args.variants} generations`);
  console.log(`  rate:     ${args.maxRpm} calls/min`);
  console.log(`  pool:     ${poolSize()} keys`);
  console.log(`  output:   ${OUT_PATH}`);
  console.log("");

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  // Append mode — resume-safe if you re-run with different categories.
  const outStream = fs.createWriteStream(OUT_PATH, { flags: "a" });

  let totalGen = 0;
  let totalKept = 0;
  let totalHeuristicFail = 0;
  let totalJudgeFail = 0;
  let totalErrors = 0;
  const byCategory = {};

  for (const anchor of anchors) {
    for (let v = 0; v < args.variants; v++) {
      totalGen++;
      process.stdout.write(`\r  [${totalGen}/${anchors.length * args.variants}] ${anchor.category} ${anchor.userMsg.slice(0, 30)}…  `);

      const variant = await generateVariant(anchor);
      if (!variant) { totalErrors++; continue; }

      // Heuristic gate — same one the gauntlet uses.
      const h = heuristicCheck(variant.response);
      if (!h.authentic) { totalHeuristicFail++; continue; }

      // Judge gate — sounds like her, not like generic AI?
      const ok = await judgeVoice(variant);
      if (!ok) { totalJudgeFail++; continue; }

      const record = {
        category: anchor.category,
        userMsg:  variant.userMsg,
        response: variant.response,
        anchorId: anchor.userMsg,
        generatedAt: Date.now(),
      };
      outStream.write(JSON.stringify(record) + "\n");
      totalKept++;
      byCategory[anchor.category] = (byCategory[anchor.category] || 0) + 1;
    }
  }
  outStream.end();

  console.log(`\n\n─── SUMMARY ───`);
  console.log(`  generated:       ${totalGen}`);
  console.log(`  kept:            ${totalKept}`);
  console.log(`  heuristic fail:  ${totalHeuristicFail}`);
  console.log(`  judge fail:      ${totalJudgeFail}`);
  console.log(`  errors:          ${totalErrors}`);
  console.log(`  keep rate:       ${((totalKept / Math.max(1, totalGen)) * 100).toFixed(1)}%`);
  console.log(`\n  per-category kept:`);
  for (const [cat, n] of Object.entries(byCategory).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${cat}: ${n}`);
  }
  console.log(`\n  output appended to: ${OUT_PATH}`);
  console.log(`  to merge into seedExemplars.js: review the file, then hand-curate the best N into the static export.`);
}

main().catch(err => { console.error(err); process.exit(1); });
