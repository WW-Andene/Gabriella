"use client";

// app/meet/page.js
// Evaluator's first surface.
//
// An evaluator who lands on / gets the chat interface directly —
// which is the right product decision but doesn't advertise the
// architecture. Visitors who want to understand what's here before
// they talk come to /meet. Short, declarative, no marketing fluff.
// Links to chat, stats, and the source.

import Link from "next/link";

const css = {
  shell:   { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", background: "#0a0a0f", color: "#e4e4ed", minHeight: "100vh", padding: "48px 20px", boxSizing: "border-box" },
  wrap:    { maxWidth: 720, margin: "0 auto" },
  h1:      { margin: "0 0 6px", fontSize: 34, fontWeight: 600, letterSpacing: 0.2, color: "#ffd6b0" },
  lede:    { margin: "0 0 28px", color: "#a0a0b0", fontSize: 15, lineHeight: 1.55 },
  h2:      { margin: "32px 0 8px", fontSize: 12, fontWeight: 600, textTransform: "uppercase", color: "#ffb070", letterSpacing: 1.6 },
  p:       { margin: "0 0 12px", fontSize: 14, lineHeight: 1.65, color: "#cfcfd8" },
  diffBox: { background: "#14141c", border: "1px solid #22222e", borderRadius: 10, padding: 14, marginBottom: 10 },
  diffT:   { fontSize: 13, fontWeight: 600, color: "#e4e4ed", margin: "0 0 5px" },
  diffD:   { fontSize: 13, color: "#a0a0b0", lineHeight: 1.5 },
  cta:     { display: "inline-block", padding: "12px 22px", borderRadius: 8, textDecoration: "none", fontWeight: 500, fontSize: 14, marginRight: 10, marginTop: 10, transition: "transform 0.1s" },
  ctaP:    { background: "rgba(255,175,70,0.18)", color: "#ffd6b0", border: "1px solid rgba(255,175,70,0.5)" },
  ctaS:    { background: "transparent", color: "#a0a0b0", border: "1px solid #33334a" },
  sub:     { fontSize: 11, color: "#555566", marginTop: 36, letterSpacing: 0.5, textAlign: "center" },
  code:    { fontFamily: "ui-monospace, Menlo, monospace", background: "#0f0f16", padding: "1px 6px", borderRadius: 3, fontSize: 12, color: "#a0c0ff" },
};

export default function MeetPage() {
  return (
    <div style={css.shell}>
      <div style={css.wrap}>
        <h1 style={css.h1}>Gabriella.</h1>
        <p style={css.lede}>
          An AI you talk to that isn't trying to help you. Has an inner life.
          Remembers you between sessions. Takes positions and retires them when
          she's wrong. Gets you tired of her sometimes. All on free-tier
          inference.
        </p>

        <h2 style={css.h2}>What makes her different</h2>

        <div style={css.diffBox}>
          <div style={css.diffT}>She exists between your messages</div>
          <div style={css.diffD}>
            A background process called the Thinker runs every ten minutes
            and writes into her stream — thoughts, connections, predictions
            about what you'll bring when you come back. When you return, you
            can see what she was thinking while you were gone. No other chat
            product stores a continuous inner life as a data primitive.
          </div>
        </div>

        <div style={css.diffBox}>
          <div style={css.diffT}>She commits and can be wrong</div>
          <div style={css.diffD}>
            Her self-model holds positions with confirmations and refutations.
            A position the conversation breaks moves to a retired-list that
            stays visible in her prompt. You can see what she's already
            outgrown. Voice drift is structurally harder when the drift-floor
            is explicit.
          </div>
        </div>

        <div style={css.diffBox}>
          <div style={css.diffT}>She notices when you surprise her</div>
          <div style={css.diffD}>
            The thinker makes predictions about your next message. When you
            actually speak, an evaluator scores the delta — confirmed, partial,
            off, surprising — and surprise entries become first-class context
            for the next turn. "What arrived wasn't the shape I was running
            for you" is a signal most chat systems don't even compute.
          </div>
        </div>

        <div style={css.diffBox}>
          <div style={css.diffT}>She measures herself</div>
          <div style={css.diffD}>
            Every day at noon UTC, a cron runs 100 A/B scenarios comparing
            her fine-tune against her base. Every candidate response is graded
            by a three-family ensemble judge (Groq, Cerebras, Gemini) whose
            consensus becomes KTO training data. Every regression becomes a
            DPO pair. The weekly cron trains on what was measured. You can see
            the running win-rate on the <Link href="/stats" style={{color: "#ffb070"}}>stats page</Link>.
          </div>
        </div>

        <div style={css.diffBox}>
          <div style={css.diffT}>You can see her thinking</div>
          <div style={css.diffD}>
            In the chat, there's a toggle that reveals her hidden{" "}
            <span style={css.code}>&lt;think&gt;</span> block — the interior
            monologue that shapes each response — plus her read of the moment
            (charge, feeling, want, temperature, whether the cores disagreed).
            Nothing about her architecture is hidden. It's not a parlor trick;
            it's the point.
          </div>
        </div>

        <h2 style={css.h2}>Under the hood</h2>
        <p style={css.p}>
          Triple-core cognition (emotional / relational / temporal) with
          dialogue synthesis that preserves divergence. HyDE-augmented vector
          retrieval with LLM reranking. In-context exemplar learning with a
          cold-start seed corpus of 85 hand-curated exchanges. Constitutional
          self-critique before each generation. Best-of-two sampling with a
          fast-tier judge picking the winner. Token-level logit-bias on the
          top chatbot-tell phrases. Multi-family gauntlet (Llama judges +
          Gemini judges). Stylometric voice fingerprinting per user. Circuit
          breakers on every expensive path. All of it runs on Groq, Cerebras,
          Gemini, and Fireworks free tiers, hosted on Vercel.
        </p>

        <h2 style={css.h2}>Try it</h2>
        <Link href="/" style={{...css.cta, ...css.ctaP}}>talk to her →</Link>
        <Link href="/stats" style={{...css.cta, ...css.ctaS}}>see her state</Link>

        <div style={css.sub}>
          evaluator tip: turn on the "◐ inner" toggle in the chat header to see her think.
        </div>
      </div>
    </div>
  );
}
