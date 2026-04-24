"use client";

// app/dev/page.js
// One-page dev dashboard for Gabriella's training + fine-tune pipeline.
//
// Replaces a dozen bookmarked URLs with a single page. Secret is typed
// once and kept in localStorage (this browser, this device only).
// Everything speaks to existing /api/* endpoints.

import { useEffect, useMemo, useState, useCallback } from "react";

// ─── Styles (no external deps) ───────────────────────────────────────────────

const css = {
  shell:    { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "20px", boxSizing: "border-box" },
  wrap:     { maxWidth: 860, margin: "0 auto" },
  h1:       { margin: "0 0 4px", fontSize: 22, fontWeight: 600, letterSpacing: 0.2 },
  subtitle: { margin: "0 0 24px", color: "#8a8a99", fontSize: 13 },
  card:     { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 14, marginBottom: 12 },
  cardTitle:{ margin: "0 0 10px", fontSize: 14, fontWeight: 600, textTransform: "uppercase", color: "#a0a0b0", letterSpacing: 1 },
  btnRow:   { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 },
  btn:      { padding: "9px 14px", border: "1px solid #33334a", borderRadius: 6, background: "#1d1d28", color: "#e4e4ed", fontSize: 13, cursor: "pointer", fontWeight: 500 },
  btnP:     { padding: "9px 14px", border: "1px solid #4a6aff", borderRadius: 6, background: "#2a3bae", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 500 },
  btnD:     { padding: "9px 14px", border: "1px solid #aa3333", borderRadius: 6, background: "#3a1a1a", color: "#ffc4c4", fontSize: 13, cursor: "pointer", fontWeight: 500 },
  input:    { width: "100%", padding: "8px 10px", border: "1px solid #33334a", borderRadius: 6, background: "#0f0f16", color: "#e4e4ed", fontSize: 13, boxSizing: "border-box", fontFamily: "inherit" },
  label:    { fontSize: 11, color: "#8a8a99", textTransform: "uppercase", letterSpacing: 0.6, display: "block", marginBottom: 3, fontWeight: 500 },
  kv:       { display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13, borderBottom: "1px dashed #22222e" },
  kvKey:    { color: "#a0a0b0" },
  kvVal:    { color: "#e4e4ed", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, textAlign: "right", maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  pill:     (color) => ({ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600, background: color, color: "#0a0a0f" }),
  notice:   { background: "#1a2938", border: "1px solid #2a4a6a", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12 },
  error:    { background: "#2a1a1a", border: "1px solid #6a2a2a", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12, color: "#ffc4c4" },
  success:  { background: "#1a2a1a", border: "1px solid #2a6a2a", borderRadius: 8, padding: 10, fontSize: 13, marginBottom: 12, color: "#c4ffc4" },
  code:     { background: "#05050a", padding: "10px", borderRadius: 6, fontSize: 11, fontFamily: "ui-monospace, Menlo, monospace", maxHeight: 300, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "#a0c0ff" },
  grid2:    { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
};

const pillFor = (state) => {
  if (!state) return css.pill("#666");
  const s = String(state).toUpperCase();
  if (s.includes("COMPLETED") || s === "READY")   return css.pill("#4ade80");
  if (s.includes("RUNNING")   || s === "UPLOADING") return css.pill("#60a5fa");
  if (s.includes("FAILED")    || s === "ERROR")    return css.pill("#f87171");
  return css.pill("#d4d4a8");
};

// ─── App ─────────────────────────────────────────────────────────────────────

export default function DevPage() {
  const [secret, setSecret]   = useState("");
  const [booted, setBooted]   = useState(false);
  const [status, setStatus]   = useState(null);
  const [logs,   setLogs]     = useState(null);
  const [tab,    setTab]      = useState("dashboard"); // "dashboard" | "logs"
  const [error,  setError]    = useState(null);
  const [notice, setNotice]   = useState(null);
  const [busy,   setBusy]     = useState(false);
  const [logLevel, setLogLevel] = useState("all");
  // Bootstrap-run panel state
  const [bootstrapState,   setBootstrapState]   = useState(null);    // server-reported state
  const [bootstrapRunning, setBootstrapRunning] = useState(false);   // client loop active
  const [bootstrapOpts,    setBootstrapOpts]    = useState({
    category:   "all",
    scenarios:  "",   // blank = all
    chunkSize:  5,
    concurrency: 3,
  });

  // Load secret from localStorage on first render.
  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("gabriella_dev_secret") : null;
    if (saved) setSecret(saved);
    setBooted(true);
  }, []);

  const saveSecret = useCallback((val) => {
    setSecret(val);
    try { localStorage.setItem("gabriella_dev_secret", val); } catch {}
  }, []);

  const clearSecret = useCallback(() => {
    setSecret("");
    try { localStorage.removeItem("gabriella_dev_secret"); } catch {}
  }, []);

  const call = useCallback(async (url, options = {}) => {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  }, [secret]);

  const refresh = useCallback(async () => {
    if (!secret) return;
    setError(null);
    try {
      const [whoami, list, finetune, watch, config, health] = await Promise.all([
        call("/api/fireworks/whoami"),
        call("/api/bootstrap/list"),
        call("/api/fireworks/finetune"),
        call("/api/learn/watch"),
        call("/api/fireworks/config"),
        call("/api/health"),
      ]);
      if (whoami.status === 401 || health.status === 401) {
        setError("Unauthorized — check the secret.");
        return;
      }
      setStatus({ whoami: whoami.data, list: list.data, finetune: finetune.data, watch: watch.data, config: config.data, health: health.data });
    } catch (err) {
      setError(String(err.message || err));
    }
  }, [secret, call]);

  const refreshLogs = useCallback(async () => {
    if (!secret) return;
    try {
      const qs = logLevel !== "all" ? `?level=${logLevel}&limit=200` : "?limit=200";
      const res = await call("/api/debug/logs" + qs);
      if (res.ok) setLogs(res.data);
    } catch {}
  }, [secret, call, logLevel]);

  // Initial + periodic refresh.
  useEffect(() => {
    if (!secret) return;
    refresh();
    if (tab === "logs") refreshLogs();
    const id = setInterval(() => {
      refresh();
      if (tab === "logs") refreshLogs();
    }, 15_000);
    return () => clearInterval(id);
  }, [secret, refresh, refreshLogs, tab]);

  // ─── Bootstrap chunked runner ────────────────────────────────────────────
  // Kicks off a run, then loops continue-requests until done. Each chunk
  // is <60s so each request fits inside Vercel's function cap. Client
  // polls state between chunks.

  const bootstrapStep = useCallback(async (action = "continue", body = {}) => {
    const res = await call("/api/bootstrap/run", {
      method: "POST",
      body:   JSON.stringify({ action, ...body }),
    });
    if (res.ok) setBootstrapState(res.data.state || null);
    return res;
  }, [call]);

  const bootstrapStart = useCallback(async () => {
    setError(null);
    setNotice(null);
    const opts = bootstrapOpts;
    const body = {
      chunkSize:   Number(opts.chunkSize) || 5,
      concurrency: Number(opts.concurrency) || 3,
    };
    if (opts.category && opts.category !== "all") body.category = opts.category;
    const n = parseInt(opts.scenarios, 10);
    if (Number.isFinite(n) && n > 0) body.scenarios = n;

    const res = await bootstrapStep("start", body);
    if (!res.ok) {
      setError(`Failed to start: ${res.status} ${JSON.stringify(res.data)}`);
      return;
    }
    setBootstrapRunning(true);
    setNotice("Bootstrap started.");

    // Loop continue-requests until done.
    while (true) {
      const cont = await bootstrapStep("continue", {
        chunkSize: Number(opts.chunkSize) || 5,
      });
      if (!cont.ok) {
        setError(`Chunk failed: ${cont.status} ${JSON.stringify(cont.data).slice(0, 300)}`);
        break;
      }
      if (cont.data?.done) {
        setNotice(
          cont.data.archiveKey
            ? `Done. Archived as ${cont.data.archiveKey.split(":").pop()}.`
            : `Done. ${cont.data.state?.totalExamples || 0} examples kept.`
        );
        break;
      }
      // Tiny breather between chunks — prevents request pile-up and
      // gives Redis a moment. Not strictly necessary.
      await new Promise(r => setTimeout(r, 200));
    }
    setBootstrapRunning(false);
    await refresh();
  }, [bootstrapOpts, bootstrapStep, refresh]);

  const bootstrapAbort = useCallback(async () => {
    setBootstrapRunning(false);
    await bootstrapStep("abort");
    setNotice("Bootstrap aborted.");
  }, [bootstrapStep]);

  // Pick up any in-progress run on mount / refresh.
  useEffect(() => {
    if (!secret) return;
    (async () => {
      const res = await call("/api/bootstrap/run");
      if (res.ok && res.data?.state) {
        setBootstrapState(res.data.state);
        if (res.data.state.status === "running") {
          setBootstrapRunning(true);
        }
      }
    })();
  }, [secret, call]);

  const doAction = useCallback(async (url, { method = "GET", successMsg, body } = {}) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await call(url, { method, body: body ? JSON.stringify(body) : undefined });
      if (res.ok) {
        setNotice(successMsg || "Done.");
      } else {
        setError(`${res.status}: ${JSON.stringify(res.data).slice(0, 500)}`);
      }
      await refresh();
      return res;
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setBusy(false);
    }
  }, [call, refresh]);

  if (!booted) return <div style={css.shell}>loading…</div>;

  // ─── Unauthed view ────────────────────────────────────────────────────────

  if (!secret) {
    return (
      <div style={css.shell}>
        <div style={{ ...css.wrap, maxWidth: 420, paddingTop: 80 }}>
          <h1 style={css.h1}>Gabriella — dev</h1>
          <p style={css.subtitle}>Enter your CRON_SECRET to unlock.</p>
          <form onSubmit={(e) => { e.preventDefault(); saveSecret(e.target.secret.value); }}>
            <label style={css.label}>CRON_SECRET</label>
            <input
              name="secret" type="password" style={css.input}
              autoComplete="off" autoFocus
              placeholder="paste the secret from Vercel env vars"
            />
            <div style={css.btnRow}>
              <button type="submit" style={css.btnP}>Unlock</button>
            </div>
          </form>
          <p style={{ ...css.subtitle, marginTop: 16 }}>
            Stored only in this browser's localStorage. Clear it any time with the "lock" button.
          </p>
        </div>
      </div>
    );
  }

  // ─── Authed view ──────────────────────────────────────────────────────────

  const whoami   = status?.whoami;
  const archives = status?.list?.archiveKeys || [];
  const dsList   = Array.isArray(status?.finetune?.datasets) ? status.finetune.datasets : [];
  const jobs     = Array.isArray(status?.finetune?.jobs)     ? status.finetune.jobs     : [];
  const watch    = status?.watch;
  const cfg      = status?.config?.config;
  const cfgSrc   = status?.config?.sources || {};

  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 8 }}>
          <div>
            <h1 style={css.h1}>Gabriella — dev</h1>
            <p style={css.subtitle}>
              {whoami?.configuredAccountId ? `account: ${whoami.configuredAccountId} ✓` : "checking credentials…"}
              {" · auto-refresh 30s"}
            </p>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button style={css.btn} onClick={() => refresh()}>↻</button>
            <button style={css.btn} onClick={() => clearSecret()}>🔒</button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid #22222e" }}>
          <button
            onClick={() => setTab("dashboard")}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "8px 12px", fontSize: 13, color: tab === "dashboard" ? "#fff" : "#8a8a99",
              borderBottom: tab === "dashboard" ? "2px solid #4a6aff" : "2px solid transparent",
              marginBottom: -1,
            }}
          >Dashboard</button>
          <button
            onClick={() => { setTab("logs"); refreshLogs(); }}
            style={{
              background: "none", border: "none", cursor: "pointer",
              padding: "8px 12px", fontSize: 13, color: tab === "logs" ? "#fff" : "#8a8a99",
              borderBottom: tab === "logs" ? "2px solid #4a6aff" : "2px solid transparent",
              marginBottom: -1,
            }}
          >Debug logs{logs?.byLevel?.error ? ` (${logs.byLevel.error})` : ""}</button>
        </div>

        {error  && <div style={css.error}>{error}</div>}
        {notice && <div style={css.success}>{notice}</div>}

        {tab === "logs" && (
          <LogsView
            logs={logs}
            level={logLevel}
            setLevel={setLogLevel}
            onRefresh={refreshLogs}
            onClear={async () => {
              if (!confirm("Clear all debug logs?")) return;
              await doAction("/api/debug/logs", { method: "DELETE", successMsg: "Logs cleared." });
              refreshLogs();
            }}
            onTestWrite={async () => {
              await doAction("/api/debug/logs", { method: "POST", successMsg: "Test entry written." });
              refreshLogs();
            }}
          />
        )}

        {tab !== "dashboard" ? null : (
          <>
        {/* keep dashboard content in fragment */}

        {/* ─── Health banner ───────────────────────────────────────────── */}
        {status?.health && (() => {
          const h = status.health;
          const isBroken   = h.overall === "broken";
          const isDegraded = h.overall === "degraded";
          if (!isBroken && !isDegraded) return null;
          return (
            <div style={isBroken ? css.error : css.notice}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>
                {isBroken ? "🚨 App is broken — chat will 500 until fixed" : "⚠ App is degraded"}
              </div>
              {(h.problems || []).map((p, i) => (
                <div key={i} style={{ fontSize: 12, marginTop: 3 }}>{p}</div>
              ))}
              <div style={{ fontSize: 11, marginTop: 8, color: "#aaa" }}>
                chat works: {String(h.summary?.chatCanWork)} ·
                fine-tune works: {String(h.summary?.fineTuneCanWork)} ·
                Groq pool: {h.summary?.poolSize || 0} keys
              </div>
            </div>
          );
        })()}

        {/* ─── Account + speaker state ─────────────────────────────────── */}
        <div style={css.card}>
          <div style={css.cardTitle}>Speaker state</div>
          <div style={css.kv}>
            <span style={css.kvKey}>Active fine-tune</span>
            <span style={css.kvVal}>{watch?.speaker?.activeModel || "— (Groq fallback)"}</span>
          </div>
          <div style={css.kv}>
            <span style={css.kvKey}>Circuit breaker</span>
            <span style={css.kvVal}>{watch?.speaker?.breakerState || watch?.speaker?.consecutiveErrors != null ? `${watch.speaker.consecutiveErrors} errors` : "ok"}</span>
          </div>
          <div style={css.kv}>
            <span style={css.kvKey}>Pending job</span>
            <span style={css.kvVal}>
              {watch?.pending ? `${watch.pending.jobId} `  : "none"}
              {watch?.pending && <span style={pillFor(watch.pending.state)}>{watch.pending.state}</span>}
            </span>
          </div>
          <div style={css.btnRow}>
            {watch?.speaker?.activeModel && (
              <button
                style={css.btnD}
                disabled={busy}
                onClick={() => {
                  if (!confirm("Clear the active fine-tune and fall back to Groq?")) return;
                  doAction("/api/learn/watch", { method: "DELETE", successMsg: "Active fine-tune cleared. Chat now uses Groq." });
                }}
              >
                Rollback to Groq
              </button>
            )}
            {watch?.pending && (
              <button
                style={css.btn}
                disabled={busy}
                onClick={() => doAction("/api/learn/watch", { successMsg: "Polled." })}
              >
                Poll now
              </button>
            )}
          </div>
        </div>

        {/* ─── Bootstrap runner ──────────────────────────────────────────── */}
        <div style={css.card}>
          <div style={css.cardTitle}>
            Bootstrap training data
            {bootstrapState?.status === "running" && <span style={{ ...css.pill("#60a5fa"), marginLeft: 8 }}>running</span>}
            {bootstrapState?.status === "done"    && <span style={{ ...css.pill("#4ade80"), marginLeft: 8 }}>done</span>}
          </div>

          {!bootstrapRunning && (!bootstrapState || bootstrapState.status !== "running") && (
            <>
              <div style={{ ...css.grid2, marginBottom: 10 }}>
                <div>
                  <label style={css.label}>Category</label>
                  <select
                    style={css.input}
                    value={bootstrapOpts.category}
                    onChange={e => setBootstrapOpts({ ...bootstrapOpts, category: e.target.value })}
                  >
                    <option value="all">all</option>
                    <option value="phatic">phatic</option>
                    <option value="casual">casual</option>
                    <option value="substantive">substantive</option>
                    <option value="emotional">emotional</option>
                    <option value="edge">edge</option>
                    <option value="trash-talk">trash-talk</option>
                    <option value="anger">anger</option>
                    <option value="sharp-disagreement">sharp-disagreement</option>
                    <option value="against-user">against-user</option>
                    <option value="hurt">hurt</option>
                    <option value="petty">petty</option>
                    <option value="tough-love">tough-love</option>
                    <option value="toxic-when-earned">toxic-when-earned</option>
                  </select>
                </div>
                <div>
                  <label style={css.label}>Limit (blank = all)</label>
                  <input
                    type="number"
                    min="1"
                    style={css.input}
                    placeholder="e.g. 20 for a test run"
                    value={bootstrapOpts.scenarios}
                    onChange={e => setBootstrapOpts({ ...bootstrapOpts, scenarios: e.target.value })}
                  />
                </div>
                <div>
                  <label style={css.label}>Chunk size (per HTTP call)</label>
                  <input
                    type="number"
                    min="1"
                    max="12"
                    style={css.input}
                    value={bootstrapOpts.chunkSize}
                    onChange={e => setBootstrapOpts({ ...bootstrapOpts, chunkSize: e.target.value })}
                  />
                </div>
                <div>
                  <label style={css.label}>Concurrency (keys in pool)</label>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    style={css.input}
                    value={bootstrapOpts.concurrency}
                    onChange={e => setBootstrapOpts({ ...bootstrapOpts, concurrency: e.target.value })}
                  />
                </div>
              </div>
              <div style={css.btnRow}>
                <button
                  style={css.btnP}
                  disabled={busy || bootstrapRunning}
                  onClick={bootstrapStart}
                >
                  Start bootstrap
                </button>
                <button
                  style={css.btn}
                  disabled={busy}
                  onClick={() => setBootstrapOpts({ category: "all", scenarios: "5", chunkSize: 5, concurrency: 3 })}
                >
                  Use smoke-test preset
                </button>
              </div>
              {bootstrapState?.status === "done" && (
                <div style={{ ...css.notice, marginTop: 10 }}>
                  Last run: {bootstrapState.totalExamples} examples kept across {bootstrapState.processed} scenarios
                  {bootstrapState.archiveKey && <> · archived as <code>{bootstrapState.archiveKey.split(":").pop()}</code></>}
                  {bootstrapState.archiveError && <span style={{ color: "#ffc4c4" }}> · archive error: {bootstrapState.archiveError}</span>}
                </div>
              )}
            </>
          )}

          {(bootstrapRunning || bootstrapState?.status === "running") && bootstrapState && (
            <>
              <div style={{ marginBottom: 8, fontSize: 13 }}>
                {bootstrapState.processed} / {bootstrapState.totalScenarios} scenarios · {bootstrapState.totalExamples} examples kept · {bootstrapState.percent}%
              </div>
              <div style={{
                height: 8,
                background: "#1a1a24",
                borderRadius: 4,
                overflow: "hidden",
                marginBottom: 10,
              }}>
                <div style={{
                  width: `${bootstrapState.percent}%`,
                  height: "100%",
                  background: "linear-gradient(90deg, #4a6aff 0%, #6a8aff 100%)",
                  transition: "width 0.4s ease",
                }} />
              </div>
              {bootstrapState.breakdownLast && bootstrapState.breakdownLast.length > 0 && (
                <div style={{ fontSize: 11, color: "#8a8a99", fontFamily: "ui-monospace, Menlo, monospace", maxHeight: 120, overflow: "auto", marginBottom: 10 }}>
                  {bootstrapState.breakdownLast.map((b, i) => (
                    <div key={i}>
                      {b.error
                        ? `✗ ${b.scenarioId}: ${b.error}`
                        : `✓ ${b.scenarioId} (${b.category}) — kept ${b.kept}/${b.generated}`}
                    </div>
                  ))}
                </div>
              )}
              <div style={css.btnRow}>
                <button style={css.btnD} disabled={busy} onClick={bootstrapAbort}>
                  Abort
                </button>
              </div>
            </>
          )}
        </div>

        {/* ─── Archives ──────────────────────────────────────────────────── */}
        <div style={css.card}>
          <div style={css.cardTitle}>Upstash archives ({archives.length})</div>
          {archives.length === 0 && <div style={css.subtitle}>No archives yet. Use the Bootstrap panel above to generate one.</div>}
          {archives.slice(-5).reverse().map((k) => (
            <div key={k} style={css.kv}>
              <span style={css.kvKey}>{k.split(":").pop()}</span>
              <span style={css.kvVal}>{k.includes(":bootstrap:") ? "bootstrap" : "cot"}</span>
            </div>
          ))}
          <div style={css.btnRow}>
            <button
              style={css.btnP}
              disabled={busy || archives.length === 0}
              onClick={() => doAction("/api/bootstrap/push", { successMsg: "Pushed newest archive to Fireworks." })}
            >
              Push newest → Fireworks
            </button>
          </div>
        </div>

        {/* ─── Fireworks datasets ────────────────────────────────────────── */}
        <div style={css.card}>
          <div style={css.cardTitle}>Fireworks datasets ({dsList.length})</div>
          {dsList.length === 0 && <div style={css.subtitle}>No datasets yet. Push from Upstash above.</div>}
          {dsList.slice(0, 10).map((d) => (
            <div key={d.id} style={css.kv}>
              <span style={css.kvKey}>{d.id}</span>
              <span style={css.kvVal}>
                {d.exampleCount ? `${d.exampleCount} ex · ` : ""}<span style={pillFor(d.state)}>{d.state}</span>
              </span>
            </div>
          ))}
          <div style={css.btnRow}>
            <button
              style={css.btnP}
              disabled={busy || dsList.length === 0}
              onClick={() => {
                if (!confirm("Launch a fine-tune job on the newest READY dataset?")) return;
                doAction("/api/fireworks/finetune?launch=1", { successMsg: "SFT job launched. Check 'Speaker state' for progress." });
              }}
            >
              Launch fine-tune (newest dataset)
            </button>
          </div>
        </div>

        {/* ─── Jobs ──────────────────────────────────────────────────────── */}
        <div style={css.card}>
          <div style={css.cardTitle}>Fine-tune jobs ({jobs.length})</div>
          {jobs.length === 0 && <div style={css.subtitle}>No jobs yet.</div>}
          {jobs.slice(0, 6).map((j) => (
            <div key={j.id} style={css.kv}>
              <span style={css.kvKey}>{j.displayName || j.id}</span>
              <span style={css.kvVal}>
                <span style={pillFor(j.state)}>{(j.state || "").replace("JOB_STATE_", "")}</span>
                {j.outputModel && " ✓"}
              </span>
            </div>
          ))}
        </div>

        {/* ─── Config ────────────────────────────────────────────────────── */}
        <div style={css.card}>
          <div style={css.cardTitle}>Fine-tune hyperparameters</div>
          <ConfigEditor cfg={cfg} sources={cfgSrc} busy={busy} onSave={async (patch) => {
            const qs = new URLSearchParams(patch).toString();
            await doAction(`/api/fireworks/config?${qs}`, { successMsg: "Config saved." });
          }} onReset={async () => {
            if (!confirm("Wipe all overrides? Env vars + defaults will take effect.")) return;
            await doAction("/api/fireworks/config?reset=1", { successMsg: "All overrides cleared." });
          }} />
        </div>

        {/* ─── Health detail card ────────────────────────────────────── */}
        {status?.health && (
          <details style={{ ...css.card, cursor: "pointer" }}>
            <summary style={{ fontSize: 13, color: "#a0a0b0" }}>
              Health details — env vars + service probes
            </summary>
            <div style={{ marginTop: 10 }}>
              <div style={css.cardTitle}>Service probes</div>
              {Object.entries(status.health.checks || {}).map(([svc, result]) => (
                <div key={svc} style={css.kv}>
                  <span style={css.kvKey}>{svc}</span>
                  <span style={css.kvVal}>
                    {result.ok
                      ? <span style={pillFor("READY")}>ok</span>
                      : <span style={pillFor("FAILED")}>{result.reason || result.error || "down"}</span>}
                  </span>
                </div>
              ))}
              <div style={{ ...css.cardTitle, marginTop: 16 }}>Required env vars</div>
              {(status.health.envVars?.required || []).map((v) => (
                <div key={v.name} style={css.kv}>
                  <span style={css.kvKey}>{v.name}</span>
                  <span style={css.kvVal}>
                    {v.status === "ok"          ? <span style={pillFor("READY")}>set</span> :
                     v.status === "MISSING"     ? <span style={pillFor("FAILED")}>MISSING</span> :
                     v.status === "PLACEHOLDER" ? <span style={pillFor("FAILED")}>placeholder: {v.preview}</span> :
                                                   <span style={pillFor("")}>{v.status}</span>}
                  </span>
                </div>
              ))}
              <div style={{ ...css.cardTitle, marginTop: 16 }}>Fireworks</div>
              {(status.health.envVars?.fireworks || []).map((v) => (
                <div key={v.name} style={css.kv}>
                  <span style={css.kvKey}>{v.name}</span>
                  <span style={css.kvVal}>{v.status === "ok" ? "set" : v.status}</span>
                </div>
              ))}
              <div style={{ ...css.cardTitle, marginTop: 16 }}>Groq pool</div>
              <div style={css.kv}>
                <span style={css.kvKey}>Keys configured</span>
                <span style={css.kvVal}>{status.health.summary?.poolSize || 0} / 10</span>
              </div>
            </div>
          </details>
        )}

        {/* ─── Raw status (debug) ────────────────────────────────────────── */}
        <details style={{ ...css.card, cursor: "pointer" }}>
          <summary style={{ fontSize: 13, color: "#a0a0b0" }}>Raw status payload</summary>
          <pre style={css.code}>{JSON.stringify(status, null, 2)}</pre>
        </details>

        <p style={{ ...css.subtitle, textAlign: "center", marginTop: 24 }}>
          Status refreshes every 15 seconds. Mutations refresh instantly.
        </p>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Logs view ────────────────────────────────────────────────────────────────

function LogsView({ logs, level, setLevel, onRefresh, onClear, onTestWrite }) {
  if (!logs) return <div style={css.card}><div style={css.subtitle}>loading…</div></div>;

  const entries = logs.entries || [];
  const levelColor = {
    error: "#f87171",
    warn:  "#fbbf24",
    info:  "#60a5fa",
  };

  return (
    <>
      <div style={css.card}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>{logs.count} entries</strong>
          {Object.entries(logs.byLevel || {}).map(([lvl, n]) => (
            <span key={lvl} style={{ fontSize: 12, color: levelColor[lvl] || "#ccc" }}>
              {lvl}: {n}
            </span>
          ))}
          <span style={{ flex: 1 }} />
          <select
            value={level}
            onChange={(e) => setLevel(e.target.value)}
            style={{ ...css.input, width: "auto", padding: "4px 8px" }}
          >
            <option value="all">all levels</option>
            <option value="error">error only</option>
            <option value="warn">warn</option>
            <option value="info">info</option>
          </select>
          <button style={css.btn} onClick={onRefresh}>↻</button>
          <button style={css.btn} onClick={onTestWrite}>test</button>
          <button style={css.btnD} onClick={onClear}>Clear</button>
        </div>
      </div>

      {entries.length === 0 && (
        <div style={css.card}>
          <div style={css.subtitle}>No log entries. Logs are written automatically when the chat route or API endpoints fail.</div>
        </div>
      )}

      {entries.map((e, idx) => (
        <div key={idx} style={{ ...css.card, borderLeft: `3px solid ${levelColor[e.level] || "#555"}` }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#8a8a99", marginBottom: 6 }}>
            <span>
              <span style={{ color: levelColor[e.level] || "#ccc", fontWeight: 600, textTransform: "uppercase" }}>
                {e.level}
              </span>
              {" · "}
              <span style={{ color: "#ccc" }}>{e.source}</span>
            </span>
            <span>{new Date(e.t).toLocaleString()}</span>
          </div>
          <div style={{ fontSize: 13, marginBottom: e.detail ? 6 : 0 }}>{e.message}</div>
          {e.detail && (
            <details>
              <summary style={{ fontSize: 11, color: "#8a8a99", cursor: "pointer" }}>detail</summary>
              <pre style={{ ...css.code, marginTop: 6 }}>
                {typeof e.detail === "string"
                  ? e.detail
                  : JSON.stringify(e.detail, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ))}
    </>
  );
}

// ─── Config editor subcomponent ───────────────────────────────────────────────

function ConfigEditor({ cfg, sources, busy, onSave, onReset }) {
  const [draft, setDraft] = useState({});

  // Reset the draft every time the live config changes.
  useEffect(() => { setDraft({}); }, [cfg]);

  if (!cfg) return <div style={css.subtitle}>loading config…</div>;

  const fields = [
    { key: "epochs",       label: "Epochs",        hint: "1–20. Higher = tighter fit, overfit risk on small data." },
    { key: "loraRank",     label: "LoRA rank",     hint: "1–128. Higher = more capacity, slower training." },
    { key: "learningRate", label: "Learning rate", hint: "Default 0.0001. Lower if loss explodes." },
    { key: "batchSize",    label: "Batch size",    hint: "Leave blank for Fireworks auto-pick." },
    { key: "baseModel",    label: "Base model",    hint: "Full resource path (accounts/fireworks/models/...).", wide: true },
  ];

  const change = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty  = Object.keys(draft).length > 0;

  return (
    <>
      <div style={css.grid2}>
        {fields.map((f) => (
          <div key={f.key} style={f.wide ? { gridColumn: "1 / -1" } : null}>
            <label style={css.label}>
              {f.label}{" "}
              <span style={{ color: "#555" }}>
                ({sources[f.key] || "default"})
              </span>
            </label>
            <input
              style={css.input}
              defaultValue={cfg[f.key] ?? ""}
              placeholder={f.hint}
              onChange={(e) => change(f.key, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div style={css.btnRow}>
        <button
          style={css.btnP}
          disabled={busy || !dirty}
          onClick={() => onSave(draft)}
        >
          Save changes
        </button>
        <button
          style={css.btn}
          disabled={busy}
          onClick={() => setDraft({})}
        >
          Discard
        </button>
        <button
          style={css.btnD}
          disabled={busy}
          onClick={onReset}
        >
          Reset all to defaults
        </button>
      </div>
    </>
  );
}
