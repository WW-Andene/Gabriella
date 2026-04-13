"use client";
import { useState, useRef, useEffect } from "react";

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg = { role: "user", content: input };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);

    // Add empty assistant message to stream into
    setMessages([...newMessages, { role: "assistant", content: "" }]);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: newMessages }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      const captured = full;
      setMessages([...newMessages, { role: "assistant", content: captured }]);
    }

    setLoading(false);
  };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#08080f",
      backgroundImage: `repeating-linear-gradient(
        0deg, transparent, transparent 28px,
        rgba(255,255,255,0.018) 28px,
        rgba(255,255,255,0.018) 30px
      )`,
      display: "flex",
      flexDirection: "column",
      fontFamily: "system-ui, sans-serif",
    }}>
      {/* City glow */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        background: `
          radial-gradient(ellipse 40% 30% at 15% 65%, rgba(255,150,40,0.05) 0%, transparent 70%),
          radial-gradient(ellipse 25% 20% at 78% 28%, rgba(255,200,90,0.04) 0%, transparent 60%),
          radial-gradient(ellipse 30% 25% at 60% 80%, rgba(180,130,255,0.03) 0%, transparent 60%)
        `,
      }} />

      {/* Header */}
      <div style={{
        padding: "20px 24px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        position: "sticky", top: 0, zIndex: 10,
        background: "rgba(8,8,15,0.8)",
        backdropFilter: "blur(12px)",
      }}>
        <div style={{ fontSize: 15, color: "rgba(255,255,255,0.88)", letterSpacing: "0.04em" }}>
          Gabriella
        </div>
        <div style={{ fontSize: 11, color: "rgba(255,175,70,0.55)", marginTop: 3 }}>
          {loading ? "typing..." : "online"}
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1, overflowY: "auto",
        padding: "24px 18px",
        display: "flex", flexDirection: "column", gap: 14,
      }}>
        {messages.length === 0 && (
          <div style={{
            color: "rgba(255,255,255,0.12)", fontSize: 13,
            textAlign: "center", marginTop: "35vh",
            letterSpacing: "0.06em",
          }}>
            say something
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{
            display: "flex",
            justifyContent: m.role === "user" ? "flex-end" : "flex-start",
          }}>
            <div style={{
              maxWidth: "78%",
              padding: "10px 14px",
              borderRadius: m.role === "user"
                ? "18px 18px 4px 18px"
                : "18px 18px 18px 4px",
              background: m.role === "user"
                ? "rgba(255,155,55,0.1)"
                : "rgba(255,255,255,0.045)",
              border: m.role === "user"
                ? "1px solid rgba(255,155,55,0.18)"
                : "1px solid rgba(255,255,255,0.07)",
              color: "rgba(255,255,255,0.85)",
              fontSize: 14, lineHeight: 1.65,
            }}>
              {m.content || (m.role === "assistant" && loading ? "···" : "")}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "14px 18px 32px",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        display: "flex", gap: 10,
        background: "rgba(8,8,15,0.8)",
        backdropFilter: "blur(12px)",
      }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && send()}
          placeholder="message..."
          style={{
            flex: 1,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 12, padding: "11px 14px",
            color: "rgba(255,255,255,0.82)",
            fontSize: 14, outline: "none",
          }}
        />
        <button onClick={send} disabled={loading} style={{
          background: loading ? "rgba(255,155,55,0.05)" : "rgba(255,155,55,0.12)",
          border: "1px solid rgba(255,155,55,0.22)",
          borderRadius: 12, padding: "11px 16px",
          color: loading ? "rgba(255,175,75,0.3)" : "rgba(255,175,75,0.85)",
          fontSize: 16, cursor: loading ? "default" : "pointer",
          transition: "all 0.2s",
        }}>→</button>
      </div>
    </div>
  );
}
