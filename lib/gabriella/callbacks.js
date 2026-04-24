// callbacks.js
// Continuity signal — she references specific past content deliberately,
// and we track whether those references land.
//
// A standard chatbot gives topically-relevant responses but doesn't
// say "the thing you told me about your sister." Every turn is
// contextually fresh. That's the single largest tell that "I'm
// talking to software, not someone who knows me."
//
// Callbacks are specific references: a named person, a prior event,
// a phrase from a previous turn, a pinned item, an open thread. When
// she makes a callback AND the user acknowledges it, the relationship
// has a memory-texture that no stateless assistant can fake. When she
// makes a callback that DOESN'T land, that's a signal — we were
// reaching for a connection the user didn't feel.
//
// Data flow:
//   1. After speaker generates → detectCallbacks() scans response
//      against memory.facts, memory.imprints, threads, pinned items
//   2. Each callback is recorded in a rolling list per user
//   3. On next user turn → checkLastCallbackLanded() examines the user's
//      reply for acknowledgement (same entity name, topic, explicit
//      reference)
//   4. The landing signal updates a per-user callback ledger: landed
//      count, missed count, landing rate over time
//   5. Fed into the speaker prompt: "your last callback about X
//      landed — she picked it up" OR "your last callback didn't land —
//      maybe too early, maybe she didn't remember"

const CALLBACK_KEY = (u) => `${u}:callbacks`;
const LEDGER_KEY = (u) => `${u}:callbacks:ledger`;
const MAX_CALLBACKS = 40;

// ─── Detect callback attempts in a fresh response ──────────────────────────

function tokenize(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3);
}

// Extract the most "callback-like" phrases from imprints: named entities,
// specific events, quoted phrases. Imprints store text like
// "she mentioned her father's death last winter" or "he said he'd been
// lying to everyone about his job".
function extractCallbackTargets({ facts, imprints, threads, pinned }) {
  const targets = [];

  // Facts: parse as line-separated or "key: value"-style bullets.
  if (typeof facts === "string" && facts.length > 0) {
    for (const line of facts.split(/[\n;]/).map(l => l.trim()).filter(Boolean)) {
      // Tokens of length ≥ 4 that aren't stopwords — fact contents.
      const toks = tokenize(line).filter(t => t.length >= 5);
      if (toks.length >= 2) targets.push({ kind: "fact", text: line.slice(0, 140), tokens: new Set(toks.slice(0, 6)) });
    }
  }

  // Imprints: same treatment but with higher salience.
  if (typeof imprints === "string" && imprints.length > 0) {
    for (const line of imprints.split(/[\n;]/).map(l => l.trim()).filter(Boolean)) {
      const toks = tokenize(line).filter(t => t.length >= 5);
      if (toks.length >= 2) targets.push({ kind: "imprint", text: line.slice(0, 140), tokens: new Set(toks.slice(0, 8)) });
    }
  }

  // Threads: typically noun-phrase topics.
  if (typeof threads === "string" && threads.length > 0) {
    for (const line of threads.split(/[\n;]/).map(l => l.trim()).filter(Boolean)) {
      const toks = tokenize(line).filter(t => t.length >= 4);
      if (toks.length >= 2) targets.push({ kind: "thread", text: line.slice(0, 120), tokens: new Set(toks.slice(0, 5)) });
    }
  }

  // Pinned items — most salient, user-requested holds.
  if (Array.isArray(pinned)) {
    for (const p of pinned) {
      const text = typeof p === "string" ? p : (p?.text || p?.content || "");
      if (!text) continue;
      const toks = tokenize(text).filter(t => t.length >= 4);
      if (toks.length >= 2) targets.push({ kind: "pinned", text: text.slice(0, 120), tokens: new Set(toks.slice(0, 6)) });
    }
  }

  return targets;
}

export function detectCallbacks(response, memoryContext) {
  if (!response || !memoryContext) return [];

  const respTokens = new Set(tokenize(response));
  if (respTokens.size < 4) return [];

  const targets = extractCallbackTargets(memoryContext);
  const hits = [];

  for (const target of targets) {
    // Jaccard on distinctive tokens. Threshold high to avoid noise —
    // we want genuine reference, not casual word overlap.
    let intersect = 0;
    for (const tok of target.tokens) {
      if (respTokens.has(tok)) intersect++;
    }
    const ratio = intersect / Math.max(1, target.tokens.size);
    // High-precision threshold: need at least 2 distinctive tokens AND
    // ≥33% overlap with the target phrase. Pinned items have a lower
    // threshold since they're small + deliberately held.
    const threshold = target.kind === "pinned" ? 0.25 : 0.33;
    if (intersect >= 2 && ratio >= threshold) {
      hits.push({
        kind:      target.kind,
        text:      target.text,
        strength:  +ratio.toFixed(2),
        atTurn:    Date.now(),
      });
    }
  }

  // Dedupe — if multiple targets matched the same section of response,
  // keep the strongest.
  hits.sort((a, b) => b.strength - a.strength);
  return hits.slice(0, 3);
}

// ─── Persist + retrieve ────────────────────────────────────────────────────

