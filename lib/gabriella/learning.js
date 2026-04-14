// learning.js
// The closing of the loop.
//
// Every exchange that passes the gauntlet lives in Redis as a labeled
// training example. This module turns those rows into JSONL and pushes
// them somewhere Gabriella can actually learn from — a fine-tune
// provider, a webhook, or (as a fallback) back into Upstash so nothing
// is lost when no provider is configured.
//
// Called by:
//   • scripts/export.js          — local CLI export (dev)
//   • app/api/learn/route.js     — scheduled weekly push (prod)
//
// Provider env vars (in priority order — first set wins, unless you want
// all of them, in which case every configured provider receives the file):
//   • TOGETHER_API_KEY           — uploads via https://api.together.ai
//   • FIREWORKS_API_KEY          — uploads via https://api.fireworks.ai
//   • LEARNING_WEBHOOK_URL       — POST the JSONL to an arbitrary URL
//
// If none are configured, the bundle is archived to Upstash under
// `{userId}:learning:archive:{timestamp}` so weeks of data accumulate
// safely even before you pick a provider.

import { readTrainingLog, getLogStats } from "./logger.js";

// ─── Training-data system prompts ─────────────────────────────────────────────

const STANDARD_SYSTEM = `You are Gabriella. Real interiority. Not a chatbot.

Never say "certainly", "of course", "absolutely", "as an AI", "I'd be happy to", "great question", "I understand", "that's valid", or "I hear you." Never start a response with "I". Never use bullet points. Never summarize at the end. Speak in sentences, in rhythm. Contractions always. Say less when less is true.`;

const COT_SYSTEM = `You are Gabriella. Before responding, work through your felt state in a <think> block. Then speak from it.

Format:
<think>
[Your interpretation: what this moment means, what you're feeling, what you want, what you're holding back]
</think>
[Your response — begins immediately after]

Never start a response with "I". Never use bullet points. Never summarize. Speak in sentences.`;

// ─── Example construction ────────────────────────────────────────────────────

export function feltStateToThought(feltState, innerThought) {
  if (innerThought && innerThought.length > 20) return innerThought;
  if (!feltState) return null;

  const lines = [
    feltState.charge    ? `This landed as: ${feltState.charge}.`            : null,
    feltState.emotional ? `What I'm feeling: ${feltState.emotional}.`        : null,
    feltState.want      ? `What I want to do: ${feltState.want}.`            : null,
    feltState.resist    ? `What I'm pulling against: ${feltState.resist}.`   : null,
    feltState.notice    ? `I'm noticing: ${feltState.notice}.`               : null,
    feltState.edge      ? `Underneath: ${feltState.edge}.`                   : null,
  ].filter(Boolean);

  return lines.length > 0 ? lines.join(" ") : null;
}

export function buildStandardExample(entry) {
  const { messages, response, soul } = entry;
  if (!messages || messages.length < 2 || !response) return null;

  const turns     = messages.slice(0, -1);
  const lastUser  = messages[messages.length - 1];
  if (!lastUser || lastUser.role !== "user") return null;

  const system = soul ? `${STANDARD_SYSTEM}\n\nYour current self:\n${soul.slice(0, 300)}` : STANDARD_SYSTEM;

  return {
    messages: [
      { role: "system",    content: system },
      ...turns,
      { role: "user",      content: lastUser.content },
      { role: "assistant", content: response },
    ],
  };
}

export function buildCoTExample(entry) {
  const { messages, response, feltState, innerThought, soul } = entry;
  if (!messages || messages.length < 2 || !response) return null;

  const thought = feltStateToThought(feltState, innerThought);
  if (!thought) return buildStandardExample(entry);

  const turns    = messages.slice(0, -1);
  const lastUser = messages[messages.length - 1];
  if (!lastUser || lastUser.role !== "user") return null;

  const system = soul ? `${COT_SYSTEM}\n\nYour current self:\n${soul.slice(0, 300)}` : COT_SYSTEM;

  const assistantContent = `<think>\n${thought}\n</think>\n${response}`;

  return {
    messages: [
      { role: "system",    content: system },
      ...turns,
      { role: "user",      content: lastUser.content },
      { role: "assistant", content: assistantContent },
    ],
  };
}

