// graph.js
// Episodic memory graph — entities and typed edges.
//
// Why a graph when we already have vector memory + episodic log +
// person model?
//
// Vector memory answers "what felt similar to this?"
// Episodic log answers "what happened in order?"
// Person model answers "who is this user, overall?"
//
// None answer "what does Gabriella know about <this thing the user
// mentioned> and how does it connect to other things she knows?"
// That's a graph question. Character.AI and Replika don't have this —
// they either fabricate continuity from training or forget.
//
// Schema (stored in Upstash Redis):
//
//   ${uid}:graph:nodes                 SET  of node ids
//   ${uid}:graph:node:<id>             STR  JSON { id, type, label,
//                                                   firstSeen, lastSeen,
//                                                   count, attrs }
//   ${uid}:graph:label:<lc>            STR  node id (lookup by label)
//   ${uid}:graph:by-type:<type>        SET  of node ids
//   ${uid}:graph:edges                 SET  of edge keys
//   ${uid}:graph:edge:<from>|<t>|<to>  STR  JSON { from, to, type,
//                                                   weight, firstSeen,
//                                                   lastSeen, evidence[] }
//   ${uid}:graph:out:<from>            SET  of edge keys from <from>
//   ${uid}:graph:in:<to>               SET  of edge keys into <to>
//
// Node types:   person | place | event | object | topic | belief |
//               activity | time | emotion
// Edge types:   MENTIONED_WITH | ABOUT | LOCATED_AT | PARTICIPATED_IN |
//               OWNS | BELIEVES | FELT | CONTRADICTS | FOLLOWS |
//               LIKES | DISLIKES | KNOWS
//
// Everything is defensively fire-and-forget in the chat path — a
// graph write that fails should never block a response.

import { withKeyRotation } from "./groqPool.js";
import { withBreaker }     from "./circuitBreaker.js";
import { fastModel }       from "./models.js";

const NODE_TYPES = new Set([
  "person", "place", "event", "object", "topic",
  "belief", "activity", "time", "emotion",
]);

const EDGE_TYPES = new Set([
  "MENTIONED_WITH", "ABOUT", "LOCATED_AT", "PARTICIPATED_IN",
  "OWNS", "BELIEVES", "FELT", "CONTRADICTS", "FOLLOWS",
  "LIKES", "DISLIKES", "KNOWS",
]);

const MAX_NODES       = 2000;
const MAX_EDGES       = 5000;
const MAX_EVIDENCE    = 8;
const MAX_LABEL_LEN   = 80;
const MAX_ATTR_BYTES  = 400;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normLabel(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_LABEL_LEN);
}

function nodeId(type, label) {
  const lc = normLabel(label);
  if (!NODE_TYPES.has(type) || !lc) return null;
  return `${type}:${lc}`;
}

function edgeKey(from, type, to) {
  return `${from}|${type}|${to}`;
}

function keyNode(uid, id)         { return `${uid}:graph:node:${id}`; }
function keyLabel(uid, lc)        { return `${uid}:graph:label:${lc}`; }
function keyByType(uid, type)     { return `${uid}:graph:by-type:${type}`; }
function keyNodesSet(uid)         { return `${uid}:graph:nodes`; }
function keyEdge(uid, ek)         { return `${uid}:graph:edge:${ek}`; }
function keyEdgesSet(uid)         { return `${uid}:graph:edges`; }
function keyOut(uid, from)        { return `${uid}:graph:out:${from}`; }
function keyIn(uid, to)           { return `${uid}:graph:in:${to}`; }

