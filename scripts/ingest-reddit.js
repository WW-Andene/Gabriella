// scripts/ingest-reddit.js
//
// Two-phase pipeline for curated internet-aware training data.
//
// Phase 1 — fetch + generate + tier:
//   npm run ingest-reddit
//   (reads URLs from training-data/seed-threads.txt or --urls flag)
//
//   For every URL:
//     - fetch thread, parse into exchanges
//     - generate Gabriella's response to each exchange (Maverick as teacher)
//     - score + tier each pair (auto / review / drop)
//
//   Writes:
//     training-data/reddit-auto-cot.jsonl         — auto-accepted, final
//     training-data/reddit-review-cot.md          — pending human review
//     training-data/reddit-drops.json             — what was dropped + why
//
// Phase 2 — you review:
//   Open training-data/reddit-review-cot.md in the Codespace editor (or
//   any text editor). For each pair you want to keep, leave the block
//   in place. For each pair you want to reject, delete its entire block
//   (header line down to just before the next header line). Save.
//
// Phase 3 — finalize:
//   npm run ingest-reddit -- --finalize
//   Merges approved review pairs with the auto-accepted pairs into:
//     training-data/reddit-final-cot.jsonl
//
// Phase 4 — push to Fireworks:
//   npm run ingest-reddit -- --finalize --push
//   Uploads the final JSONL to Fireworks + archives to Upstash.
//
// Env:
//   GROQ_API_KEY (+ GROQ_API_KEY_2..10 for parallelism)
//   UPSTASH_REDIS_REST_URL / TOKEN          (only for --push)
//   FIREWORKS_API_KEY / FIREWORKS_ACCOUNT_ID (only for --push)

import fs   from "fs";
import path from "path";
import { Redis } from "@upstash/redis";

import { extractExchanges } from "../lib/gabriella/reddit.js";
import {
  processBatch,
  formatReviewFile,
  parseReviewFile,
} from "../lib/gabriella/ingest.js";
import { archiveToUpstash, uploadToFireworks } from "../lib/gabriella/learning.js";
import { poolSize } from "../lib/gabriella/groqPool.js";

const OUTPUT_DIR      = "./training-data";
const SEED_FILE       = "./seed-threads.txt";                // tracked in git
const AUTO_FILE       = path.join(OUTPUT_DIR, "reddit-auto-cot.jsonl");
const REVIEW_FILE     = path.join(OUTPUT_DIR, "reddit-review-cot.md");
const DROPS_FILE      = path.join(OUTPUT_DIR, "reddit-drops.json");
const FINAL_FILE      = path.join(OUTPUT_DIR, "reddit-final-cot.jsonl");

// ─── Args ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    finalize:    false,
    push:        false,
    urls:        [],
    concurrency: null,
    maxPerThread: null,
    limit:       null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--finalize")    args.finalize = true;
    else if (a === "--push")   args.push = true;
    else if (a === "--urls"    && argv[i + 1]) { args.urls = String(argv[++i]).split(",").map(s => s.trim()).filter(Boolean); }
    else if (a === "--concurrency"  && argv[i + 1]) args.concurrency  = Number(argv[++i]);
    else if (a === "--max-per-thread" && argv[i + 1]) args.maxPerThread = Number(argv[++i]);
    else if (a === "--limit"   && argv[i + 1]) args.limit = Number(argv[++i]);
  }
  return args;
}

function ensureDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ─── Load URLs ──────────────────────────────────────────────────────────────

