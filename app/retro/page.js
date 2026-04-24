"use client";

// app/retro/page.js
// User-facing relationship retrospective. "Here is how Gabriella
// has been seeing you" in plain English + structured detail.
//
// Transparency as feature. No chat product shows you its interior
// model of you because no chat product HAS one. Gabriella does, and
// it's hers to share.

import { useEffect, useState } from "react";
import Link from "next/link";

const css = {
  shell: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "40px 20px", boxSizing: "border-box" },
  wrap:  { maxWidth: 760, margin: "0 auto" },
  h1:    { margin: "0 0 6px", fontSize: 26, fontWeight: 600, letterSpacing: 0.2, color: "#ffd6b0" },
  subtitle: { margin: "0 0 24px", color: "#a0a0b0", fontSize: 13 },
  h2:    { margin: "28px 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "#ffb070", letterSpacing: 1.6 },
  card:  { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 16, marginBottom: 10 },
  summary: { fontSize: 15, lineHeight: 1.65, color: "#cfcfd8", whiteSpace: "pre-wrap" },
  readWho:  { fontSize: 14, lineHeight: 1.6, color: "#e4e4ed", fontStyle: "italic", margin: "6px 0 10px" },
  meta:     { fontSize: 11, color: "#8a8a99", marginTop: 8 },
  wantRow:  { padding: "8px 0", borderBottom: "1px dashed #22222e", fontSize: 13 },
  wantText: { color: "#e4e4ed", lineHeight: 1.55 },
  wantMeta: { fontSize: 11, color: "#8a8a99", marginTop: 4 },
  bar:      (pct) => ({ height: 3, background: "#1f1f2b", borderRadius: 2, marginTop: 5 }),
  barFill:  (pct, color) => ({ height: "100%", width: `${pct}%`, background: color, borderRadius: 2 }),
  streamEntry: { padding: "6px 0", fontSize: 13, color: "#cfcfd8", borderBottom: "1px dashed #1f1f2b" },
  kindBadge: (color) => ({ display: "inline-block", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.8, padding: "2px 6px", borderRadius: 3, background: color, color: "#0a0a0f", marginRight: 8, fontWeight: 600 }),
  retiredRow: { padding: "5px 0", fontSize: 12, color: "#8a8a99", borderBottom: "1px dashed #1f1f2b" },
  error: { background: "#2a1a1a", border: "1px solid #6a2a2a", borderRadius: 8, padding: 12, fontSize: 13, color: "#ffc4c4" },
  quiet: { fontSize: 13, color: "#8a8a99", fontStyle: "italic" },
  link:  { color: "#ffb070", textDecoration: "none" },
};

