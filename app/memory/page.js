"use client";

// app/memory/page.js
// Memory inspector + editor.
//
// User can see what she believes about them and delete specific
// items that are wrong — OR wipe everything and let her start over.
// User control over AI memory is a real differentiator; no chat
// companion product offers it because none of them have structured
// memory to edit.

import { useEffect, useState } from "react";
import Link from "next/link";

const css = {
  shell: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "40px 20px", boxSizing: "border-box" },
  wrap:  { maxWidth: 760, margin: "0 auto" },
  h1:    { margin: "0 0 6px", fontSize: 26, fontWeight: 600, letterSpacing: 0.2, color: "#ffd6b0" },
  subtitle: { margin: "0 0 24px", color: "#a0a0b0", fontSize: 13, lineHeight: 1.5 },
  h2:    { margin: "28px 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "#ffb070", letterSpacing: 1.6 },
  card:  { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 14, marginBottom: 10 },
  row:   { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px dashed #22222e", fontSize: 13, color: "#cfcfd8" },
  rowText: { flex: 1, lineHeight: 1.5 },
  del:   { padding: "2px 10px", fontSize: 11, background: "transparent", border: "1px solid #55334a", color: "#ffc4c4", borderRadius: 4, cursor: "pointer", fontFamily: "inherit" },
  danger:{ padding: "10px 16px", background: "#3a1a1a", border: "1px solid #aa3333", color: "#ffc4c4", borderRadius: 6, fontSize: 13, cursor: "pointer", fontFamily: "inherit", marginTop: 16 },
  quiet: { fontSize: 13, color: "#8a8a99", fontStyle: "italic" },
  error: { background: "#2a1a1a", border: "1px solid #6a2a2a", borderRadius: 8, padding: 12, fontSize: 13, color: "#ffc4c4", marginBottom: 12 },
  link:  { color: "#ffb070", textDecoration: "none" },
};

export default function MemoryPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [wipeStage, setWipeStage] = useState(0);  // 0 = idle, 1 = confirm

  const load = async () => {
    setError(null);
    try {
      const res = await fetch("/api/memory");
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "load failed");
      setData(j);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const deleteOne = async (kind, index) => {
    if (!confirm(`Delete this ${kind} entry?`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, index }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "delete failed");
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const deleteStreamEntry = async (id) => {
    if (!confirm("Delete this thought from her stream?")) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/memory", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "stream", id }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "delete failed");
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const wipeAll = async () => {
    if (wipeStage === 0) { setWipeStage(1); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/memory?all=1", { method: "DELETE" });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "wipe failed");
      setWipeStage(0);
      await load();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data && !error) {
    return <div style={css.shell}><div style={css.wrap}><p style={css.quiet}>loading…</p></div></div>;
  }

  const isEmpty = data
    && !(data.facts?.length || data.imprints?.length || data.threads?.length || data.pinned?.length || data.summary || data.stream?.length);

  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <h1 style={css.h1}>What she thinks she knows</h1>
        <p style={css.subtitle}>
          Every structured thing Gabriella has stored about you. Delete anything
          she got wrong — or wipe it all and start over. She keeps her own self-
          model and recent stream separate from facts about you; those are wiped
          together under "forget everything". {" "}
          <Link href="/" style={css.link}>back to chat</Link>
        </p>

        {error && <div style={css.error}>{error}</div>}

        {isEmpty && (
          <div style={css.card}>
            <p style={css.quiet}>Nothing yet. She hasn't accumulated structured facts about you — which usually means either it's early in your conversations, or you've just wiped.</p>
          </div>
        )}

        {data?.summary && (
          <>
            <h2 style={css.h2}>Running summary</h2>
            <div style={css.card}>
              <p style={{ fontSize: 13, lineHeight: 1.65, color: "#cfcfd8", margin: 0 }}>{data.summary}</p>
              <p style={{ ...css.quiet, marginTop: 10, fontSize: 11 }}>
                (the summary is rewritten from your conversations on a regular cadence; there's no per-entry delete — it regenerates)
              </p>
            </div>
          </>
        )}

        {data?.facts?.length > 0 && (
          <>
            <h2 style={css.h2}>Facts ({data.facts.length})</h2>
            <div style={css.card}>
              {data.facts.map((f, i) => (
                <div key={i} style={css.row}>
                  <div style={css.rowText}>{f}</div>
                  <button onClick={() => deleteOne("facts", i)} disabled={busy} style={css.del}>delete</button>
                </div>
              ))}
            </div>
          </>
        )}

        {data?.imprints?.length > 0 && (
          <>
            <h2 style={css.h2}>Imprints ({data.imprints.length})</h2>
            <div style={css.card}>
              {data.imprints.map((f, i) => (
                <div key={i} style={css.row}>
                  <div style={css.rowText}>{f}</div>
                  <button onClick={() => deleteOne("imprints", i)} disabled={busy} style={css.del}>delete</button>
                </div>
              ))}
            </div>
          </>
        )}

        {data?.threads?.length > 0 && (
          <>
            <h2 style={css.h2}>Open threads ({data.threads.length})</h2>
            <div style={css.card}>
              {data.threads.map((f, i) => (
                <div key={i} style={css.row}>
                  <div style={css.rowText}>{f}</div>
                  <button onClick={() => deleteOne("threads", i)} disabled={busy} style={css.del}>delete</button>
                </div>
              ))}
            </div>
          </>
        )}

        {data?.pinned?.length > 0 && (
          <>
            <h2 style={css.h2}>Pinned items ({data.pinned.length})</h2>
            <div style={css.card}>
              {data.pinned.map((p, i) => (
                <div key={i} style={css.row}>
                  <div style={css.rowText}>{typeof p === "string" ? p : (p.text || p.content || JSON.stringify(p))}</div>
                  <button onClick={() => deleteOne("pinned", i)} disabled={busy} style={css.del}>delete</button>
                </div>
              ))}
            </div>
          </>
        )}

        {data?.stream?.length > 0 && (
          <>
            <h2 style={css.h2}>Her inner stream ({data.stream.length})</h2>
            <div style={css.card}>
              <p style={{ ...css.quiet, margin: "0 0 10px", fontSize: 12 }}>
                The log of things she's been thinking between your turns: thoughts, predictions
                about you, connections she noticed, surprises, re-readings. Delete anything you'd
                rather she forget.
              </p>
              {data.stream.map((e) => (
                <div key={e.id || `${e.at}-${e.kind}`} style={css.row}>
                  <div style={css.rowText}>
                    <span style={{
                      display: "inline-block",
                      fontSize: 10,
                      letterSpacing: 0.8,
                      textTransform: "uppercase",
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: "#22222e",
                      color: "#a0a0b0",
                      marginRight: 8,
                      fontWeight: 600,
                    }}>{e.kind}</span>
                    {e.content}
                  </div>
                  <button
                    onClick={() => deleteStreamEntry(e.id)}
                    disabled={busy || !e.id}
                    style={css.del}
                  >delete</button>
                </div>
              ))}
            </div>
          </>
        )}

        <h2 style={css.h2}>Export</h2>
        <div style={css.card}>
          <p style={{ fontSize: 13, color: "#cfcfd8", lineHeight: 1.6, margin: "0 0 8px" }}>
            Download everything she knows about you as a single markdown file — conversation log, her self-model, her stream, her retired positions. Portable, diffable, useful for archiving before a wipe.
          </p>
          <a href="/api/export" download style={{
            display: "inline-block", padding: "8px 16px",
            background: "rgba(130,175,255,0.1)",
            border: "1px solid rgba(130,175,255,0.3)",
            color: "rgba(190,210,255,0.92)",
            borderRadius: 6, fontSize: 13, cursor: "pointer",
            fontFamily: "inherit", textDecoration: "none",
          }}>
            ⬇ download as markdown
          </a>
          <a href="/api/export?format=json" style={{
            display: "inline-block", padding: "8px 16px",
            marginLeft: 10,
            background: "transparent",
            border: "1px solid #33334a",
            color: "#8a8a99",
            borderRadius: 6, fontSize: 12, cursor: "pointer",
            fontFamily: "inherit", textDecoration: "none",
          }}>
            raw json
          </a>
        </div>

        <h2 style={css.h2}>Nuclear option</h2>
        <div style={css.card}>
          <p style={{ fontSize: 13, color: "#cfcfd8", lineHeight: 1.6, margin: "0 0 6px" }}>
            Forget everything. Wipes facts, imprints, threads, pinned items, her self-model,
            her stream, her current read of you, her session plan, stylometry, and idiolect.
            Does not wipe aggregate training data — that's never personal.
          </p>
          <button onClick={wipeAll} disabled={busy} style={css.danger}>
            {wipeStage === 0 ? "forget everything" : "really — click again to confirm"}
          </button>
          {wipeStage === 1 && (
            <button onClick={() => setWipeStage(0)} style={{ ...css.del, marginLeft: 10, fontSize: 12, padding: "6px 14px" }}>cancel</button>
          )}
        </div>

        <div style={{ fontSize: 10, color: "#555566", textAlign: "center", marginTop: 24, letterSpacing: 0.5 }}>
          raw inspector at <a href="/api/memory" style={{color: "#8a8a99"}}>/api/memory</a>
        </div>
      </div>
    </div>
  );
}
