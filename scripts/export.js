// scripts/export.js
// Fine-tuning data export pipeline (CLI).
//
// Run manually:   npm run export-training
//
// Writes two files to ./training-data/ :
//   • training-standard.jsonl   — plain system + user + assistant format
//   • training-cot.jsonl        — chain-of-thought format with the
//                                 felt-state serialized into a <think>
//                                 block before the response
//
// All formatting / filtering / validation logic lives in
// lib/gabriella/learning.js — both this CLI and the scheduled /api/learn
// endpoint share the same producer so exports are identical regardless
// of where they were triggered.

import { Redis } from "@upstash/redis";
import fs from "fs";
import path from "path";
import { buildLearningBundle, pushLearningBundle } from "../lib/gabriella/learning.js";

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const USER_ID    = "user_default";
const OUTPUT_DIR = "./training-data";

async function main() {
  const args      = new Set(process.argv.slice(2));
  const doUpload  = args.has("--push") || args.has("--upload");

  console.log("Reading training log from Redis...");

  const bundle = await buildLearningBundle(redis, USER_ID);
  const { stats, standardJsonl, cotJsonl } = bundle;

  console.log(`Logged:      ${stats.totalLogged}`);
  console.log(`Valid:       ${stats.valid} / ${stats.considered}`);
  console.log(`Standard:    ${stats.standardCount}`);
  console.log(`CoT:         ${stats.cotCount}`);

  if (stats.cotCount === 0) {
    console.log("\nNo valid examples yet. Have some conversations first.");
    return;
  }

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const standardPath = path.join(OUTPUT_DIR, "training-standard.jsonl");
  const cotPath      = path.join(OUTPUT_DIR, "training-cot.jsonl");

  fs.writeFileSync(standardPath, standardJsonl, "utf-8");
  fs.writeFileSync(cotPath,      cotJsonl,      "utf-8");

  console.log(`\nWritten:`);
  console.log(`  ${standardPath}`);
  console.log(`  ${cotPath}`);

  if (doUpload) {
    console.log("\nPushing to configured provider(s)...");
    const result = await pushLearningBundle(redis, USER_ID, { minExamples: 1 });
    if (result.pushed) {
      for (const u of result.uploads) {
        console.log(`  ✓ ${u.provider} — ${u.fileId || u.key || u.url} (${u.bytes} bytes)`);
      }
    } else {
      console.log(`  Skipped: ${result.reason || "no provider configured"}`);
    }
    for (const e of result.errors || []) {
      console.log(`  ✗ ${e.provider}: ${e.error}`);
    }
  } else {
    console.log("\nNext: upload the CoT file to your fine-tune provider.");
    console.log("  Together:   together files upload training-data/training-cot.jsonl");
    console.log("  Fireworks:  firectl create dataset training-data/training-cot.jsonl");
    console.log("\nOr run with --push to upload automatically via the same");
    console.log("pipeline /api/learn uses (requires TOGETHER_API_KEY or");
    console.log("FIREWORKS_API_KEY or LEARNING_WEBHOOK_URL in env).");
  }

  console.log(`\nRecommended minimum before fine-tuning: 50 examples.`);
  console.log(`Current: ${stats.cotCount}. ${stats.cotCount < 50 ? `Need ${50 - stats.cotCount} more.` : "Ready."}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