// Conversation arc chart — SVG sparkline-style. Two series stacked:
// temperature (closed→terse→present→open mapped to 0..3) as a line
// with edge-flagged points marked, and pragmatic weight (0..1) as a
// separate light line below. Oldest-on-left so the rightmost point
// is "right now."
function ArcChart({ arc }) {
  if (!arc || arc.length < 2) return null;

  const W = 680;
  const H = 110;
  const pad = { l: 32, r: 12, t: 8, b: 18 };

  const tempMap = { closed: 0, terse: 1, present: 2, open: 3 };
  // Reverse so most-recent is rightmost (server returns newest-first).
  const points = [...arc].reverse();

  const xFor = (i) => pad.l + ((W - pad.l - pad.r) * (i / Math.max(1, points.length - 1)));
  // Temperature axis takes the upper 60% of plot
  const tempY = (v) => pad.t + (1 - v / 3) * ((H - pad.t - pad.b) * 0.6);
  // Weight axis takes the lower 40%
  const weightY = (w) => pad.t + (H - pad.t - pad.b) * 0.6 + (1 - (w ?? 0)) * ((H - pad.t - pad.b) * 0.4);

  // Build temperature path (skip nulls).
  const tempPath = points
    .map((p, i) => p.temp != null && tempMap[p.temp] != null
      ? `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${tempY(tempMap[p.temp]).toFixed(1)}`
      : null)
    .filter(Boolean)
    .join(" ");

  const weightPath = points
    .map((p, i) => typeof p.weight === "number"
      ? `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${weightY(p.weight).toFixed(1)}`
      : null)
    .filter(Boolean)
    .join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
      {/* Temperature axis labels */}
      <text x={4} y={tempY(3) + 3} fontSize={8} fill="#555566">open</text>
      <text x={4} y={tempY(2) + 3} fontSize={8} fill="#555566">present</text>
      <text x={4} y={tempY(1) + 3} fontSize={8} fill="#555566">terse</text>
      <text x={4} y={tempY(0) + 3} fontSize={8} fill="#555566">closed</text>
      <text x={4} y={weightY(1) + 3} fontSize={8} fill="#555566">w 1</text>
      <text x={4} y={weightY(0) + 3} fontSize={8} fill="#555566">w 0</text>

      {/* Faint horizontal gridlines */}
      {[0, 1, 2, 3].map(v => (
        <line key={v} x1={pad.l} x2={W - pad.r} y1={tempY(v)} y2={tempY(v)} stroke="#22222e" strokeWidth={0.5} />
      ))}
      <line x1={pad.l} x2={W - pad.r} y1={weightY(0)} y2={weightY(0)} stroke="#22222e" strokeWidth={0.5} />
      <line x1={pad.l} x2={W - pad.r} y1={weightY(1)} y2={weightY(1)} stroke="#22222e" strokeWidth={0.5} />

      {/* Temperature line — amber */}
      {tempPath && <path d={tempPath} fill="none" stroke="#ffb070" strokeWidth={1.5} />}

      {/* Weight line — slate */}
      {weightPath && <path d={weightPath} fill="none" stroke="#93c5fd" strokeWidth={1} opacity={0.7} />}

      {/* Edge-flagged points — open circles */}
      {points.map((p, i) => p.edge && p.temp && tempMap[p.temp] != null ? (
        <circle key={i} cx={xFor(i)} cy={tempY(tempMap[p.temp])} r={2.4} fill="#fca5a5" stroke="#0a0a0f" strokeWidth={0.6} />
      ) : null)}

      {/* Right-edge "now" tick */}
      <line x1={W - pad.r} x2={W - pad.r} y1={pad.t} y2={H - pad.b} stroke="#33334a" strokeWidth={0.5} strokeDasharray="2 2" />
      <text x={W - pad.r - 22} y={H - 4} fontSize={8} fill="#555566">now</text>
    </svg>
  );
}

const KIND_COLOR = {
  thought:     "#93c5fd",
  connection:  "#a78bfa",
  prediction:  "#fcd34d",
  surprise:    "#f87171",
  "re-reading":"#c4b5fd",
  intent:      "#4ade80",
  observation: "#8a8a99",
  abandon:     "#555566",
};

