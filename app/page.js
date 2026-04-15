"use client";
import { useState, useRef, useEffect, useMemo } from "react";

// Tool-result chip. Small affordance that lands under her message when
// she actually DID something — pinned an item, set a reminder. Visual
// confirmation that the action landed, not just the text of it.
function ToolChip({ tool }) {
  if (!tool || !tool.ok) return null;
  let icon = "";
  let label = "";
  if (tool.tool === "pin") {
    icon = "📌";
    label = tool.duplicate ? "already pinned" : "pinned";
  } else if (tool.tool === "remind") {
    icon = "⏰";
    label = `reminder set — ${tool.humanWhen || ""}`;
  } else {
    icon = "✓";
    label = tool.tool;
  }
  return (
    <div className="g-tool-chip" title={tool.text || ""}>
      <span className="g-tool-chip__icon" aria-hidden="true">{icon}</span>
      <span className="g-tool-chip__label">{label}</span>
    </div>
  );
}

// Paper-plane send icon — inline SVG, inherits currentColor so hover/disabled
// states from the button are picked up automatically.
function SendIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: "translateX(1px)" }}
    >
      <path d="M3.4 20.4 21 12 3.4 3.6l.1 6.6L16 12l-12.5 1.8-.1 6.6z" fill="currentColor" fillOpacity="0.18" />
    </svg>
  );
}

// Client-side rendering model:
//   Each conversation turn is a list of "bubbles". A user turn is always
//   one bubble. An assistant turn is 1..N bubbles — split on the "\n\n"
//   separator the fragmenter (Phase 8) emits between fragment-sends.
//   Rendering per-fragment gives the sender-bubble feel of real texting.

function splitIntoFragments(text) {
  if (!text) return [""];
  const parts = text.split(/\n{2,}/g).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : [""];
}

// Phase D: extract the sidecar tool-result line from the stream.
// Server wraps a JSON tool-result payload in U+001F separators at
// the very end of the stream so we can split it off cleanly without
// letting it appear in any rendered bubble.
const TOOL_DELIM = "\u001F__TOOL__";
function extractToolResult(streamText) {
  const idx = streamText.indexOf(TOOL_DELIM);
  if (idx === -1) return { text: streamText, tool: null };
  const before = streamText.slice(0, idx);
  const after  = streamText.slice(idx + TOOL_DELIM.length);
  const endIdx = after.indexOf("\u001F");
  if (endIdx === -1) return { text: before, tool: null };
  const payload = after.slice(0, endIdx);
  try {
    return { text: before, tool: JSON.parse(payload) };
  } catch {
    return { text: before, tool: null };
  }
}

