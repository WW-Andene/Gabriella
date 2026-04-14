// scripts/bootstrap-training.js
// Generate synthetic Gabriella training data using Scout as teacher.
//
// Usage:
//   npm run bootstrap-training
//   npm run bootstrap-training -- --push                  # also upload via /api/learn infra
//   npm run bootstrap-training -- --scenarios 10          # limit to first 10 for a test run
//   npm run bootstrap-training -- --category phatic       # only one category
//   npm run bootstrap-training -- --concurrency 5         # match to your pool size
//
// Writes to training-data/bootstrap-cot.jsonl in the same CoT format the
// existing learning pipeline uses. That file can be uploaded to Fireworks
// via the --push flag or by hitting /api/learn manually.
//
// Env:
//   GROQ_API_KEY (+ GROQ_API_KEY_2...10 for parallelism)
//   UPSTASH_REDIS_REST_URL  / UPSTASH_REDIS_REST_TOKEN   (only if --push)
//   FIREWORKS_API_KEY / FIREWORKS_ACCOUNT_ID             (only if --push)

import fs from "fs";
import path from "path";
import { Redis } from "@upstash/redis";
import { SCENARIOS, CATEGORIES } from "../lib/gabriella/bootstrap-scenarios.js";
import { generateBatch } from "../lib/gabriella/bootstrap.js";
import { archiveToUpstash, uploadToFireworks } from "../lib/gabriella/learning.js";
import { poolSize } from "../lib/gabriella/groqPool.js";

const OUTPUT_DIR = "./training-data";
const OUTPUT_FILE = "bootstrap-cot.jsonl";
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILE);

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { push: false, scenarios: null, category: null, concurrency: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--push" || a === "--upload") args.push = true;
    else if (a === "--scenarios" && argv[i + 1]) { args.scenarios = Number(argv[++i]); }
    else if (a === "--category"  && argv[i + 1]) { args.category  = String(argv[++i]); }
    else if (a === "--concurrency" && argv[i + 1]) { args.concurrency = Number(argv[++i]); }
  }
  return args;
}

// ─── Filter scenarios based on args ──────────────────────────────────────────

function filterScenarios(all, args) {
  let out = all;
  if (args.category) {
    if (!CATEGORIES.includes(args.category)) {
      console.error(`Unknown category: ${args.category}. Known: ${CATEGORIES.join(", ")}`);
      process.exit(1);
    }
    out = out.filter(s => s.category === args.category);
  }
  if (args.scenarios && args.scenarios > 0) {
    out = out.slice(0, args.scenarios);
  }
  return out;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = filterScenarios(SCENARIOS, args);

  if (scenarios.length === 0) {
    console.error("No scenarios selected.");
    process.exit(1);
  }

  // Default concurrency = number of configured Groq keys (up to 5 cap).
  const concurrency = args.concurrency || Math.min(5, Math.max(1, poolSize() || 1));

  console.log(`Bootstrap generation`);
  console.log(`  scenarios:   ${scenarios.length}${args.category ? ` (category: ${args.category})` : ""}`);
  console.log(`  pool size:   ${poolSize()}`);
  console.log(`  concurrency: ${concurrency}`);
  console.log(`  output:      ${OUTPUT_PATH}`);
  console.log(``);

  const start = Date.now();
  const results = await generateBatch(scenarios, {
    concurrency,
    onProgress: (r, done, total) => {
      if (r.error) {
        console.log(`  [${done}/${total}] ✗ ${r.scenarioId} — ${r.error}`);
      } else {
        console.log(`  [${done}/${total}] ✓ ${r.scenarioId} (${r.category}) — kept ${r.kept}/${r.generated} turns`);
      }
    },
  });

  const allExamples = results.flatMap(r => r.examples || []);
  const totalKept = allExamples.length;
  const totalDropped = results.reduce((s, r) => s + (r.dropped || 0), 0);
  const totalFailed = results.filter(r => r.error).length;

  console.log(``);
  console.log(`Summary`);
  console.log(`  scenarios completed: ${results.length - totalFailed}/${results.length}`);
  console.log(`  scenarios failed:    ${totalFailed}`);
  console.log(`  training examples:   ${totalKept} kept, ${totalDropped} dropped`);
  console.log(`  elapsed:             ${((Date.now() - start) / 1000).toFixed(1)}s`);

  if (totalKept === 0) {
    console.log(`\nNothing to write. Aborting.`);
    process.exit(1);
  }

  // Write to disk.
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const jsonl = allExamples.map(e => {
    // Drop the _meta field — training providers don't want it.
    const { _meta, ...pure } = e;
    return JSON.stringify(pure);
  }).join("\n");
  fs.writeFileSync(OUTPUT_PATH, jsonl, "utf-8");
  console.log(`\nWritten: ${OUTPUT_PATH} (${jsonl.length} bytes)`);

  // Also emit a per-scenario breakdown for inspection.
  const breakdownPath = path.join(OUTPUT_DIR, "bootstrap-breakdown.json");
  const breakdown = results.map(r => ({
    scenarioId: r.scenarioId,
    category:   r.category,
    generated:  r.generated || 0,
    kept:       r.kept || 0,
    dropped:    r.dropped || 0,
    error:      r.error || null,
  }));
  fs.writeFileSync(breakdownPath, JSON.stringify(breakdown, null, 2), "utf-8");
  console.log(`Breakdown: ${breakdownPath}`);

  if (!args.push) {
    console.log(`\nNext: upload the bundle to your fine-tune provider, or re-run with --push to use the /api/learn pipeline.`);
    return;
  }

  // ─── Push to Fireworks + archive to Upstash ──────────────────────────────

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.log(`\n--push requested but Upstash Redis is not configured. Skipping upload.`);
    return;
  }

  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  const USER_ID = "user_default";
  const filename = `gabriella-bootstrap-${new Date().toISOString().slice(0, 10)}.jsonl`;

  console.log(`\nUploading bundle as ${filename}...`);

  // Always archive.
  try {
    const archive = await archiveToUpstash(redis, USER_ID, jsonl, {
      kind:     "bootstrap",
      filename,
    });
    console.log(`  ✓ Upstash archive: ${archive.key}`);
  } catch (err) {
    console.log(`  ✗ Upstash archive failed: ${err.message}`);
  }

  // Fireworks if configured.
  if (process.env.FIREWORKS_API_KEY && process.env.FIREWORKS_ACCOUNT_ID) {
    try {
      const fw = await uploadToFireworks(jsonl, process.env.FIREWORKS_API_KEY, {
        filename,
        accountId: process.env.FIREWORKS_ACCOUNT_ID,
      });
      console.log(`  ✓ Fireworks upload — dataset: ${fw.datasetId} (${fw.bytes} bytes)`);
      console.log(`\n  The dataset is now available on Fireworks. The next /api/learn run`);
      console.log(`  (or AUTO_FINETUNE pipeline) can kick off SFT against it.`);
    } catch (err) {
      console.log(`  ✗ Fireworks upload failed: ${err.message}`);
    }
  } else {
    console.log(`  (Fireworks skipped — FIREWORKS_API_KEY + FIREWORKS_ACCOUNT_ID not set)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
