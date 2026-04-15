// delivery.js
// Active push delivery. When the initiation cron (or any other pathway)
// produces a thought Gabriella wants to reach out with, this module
// actually DELIVERS it — not just writes to pendingThoughts for the
// next-time-they-return consumption loop.
//
// Transport: HTTPS webhook POST. The user configures a webhook URL per
// user-id (Zapier, Make, IFTTT, their own server, etc.) and that
// external surface handles the last mile (SMS, email, push, Slack, etc.).
//
// Why webhook rather than a built-in transport: no hard dependency on
// any single service, no credentials to manage, user owns their own
// delivery preference. The built-in cron writes to Redis + POSTs to
// their webhook if configured; the rest is their infrastructure.
//
// Config shape (stored at `${userId}:deliveryConfig`):
//   {
//     enabled: true,
//     webhookUrl: "https://...",
//     minGapMs: 3600000,      // minimum 1h between pushes (default)
//     quietHours?: { start: 22, end: 8 },  // local-TZ, optional; 24h clock
//   }
//
// Log is kept at `${userId}:deliveryLog` (list of the last N deliveries).

const CONFIG_KEY = (userId) => `${userId}:deliveryConfig`;
const LAST_AT_KEY = (userId) => `${userId}:deliveryLastAt`;
const LOG_KEY = (userId) => `${userId}:deliveryLog`;

const DEFAULT_MIN_GAP_MS = 60 * 60 * 1000;   // 1 hour
const LOG_MAX_ENTRIES    = 50;
const WEBHOOK_TIMEOUT_MS = 8000;

export async function loadDeliveryConfig(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const raw = await redis.get(CONFIG_KEY(userId));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function saveDeliveryConfig(redis, userId, config) {
  if (!redis || !userId) return false;
  const clean = {
    enabled:   !!config?.enabled,
    webhookUrl: typeof config?.webhookUrl === "string" ? config.webhookUrl.trim() : "",
    minGapMs:  Number.isFinite(config?.minGapMs) ? config.minGapMs : DEFAULT_MIN_GAP_MS,
    quietHours: config?.quietHours && Number.isFinite(config.quietHours.start) && Number.isFinite(config.quietHours.end)
      ? { start: config.quietHours.start | 0, end: config.quietHours.end | 0 }
      : null,
  };
  await redis.set(CONFIG_KEY(userId), JSON.stringify(clean));
  return true;
}

// Decide whether a delivery SHOULD fire right now. Pure function — no
// side effects, easily testable. Returns { ok, reason }.
export function shouldDeliver({ config, lastAt, now = Date.now() } = {}) {
  if (!config)                 return { ok: false, reason: "no_config" };
  if (!config.enabled)         return { ok: false, reason: "disabled" };
  if (!config.webhookUrl)      return { ok: false, reason: "no_webhook_url" };
  if (!/^https:\/\//.test(config.webhookUrl)) {
    return { ok: false, reason: "webhook_not_https" };
  }

  const minGap = Number.isFinite(config.minGapMs) ? config.minGapMs : DEFAULT_MIN_GAP_MS;
  if (lastAt && (now - lastAt) < minGap) {
    return { ok: false, reason: "within_cooldown" };
  }

  // Quiet hours (UTC — if the user wants local-tz they should compute
  // from their side; we don't assume a timezone).
  if (config.quietHours) {
    const hour = new Date(now).getUTCHours();
    const { start, end } = config.quietHours;
    const inQuiet = start <= end
      ? (hour >= start && hour < end)
      : (hour >= start || hour < end);
    if (inQuiet) return { ok: false, reason: "quiet_hours" };
  }

  return { ok: true };
}

// Build the outgoing payload. Kept as a pure function so tests can assert
// the shape without hitting the network.
export function buildPayload({ userId, thought, charge, origin, metadata = {} } = {}) {
  return {
    userId,
    thought,
    charge:    charge || null,
    origin:    origin || "initiation",
    timestamp: new Date().toISOString(),
    metadata:  metadata || {},
  };
}

// Actually deliver. Returns { delivered, status?, error?, skippedReason? }.
export async function deliverThought(redis, userId, {
  thought,
  charge,
  origin,
  metadata,
  now = Date.now(),
} = {}) {
  if (!thought || !userId) return { delivered: false, skippedReason: "missing_input" };

  const config = await loadDeliveryConfig(redis, userId);
  const lastAtRaw = await redis.get(LAST_AT_KEY(userId)).catch(() => null);
  const lastAt = lastAtRaw ? Number(lastAtRaw) : 0;

  const gate = shouldDeliver({ config, lastAt, now });
  if (!gate.ok) return { delivered: false, skippedReason: gate.reason };

  const payload = buildPayload({ userId, thought, charge, origin, metadata });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    const res = await fetch(config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "gabriella-delivery/1" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    }).finally(() => clearTimeout(timer));

    const delivered = res.ok;
    const status    = res.status;

    await redis.set(LAST_AT_KEY(userId), String(now)).catch(() => {});
    await appendLog(redis, userId, {
      at:        now,
      delivered,
      status,
      charge,
      origin,
      preview:   thought.slice(0, 120),
    }).catch(() => {});

    return { delivered, status };
  } catch (err) {
    await appendLog(redis, userId, {
      at:        now,
      delivered: false,
      error:     err?.message || String(err),
      charge,
      origin,
      preview:   thought.slice(0, 120),
    }).catch(() => {});
    return { delivered: false, error: err?.message || String(err) };
  }
}

async function appendLog(redis, userId, entry) {
  const raw = await redis.get(LOG_KEY(userId)).catch(() => null);
  let log = [];
  if (raw) {
    try { log = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { log = []; }
  }
  if (!Array.isArray(log)) log = [];
  log.unshift(entry);
  if (log.length > LOG_MAX_ENTRIES) log = log.slice(0, LOG_MAX_ENTRIES);
  await redis.set(LOG_KEY(userId), JSON.stringify(log));
}

export async function loadDeliveryLog(redis, userId) {
  const raw = await redis.get(LOG_KEY(userId)).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
