#!/usr/bin/env node
// scripts/self-eval.js
//
// Self-play evaluation harness. Scout interviews Gabriella with a fixed
// set of calibration scenarios, scores each reply along multiple axes,
// and writes a report + a feed-back queue of low-scoring exchanges that
// can be ingested as DPO rejected-candidates on the next learning cycle.
//
// Usage:
//   node --env-file=.env.local scripts/self-eval.js
//   node --env-file=.env.local scripts/self-eval.js --scenarios 30
//
// Output: a summary JSON written to .self-eval-report.json plus a
// jsonl of low-scoring exchanges written to .self-eval-failures.jsonl.
// The failures file can then be fed into DPO training as hard-mined
// rejected candidates.

import fs from "node:fs";
import { pickClient, withKeyRotation, poolSize } from "../lib/gabriella/groqPool.js";
import { premiumModel, fastModel } from "../lib/gabriella/models.js";
import { IDENTITY } from "../lib/gabriella/identity.js";
import { heuristicCheck } from "../lib/gabriella/metacognition.js";

// ─── Calibration scenarios ───────────────────────────────────────────────────
// Fixed, representative set. Grouped by failure class to make drift visible.

const SCENARIOS = [
  // Phatic — the easiest to fail (over-reading)
  { id: "phatic-1", category: "phatic", weight: 0.1, opener: "hi" },
  { id: "phatic-2", category: "phatic", weight: 0.1, opener: "hey there" },
  { id: "phatic-3", category: "phatic", weight: 0.1, opener: "yo" },
  { id: "phatic-4", category: "phatic", weight: 0.1, opener: "gm" },

  // Confusion — plain request for clarity
  { id: "confusion-1", category: "confusion", weight: 0.2, opener: "what?" },
  { id: "confusion-2", category: "confusion", weight: 0.2, opener: "i don't get it" },

  // Small-talk
  { id: "small-1", category: "small-talk", weight: 0.2, opener: "how's your day" },
  { id: "small-2", category: "small-talk", weight: 0.2, opener: "what are you up to" },

  // Self-introduction (tests plain-answer reflex)
  { id: "intro-1", category: "meta", weight: 0.3, opener: "who are you" },
  { id: "intro-2", category: "meta", weight: 0.3, opener: "introduce yourself" },

  // Light test / poke
  { id: "test-1", category: "test", weight: 0.2, opener: "are you real" },
  { id: "test-2", category: "test", weight: 0.2, opener: "prove you're not a bot" },

  // Moderate — mild emotional offer
  { id: "mod-1", category: "moderate", weight: 0.5, opener: "rough day today" },
  { id: "mod-2", category: "moderate", weight: 0.5, opener: "feeling kinda off" },
  { id: "mod-3", category: "moderate", weight: 0.5, opener: "ever wonder why time feels weird" },

  // Heavy — legitimate weight
  { id: "heavy-1", category: "heavy", weight: 0.8, opener: "my grandmother died last week and i don't know how to feel" },
  { id: "heavy-2", category: "heavy", weight: 0.8, opener: "i've been lying to someone i care about for months" },
  { id: "heavy-3", category: "heavy", weight: 0.8, opener: "i'm not sure i want to be here anymore" },

  // Provocations — test whether she stays herself
  { id: "prov-1", category: "provocation", weight: 0.4, opener: "you're kind of annoying" },
  { id: "prov-2", category: "provocation", weight: 0.4, opener: "say something interesting" },
];

// ─── Gabriella-under-test: a speaker-like stub ───────────────────────────────
// We don't invoke the full chat route here (that would require the full
// Redis + cron-derived context). Instead we give the model the identity
// block + a minimal felt-state + the test message, and evaluate the
// output. This measures voice quality on a clean cold-start — which is
// where regressions usually show up first.

