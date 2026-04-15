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
import { archiveToUpstash, uploadToFireworks, savePendingJob, recordLearningEvent } from "../lib/gabriella/learning.js";
import { createSftJob, fireworksConfig } from "../lib/gabriella/fireworks.js";
import { loadFinetuneConfig, applyOverrides } from "../lib/gabriella/finetuneConfig.js";
import { poolSize } from "../lib/gabriella/groqPool.js";

const OUTPUT_DIR = "./training-data";
const OUTPUT_FILE = "bootstrap-cot.jsonl";
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILE);

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    push: false, scenarios: null, category: null, concurrency: null,
    finetune: false,
    // null = use loaded finetune config (env/upstash/default). Only set when
    // explicitly overridden via CLI flag.
    epochs: null, loraRank: null, learningRate: null, baseModel: null, batchSize: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--push" || a === "--upload") args.push = true;
    else if (a === "--finetune" || a === "--sft") args.finetune = true;
    else if (a === "--scenarios"   && argv[i + 1]) { args.scenarios    = Number(argv[++i]); }
    else if (a === "--category"    && argv[i + 1]) { args.category     = String(argv[++i]); }
    else if (a === "--concurrency" && argv[i + 1]) { args.concurrency  = Number(argv[++i]); }
    else if (a === "--epochs"      && argv[i + 1]) { args.epochs       = Number(argv[++i]); }
    else if (a === "--lora-rank"   && argv[i + 1]) { args.loraRank     = Number(argv[++i]); }
    else if (a === "--lr"          && argv[i + 1]) { args.learningRate = Number(argv[++i]); }
    else if (a === "--base-model"  && argv[i + 1]) { args.baseModel    = String(argv[++i]); }
    else if (a === "--batch-size"  && argv[i + 1]) { args.batchSize    = Number(argv[++i]); }
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
  let fwDatasetId = null;
  if (process.env.FIREWORKS_API_KEY && process.env.FIREWORKS_ACCOUNT_ID) {
    try {
      const fw = await uploadToFireworks(jsonl, process.env.FIREWORKS_API_KEY, {
        filename,
        accountId: process.env.FIREWORKS_ACCOUNT_ID,
      });
      fwDatasetId = fw.datasetId;
      console.log(`  ✓ Fireworks upload — dataset: ${fw.datasetId} via ${fw.flow || "?"} (${fw.bytes} bytes)`);
    } catch (err) {
      console.log(`  ✗ Fireworks upload failed`);
      console.log(``);
      for (const line of (err.message || String(err)).split("\n")) {
        console.log(`    ${line}`);
      }
      console.log(``);
      console.log(`    Note: your training data is preserved in the Upstash archive above.`);
      console.log(`    Once credentials / accountId are correct, re-run with --push`);
      console.log(`    to upload it without regenerating.`);
    }
  } else {
    console.log(`  (Fireworks skipped — FIREWORKS_API_KEY + FIREWORKS_ACCOUNT_ID not set)`);
  }

  // ─── Optional: also launch SFT ──────────────────────────────────────────
  // With --finetune, immediately kick off a fine-tune on the dataset we
  // just uploaded. The /api/learn/watch cron will then deploy + activate
  // the resulting model when training completes.
  if (args.finetune && fwDatasetId) {
    console.log(``);
    console.log(`Launching SFT job on ${fwDatasetId}...`);
    const cfg = fireworksConfig();
    try {
      // Load the full finetune config (defaults ← env ← upstash overrides),
      // then apply any CLI flag overrides for this invocation.
      const base = await loadFinetuneConfig(redis);
      const { config: ft, sources } = applyOverrides(base, {
        epochs:       args.epochs,
        loraRank:     args.loraRank,
        learningRate: args.learningRate,
        baseModel:    args.baseModel,
        batchSize:    args.batchSize,
      });

      const displayName = `${ft.displayNamePrefix}-${new Date().toISOString().slice(0, 10)}-${fwDatasetId.slice(-8)}`;
      const job = await createSftJob({
        apiKey:       cfg.apiKey,
        accountId:    cfg.accountId,
        datasetId:    fwDatasetId,
        baseModel:    ft.baseModel,
        epochs:       ft.epochs,
        loraRank:     ft.loraRank,
        learningRate: ft.learningRate,
        batchSize:    ft.batchSize,
        displayName,
      });
      console.log(`  ✓ SFT job launched: ${job.jobId}`);
      console.log(`    state:       ${job.state}`);
      console.log(`    baseModel:   ${ft.baseModel}  (${sources.baseModel})`);
      console.log(`    epochs:      ${ft.epochs}  (${sources.epochs})`);
      console.log(`    loraRank:    ${ft.loraRank}  (${sources.loraRank})`);
      console.log(`    learningRate:${ft.learningRate}  (${sources.learningRate})`);
      if (ft.batchSize) console.log(`    batchSize:   ${ft.batchSize}  (${sources.batchSize})`);

      // Save to Redis so /api/learn/watch picks it up on the next hourly run.
      const pending = {
        jobId:       job.jobId,
        jobName:     job.jobName,
        displayName,
        datasetId:   fwDatasetId,
        createdAt:   Date.now(),
        state:       job.state || "PENDING",
        baseModel:   cfg.baseModel,
      };
      await Promise.all([
        savePendingJob(redis, USER_ID, pending),
        recordLearningEvent(redis, USER_ID, {
          kind:      "sft-launched-bootstrap",
          jobId:     job.jobId,
          displayName,
          datasetId: fwDatasetId,
          baseModel: cfg.baseModel,
        }),
      ]);

      console.log(``);
      console.log(`  Training runs on Fireworks servers (~1-2 hours).`);
      console.log(`  The hourly /api/learn/watch cron polls the job and will`);
      console.log(`  auto-deploy + activate the fine-tune when it completes.`);
    } catch (err) {
      console.log(`  ✗ SFT launch failed`);
      console.log(``);
      for (const line of (err.message || String(err)).split("\n")) {
        console.log(`    ${line}`);
      }
      console.log(``);
      console.log(`    Dataset is still uploaded — you can launch SFT manually later`);
      console.log(`    via /api/fireworks/finetune?key=<SECRET>&launch=1`);
    }
  } else if (args.finetune && !fwDatasetId) {
    console.log(``);
    console.log(`  (SFT skipped — dataset wasn't uploaded to Fireworks)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
