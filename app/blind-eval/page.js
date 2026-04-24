"use client";
// app/blind-eval/page.js
//
// Blind human A/B eval UI.
//
// Shows one scenario at a time with two anonymized candidate replies
// labeled A and B (server-side randomly swapped). The voter picks
// A, B, or tie. No source labels visible during voting — the only
// way to infer which side is Gabriella is by taste.
//
// After voting, the next pair loads automatically. A small stats
// strip at the top shows total votes, Gabriella win rate, and the
// Wilson 95% CI — with an 'actually better' flag lit only when the
// CI's lower bound is above 0.5.

import { useEffect, useState } from "react";

export default function BlindEvalPage() {
  const [pair, setPair]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone]   = useState(false);
  const [stats, setStats] = useState(null);
  const [voted, setVoted] = useState(0);
  const [error, setError] = useState(null);

  const loadNext = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/blind-eval?action=next");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "request failed");
      if (data.done) { setDone(true); setPair(null); }
      else           { setPair(data.pair); setDone(false); }
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadStats = async () => {
    try {
      const res = await fetch("/api/blind-eval?action=stats");
      const data = await res.json();
      if (data.ok) setStats(data.stats);
    } catch { /* silent */ }
  };

  useEffect(() => { loadNext(); loadStats(); }, []);

  const vote = async (pick) => {
    if (!pair) return;
    try {
      await fetch("/api/blind-eval", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          action: "vote",
          pairId: pair.pairId,
          pick,
          swap:   pair.swap,
        }),
      });
      setVoted(v => v + 1);
      loadStats();
      loadNext();
    } catch (e) {
      setError(e?.message || String(e));
    }
  };

  const pct = (x) => x == null ? "—" : `${Math.round(x * 100)}%`;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#08080f",
      color: "rgba(255,255,255,0.9)",
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      padding: "40px 24px 80px",
    }}>
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, fontWeight: 500, letterSpacing: "0.04em", margin: 0 }}>
          Blind A/B — which reads better?
        </h1>
        <p style={{ fontSize: 13, opacity: 0.55, marginTop: 8, lineHeight: 1.55 }}>
          Two replies to the same opener. No labels. Pick whichever sounds more like a
          real person meeting you — or tie if neither does. Swap is randomized per pair.
        </p>

        {/* Stats strip */}
        {stats && (
          <div style={{
            marginTop: 22, padding: "14px 18px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 10,
            display: "flex", gap: 28, fontSize: 13, flexWrap: "wrap",
          }}>
            <div><span style={{ opacity: 0.55 }}>votes:</span> {stats.totalVotes}</div>
            <div><span style={{ opacity: 0.55 }}>gabriella wins:</span> {stats.gabWins} / {stats.gabWins + stats.gabLoss} ({pct(stats.winRate)})</div>
            <div><span style={{ opacity: 0.55 }}>95% CI:</span> [{pct(stats.ci?.low)}, {pct(stats.ci?.high)}]</div>
            <div><span style={{ opacity: 0.55 }}>ties:</span> {stats.ties}</div>
            <div><span style={{ opacity: 0.55 }}>pairs in pool:</span> {stats.pairCount}</div>
            {stats.actuallyBetter && (
              <div style={{ color: "rgba(140,255,160,0.9)", fontWeight: 500 }}>
                ◉ actually better (CI lower bound {'>'} 0.5)
              </div>
            )}
          </div>
        )}

        {/* Vote panel */}
        <div style={{ marginTop: 32 }}>
          {error && (
            <div style={{ color: "rgba(255,150,150,0.9)", padding: 16, fontSize: 13 }}>
              {error}
            </div>
          )}
          {loading && <div style={{ opacity: 0.5 }}>loading...</div>}
          {done && !loading && (
            <div style={{ padding: 24, textAlign: "center", opacity: 0.6 }}>
              You've voted on every pair currently in the pool. Check back after more are added — or submit your own from another tool.
            </div>
          )}
          {pair && !loading && (
            <>
              <div style={{
                padding: "18px 20px",
                background: "rgba(255,175,70,0.05)",
                borderLeft: "2px solid rgba(255,175,70,0.45)",
                fontSize: 15, fontStyle: "italic",
                borderRadius: 4,
              }}>
                {pair.scenario.opener}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 22 }}>
                {[["a", pair.a], ["b", pair.b]].map(([key, cand]) => (
                  <button
                    key={key}
                    onClick={() => vote(key)}
                    style={{
                      textAlign: "left",
                      padding: 18,
                      background: "rgba(255,255,255,0.04)",
                      border: "1px solid rgba(255,255,255,0.09)",
                      borderRadius: 8,
                      color: "inherit",
                      fontSize: 14,
                      lineHeight: 1.55,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      minHeight: 120,
                      whiteSpace: "pre-wrap",
                      transition: "background 0.15s, border 0.15s",
                    }}
                    onMouseOver={e => {
                      e.currentTarget.style.background = "rgba(255,175,70,0.08)";
                      e.currentTarget.style.borderColor = "rgba(255,175,70,0.4)";
                    }}
                    onMouseOut={e => {
                      e.currentTarget.style.background = "rgba(255,255,255,0.04)";
                      e.currentTarget.style.borderColor = "rgba(255,255,255,0.09)";
                    }}
                  >
                    <div style={{ fontSize: 11, opacity: 0.45, marginBottom: 8, letterSpacing: "0.05em" }}>{key.toUpperCase()}</div>
                    {cand.text}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 16, textAlign: "center" }}>
                <button
                  onClick={() => vote("tie")}
                  style={{
                    padding: "10px 20px",
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 20,
                    color: "rgba(255,255,255,0.55)",
                    cursor: "pointer",
                    fontSize: 12,
                    letterSpacing: "0.05em",
                    fontFamily: "inherit",
                  }}
                >
                  tie — neither wins
                </button>
              </div>
              <div style={{ fontSize: 11, opacity: 0.35, marginTop: 18, textAlign: "center" }}>
                you've voted {voted} this session
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