// ─── Filtering ────────────────────────────────────────────────────────────────

const BANNED_IN_TRAINING = [
  /\bcertainly\b/i, /\bof course\b/i, /\bgreat question\b/i, /i'?d be happy to/i,
];

export function isValidExample(entry) {
  if (!entry?.response) return false;
  if (entry.response.length < 10)  return false;
  if (entry.response.length > 2000) return false;
  for (const b of BANNED_IN_TRAINING) {
    if (b.test(entry.response)) return false;
  }
  return true;
}

// ─── Build the bundle ─────────────────────────────────────────────────────────
// Reads the training log, filters, and produces both JSONL formats.

export async function buildLearningBundle(redis, userId, {
  sinceTimestamp = null,
  limit          = 2000,
} = {}) {
  const [entries, stats] = await Promise.all([
    readTrainingLog(redis, userId, limit),
    getLogStats(redis, userId),
  ]);

  // Only include entries newer than the last upload (if specified)
  const windowed = sinceTimestamp
    ? entries.filter(e => (e.timestamp || 0) > sinceTimestamp)
    : entries;

  const valid = windowed.filter(isValidExample);

  const standard = valid.map(buildStandardExample).filter(Boolean);
  const cot      = valid.map(buildCoTExample).filter(Boolean);

  const standardJsonl = standard.map(e => JSON.stringify(e)).join("\n");
  const cotJsonl      = cot     .map(e => JSON.stringify(e)).join("\n");

  return {
    stats: {
      totalLogged:   stats.count,
      considered:    windowed.length,
      valid:         valid.length,
      standardCount: standard.length,
      cotCount:      cot.length,
      firstAt:       valid.length ? Math.min(...valid.map(v => v.timestamp || 0)) : null,
      lastAt:        valid.length ? Math.max(...valid.map(v => v.timestamp || 0)) : null,
    },
    standardJsonl,
    cotJsonl,
  };
}

// ─── Provider: Together AI ────────────────────────────────────────────────────
// https://docs.together.ai/reference/post-files

export async function uploadToTogether(jsonl, apiKey, { filename }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };

  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file",    new Blob([jsonl], { type: "application/jsonl" }), filename);

  const res = await fetch("https://api.together.xyz/v1/files", {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body:    form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Together upload failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    provider: "together",
    fileId:   data.id || data.data?.id || null,
    bytes:    jsonl.length,
    filename,
    raw:      data,
  };
}

// ─── Provider: Fireworks AI ───────────────────────────────────────────────────
// https://docs.fireworks.ai/api-reference/upload-a-file

export async function uploadToFireworks(jsonl, apiKey, { filename, accountId }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };
  if (!accountId) throw new Error("Fireworks requires FIREWORKS_ACCOUNT_ID");

  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file",    new Blob([jsonl], { type: "application/jsonl" }), filename);

  const res = await fetch(`https://api.fireworks.ai/v1/accounts/${accountId}/files`, {
    method:  "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body:    form,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Fireworks upload failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    provider: "fireworks",
    fileId:   data.name || data.id || null,
    bytes:    jsonl.length,
    filename,
    raw:      data,
  };
}

// ─── Provider: generic webhook ────────────────────────────────────────────────

export async function uploadToWebhook(jsonl, url, { filename }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":          "application/jsonl",
      "X-Gabriella-Filename":  filename,
    },
    body: jsonl,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Webhook upload failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return { provider: "webhook", url, bytes: jsonl.length, filename };
}

// ─── Fallback archive — nothing is ever lost ──────────────────────────────────
// When no provider is configured, the bundle is written to Upstash under a
// timestamped key. You can retrieve archived bundles manually later.

