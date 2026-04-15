#!/usr/bin/env node
// scripts/push-existing.js
//
// Push an existing training-data JSONL to Fireworks + Upstash WITHOUT
// regenerating. Use this when:
//   • Bootstrap generation already succeeded and wrote the JSONL
//   • Fireworks upload failed (wrong credentials, transient error, etc.)
//   • You've fixed the config and just want to retry the upload
//
// Usage:
//   npm run push-existing
//   npm run push-existing -- --file training-data/bootstrap-cot.jsonl

import fs from "fs";
import path from "path";
import { Redis } from "@upstash/redis";
import { archiveToUpstash, uploadToFireworks } from "../lib/gabriella/learning.js";

const DEFAULT_FILE = "training-data/bootstrap-cot.jsonl";

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--file" || a === "-f") && argv[i + 1]) args.file = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.file)) {
    console.error(`✗ File not found: ${args.file}`);
    console.error(`  Run 'npm run bootstrap-training' first to generate it.`);
    process.exit(1);
  }

  const jsonl = fs.readFileSync(args.file, "utf-8");
  const bytes = jsonl.length;
  const lines = jsonl.split("\n").filter(l => l.trim()).length;

  if (bytes === 0 || lines === 0) {
    console.error(`✗ File is empty: ${args.file}`);
    process.exit(1);
  }

  console.log(`Pushing ${args.file}`);
  console.log(`  size:     ${bytes} bytes`);
  console.log(`  examples: ${lines}`);
  console.log(``);

  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error(`✗ Upstash Redis is not configured. Check your .env.local`);
    process.exit(1);
  }

  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  const USER_ID = "user_default";
  const filename = `gabriella-bootstrap-${new Date().toISOString().slice(0, 10)}.jsonl`;

  // Always archive first — even if Fireworks fails, this is our safety net.
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
      console.log(`  ✓ Fireworks upload — dataset: ${fw.datasetId} via ${fw.flow || "?"}`);
      console.log(``);
      console.log(`  The dataset is now available on Fireworks.`);
      console.log(`  The next /api/learn run (or AUTO_FINETUNE pipeline) can kick off SFT.`);
    } catch (err) {
      console.log(`  ✗ Fireworks upload failed`);
      console.log(``);
      for (const line of (err.message || String(err)).split("\n")) {
        console.log(`    ${line}`);
      }
      console.log(``);
      console.log(`    Training data remains safe in the Upstash archive above.`);
    }
  } else {
    console.log(`  (Fireworks skipped — FIREWORKS_API_KEY + FIREWORKS_ACCOUNT_ID not set)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
