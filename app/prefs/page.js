"use client";

// app/prefs/page.js
// User preference page — pick a persona variant + optional custom anchor.

import { useEffect, useState } from "react";
import Link from "next/link";

const VARIANTS = [
  { id: "standard", label: "standard",  desc: "default — direct, restrained, occasionally warm or dry as the moment calls for." },
  { id: "sharper",  label: "sharper",   desc: "more direct, more willing to push back, less cushioning." },
  { id: "softer",   label: "softer",    desc: "warmer register, more space for the moment, gentler pacing." },
  { id: "drier",    label: "drier",     desc: "more wit, more deadpan, less earnestness." },
];

const css = {
  shell: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "40px 20px", boxSizing: "border-box" },
  wrap:  { maxWidth: 640, margin: "0 auto" },
  h1:    { margin: "0 0 6px", fontSize: 26, fontWeight: 600, letterSpacing: 0.2, color: "#ffd6b0" },
  subtitle: { margin: "0 0 24px", color: "#a0a0b0", fontSize: 13, lineHeight: 1.5 },
  card:  { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 16, marginBottom: 10 },
  h2:    { margin: "28px 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: "#ffb070", letterSpacing: 1.6 },
  radioRow: (selected) => ({
    display: "flex", gap: 12, padding: "12px 14px", cursor: "pointer",
    border: selected ? "1px solid rgba(255,175,70,0.5)" : "1px solid #22222e",
    background: selected ? "rgba(255,175,70,0.06)" : "transparent",
    borderRadius: 8, marginBottom: 8, transition: "all 0.15s",
  }),
  label: { fontSize: 14, color: "#e4e4ed", fontWeight: 500 },
  desc:  { fontSize: 12, color: "#8a8a99", marginTop: 3, lineHeight: 1.5 },
  textarea: { width: "100%", padding: 10, background: "#0f0f16", color: "#e4e4ed", border: "1px solid #33334a", borderRadius: 6, fontSize: 13, fontFamily: "inherit", boxSizing: "border-box", resize: "vertical", minHeight: 80 },
  save: { padding: "10px 18px", background: "rgba(255,175,70,0.18)", border: "1px solid rgba(255,175,70,0.5)", color: "#ffd6b0", borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginTop: 12 },
  link:  { color: "#ffb070", textDecoration: "none" },
  status: { fontSize: 12, color: "#8a8a99", marginTop: 10, fontStyle: "italic" },
};

export default function PrefsPage() {
  const [variant, setVariant] = useState("standard");
  const [customAnchor, setCustomAnchor] = useState("");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/prefs").then(r => r.json()).then(j => {
      if (j.ok && j.prefs) {
        setVariant(j.prefs.variant || "standard");
        setCustomAnchor(j.prefs.customAnchor || "");
      }
    }).catch(() => {});
  }, []);

  const save = async () => {
    setBusy(true); setStatus(null);
    try {
      const res = await fetch("/api/prefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variant, customAnchor: customAnchor || null }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "save failed");
      setStatus("saved — takes effect on her next reply.");
    } catch (e) { setStatus(`error: ${e.message}`); }
    finally { setBusy(false); }
  };

  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <h1 style={css.h1}>How you'd like her.</h1>
        <p style={css.subtitle}>
          Her base identity stays the same. This tunes her register for THIS relationship.
          You can change it anytime. {" "}<Link href="/" style={css.link}>back to chat</Link>
        </p>

        <h2 style={css.h2}>Variant</h2>
        <div>
          {VARIANTS.map(v => (
            <div
              key={v.id}
              onClick={() => setVariant(v.id)}
              style={css.radioRow(variant === v.id)}
            >
              <div style={{ fontSize: 16 }}>{variant === v.id ? "●" : "○"}</div>
              <div>
                <div style={css.label}>{v.label}</div>
                <div style={css.desc}>{v.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <h2 style={css.h2}>Custom anchor (optional)</h2>
        <div style={css.card}>
          <p style={{ fontSize: 12, color: "#8a8a99", margin: "0 0 8px", lineHeight: 1.5 }}>
            Write a sentence or two telling her what you're looking for. She'll honor it where it points at a real register shift, without contorting against her identity.
          </p>
          <textarea
            value={customAnchor}
            onChange={e => setCustomAnchor(e.target.value.slice(0, 400))}
            placeholder="e.g. I don't need you to fix anything; I want someone to actually listen and tell me when I'm not making sense."
            style={css.textarea}
            maxLength={400}
          />
          <div style={{ fontSize: 11, color: "#555566", marginTop: 4, textAlign: "right" }}>
            {customAnchor.length} / 400
          </div>
        </div>

        <button onClick={save} disabled={busy} style={css.save}>
          {busy ? "saving…" : "save preferences"}
        </button>
        {status && <div style={css.status}>{status}</div>}
      </div>
    </div>
  );
}