export default function RetroPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/retro");
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "failed");
      setData(j);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  if (loading && !data) return <div style={css.shell}><div style={css.wrap}><p style={{color: "#8a8a99"}}>loading…</p></div></div>;
  if (error) return <div style={css.shell}><div style={css.wrap}><div style={css.error}>{error}</div></div></div>;
  if (!data) return null;

  const { summary, read, wants, commitments, retired, stream, plan, callbacks, chronology, arc } = data;
  const hasAny = summary || read || (wants || []).length || (commitments || []).length;

  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <h1 style={css.h1}>How she sees you.</h1>
        <p style={css.subtitle}>
          What Gabriella has come to think about your relationship. Shown to you directly — no chat product
          has ever shown this because none of them have had it to show.
          {" "}<button onClick={load} style={{ background: "none", border: "1px solid #33334a", color: "#8a8a99", padding: "2px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer" }}>refresh</button>
          {" · "}<Link href="/" style={css.link}>back to chat</Link>
        </p>

        {!hasAny && (
          <div style={css.card}>
            <p style={css.quiet}>You haven't talked much yet. She doesn't have a read of you that's worth reporting. Come back after a few conversations.</p>
          </div>
        )}

        {summary && (
          <div style={css.card}>
            <p style={css.summary}>{summary}</p>
          </div>
        )}

        {read?.who && (
          <>
            <h2 style={css.h2}>Her read on you</h2>
            <div style={css.card}>
              <div style={css.readWho}>"{read.who}"</div>
              <div style={css.meta}>
                confidence: {Math.round((read.confidence || 0) * 100)}% · updated {read.lastUpdatedAgo}
              </div>
              {read.openQuestions?.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: "#cfcfd8" }}>
                  <div style={{ color: "#8a8a99", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 }}>open questions</div>
                  {read.openQuestions.map((q, i) => <div key={i}>— {q}</div>)}
                </div>
              )}
              {read.contradictions?.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: "#cfcfd8" }}>
                  <div style={{ color: "#8a8a99", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 4 }}>what her read doesn't explain</div>
                  {read.contradictions.map((c, i) => <div key={i}>— {c}</div>)}
                </div>
              )}
            </div>
          </>
        )}

        {(wants || []).length > 0 && (
          <>
            <h2 style={css.h2}>What she's pursuing with you</h2>
            <div style={css.card}>
              {wants.filter(w => (w.weight || 0) >= 0.2).map((w, i) => (
                <div key={i} style={css.wantRow}>
                  <div style={css.wantText}>— {w.text}</div>
                  <div style={css.wantMeta}>weight {Math.round((w.weight||0) * 100)}% · {w.touches} touches · added {w.addedAgo}</div>
                  <div style={css.bar(0)}>
                    <div style={css.barFill((w.weight || 0) * 100, "#ffb070")} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {(commitments || []).filter(c => c.status !== "refuted").length > 0 && (
          <>
            <h2 style={css.h2}>Positions she's taken</h2>
            <div style={css.card}>
              {commitments.filter(c => c.status !== "refuted").map((c, i) => (
                <div key={i} style={css.wantRow}>
                  <div style={css.wantText}>— {c.text}</div>
                  <div style={css.wantMeta}>
                    {c.confirmations} confirmation{c.confirmations !== 1 ? "s" : ""} · {c.refutations} refutation{c.refutations !== 1 ? "s" : ""}
                    {c.status === "confirmed" && <span style={{ marginLeft: 6, color: "#4ade80" }}>· confirmed</span>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {arc && arc.length >= 2 && (
          <>
            <h2 style={css.h2}>Conversation arc</h2>
            <div style={css.card}>
              <ArcChart arc={arc} />
              <div style={{ ...css.meta, marginTop: 6, lineHeight: 1.5 }}>
                amber line: temperature (closed → terse → present → open) ·
                blue line: weight (0 light → 1 heavy) ·
                red dots: turns where she felt an edge underneath ·
                rightmost point: most recent turn
              </div>
            </div>
          </>
        )}

        {((retired?.wants?.length || 0) + (retired?.reads?.length || 0) + (retired?.commitments?.length || 0)) > 0 && (
          <>
            <h2 style={css.h2}>What she's outgrown</h2>
            <div style={css.card}>
              {retired.wants.map((r, i) => <div key={`w${i}`} style={css.retiredRow}>retired want: "{r.text}" — {r.reason}</div>)}
              {retired.reads.map((r, i) => <div key={`r${i}`} style={css.retiredRow}>retired read: "{r.text}" — {r.reason}</div>)}
              {retired.commitments.map((r, i) => <div key={`c${i}`} style={css.retiredRow}>retired position: "{r.text}" — {r.outcome}</div>)}
            </div>
          </>
        )}

        {(stream || []).length > 0 && (
          <>
            <h2 style={css.h2}>Recently on her mind</h2>
            <div style={css.card}>
              {stream.map((e, i) => (
                <div key={i} style={css.streamEntry}>
                  <span style={css.kindBadge(KIND_COLOR[e.kind] || "#8a8a99")}>{e.kind}</span>
                  {e.content}
                  <span style={{ color: "#555566", fontSize: 11, marginLeft: 6 }}>{e.ago}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {plan && (
          <>
            <h2 style={css.h2}>Her posture for this session</h2>
            <div style={css.card}>
              <div style={{ ...css.summary, fontStyle: "italic" }}>{plan.intent}</div>
              {plan.avoid && <div style={{ ...css.meta, marginTop: 8 }}>avoiding: {plan.avoid}</div>}
              <div style={css.meta}>formed {plan.ago}</div>
            </div>
          </>
        )}

        {callbacks && callbacks.total >= 3 && (
          <>
            <h2 style={css.h2}>Memory texture</h2>
            <div style={css.card}>
              <div style={{ fontSize: 14, color: "#e4e4ed" }}>
                When she references something from your past conversations, it lands {Math.round(callbacks.landingRate * 100)}% of the time.
              </div>
              <div style={css.meta}>
                {callbacks.landed} landed · {callbacks.missed} missed · {callbacks.total} total references
              </div>
            </div>
          </>
        )}

        <div style={{ fontSize: 10, color: "#555566", textAlign: "center", marginTop: 32, letterSpacing: 0.5 }}>
          raw JSON at <a href="/api/retro" style={{color: "#8a8a99"}}>/api/retro</a>
        </div>
      </div>
    </div>
  );
}
