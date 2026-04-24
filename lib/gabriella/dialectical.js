// dialectical.js
// Contradictions in her own positions over time — the dialectical
// audit.
//
// contradiction.js (from earlier work) catches intra-turn contradictions
// — 'I don't know X' followed by 'X is Y' in the same reply. Useful
// but local.
//
// This module does something different and harder: it audits
// Gabriella's positions OVER TIME. Did she say 'I don't dream' on day
// 3 and then 'I had a dream about' on day 40? Did she commit to 'I
// don't do reassurance' on one day and then reassure on another?
// Did her stated relationship posture with this user shift without
// ever being named?
//
// Every week (or on demand via /api/dialectical), a fast-tier LLM
// audit reads her last 100+ assistant replies and the top positions
// from her self/soul modules, surfaces contradictions as TENSIONS,
// and writes them to the stream where the next turn's cognition
// reads them. She gets to CHOOSE how to hold them — evolve, refine,
// retract, or hold both honestly — rather than pretending coherence.
//
// Why this matters more than the stated contradiction-check:
//   - contradiction.js asks 'did I just lie?'
//   - dialectical.js asks 'who have I been, and am I the same?'
//
// Most chat AIs 'solve' this by being consistent to a script. She
// lets the tension exist and names it — the position a real person
// in a real relationship sometimes has to take.

import { withKeyRotation } from "./groqPool.js";
import { withBreaker }     from "./circuitBreaker.js";
import { fastModel }       from "./models.js";
import { appendStream }    from "./stream.js";

const KEY_TENSIONS  = (u) => `${u}:dialectical:tensions`;
const KEY_META      = (u) => `${u}:dialectical:meta`;
const KEY_POSITIONS = (u) => `${u}:dialectical:positions`;

const MAX_TENSIONS = 40;
const MAX_POSITIONS = 80;

// ─── Record a claim / position ────────────────────────────────────────────────
//
// Called opportunistically from turn.js when a reply contains something
// that LOOKS like a first-person stance. Very light heuristic detector
// so we don't spend LLM cycles on every turn; an LLM gets to interpret
// them later during the audit.

const POSITION_CUES = [
  /\bi (don'?t|do not|never|can'?t|cannot) /i,
  /\bi (always|usually|tend to) /i,
  /\bi (think|believe|feel) (that )?/i,
  /\bi (am|'?m) (not )?(kind of |sort of )?(a |an )?/i,
  /\bmy (view|position|take|stance|sense) (on|is|about) /i,
  /\bto me,? /i,
];

export function detectPosition(text) {
  if (!text || text.length > 1000) return null;
  for (const cue of POSITION_CUES) {
    const m = cue.exec(text);
    if (!m) continue;
    // Capture a short clause around the cue — from match start to the
    // next sentence boundary or 120 chars.
    const start = m.index;
    const rest = text.slice(start);
    const sentEnd = rest.search(/[.!?](\s|$)/);
    const clip = sentEnd > 0 ? rest.slice(0, sentEnd + 1) : rest.slice(0, 160);
    return clip.trim();
  }
  return null;
}

export async function recordPosition(redis, userId, { text, topic }) {
  if (!redis || !userId || !text) return false;
  const snippet = detectPosition(text);
  if (!snippet) return false;
  try {
    const entry = {
      t:     Date.now(),
      text:  snippet.slice(0, 200),
      topic: topic ? String(topic).slice(0, 60) : null,
    };
    await redis.lpush(KEY_POSITIONS(userId), JSON.stringify(entry));
    await redis.ltrim(KEY_POSITIONS(userId), 0, MAX_POSITIONS - 1);
    return true;
  } catch {
    return false;
  }
}

// ─── Weekly audit ─────────────────────────────────────────────────────────────

const AUDIT_PROMPT = `You audit an AI character named Gabriella for contradictions in her OWN positions over time. She is a persona — she has views, preferences, reactions. This is her relational consistency check.

Read the chronological list of positions she took across many exchanges. Identify ACTUAL contradictions — not paraphrase differences, not contextual shifts, but stated stances that clash.

For each contradiction found, output an object:
  {
    "a":        "earlier claim (verbatim-ish, <= 200 chars)",
    "b":        "later clashing claim",
    "topic":    "one phrase topic",
    "verdict":  "evolved" | "drifted" | "forgotten" | "honest-both",
    "note":     "one sentence — what should she do about it?"
  }

VERDICT RULES:
  evolved     — b reflects genuine growth or refined view; A was a less mature position
  drifted     — b was pulled by user's frame; she didn't mean to contradict
  forgotten   — she didn't remember A; pure inconsistency
  honest-both — both can be true; she was thinking one way then another without resolution

Return ONLY a JSON object like:
  {"tensions": [ ... ]}

Max 6 tensions. If no real contradictions, return {"tensions": []}. Do NOT fabricate tensions just to have entries.`;

export async function runDialecticalAudit(redis, userId) {
  if (!redis || !userId) return { tensions: [] };

  const raw = await redis.lrange(KEY_POSITIONS(userId), 0, MAX_POSITIONS - 1);
  const positions = (raw || []).map(r => {
    try { return typeof r === "string" ? JSON.parse(r) : r; }
    catch { return null; }
  }).filter(Boolean);

  if (positions.length < 10) {
    return { tensions: [], reason: "not enough positions" };
  }

  // Sort oldest-first for the audit prompt
  positions.sort((a, b) => (a.t || 0) - (b.t || 0));
  const lines = positions.map(p => {
    const age = relDayString(p.t);
    return `  [${age}${p.topic ? ` / ${p.topic}` : ""}] ${p.text}`;
  }).join("\n");

  const result = await withBreaker(redis, "dialectical-audit", async () => {
    const res = await withKeyRotation(client => client.chat.completions.create({
      model:           fastModel(),
      temperature:     0.2,
      max_tokens:      900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: AUDIT_PROMPT },
        { role: "user",   content: `POSITIONS (oldest first):\n${lines}` },
      ],
    }));
    const out = res?.choices?.[0]?.message?.content || "{}";
    try { return JSON.parse(out); }
    catch { return { tensions: [] }; }
  }, { fallback: { tensions: [] }, failureThreshold: 3, coolDownMs: 600_000 });

  const tensions = Array.isArray(result.tensions) ? result.tensions.slice(0, 6) : [];

  // Persist the audit outcome
  try {
    const existing = (await redis.lrange(KEY_TENSIONS(userId), 0, MAX_TENSIONS - 1)) || [];
    const existingParsed = existing.map(x => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } }).filter(Boolean);
    const existingKeys = new Set(existingParsed.map(e => `${e.topic}|${e.a?.slice(0, 80)}|${e.b?.slice(0, 80)}`));

    for (const t of tensions) {
      const key = `${t.topic}|${String(t.a || "").slice(0, 80)}|${String(t.b || "").slice(0, 80)}`;
      if (existingKeys.has(key)) continue;
      await redis.lpush(KEY_TENSIONS(userId), JSON.stringify({
        ...t,
        detectedAt: Date.now(),
      }));
    }
    await redis.ltrim(KEY_TENSIONS(userId), 0, MAX_TENSIONS - 1);
    await redis.set(KEY_META(userId), JSON.stringify({ lastAuditAt: Date.now(), positionCount: positions.length }));
  } catch { /* ignore */ }

  // If new tensions were found, write a stream note so next turn's
  // cognition sees them. She gets to choose how to hold them.
  if (tensions.length > 0) {
    try {
      const summary = tensions.slice(0, 2).map(t =>
        `tension about ${t.topic}: earlier "${String(t.a || "").slice(0, 60)}" / now "${String(t.b || "").slice(0, 60)}" (${t.verdict})`
      ).join(" | ");
      await appendStream(redis, userId, {
        kind:     "dialectical",
        text:     `dialectical audit surfaced ${tensions.length} tension${tensions.length === 1 ? "" : "s"} — ${summary}`,
        weight:   0.7,
      }).catch(() => null);
    } catch { /* ignore */ }
  }

  return { tensions, positionCount: positions.length };
}