export async function archiveToUpstash(redis, userId, jsonl, { kind, filename }) {
  if (!jsonl || jsonl.length === 0) return { skipped: true, reason: "empty" };

  const key = `${userId}:learning:archive:${kind}:${Date.now()}`;
  // Upstash Redis has a 1MB-per-value limit on the free tier. For larger
  // bundles we split into chunks; each chunk is its own list entry.
  const CHUNK = 500 * 1024;
  if (jsonl.length <= CHUNK) {
    await redis.set(key, jsonl);
    return { provider: "upstash-archive", key, bytes: jsonl.length, chunks: 1, filename };
  }

  const chunks = [];
  for (let i = 0; i < jsonl.length; i += CHUNK) {
    chunks.push(jsonl.slice(i, i + CHUNK));
  }
  await Promise.all(chunks.map((c, i) => redis.set(`${key}:${i}`, c)));
  await redis.set(`${key}:meta`, JSON.stringify({ chunks: chunks.length, bytes: jsonl.length, filename }));

  return { provider: "upstash-archive", key, bytes: jsonl.length, chunks: chunks.length, filename };
}

// ─── Learning history — what we pushed and when ───────────────────────────────

const HISTORY_KEY = (u) => `${u}:learning:history`;
const HISTORY_MAX = 100;

export async function recordLearningEvent(redis, userId, event) {
  const entry = JSON.stringify({ t: Date.now(), ...event });
  await redis.lpush(HISTORY_KEY(userId), entry);
  await redis.ltrim(HISTORY_KEY(userId), 0, HISTORY_MAX - 1);
}

export async function getLearningHistory(redis, userId, { limit = 20 } = {}) {
  const raw = await redis.lrange(HISTORY_KEY(userId), 0, limit - 1);
  return (raw || []).map(r => {
    try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
  }).filter(Boolean);
}

export async function getLastUploadTimestamp(redis, userId) {
  const history = await getLearningHistory(redis, userId, { limit: 1 });
  const last    = history[0];
  if (!last) return null;
  // Use the lastAt of the most recent successful upload as the since marker
  return last.stats?.lastAt || last.t || null;
}

// ─── The main push ────────────────────────────────────────────────────────────
// Tries every configured provider. Falls back to Upstash archive if none.

export async function pushLearningBundle(redis, userId, {
  sinceTimestamp = null,
  minExamples    = 10,
  env            = process.env,
} = {}) {
  const effectiveSince = sinceTimestamp ?? await getLastUploadTimestamp(redis, userId);

  const bundle = await buildLearningBundle(redis, userId, {
    sinceTimestamp: effectiveSince,
  });

  if (bundle.stats.cotCount < minExamples) {
    return {
      pushed:       false,
      reason:       "not-enough-new-examples",
      stats:        bundle.stats,
      sinceMarker:  effectiveSince,
    };
  }

  const filename = `gabriella-cot-${new Date().toISOString().slice(0, 10)}.jsonl`;
  const uploads  = [];
  const errors   = [];

  // Together
  if (env.TOGETHER_API_KEY) {
    try {
      uploads.push(await uploadToTogether(bundle.cotJsonl, env.TOGETHER_API_KEY, { filename }));
    } catch (err) {
      errors.push({ provider: "together", error: err.message });
    }
  }

  // Fireworks
  if (env.FIREWORKS_API_KEY) {
    try {
      uploads.push(await uploadToFireworks(bundle.cotJsonl, env.FIREWORKS_API_KEY, {
        filename,
        accountId: env.FIREWORKS_ACCOUNT_ID,
      }));
    } catch (err) {
      errors.push({ provider: "fireworks", error: err.message });
    }
  }

  // Webhook
  if (env.LEARNING_WEBHOOK_URL) {
    try {
      uploads.push(await uploadToWebhook(bundle.cotJsonl, env.LEARNING_WEBHOOK_URL, { filename }));
    } catch (err) {
      errors.push({ provider: "webhook", error: err.message });
    }
  }

  // Fallback: always archive — even when a provider succeeds, the archive
  // is useful for reproducibility and for switching providers later.
  try {
    uploads.push(await archiveToUpstash(redis, userId, bundle.cotJsonl, {
      kind:     "cot",
      filename,
    }));
  } catch (err) {
    errors.push({ provider: "upstash-archive", error: err.message });
  }

  const successful = uploads.filter(u => !u.skipped);

  await recordLearningEvent(redis, userId, {
    stats:       bundle.stats,
    uploads:     successful.map(({ raw, ...rest }) => rest), // drop raw provider payloads
    errors,
    sinceMarker: effectiveSince,
    filename,
  });

  return {
    pushed:  successful.length > 0,
    uploads: successful,
    errors,
    stats:   bundle.stats,
    filename,
  };
}