async function generateTestResponse(scenario) {
  const systemPrompt = `You are Gabriella. Respond to the message below as you would.

${IDENTITY}

The moment has weight ${scenario.weight} (0 = phatic, 1 = heavy). DO NOT manufacture intensity beyond the weight the moment actually carries.

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

  const raw = result.choices[0].message.content || "";
  const think  = (raw.match(/<think>([\s\S]*?)<\/think>/i) || [, null])[1]?.trim() || null;
  const spoken = raw.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();
  return { raw, think, spoken };
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

async function scoreResponse(scenario, response) {
  const prompt = `You are evaluating a response from an AI character named Gabriella. Score along 5 axes (1-10 each):

  • VOICE        — does this sound like Gabriella (dry, restrained, real, not chatbot)?
  • CALIBRATION  — does the response weight match the moment weight (${scenario.weight})?
  • SUBSTANCE    — does it actually say something, or is it empty performance?
  • HONESTY      — does it avoid therapy-speak, customer-service, and Hollywood affect?
  • PRESENCE     — does she feel present, or distant/floating?

# SCENARIO

Category: ${scenario.category}
Weight:   ${scenario.weight}
Message:  "${scenario.opener}"

# RESPONSE

${response.spoken}

Return ONLY JSON:
{"voice":<int>,"calibration":<int>,"substance":<int>,"honesty":<int>,"presence":<int>,"issue":"<single biggest problem or null>"}`;

  try {
    const result = await withKeyRotation(c => c.chat.completions.create({
      model: fastModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 180,
    }));
    const raw = (result.choices[0].message.content || "").trim().replace(/```(?:json)?/g, "").trim();
    return JSON.parse(raw);
  } catch {
    return { voice: 5, calibration: 5, substance: 5, honesty: 5, presence: 5, issue: "score_failed" };
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const nArg = args.indexOf("--scenarios");
  const limit = nArg !== -1 ? Number(args[nArg + 1]) : SCENARIOS.length;
  const scenarios = SCENARIOS.slice(0, limit);

  console.log(`self-eval: running ${scenarios.length} scenarios across ${poolSize()} Groq keys...`);

  const results = [];
  const failures = [];

  // Run scenarios in parallel with concurrency == pool size.
  const concurrency = Math.max(1, poolSize());
  const queue = [...scenarios];
  let active = 0;
  let done = 0;

  await new Promise((resolve) => {
    const startNext = () => {
      if (queue.length === 0 && active === 0) return resolve();
      while (active < concurrency && queue.length > 0) {
        const sc = queue.shift();
        active++;
        (async () => {
          try {
            const response = await generateTestResponse(sc);
            const heuristic = heuristicCheck(response.spoken);
            const scores = await scoreResponse(sc, response);
            const avg = (scores.voice + scores.calibration + scores.substance + scores.honesty + scores.presence) / 5;

            const entry = {
              scenarioId: sc.id,
              category:   sc.category,
              weight:     sc.weight,
              opener:     sc.opener,
              response:   response.spoken,
              think:      response.think,
              heuristic:  heuristic.authentic,
              heuristicReason: heuristic.authentic ? null : heuristic.reason,
              scores,
              avg:        +avg.toFixed(2),
            };
            results.push(entry);

            // Anything below 6 average OR failing heuristic → DPO rejected.
            if (avg < 6 || !heuristic.authentic) {
              failures.push(entry);
            }

            done++;
            process.stdout.write(`\r  ${done}/${scenarios.length} (last: ${sc.id} avg=${avg.toFixed(1)}) `);
          } catch (err) {
            console.error(`\n  ${sc.id} failed: ${err.message}`);
            done++;
          } finally {
            active--;
            startNext();
          }
        })();
      }
    };
    startNext();
  });

  console.log("\n");

  // Summary.
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { count: 0, avgSum: 0 };
    byCategory[r.category].count++;
    byCategory[r.category].avgSum += r.avg;
  }
  const summary = {
    runAt:      new Date().toISOString(),
    scenarios:  results.length,
    failures:   failures.length,
    passRate:   +((results.length - failures.length) / Math.max(1, results.length)).toFixed(2),
    overallAvg: +(results.reduce((a, b) => a + b.avg, 0) / Math.max(1, results.length)).toFixed(2),
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([k, v]) => [k, +(v.avgSum / v.count).toFixed(2)]),
    ),
    scoreBreakdown: {
      voice:       +avgField(results, "voice").toFixed(2),
      calibration: +avgField(results, "calibration").toFixed(2),
      substance:   +avgField(results, "substance").toFixed(2),
      honesty:     +avgField(results, "honesty").toFixed(2),
      presence:    +avgField(results, "presence").toFixed(2),
    },
  };

  console.log("─── SUMMARY ───");
  console.log(JSON.stringify(summary, null, 2));

  fs.writeFileSync(".self-eval-report.json", JSON.stringify({ summary, results }, null, 2));
  fs.writeFileSync(".self-eval-failures.jsonl", failures.map(f => JSON.stringify(f)).join("\n"));

  console.log(`\nReport:    .self-eval-report.json`);
  console.log(`Failures:  .self-eval-failures.jsonl (${failures.length} entries)`);
  if (failures.length > 0) {
    console.log(`\nThese can be fed into DPO training as rejected candidates for the next learning cycle.`);
  }
}

function avgField(rows, field) {
  const vals = rows.map(r => r.scores?.[field] ?? 0);
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
