#!/usr/bin/env node
// scripts/fireworks-check.js
//
// Diagnostic for Fireworks credentials / account routing. Hits a few
// known-good endpoints with your current FIREWORKS_API_KEY and
// FIREWORKS_ACCOUNT_ID and reports where any mismatch is.
//
// Usage:
//   node --env-file=.env.local scripts/fireworks-check.js

const apiKey    = process.env.FIREWORKS_API_KEY;
const accountId = process.env.FIREWORKS_ACCOUNT_ID;

function red(s)    { return `\x1b[31m${s}\x1b[0m`; }
function green(s)  { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function dim(s)    { return `\x1b[2m${s}\x1b[0m`; }

function ok(m)   { console.log(green("✓"), m); }
function fail(m) { console.log(red("✗"), m); }
function warn(m) { console.log(yellow("!"), m); }
function info(m) { console.log(dim(m)); }

async function check() {
  console.log("─── Fireworks diagnostic ───");

  if (!apiKey) {
    fail("FIREWORKS_API_KEY not set in .env.local");
    process.exit(1);
  }
  ok(`FIREWORKS_API_KEY present (${apiKey.slice(0, 4)}…${apiKey.slice(-4)})`);

  if (!accountId) {
    fail("FIREWORKS_ACCOUNT_ID not set in .env.local");
    process.exit(1);
  }
  ok(`FIREWORKS_ACCOUNT_ID: ${accountId}`);

  console.log();
  console.log("─── Step 1: can the key hit /v1/accounts/{id}/models? ───");

  const modelsUrl = `https://api.fireworks.ai/v1/accounts/${accountId}/models`;
  info(`GET ${modelsUrl}`);
  const r1 = await fetch(modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const t1 = await r1.text();
  if (r1.ok) {
    ok(`Models endpoint reachable (${r1.status})`);
    try {
      const j = JSON.parse(t1);
      const count = Array.isArray(j.models) ? j.models.length : "?";
      info(`  found ${count} model(s) under account "${accountId}"`);
    } catch {}
  } else {
    fail(`Models endpoint returned ${r1.status}`);
    info(`  body: ${t1.slice(0, 300)}`);
    if (r1.status === 401 || r1.status === 403) {
      info(`  → API key is invalid, revoked, or lacks account access`);
    } else if (r1.status === 404 || /not.found/i.test(t1)) {
      info(`  → Account id "${accountId}" is likely wrong`);
      info(`  → Check the slug at https://fireworks.ai/account/profile`);
    }
  }

  console.log();
  console.log("─── Step 2: can we probe the files endpoint? ───");

  // A GET (listing) should succeed on a valid account even if empty.
  const filesUrl = `https://api.fireworks.ai/v1/accounts/${accountId}/datasets`;
  info(`GET ${filesUrl}`);
  const r2 = await fetch(filesUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const t2 = await r2.text();
  if (r2.ok) {
    ok(`Datasets endpoint reachable (${r2.status})`);
    try {
      const j = JSON.parse(t2);
      const count = Array.isArray(j.datasets) ? j.datasets.length : "?";
      info(`  ${count} existing dataset(s) under "${accountId}"`);
    } catch {}
  } else {
    fail(`Datasets endpoint returned ${r2.status}`);
    info(`  body: ${t2.slice(0, 400)}`);
  }

  console.log();
  console.log("─── Verdict ───");

  if (r1.ok && r2.ok) {
    ok("Credentials look correct. The upload 404 is probably an endpoint issue,");
    info("  not a config issue — tell me and I'll patch the upload flow.");
  } else if (!r1.ok && /not.found/i.test(t1)) {
    console.log();
    console.log(red("The account id is wrong."));
    console.log();
    console.log("Fix:");
    console.log("  1. Log in at https://fireworks.ai");
    console.log("  2. Go to Account → Profile (or Settings)");
    console.log("  3. Copy the account slug (shows up in URL / profile page)");
    console.log("  4. Set FIREWORKS_ACCOUNT_ID on Vercel AND in the Codespace secrets");
    console.log("  5. Re-run: npm run rebuild-env && npm run run-everything");
  } else {
    warn("Inconclusive — paste both raw responses above to me.");
  }
}

check().catch(err => {
  console.error(red("Unexpected error:"), err.message);
  process.exit(1);
});