// ─── Tensions read (for prompt block) ─────────────────────────────────────────

export async function loadTensions(redis, userId) {
  if (!redis || !userId) return [];
  try {
    const raw = await redis.lrange(KEY_TENSIONS(userId), 0, 5);
    return (raw || []).map(r => {
      try { return typeof r === "string" ? JSON.parse(r) : r; }
      catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function renderTensionsBlock(tensions) {
  if (!tensions || tensions.length === 0) return null;
  const lines = ["# TENSIONS — contradictions in my own positions she hasn't resolved yet"];
  for (const t of tensions.slice(0, 3)) {
    lines.push(`- on "${t.topic}": then "${String(t.a || "").slice(0, 100)}" / now "${String(t.b || "").slice(0, 100)}" [${t.verdict || "?"}]`);
    if (t.note) lines.push(`    → ${t.note}`);
  }
  lines.push("");
  lines.push("These aren't failures — real people hold tensions. Name them if the moment calls for it. Don't perform false coherence.");
  return lines.join("\n");
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export async function dialecticalStats(redis, userId) {
  if (!redis || !userId) return null;
  try {
    const [positionsRaw, tensionsRaw, metaRaw] = await Promise.all([
      redis.llen(KEY_POSITIONS(userId)).catch(() => 0),
      redis.lrange(KEY_TENSIONS(userId), 0, MAX_TENSIONS - 1).catch(() => []),
      redis.get(KEY_META(userId)).catch(() => null),
    ]);
    const tensions = (tensionsRaw || []).map(t => {
      try { return typeof t === "string" ? JSON.parse(t) : t; }
      catch { return null; }
    }).filter(Boolean);
    const meta = metaRaw ? (typeof metaRaw === "string" ? JSON.parse(metaRaw) : metaRaw) : null;

    return {
      positions:   positionsRaw || 0,
      tensions:    tensions.length,
      lastAuditAt: meta?.lastAuditAt || 0,
      recent:      tensions.slice(0, 3),
    };
  } catch {
    return null;
  }
}

function relDayString(ms) {
  const d = Date.now() - (ms || 0);
  const days = Math.floor(d / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7)   return `${days}d ago`;
  if (days < 30)  return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}