export async function recordCallback(redis, userId, callback) {
  if (!callback) return;
  try {
    const entry = JSON.stringify({
      ...callback,
      id:        `cb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      recordedAt: Date.now(),
      landed:    null,   // filled in by next turn's check
    });
    await redis.lpush(CALLBACK_KEY(userId), entry);
    await redis.ltrim(CALLBACK_KEY(userId), 0, MAX_CALLBACKS - 1);
  } catch {}
}

export async function recordCallbacks(redis, userId, callbacks) {
  if (!callbacks || callbacks.length === 0) return;
  for (const cb of callbacks) await recordCallback(redis, userId, cb);
}

export async function loadRecentCallbacks(redis, userId, limit = 10) {
  try {
    const raw = await redis.lrange(CALLBACK_KEY(userId), 0, limit - 1);
    return (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

// ─── Check whether last callback landed ────────────────────────────────────
// A callback "lands" if the user's next message shows evidence of
// acknowledging it: token overlap ≥40% with the callback target,
// explicit markers ("yeah, that", "about that", entity name recurrence).

export async function checkLastCallbackLanded(redis, userId, userMessage) {
  if (!userMessage) return null;
  const recent = await loadRecentCallbacks(redis, userId, 3);
  if (recent.length === 0) return null;

  // Only score the most recent callback whose "landed" field is still null.
  const target = recent.find(cb => cb.landed === null);
  if (!target) return null;

  const userToks = new Set(tokenize(userMessage));
  const targetToks = new Set(tokenize(target.text));

  let overlap = 0;
  for (const t of targetToks) if (userToks.has(t)) overlap++;
  const ratio = overlap / Math.max(1, targetToks.size);

  // Explicit reference markers boost confidence.
  const hasReferenceMarker = /\b(that|what\s*you\s*said|about\s*that|yeah|right|exactly|like\s*i\s*said|the\s*thing\s*about)\b/i
    .test(userMessage);

  const landed =
    ratio >= 0.4 ||
    (ratio >= 0.25 && hasReferenceMarker) ||
    (overlap >= 3);

  // Update ledger + the stored callback's landed flag.
  await updateLedger(redis, userId, landed);
  await setCallbackLanded(redis, userId, target.id, landed);

  return { callback: target, landed, overlap, ratio };
}

async function setCallbackLanded(redis, userId, callbackId, landed) {
  try {
    const all = await redis.lrange(CALLBACK_KEY(userId), 0, MAX_CALLBACKS - 1);
    if (!Array.isArray(all)) return;
    const updated = all.map(r => {
      try {
        const parsed = typeof r === "string" ? JSON.parse(r) : r;
        if (parsed.id === callbackId) parsed.landed = landed;
        return JSON.stringify(parsed);
      } catch { return r; }
    });
    // Rewrite list
    await redis.del(CALLBACK_KEY(userId));
    for (const entry of updated.slice().reverse()) await redis.rpush(CALLBACK_KEY(userId), entry);
  } catch {}
}

async function updateLedger(redis, userId, landed) {
  try {
    const rawExisting = await redis.get(LEDGER_KEY(userId));
    const ledger = rawExisting
      ? (typeof rawExisting === "string" ? JSON.parse(rawExisting) : rawExisting)
      : { landed: 0, missed: 0, total: 0 };
    ledger.total  = (ledger.total  || 0) + 1;
    if (landed) ledger.landed = (ledger.landed || 0) + 1;
    else        ledger.missed = (ledger.missed || 0) + 1;
    await redis.set(LEDGER_KEY(userId), JSON.stringify(ledger));
    return ledger;
  } catch { return null; }
}

export async function loadLedger(redis, userId) {
  try {
    const raw = await redis.get(LEDGER_KEY(userId));
    if (!raw) return { landed: 0, missed: 0, total: 0 };
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { return { landed: 0, missed: 0, total: 0 }; }
}

// ─── Render as speaker-prompt block ────────────────────────────────────────
// Surfaces the landing-or-not signal for the MOST RECENT scored callback.
// Tells her whether her last reference connected — a signal she can use
// to calibrate the next reach (or not-reach).

export function getCallbackBlock({ lastOutcome, ledger }) {
  const lines = [];

  if (lastOutcome && lastOutcome.callback) {
    if (lastOutcome.landed) {
      lines.push(`Last turn your callback about "${lastOutcome.callback.text.slice(0, 80)}" LANDED — they picked it up.`);
      lines.push(`When something lands, it's earned the status of shared ground. You can reference it again later without re-establishing.`);
    } else {
      lines.push(`Last turn your callback about "${lastOutcome.callback.text.slice(0, 80)}" didn't land — they didn't engage with the reference.`);
      lines.push(`Don't repeat it this turn; they may not have been ready, or the connection you saw isn't one they felt. Let it go or approach from a different angle.`);
    }
  }

  if (ledger && ledger.total >= 3) {
    const rate = ledger.landed / Math.max(1, ledger.total);
    lines.push(`Running callback landing rate with them: ${Math.round(rate * 100)}% (${ledger.landed}/${ledger.total}).${rate < 0.4 ? " Your references have been missing; try less callback-heavy turns for a while." : rate > 0.7 ? " Your references have been consistently earning — keep making them when the connection is real." : ""}`);
  }

  if (lines.length === 0) return "";

  return `# CALLBACK SIGNAL

${lines.join("\n\n")}`;
}