async function safeJson(redis, key) {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// ─── Upsert node ──────────────────────────────────────────────────────────────

export async function upsertNode(redis, userId, { type, label, attrs }) {
  const id = nodeId(type, label);
  if (!id) return null;
  const now = Date.now();

  const existing = await safeJson(redis, keyNode(userId, id));
  const next = existing ? {
    ...existing,
    lastSeen: now,
    count:    (existing.count || 0) + 1,
    attrs:    mergeAttrs(existing.attrs, attrs),
  } : {
    id, type,
    label:    String(label).slice(0, MAX_LABEL_LEN),
    firstSeen: now,
    lastSeen:  now,
    count:     1,
    attrs:     truncateAttrs(attrs || {}),
  };

  await Promise.all([
    redis.set(keyNode(userId, id), JSON.stringify(next)),
    redis.sadd(keyNodesSet(userId), id),
    redis.sadd(keyByType(userId, type), id),
    redis.set(keyLabel(userId, normLabel(label)), id),
  ]);
  return next;
}

function mergeAttrs(a, b) {
  if (!b) return a || {};
  const merged = { ...(a || {}), ...b };
  return truncateAttrs(merged);
}

function truncateAttrs(attrs) {
  const out = {};
  let bytes = 0;
  for (const [k, v] of Object.entries(attrs || {})) {
    const s = typeof v === "string" ? v.slice(0, 200) : v;
    const ser = JSON.stringify(s);
    if (bytes + ser.length > MAX_ATTR_BYTES) break;
    out[k] = s;
    bytes += ser.length;
  }
  return out;
}

// ─── Add or reinforce edge ────────────────────────────────────────────────────

export async function addEdge(redis, userId, { from, to, type, weight = 1, evidence }) {
  if (!from || !to || !EDGE_TYPES.has(type)) return null;
  if (from === to) return null;
  const ek  = edgeKey(from, type, to);
  const now = Date.now();

  const existing = await safeJson(redis, keyEdge(userId, ek));
  const ev = (existing?.evidence || []).concat(evidence ? [String(evidence).slice(0, 200)] : []);
  const next = existing ? {
    ...existing,
    lastSeen: now,
    weight:   (existing.weight || 0) + weight,
    evidence: ev.slice(-MAX_EVIDENCE),
  } : {
    from, to, type,
    firstSeen: now,
    lastSeen:  now,
    weight,
    evidence:  evidence ? [String(evidence).slice(0, 200)] : [],
  };

  await Promise.all([
    redis.set(keyEdge(userId, ek), JSON.stringify(next)),
    redis.sadd(keyEdgesSet(userId), ek),
    redis.sadd(keyOut(userId, from), ek),
    redis.sadd(keyIn(userId, to), ek),
  ]);
  return next;
}

// ─── Query by label ───────────────────────────────────────────────────────────

export async function findByLabel(redis, userId, label) {
  const lc = normLabel(label);
  if (!lc) return null;
  const id = await redis.get(keyLabel(userId, lc));
  if (!id) return null;
  return safeJson(redis, keyNode(userId, id));
}

// ─── Query neighbors of a node (1 hop) ────────────────────────────────────────

export async function neighbors(redis, userId, id, { limit = 12 } = {}) {
  const outKeys = (await redis.smembers(keyOut(userId, id))) || [];
  const inKeys  = (await redis.smembers(keyIn(userId,  id))) || [];
  const keys = [...outKeys, ...inKeys].slice(0, limit * 2);
  const edges = await Promise.all(keys.map(k => safeJson(redis, keyEdge(userId, k))));
  const nbs = [];
  for (const e of edges) {
    if (!e) continue;
    const otherId = e.from === id ? e.to : e.from;
    const other   = await safeJson(redis, keyNode(userId, otherId));
    if (!other) continue;
    nbs.push({ edge: e, node: other, direction: e.from === id ? "out" : "in" });
  }
  nbs.sort((a, b) => (b.edge.weight || 0) - (a.edge.weight || 0));
  return nbs.slice(0, limit);
}

// ─── LLM extractor — user turn + reply → entities + edges ─────────────────────

const EXTRACTOR_PROMPT = `You extract structured facts from a chat exchange.

Output ONLY a compact JSON object with fields:
{
  "entities": [ { "type": "person|place|event|object|topic|activity|belief|emotion", "label": "short phrase" } ],
  "edges":    [ { "from": {"type":"...","label":"..."}, "to": {"type":"...","label":"..."}, "type": "MENTIONED_WITH|ABOUT|LOCATED_AT|PARTICIPATED_IN|OWNS|BELIEVES|FELT|CONTRADICTS|FOLLOWS|LIKES|DISLIKES|KNOWS" } ]
}

RULES:
- Only extract entities clearly named in the text. Never infer from absence.
- Labels: noun phrases, 1-5 words, lowercase, concrete ("my sister", "the paris trip", "overwhelm").
- Max 6 entities, max 6 edges.
- No pronouns as entities ("he", "it"). Skip if you can't resolve them.
- If nothing extractable, return {"entities":[],"edges":[]}.
- NEVER output prose, commentary, or markdown. JUST the JSON object.`;

export async function extractFromTurn({ redis, userMsg, reply }) {
  const text = `USER: ${String(userMsg || "").slice(0, 900)}
GABRIELLA: ${String(reply || "").slice(0, 900)}`;

  return withBreaker(redis, "graph-extract", async () => {
    const res = await withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      temperature: 0.2,
      max_tokens:  420,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACTOR_PROMPT },
        { role: "user",   content: text },
      ],
    }));
    const raw = res?.choices?.[0]?.message?.content || "{}";
    let obj;
    try { obj = JSON.parse(raw); } catch { return { entities: [], edges: [] }; }
    return {
      entities: Array.isArray(obj.entities) ? obj.entities.slice(0, 6) : [],
      edges:    Array.isArray(obj.edges)    ? obj.edges.slice(0, 6)    : [],
    };
  }, { fallback: { entities: [], edges: [] }, failureThreshold: 4, coolDownMs: 180_000 });
}

