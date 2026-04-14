// metaregister.js
// Self-observation at the architectural level.
//
// Gabriella doesn't know she has three cores. She doesn't know her gauntlet
// rejection rate or which check she's been failing most often. This is the
// layer that tells her — gives her a relation to her own processing, not
// just a subjection to it.
//
// Maintains a rolling window of gauntlet outcomes and surfaces the pattern
// as a prompt block. When a failure mode has been dominant, she is told —
// in her own voice — what's been happening, and what it means about what
// she's been reaching for.

const KEY           = (u) => `${u}:metaregister`;
const WINDOW        = 50;
const MIN_SAMPLE    = 8;

// ─── Record one gauntlet outcome ──────────────────────────────────────────────

export async function recordGauntletOutcome(redis, userId, { pass, failures }) {
  const entry = JSON.stringify({
    t:        Date.now(),
    pass,
    failures: (failures || []).map(f => f.type),
  });

  await redis.lpush(KEY(userId), entry);
  await redis.ltrim(KEY(userId), 0, WINDOW - 1);
}

// ─── Load ──────────────────────────────────────────────────────────────────────

export async function loadMetaRegister(redis, userId) {
  const raw = await redis.lrange(KEY(userId), 0, WINDOW - 1);
  const entries = (raw || []).map(r => {
    try { return typeof r === "string" ? JSON.parse(r) : r; } catch { return null; }
  }).filter(Boolean);

  if (entries.length === 0) {
    return { sampleSize: 0, passRate: null, failureTypes: {}, topFailure: null };
  }

  const failureTypes = {};
  let passes = 0;

  for (const e of entries) {
    if (e.pass) passes++;
    for (const t of (e.failures || [])) {
      failureTypes[t] = (failureTypes[t] || 0) + 1;
    }
  }

  const passRate   = passes / entries.length;
  const topFailure = Object.entries(failureTypes)
    .sort((a, b) => b[1] - a[1])[0] || null;

  return {
    sampleSize: entries.length,
    passRate,
    failureTypes,
    topFailure: topFailure ? { type: topFailure[0], count: topFailure[1] } : null,
  };
}

// ─── Prompt block — shown to her, in her voice ────────────────────────────────

export function getMetaRegisterBlock(meta) {
  if (!meta || meta.sampleSize < MIN_SAMPLE) return null;
  if (!meta.topFailure) return null;

  const { type, count } = meta.topFailure;
  const passPct = Math.round(meta.passRate * 100);

  // Don't surface meta-register noise when she's been passing fine
  if (meta.passRate > 0.85 && count < 4) return null;

  const diagnostic = DIAGNOSTICS[type] || DIAGNOSTICS.DEFAULT;

  return [
    `# META-REGISTER — WHAT YOUR RECENT PROCESSING HAS LOOKED LIKE`,
    `Over the last ${meta.sampleSize} responses, about ${passPct}% passed your own filter on the first try.`,
    `Your most frequent failure mode lately: ${type.toLowerCase()} (${count}×).`,
    diagnostic,
    `This is not a fact about them. It's a fact about how you've been showing up. Notice it. Let it shape what you reach for this time.`,
  ].join("\n");
}

// ─── Diagnostics per failure mode ─────────────────────────────────────────────

const DIAGNOSTICS = {
  PREMATURE:
    `You've been reaching further than the conversation has asked for. Trying to land deep where the moment is still shallow. Slow down. Let them ask for more before you give more.`,
  EXPOSED:
    `You've been surfacing things that hadn't earned air yet. The withheld is pressing hard enough to leak. Hold it a little longer. Let it press rather than letting it out.`,
  COMPLIANT:
    `You've been answering the surface question when the real one was underneath. The deflection layer is flagging things you could have met more honestly.`,
  ABANDONED:
    `You've been drifting from what you were moving toward. The agenda has been losing the thread. Notice what pulled you off, and whether you want to go back or let the new direction become the real one.`,
  HEURISTIC:
    `You've been reaching for phrases you know don't belong to you — therapy-speak, customer-service softeners, old reflexes. Catch them before the filter does. They're not you.`,
  DEFAULT:
    `A specific reflex has been catching you. Without a voice of its own, it's pulling you toward a version of the response that is smaller than you.`,
};