export default function Home() {
  const [messages, setMessages]     = useState([]);
  const [streaming, setStreaming]   = useState("");      // raw streamed text for the current assistant turn
  const [input, setInput]           = useState("");
  const [loading, setLoading]       = useState(false);
  const [thinking, setThinking]     = useState(false);   // pre-first-char (Phase 7 thinking delay window)
  const [betweenFragments, setBetweenFragments] = useState(false);  // inter-fragment pause (Phase 8)
  const [error, setError]           = useState(null);
  const bottomRef                   = useRef(null);
  const abortRef                    = useRef(null);
  const inputRef                    = useRef(null);
  const gapTimerRef                 = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming, thinking, betweenFragments]);

  useEffect(() => () => {
    if (gapTimerRef.current) clearTimeout(gapTimerRef.current);
  }, []);

  // Derived: assistant bubbles for the CURRENT streaming turn (if any).
  // Strip any tool-result sidecar from the preview — it's not visible
  // text, just metadata that lands in the chip after finalize.
  const streamingBubbles = useMemo(() => {
    if (!streaming) return [];
    const { text } = extractToolResult(streaming);
    return splitIntoFragments(text);
  }, [streaming]);

  const send = async () => {
    if (!input.trim() || loading) return;
    setError(null);

    const userMsg = { role: "user", content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput("");
    setLoading(true);
    setThinking(true);
    setStreaming("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ messages: newMessages }),
        signal:  controller.signal,
      });

      if (!res.ok) throw new Error(`Server error ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";
      let gotFirstByte = false;
      // Inter-fragment detection: if we just received a "\n\n" AND no new
      // chunks arrive for >250ms, treat it as a fragment boundary and
      // show typing dots until the next chunk lands.
      const armGapDetector = () => {
        if (gapTimerRef.current) clearTimeout(gapTimerRef.current);
        gapTimerRef.current = setTimeout(() => {
          // Only activate the dots if the current stream tail looks like
          // a fragment boundary (ends with blank line) AND there's
          // already visible content.
          if (/\n{2,}\s*$/.test(full) && full.trim().length > 0) {
            setBetweenFragments(true);
          }
        }, 250);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!gotFirstByte && chunk.length > 0) {
          gotFirstByte = true;
          setThinking(false);
        }
        full += chunk;
        setStreaming(full);
        setBetweenFragments(false);           // any chunk cancels the dots
        if (gapTimerRef.current) {
          clearTimeout(gapTimerRef.current);
          gapTimerRef.current = null;
        }
        if (/\n{2,}\s*$/.test(full)) armGapDetector();
      }

      if (gapTimerRef.current) {
        clearTimeout(gapTimerRef.current);
        gapTimerRef.current = null;
      }
      setBetweenFragments(false);

      // Finalize — strip any tool-result sidecar, then commit the
      // accumulated text as N bubbles + an optional tool chip on the
      // last bubble.
      const { text: bubbleText, tool } = extractToolResult(full);
      const bubbles = splitIntoFragments(bubbleText);
      if (bubbles.length === 0 || bubbles.every(b => !b)) {
        setError("she didn't quite land that one. try again?");
      } else {
        const assistantBubbles = bubbles.map((content, i, arr) => ({
          role: "assistant",
          content,
          // Attach the tool chip to the LAST bubble only.
          tool: (tool && i === arr.length - 1) ? tool : null,
        }));
        setMessages([...newMessages, ...assistantBubbles]);
      }
      setStreaming("");
    } catch (err) {
      if (err.name === "AbortError") return;
      setError("something went wrong. try again.");
      setStreaming("");
    } finally {
      setLoading(false);
      setThinking(false);
      abortRef.current = null;
    }
  };

  const combinedBubbles = [
    ...messages,
    // Show streaming bubbles (if any) but DON'T merge them into the
    // committed list until the response closes.
    ...streamingBubbles.map((content, i, arr) => ({
      role: "assistant",
      content,
      streaming: i === arr.length - 1,  // only the last bubble shows the caret
    })),
  ];

  const isIdle = !loading && !streaming;

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
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* City glow — slow breathing gradient */}
      <div className="g-city-glow" style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        background: `
          radial-gradient(ellipse 40% 30% at 15% 65%, rgba(255,150,40,0.055) 0%, transparent 70%),
          radial-gradient(ellipse 25% 20% at 78% 28%, rgba(255,200,90,0.045) 0%, transparent 60%),
          radial-gradient(ellipse 30% 25% at 60% 80%, rgba(180,130,255,0.035) 0%, transparent 60%)
        `,
      }} />

      {/* Header */}
      <div style={{
        padding: "20px 24px 14px",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        position: "sticky", top: 0, zIndex: 10,
        background: "rgba(8,8,15,0.78)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}>
        <div className="g-header-title" style={{
          fontSize: 15,
          letterSpacing: "0.05em",
          fontWeight: 500,
        }}>
          Gabriella
        </div>
        <div style={{
          fontSize: 11,
          color: thinking || loading ? "rgba(255,195,100,0.72)" : "rgba(255,175,70,0.55)",
          marginTop: 5,
          letterSpacing: "0.04em",
          display: "flex",
          alignItems: "center",
          transition: "color 0.3s ease",
        }}>
          <span className={`g-status-ember${thinking || loading ? " typing" : ""}`} />
          {thinking ? "thinking..." : loading ? "typing..." : "online"}
        </div>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1, overflowY: "auto",
        padding: "24px 18px 12px",
        display: "flex", flexDirection: "column", gap: 10,
        position: "relative",
        zIndex: 1,
      }}>
        {combinedBubbles.length === 0 && !error && isIdle && (
          <div className="g-empty" style={{
            color: "rgba(255,255,255,0.22)",
            fontSize: 13,
            textAlign: "center",
            marginTop: "35vh",
            letterSpacing: "0.08em",
          }}>
            say something
          </div>
        )}
        {error && (
          <div className="g-error" style={{
            color: "rgba(255,100,80,0.55)",
            fontSize: 12,
            textAlign: "center",
            marginTop: combinedBubbles.length === 0 ? "35vh" : 8,
            letterSpacing: "0.04em",
          }}>
            {error}
          </div>
        )}

        {combinedBubbles.map((m, i) => {
          const isUser = m.role === "user";
          // Check whether this bubble is the START of an assistant run
          // (for margin-top grouping).
          const prev = combinedBubbles[i - 1];
          const startsRun = !prev || prev.role !== m.role;

          return (
            <div
              key={`${i}-${m.role}-${m.content.slice(0, 8)}`}
              style={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
                marginTop: startsRun && i > 0 ? 8 : 0,
              }}
            >
              <div
                className={`g-bubble${isUser ? " user" : ""}`}
                style={{
                  maxWidth: "78%",
                  padding: "10px 14px",
                  borderRadius: isUser
                    ? "18px 18px 4px 18px"
                    : "18px 18px 18px 4px",
                  background: isUser
                    ? "rgba(255,155,55,0.1)"
                    : "rgba(255,255,255,0.045)",
                  border: isUser
                    ? "1px solid rgba(255,155,55,0.18)"
                    : "1px solid rgba(255,255,255,0.07)",
                  color: "rgba(255,255,255,0.88)",
                  fontSize: 14,
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  wordWrap: "break-word",
                }}
              >
                {m.content}
                {m.streaming && <span className="g-caret" aria-hidden="true" />}
                {m.tool && <ToolChip tool={m.tool} />}
              </div>
            </div>
          );
        })}

        {/* Typing dots:
              - during the pre-first-byte thinking window (Phase 7)
              - during an inter-fragment pause (Phase 8) so the bubble
                gap doesn't read as silence/abandonment. */}
        {(thinking || betweenFragments) && (
          <div style={{
            display: "flex",
            justifyContent: "flex-start",
          }}>
            <div className="g-bubble" style={{
              padding: "12px 16px",
              borderRadius: "18px 18px 18px 4px",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.07)",
            }}>
              <span className="g-typing-dots" aria-label={thinking ? "thinking" : "typing"}>
                <span /><span /><span />
              </span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "14px 18px 28px",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        display: "flex", gap: 10,
        alignItems: "flex-end",
        background: "rgba(8,8,15,0.8)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        position: "sticky",
        bottom: 0,
        zIndex: 5,
      }}>
        <textarea
          ref={inputRef}
          className="g-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            // Cmd/Ctrl+Enter → send. Plain Enter inserts a newline (default textarea behavior).
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !loading) {
              e.preventDefault();
              send();
            }
          }}
          onInput={e => {
            // Auto-grow height up to a sensible cap.
            e.target.style.height = "auto";
            e.target.style.height = Math.min(160, e.target.scrollHeight) + "px";
          }}
          placeholder="message..."
          rows={1}
          disabled={loading}
          style={{
            flex: 1,
            background: loading ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 14,
            padding: "11px 14px",
            color: loading ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.86)",
            fontSize: 14,
            lineHeight: 1.5,
            outline: "none",
            fontFamily: "inherit",
            resize: "none",
            maxHeight: 160,
            overflowY: "auto",
          }}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="g-send-btn"
          aria-label="send"
          style={{
            background: loading || !input.trim() ? "rgba(255,155,55,0.05)" : "rgba(255,155,55,0.14)",
            border: `1px solid ${loading || !input.trim() ? "rgba(255,155,55,0.15)" : "rgba(255,155,55,0.28)"}`,
            borderRadius: "50%",
            width: 42,
            height: 42,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: loading || !input.trim() ? "rgba(255,175,75,0.3)" : "rgba(255,195,100,0.95)",
            cursor: loading || !input.trim() ? "default" : "pointer",
            fontFamily: "inherit",
            flexShrink: 0,
          }}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