function loadUrls(args) {
  if (args.urls.length > 0) return args.urls;
  if (!fs.existsSync(SEED_FILE)) {
    console.error(`No URLs provided, and ${SEED_FILE} does not exist.`);
    console.error(`Create it with one Reddit thread URL per line, or pass --urls "url1,url2".`);
    process.exit(1);
  }
  const lines = fs.readFileSync(SEED_FILE, "utf-8").split(/\r?\n/);
  return lines
    .map(l => l.replace(/^\s*#.*$/, "").trim())
    .filter(l => l.length > 0 && l.startsWith("http"));
}

// ─── Finalize phase ─────────────────────────────────────────────────────────
// Merges reviewed pairs with auto-accepted pairs into the final JSONL.

async function finalize(args) {
  if (!fs.existsSync(AUTO_FILE)) {
    console.error(`Missing ${AUTO_FILE}. Run the ingest phase first (no --finalize).`);
    process.exit(1);
  }

  const autoLines = fs.readFileSync(AUTO_FILE, "utf-8").split(/\r?\n/).filter(Boolean);
  const autoPairs = autoLines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  let reviewPairs = [];
  if (fs.existsSync(REVIEW_FILE)) {
    const reviewText = fs.readFileSync(REVIEW_FILE, "utf-8");
    reviewPairs = parseReviewFile(reviewText);
  }

  const all = [...autoPairs, ...reviewPairs];
  if (all.length === 0) {
    console.error("Finalize: no pairs found in auto + review. Nothing to write.");
    process.exit(1);
  }

  const jsonl = all.map(p => {
    const { _meta, ...pure } = p;
    return JSON.stringify(pure);
  }).join("\n");

  fs.writeFileSync(FINAL_FILE, jsonl, "utf-8");

  console.log(`Finalize summary:`);
  console.log(`  auto-accepted:   ${autoPairs.length}`);
  console.log(`  review-approved: ${reviewPairs.length}`);
  console.log(`  final total:     ${all.length}`);
  console.log(`  written:         ${FINAL_FILE} (${jsonl.length} bytes)`);

  if (!args.push) {
    console.log(`\nTo upload to Fireworks: re-run with --finalize --push`);
    return;
  }

  // ─── --push: upload to Fireworks + archive to Upstash ─────────────────────
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.log(`\n--push requested but Upstash Redis env not set. Skipping upload.`);
    return;
  }

  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  const USER_ID = "user_default";
  const filename = `gabriella-reddit-${new Date().toISOString().slice(0, 10)}.jsonl`;

  console.log(`\nUploading as ${filename}...`);

  try {
    const archive = await archiveToUpstash(redis, USER_ID, jsonl, { kind: "reddit", filename });
    console.log(`  ✓ Upstash archive: ${archive.key}`);
  } catch (err) {
    console.log(`  ✗ Upstash archive failed: ${err.message}`);
  }

  if (process.env.FIREWORKS_API_KEY && process.env.FIREWORKS_ACCOUNT_ID) {
    try {
      const fw = await uploadToFireworks(jsonl, process.env.FIREWORKS_API_KEY, {
        filename,
        accountId: process.env.FIREWORKS_ACCOUNT_ID,
      });
      console.log(`  ✓ Fireworks upload — dataset: ${fw.datasetId} (${fw.bytes} bytes)`);
    } catch (err) {
      console.log(`  ✗ Fireworks upload failed: ${err.message}`);
    }
  } else {
    console.log(`  (Fireworks skipped — FIREWORKS_API_KEY + FIREWORKS_ACCOUNT_ID not set)`);
  }
}

// ─── Ingest phase ───────────────────────────────────────────────────────────

async function ingest(args) {
  ensureDir();

  const urls = loadUrls(args);
  if (urls.length === 0) {
    console.error("No URLs to process.");
    process.exit(1);
  }

  const concurrency = args.concurrency || Math.min(5, Math.max(1, poolSize() || 1));
  const maxPerThread = args.maxPerThread || 3;

  console.log(`Reddit ingest`);
  console.log(`  URLs:             ${urls.length}`);
  console.log(`  pool size:        ${poolSize()}`);
  console.log(`  concurrency:      ${concurrency}`);
  console.log(`  max exchanges:    ${maxPerThread} per thread`);
  console.log(``);

  // Step 1: fetch all threads, extract exchanges.
  const allExchanges = [];
  const threadErrors = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const { post, exchanges, skippedReason } = await extractExchanges(url, {
        maxExchangesPerThread: maxPerThread,
      });
      if (skippedReason) {
        console.log(`  [${i + 1}/${urls.length}] skipped ${post.subreddit ? `r/${post.subreddit}` : url} — ${skippedReason}`);
      } else {
        console.log(`  [${i + 1}/${urls.length}] r/${post.subreddit} "${post.title.slice(0, 60)}" — ${exchanges.length} exchanges`);
        allExchanges.push(...exchanges);
      }
    } catch (err) {
      console.log(`  [${i + 1}/${urls.length}] ✗ ${url} — ${err.message}`);
      threadErrors.push({ url, error: err.message });
    }
  }

  if (args.limit && args.limit > 0) {
    allExchanges.splice(args.limit);
    console.log(`\n  (limited to first ${args.limit} exchanges)`);
  }

  if (allExchanges.length === 0) {
    console.log(`\nNo exchanges extracted.`);
    process.exit(1);
  }

  console.log(``);
  console.log(`Exchanges to process: ${allExchanges.length}`);
  console.log(``);

  // Step 2: generate + score + tier.
  const results = await processBatch(allExchanges, {
    concurrency,
    onProgress: (r, done, total) => {
      if (r.tier === "drop") {
        console.log(`  [${done}/${total}] ⊘ ${r.exchange.exchangeId} — ${r.reason}`);
      } else if (r.tier === "auto") {
        console.log(`  [${done}/${total}] ✓ ${r.exchange.exchangeId} (auto) — voice=${r.score.voice} fit=${r.score.fit}`);
      } else {
        console.log(`  [${done}/${total}] ? ${r.exchange.exchangeId} (review) — voice=${r.score.voice} fit=${r.score.fit}`);
      }
    },
  });

  // Step 3: split into tiers + write.
  const auto   = results.filter(r => r.tier === "auto"   && r.example);
  const review = results.filter(r => r.tier === "review" && r.example);
  const drops  = results.filter(r => r.tier === "drop");

  const autoJsonl = auto.map(r => {
    const { _meta, ...pure } = r.example;
    return JSON.stringify(pure);
  }).join("\n");
  fs.writeFileSync(AUTO_FILE, autoJsonl, "utf-8");

  const reviewText = formatReviewFile(review);
  fs.writeFileSync(REVIEW_FILE, reviewText, "utf-8");

  const dropSummary = drops.map(d => ({
    exchangeId: d.exchange?.exchangeId || "unknown",
    reason:     d.reason,
  }));
  fs.writeFileSync(DROPS_FILE, JSON.stringify({ drops: dropSummary, threadErrors }, null, 2), "utf-8");

  console.log(``);
  console.log(`Summary`);
  console.log(`  auto-accepted:   ${auto.length}     → ${AUTO_FILE}`);
  console.log(`  for review:      ${review.length}   → ${REVIEW_FILE}`);
  console.log(`  dropped:         ${drops.length}`);
  console.log(`  thread errors:   ${threadErrors.length}`);
  console.log(``);
  console.log(`Next:`);
  console.log(`  1. Open ${REVIEW_FILE} in your editor.`);
  console.log(`  2. Delete any review-blocks you don't want (leave the ones you do).`);
  console.log(`  3. Run: npm run ingest-reddit -- --finalize`);
  console.log(`  4. Or with upload: npm run ingest-reddit -- --finalize --push`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.finalize) {
    await finalize(args);
  } else {
    await ingest(args);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