// ─── End-to-end ingest — extraction + upserts ─────────────────────────────────

export async function ingestTurn(redis, userId, { userMsg, reply, feltState }) {
  if (!redis || !userId) return { entities: 0, edges: 0 };
  if (!userMsg && !reply) return { entities: 0, edges: 0 };

  const { entities, edges } = await extractFromTurn({ redis, userMsg, reply });

  let nodesWritten = 0;
  for (const e of entities) {
    if (!NODE_TYPES.has(e?.type)) continue;
    const n = await upsertNode(redis, userId, {
      type:  e.type,
      label: e.label,
      attrs: e.attrs || null,
    }).catch(() => null);
    if (n) nodesWritten++;
  }

  let edgesWritten = 0;
  for (const ed of edges) {
    if (!EDGE_TYPES.has(ed?.type)) continue;
    const fromId = nodeId(ed.from?.type, ed.from?.label);
    const toId   = nodeId(ed.to?.type,   ed.to?.label);
    if (!fromId || !toId) continue;
    // Ensure endpoints exist (the extractor sometimes emits edges
    // whose endpoints weren't in the entities list).
    await upsertNode(redis, userId, { type: ed.from.type, label: ed.from.label }).catch(() => null);
    await upsertNode(redis, userId, { type: ed.to.type,   label: ed.to.label   }).catch(() => null);
    const evidence = `${String(userMsg || "").slice(0, 120)} / ${String(reply || "").slice(0, 120)}`;
    const w = await addEdge(redis, userId, {
      from: fromId, to: toId, type: ed.type, weight: 1, evidence,
    }).catch(() => null);
    if (w) edgesWritten++;
  }

  // If felt state has a named emotion, link it to any extracted entity
  // with a FELT edge — this captures "talking about X made her feel Y"
  // deterministically without a second LLM call.
  if (feltState?.emotional && entities.length) {
    const emotionId = nodeId("emotion", feltState.emotional);
    if (emotionId) {
      await upsertNode(redis, userId, {
        type: "emotion", label: feltState.emotional,
      }).catch(() => null);
      for (const e of entities) {
        const fromId = nodeId(e?.type, e?.label);
        if (!fromId) continue;
        await addEdge(redis, userId, {
          from: fromId, to: emotionId, type: "FELT", weight: 0.5,
          evidence: `felt ${feltState.emotional} at temperature ${feltState.temperature}`,
        }).catch(() => null);
      }
    }
  }

  return { entities: nodesWritten, edges: edgesWritten };
}

// ─── Retrieve compact graph context for the prompt ────────────────────────────
//
// Given the current user message, pull any nodes whose labels appear
// verbatim (case-insensitive substring), fetch their top neighbors,
// and render a compact text block. Deterministic, no LLM call.

