"use client";

// app/admin/page.js
//
// Single ops entrypoint. Everything you'd previously need a terminal
// + curl + gh CLI for lives here as real buttons + live data:
//
//   - Deploy health:          /healthz + /api/stats.readiness pulled live
//   - Validation actions:     integration bench (6 scenarios), seed
//                             blind-eval with live pairs, recompute
//                             dead-block skip list, run dialectical
//                             audit
//   - Live telemetry snapshot: prompt size, breakers, skip list,
//                             blind-eval CI, gauntlet pass rate
//   - Quick nav:              /stats, /retro, /blind-eval, /dev,
//                             /meet, /memory, /prefs + GitHub Actions
//                             (APK build) link
//
// Token gating: if ADMIN_TOKEN is set in env, action buttons require
// the user paste it into the box; the token is cached in localStorage
// on this device only. Read-only panels (health, telemetry) are
// always visible so a glance doesn't require auth.

import { useCallback, useEffect, useState } from "react";

const GITHUB_REPO = "WW-Andene/Gabriella";

const css = {
  shell:    { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "24px 16px", boxSizing: "border-box" },
  wrap:     { maxWidth: 900, margin: "0 auto" },
  h1:       { margin: "0 0 4px", fontSize: 22, fontWeight: 600, letterSpacing: 0.2 },
  sub:      { margin: "0 0 20px", color: "#8a8a99", fontSize: 12 },
  grid:     { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10 },
  card:     { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 14, marginBottom: 10 },
  cardT:    { margin: "0 0 10px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "#a0a0b0", letterSpacing: 1.2 },
  kv:       { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, borderBottom: "1px dashed #22222e" },
  k:        { color: "#8a8a99" },
  v:        { color: "#e4e4ed", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, textAlign: "right" },
  btnRow:   { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 },
  btn:      { padding: "9px 14px", border: "1px solid #33334a", borderRadius: 6, background: "#1d1d28", color: "#e4e4ed", fontSize: 13, cursor: "pointer", fontWeight: 500, fontFamily: "inherit" },
  btnP:     { padding: "9px 14px", border: "1px solid #4a6aff", borderRadius: 6, background: "#2a3bae", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 500, fontFamily: "inherit" },
  btnBusy:  { padding: "9px 14px", border: "1px solid #33334a", borderRadius: 6, background: "#1d1d28", color: "#666", fontSize: 13, cursor: "wait", fontWeight: 500, fontFamily: "inherit" },
  input:    { width: "100%", padding: "8px 10px", border: "1px solid #33334a", borderRadius: 6, background: "#0f0f16", color: "#e4e4ed", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit", marginBottom: 8 },
  code:     { background: "#05050a", padding: "10px", borderRadius: 6, fontSize: 11, fontFamily: "ui-monospace, Menlo, monospace", maxHeight: 340, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#a0c0ff", marginTop: 8 },
  dot:      (color) => ({ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: color, marginRight: 8, verticalAlign: "middle" }),
  linkRow:  { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 },
  linkPill: { padding: "4px 10px", borderRadius: 12, background: "#1d1d28", color: "#a0a0b0", fontSize: 12, textDecoration: "none", border: "1px solid #22222e" },
};

const dotFor = (ok) => ok ? css.dot("#4ade80") : css.dot("#f87171");

export default function AdminPage() {
  const [token, setToken]       = useState("");
  const [stats, setStats]       = useState(null);
  const [health, setHealth]     = useState(null);
  const [err, setErr]           = useState(null);
  const [busy, setBusy]         = useState(null);     // name of the in-flight action
  const [benchOut, setBenchOut] = useState(null);
  const [seedOut, setSeedOut]   = useState(null);
  const [skipOut, setSkipOut]   = useState(null);
  const [auditOut, setAuditOut] = useState(null);

  // Load cached token from localStorage
  useEffect(() => {
    try { setToken(localStorage.getItem("gab:adminToken") || ""); } catch {}
  }, []);
  const saveToken = (t) => {
    setToken(t);
    try { localStorage.setItem("gab:adminToken", t); } catch {}
  };

  const fetchHealth = useCallback(async () => {
    try {
      const h = await fetch("/healthz").then(r => r.ok ? r.text() : null).catch(() => null);
      setHealth(h);
    } catch { setHealth(null); }
  }, []);
  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch("/api/stats");
      if (!r.ok) { setErr(`/api/stats returned ${r.status}`); return; }
      const j = await r.json();
      setStats(j);
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }, []);
  useEffect(() => { fetchHealth(); fetchStats(); }, [fetchHealth, fetchStats]);

  const runAction = async (name, path, outSetter) => {
    setBusy(name);
    setErr(null);
    try {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const r = await fetch(path, { method: "POST", headers });
      const j = await r.json().catch(() => ({ ok: false, error: "bad json" }));
      outSetter(j);
      fetchStats();
    } catch (e) {
      outSetter({ ok: false, error: e?.message || String(e) });
    } finally {
      setBusy(null);
    }
  };

  const readiness = stats?.readiness || {};
  const actionsUrl = `https://github.com/${GITHUB_REPO}/actions/workflows/build-apk.yml`;

  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <h1 style={css.h1}>Gabriella — admin</h1>
        <p style={css.sub}>One ops entrypoint. Read-only panels load on mount; action buttons need an ADMIN_TOKEN if one is configured.</p>

        {err && <div style={{ ...css.card, borderColor: "#6a2a2a", background: "#2a1a1a", color: "#ffc4c4" }}>{err}</div>}

        {/* ── DEPLOY HEALTH ── */}
        <div style={css.card}>
          <div style={css.cardT}>Deploy health</div>
          <div style={css.kv}>
            <span style={css.k}>/healthz</span>
            <span style={css.v}>{health === null ? "…" : <><span style={dotFor(!!health)} />{health ? "ok" : "unreachable"}</>}</span>
          </div>
          <div style={css.kv}><span style={css.k}>upstash redis</span>      <span style={css.v}><span style={dotFor(readiness.upstashConfigured)} />{readiness.upstashConfigured ? "configured" : "missing"}</span></div>
          <div style={css.kv}><span style={css.k}>upstash vector</span>     <span style={css.v}><span style={dotFor(readiness.upstashVectorConfigured)} />{readiness.upstashVectorConfigured ? "configured" : "missing"}</span></div>
          <div style={css.kv}><span style={css.k}>groq keys</span>          <span style={css.v}><span style={dotFor(readiness.groqConfigured)} />{readiness.groqConfigured ? "live" : "none"}</span></div>
          <div style={css.kv}><span style={css.k}>cerebras keys</span>      <span style={css.v}><span style={dotFor(readiness.cerebrasConfigured)} />{readiness.cerebrasConfigured ? "live" : "none"}</span></div>
          <div style={css.kv}><span style={css.k}>gemini keys</span>        <span style={css.v}><span style={dotFor(readiness.geminiConfigured)} />{readiness.geminiConfigured ? "live" : "none"}</span></div>
          <div style={css.kv}><span style={css.k}>fireworks</span>          <span style={css.v}><span style={dotFor(readiness.fireworksConfigured)} />{readiness.fireworksConfigured ? "configured" : "off"}</span></div>
          <div style={css.kv}><span style={css.k}>cron secret</span>        <span style={css.v}><span style={dotFor(readiness.cronSecretSet)} />{readiness.cronSecretSet ? "set" : "unset"}</span></div>
        </div>

        {/* ── AUTH ── */}
        <div style={css.card}>
          <div style={css.cardT}>Admin token</div>
          <p style={{ ...css.sub, margin: "0 0 6px" }}>If ADMIN_TOKEN is set on the server, paste it here (cached in localStorage; never sent anywhere but this origin).</p>
          <input style={css.input} type="password" placeholder="ADMIN_TOKEN" value={token} onChange={e => saveToken(e.target.value)} />
        </div>

        <div style={css.grid}>

          {/* ── INTEGRATION BENCH ── */}
          <div style={css.card}>
            <div style={css.cardT}>Integration bench (6 scenarios)</div>
            <p style={css.sub}>Exercises turnShape routing, rollout, gauntlet modes, bridge. ~30–60s wall time. Privacy-mode, won't poison real state.</p>
            <div style={css.btnRow}>
              <button
                style={busy === "bench" ? css.btnBusy : css.btnP}
                disabled={!!busy}
                onClick={() => runAction("bench", "/api/admin/bench", setBenchOut)}
              >{busy === "bench" ? "running…" : "run bench"}</button>
            </div>
            {benchOut && <pre style={css.code}>{JSON.stringify(benchOut.summary || benchOut, null, 2)}</pre>}
          </div>

          {/* ── SEED BLIND EVAL ── */}
          <div style={css.card}>
            <div style={css.cardT}>Seed blind-eval from live bench</div>
            <p style={css.sub}>Runs the bench and posts each (gabriella-reply, baseline-stub) pair to /api/blind-eval so voting reflects current production output, not just the illustrative seed set.</p>
            <div style={css.btnRow}>
              <button
                style={busy === "seed" ? css.btnBusy : css.btn}
                disabled={!!busy}
                onClick={() => runAction("seed", "/api/admin/seed-blind", setSeedOut)}
              >{busy === "seed" ? "running…" : "seed blind-eval"}</button>
              <a style={css.linkPill} href="/blind-eval">open /blind-eval →</a>
            </div>
            {seedOut && <pre style={css.code}>{JSON.stringify(seedOut.seeded ? { seeded: seedOut.seeded.length, ok: seedOut.seeded.filter(x => x.ok).length } : seedOut, null, 2)}</pre>}
          </div>

          {/* ── SKIP LIST ── */}
          <div style={css.card}>
            <div style={css.cardT}>Dead-block skip list</div>
            <p style={css.sub}>Force recompute of the empirical prompt-slot skip set (Step TT). Normally auto-refreshes every 24h.</p>
            <div style={css.kv}><span style={css.k}>current skip size</span><span style={css.v}>{stats?.skipList?.skipSet?.length ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>turns observed</span>    <span style={css.v}>{stats?.skipList?.turnsObserved ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>last compute</span>      <span style={css.v}>{stats?.skipList?.ageHours != null ? `${stats.skipList.ageHours}h ago` : "never"}</span></div>
            <div style={css.btnRow}>
              <button
                style={busy === "skip" ? css.btnBusy : css.btn}
                disabled={!!busy}
                onClick={() => runAction("skip", "/api/admin/recompute-skiplist", setSkipOut)}
              >{busy === "skip" ? "recomputing…" : "recompute now"}</button>
            </div>
            {skipOut && <pre style={css.code}>{JSON.stringify(skipOut.payload || skipOut, null, 2)}</pre>}
          </div>

          {/* ── DIALECTICAL AUDIT ── */}
          <div style={css.card}>
            <div style={css.cardT}>Dialectical audit</div>
            <p style={css.sub}>Scan her position log for contradictions over time (Step XX). Surfaces them as tensions in the next turn's stream.</p>
            <div style={css.kv}><span style={css.k}>positions logged</span><span style={css.v}>{stats?.dialectical?.positions ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>tensions held</span>   <span style={css.v}>{stats?.dialectical?.tensions ?? "—"}</span></div>
            <div style={css.btnRow}>
              <button
                style={busy === "audit" ? css.btnBusy : css.btn}
                disabled={!!busy}
                onClick={async () => {
                  setBusy("audit"); setErr(null);
                  try {
                    const r = await fetch("/api/dialectical?run=1");
                    const j = await r.json();
                    setAuditOut(j);
                    fetchStats();
                  } catch (e) { setAuditOut({ ok: false, error: e?.message || String(e) }); }
                  finally { setBusy(null); }
                }}
              >{busy === "audit" ? "auditing…" : "run audit"}</button>
            </div>
            {auditOut && <pre style={css.code}>{JSON.stringify(auditOut.result || auditOut, null, 2)}</pre>}
          </div>

          {/* ── BLIND EVAL SNAPSHOT ── */}
          <div style={css.card}>
            <div style={css.cardT}>Blind A/B — human preference</div>
            <div style={css.kv}><span style={css.k}>votes</span>        <span style={css.v}>{stats?.blindEval?.totalVotes ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>gabriella wins</span><span style={css.v}>{stats?.blindEval ? `${stats.blindEval.gabWins} / ${stats.blindEval.gabWins + stats.blindEval.gabLoss}` : "—"}</span></div>
            <div style={css.kv}><span style={css.k}>win rate</span>     <span style={css.v}>{stats?.blindEval?.winRate != null ? `${Math.round(stats.blindEval.winRate * 100)}%` : "—"}</span></div>
            <div style={css.kv}><span style={css.k}>95% CI</span>       <span style={css.v}>{stats?.blindEval?.ci ? `[${Math.round(stats.blindEval.ci.low * 100)}%, ${Math.round(stats.blindEval.ci.high * 100)}%]` : "—"}</span></div>
            <div style={css.kv}>
              <span style={css.k}>actually better?</span>
              <span style={css.v}>
                {stats?.blindEval?.actuallyBetter
                  ? <><span style={css.dot("#4ade80")} />yes (CI lower {'>'} 0.5)</>
                  : <span style={{ color: "#8a8a99" }}>not yet</span>}
              </span>
            </div>
            <div style={css.btnRow}><a style={css.linkPill} href="/blind-eval">vote →</a></div>
          </div>

          {/* ── APK BUILD ── */}
          <div style={css.card}>
            <div style={css.cardT}>Android APK build</div>
            <p style={css.sub}>Bubblewrap TWA pipeline (Step SS). Workflow runs on GitHub Actions; not locally runnable. Opens Actions tab where you click "Run workflow".</p>
            <div style={css.btnRow}>
              <a style={css.linkPill} href={actionsUrl} target="_blank" rel="noreferrer">open Actions →</a>
              <a style={css.linkPill} href="/manifest.webmanifest" target="_blank" rel="noreferrer">view manifest</a>
              <a style={css.linkPill} href="/icon-512.png" target="_blank" rel="noreferrer">view icon</a>
            </div>
          </div>

          {/* ── TELEMETRY SNAPSHOT ── */}
          <div style={css.card}>
            <div style={css.cardT}>Live telemetry</div>
            <div style={css.kv}><span style={css.k}>prompt chars (avg)</span><span style={css.v}>{stats?.promptAudit?.avgChars ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>prompt tokens (≈)</span> <span style={css.v}>{stats?.promptAudit?.avgTokens ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>wave A p95</span>        <span style={css.v}>{stats?.promptAudit?.phaseTimings?.waveA?.p95 ?? "—"}ms</span></div>
            <div style={css.kv}><span style={css.k}>wave B p95</span>        <span style={css.v}>{stats?.promptAudit?.phaseTimings?.waveB?.p95 ?? "—"}ms</span></div>
            <div style={css.kv}><span style={css.k}>gauntlet pass rate</span><span style={css.v}>{stats?.gauntlet?.passRate != null ? `${Math.round(stats.gauntlet.passRate * 100)}%` : "—"}</span></div>
            <div style={css.kv}><span style={css.k}>graph nodes</span>       <span style={css.v}>{stats?.graph?.nodes ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>graph edges</span>       <span style={css.v}>{stats?.graph?.edges ?? "—"}</span></div>
            <div style={css.kv}><span style={css.k}>rel time mult avg</span> <span style={css.v}>{stats?.relTime?.avgMultiplier ?? "—"}×</span></div>
          </div>

        </div>

        {/* ── NAV ── */}
        <div style={css.card}>
          <div style={css.cardT}>Other consoles</div>
          <div style={css.linkRow}>
            <a style={css.linkPill} href="/stats">/stats (read-only)</a>
            <a style={css.linkPill} href="/retro">/retro</a>
            <a style={css.linkPill} href="/dev">/dev (training pipeline)</a>
            <a style={css.linkPill} href="/blind-eval">/blind-eval</a>
            <a style={css.linkPill} href="/memory">/memory</a>
            <a style={css.linkPill} href="/prefs">/prefs</a>
            <a style={css.linkPill} href="/meet">/meet</a>
            <a style={css.linkPill} href="/">/ (chat)</a>
            <a style={css.linkPill} target="_blank" rel="noreferrer" href={`https://github.com/${GITHUB_REPO}/actions`}>GitHub Actions →</a>
          </div>
        </div>

      </div>
    </div>
  );
}