export async function getGraphContext(redis, userId, currentUserMsg, { maxNodes = 4, maxNeighbors = 4 } = {}) {
  if (!redis || !userId || !currentUserMsg) return null;
  const text = String(currentUserMsg).toLowerCase();

  // Fast label-substring scan: pull all labels, find overlaps. At MAX_NODES
  // = 2000 this is bounded; if it grows further we'd switch to a secondary
  // inverted index, but this is fine for now.
  const nodeIds = await redis.smembers(keyNodesSet(userId));
  if (!nodeIds || nodeIds.length === 0) return null;

  const hits = [];
  for (const id of nodeIds) {
    const colonIdx = id.indexOf(":");
    if (colonIdx < 0) continue;
    const lc = id.slice(colonIdx + 1);
    if (lc.length < 3) continue;
    if (text.includes(lc)) hits.push(id);
    if (hits.length >= maxNodes * 2) break;
  }
  if (!hits.length) return null;

  const nodes = await Promise.all(
    hits.slice(0, maxNodes).map(id => safeJson(redis, keyNode(userId, id))),
  );

  const lines = ["# GRAPH — what she knows about things just mentioned"];
  for (const n of nodes) {
    if (!n) continue;
    lines.push(`- ${n.type} "${n.label}" (seen ${n.count}x, last ${relTime(n.lastSeen)})`);
    const nbs = await neighbors(redis, userId, n.id, { limit: maxNeighbors });
    for (const nb of nbs) {
      const arrow = nb.direction === "out" ? "→" : "←";
      lines.push(`    ${arrow} ${nb.edge.type} ${arrow} ${nb.node.type}:"${nb.node.label}" (weight ${nb.edge.weight.toFixed(1)})`);
    }
  }
  if (lines.length === 1) return null;
  lines.push("");
  lines.push("Use this ONLY to ground continuity — 'the sister you mentioned last week', not 'YOUR DATABASE SAYS'. Never cite the graph explicitly.");
  return lines.join("\n");
}

function relTime(ms) {
  const d = Date.now() - (ms || 0);
  if (d < 60_000)       return "just now";
  if (d < 3_600_000)    return Math.round(d / 60_000) + "m ago";
  if (d < 86_400_000)   return Math.round(d / 3_600_000) + "h ago";
  return Math.round(d / 86_400_000) + "d ago";
}

// ─── Stats — for /api/stats + /stats page ─────────────────────────────────────

export async function graphStats(redis, userId) {
  if (!redis || !userId) return null;
  const [nodeIds, edgeKeys] = await Promise.all([
    redis.smembers(keyNodesSet(userId)),
    redis.smembers(keyEdgesSet(userId)),
  ]);
  const byType = {};
  for (const id of (nodeIds || [])) {
    const t = id.split(":")[0];
    byType[t] = (byType[t] || 0) + 1;
  }
  return {
    nodes:  (nodeIds  || []).length,
    edges:  (edgeKeys || []).length,
    byType,
  };
}

// ─── Pruning (optional, not called from chat path) ────────────────────────────
// Drops weakest nodes/edges when above soft caps. Run from a cron or
// inner-loop; safe to call concurrently with chat traffic but not
// atomic with it.

export async function pruneGraph(redis, userId) {
  const [nodeIds, edgeKeys] = await Promise.all([
    redis.smembers(keyNodesSet(userId)),
    redis.smembers(keyEdgesSet(userId)),
  ]);
  let droppedN = 0, droppedE = 0;

  if ((nodeIds || []).length > MAX_NODES) {
    const all = await Promise.all(nodeIds.map(id => safeJson(redis, keyNode(userId, id))));
    const valid = all.filter(Boolean);
    valid.sort((a, b) => (a.count + (a.lastSeen / 1e12)) - (b.count + (b.lastSeen / 1e12)));
    const excess = valid.length - MAX_NODES;
    for (let i = 0; i < excess; i++) {
      const n = valid[i];
      await Promise.all([
        redis.del(keyNode(userId, n.id)),
        redis.srem(keyNodesSet(userId), n.id),
        redis.srem(keyByType(userId, n.type), n.id),
      ]);
      droppedN++;
    }
  }

  if ((edgeKeys || []).length > MAX_EDGES) {
    const all = await Promise.all(edgeKeys.map(k => safeJson(redis, keyEdge(userId, k))));
    const valid = all.filter(Boolean);
    valid.sort((a, b) => (a.weight + (a.lastSeen / 1e12)) - (b.weight + (b.lastSeen / 1e12)));
    const excess = valid.length - MAX_EDGES;
    for (let i = 0; i < excess; i++) {
      const e = valid[i];
      const ek = edgeKey(e.from, e.type, e.to);
      await Promise.all([
        redis.del(keyEdge(userId, ek)),
        redis.srem(keyEdgesSet(userId), ek),
        redis.srem(keyOut(userId, e.from), ek),
        redis.srem(keyIn(userId, e.to), ek),
      ]);
      droppedE++;
    }
  }

  return { droppedN, droppedE };
}
