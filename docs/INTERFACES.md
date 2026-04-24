# Interfaces

What a user or evaluator actually touches.

## `/` — chat

Standard streaming chat UI, but with structural differences:

- **Fragmented delivery** — responses are split at `\n\n` and
  streamed as separate bubbles with inter-fragment pauses, so a
  longer reply feels like texting ("thinking…" → first bubble →
  pause → second bubble) rather than a single wall of text.
- **Cadence** — `cadence.js` computes a pre-stream thinking delay
  plus per-character typing speed from her felt-state, pragmatic
  weight, and organism state. Fast-and-light for phatic; slow-and-
  deliberate for heavy.
- **Tool chip** — when she commits to an action (pinning, setting
  a reminder), a small chip lands on the last bubble confirming
  the action happened.
- **Inner-life reveal toggle** — the amber `◐ inner` button in the
  header. When on, a subtle amber panel shows:
  - her `<think>` block for the last turn (italic prose)
  - `<uncertain>` annotation if she wasn't sure about something
  - her felt-state snapshot: charge, emotional, want, temperature,
    edge, consensus, retried flag
  Preference persists via `localStorage`.

## `/meet` — evaluator landing page

Short declarative page that says what makes her different in five
specific claims, links to chat + stats. No marketing fluff — five
things plus an "under the hood" paragraph naming the techniques.

## `/stats` — visual dashboard

Consumes `/api/stats`. Renders:

- **Hero**: total turns + autonomous-eval win-rate with sparkline
  of last 10 days, 95% CI, rolling average
- **Sovereign Self**: active wants, top weight, live/confirmed
  commitments, read confidence, open questions, contradictions,
  retired track record
- **Stream**: entry count, per-kind distribution, last thought
- **Memory**: char counts per layer
- **Training pipeline**: log size, DPO pairs, ensemble labels,
  KTO readiness, fine-tune active/base, speaker errors
- **Heartbeats**: soul / evolution / register / authorial last-updated
- **Circuit breakers**: color-coded pills per subsystem
- **Pool**: keys alive per provider
- **Readiness**: green/red per configured provider

Dark theme, refresh button, zero-dep sparkline renderer.

## `/dev` — operator console

Pre-existing page (v7) for training pipeline operations: view logs,
trigger bootstraps, push bundles manually. Auth via a secret kept
in `localStorage`.

## Sidecar protocol

`/api/chat` streams responses as a mix of natural prose and typed
sidecar markers wrapped in `U+001F` (unit-separator) delimiters:

```
visible text here...
<US>__THINK__{"text":"...","uncertain":null}<US>
<US>__FELT__{"charge":"...","want":"..."}<US>
<US>__TOOL__{"tool":"pin","ok":true}<US>
```

Client parses via `extractSidecars()` which strips all markers from
the rendered bubble and exposes their payloads to state. New marker
types can be added server-side without client changes (unknown
markers are preserved in text — defensive). Recognized markers:

- `__THINK__` — interior monologue + optional uncertain flag
- `__FELT__` — felt-state snapshot (renders in inner-life panel)
- `__TOOL__` — tool result (renders as chip on last bubble)

## API endpoints

| Path | Purpose |
|---|---|
| `POST /api/chat` | Chat turn, streaming |
| `GET  /api/stats` | System state JSON |
| `GET  /api/eval` | Manual trigger for daily autonomous eval |
| `GET  /api/think` | Manual trigger for /api/think cron |
| `GET  /api/sleep` | Manual trigger for daily consolidation |
| `GET  /api/initiate` | Manual trigger for between-session opener |
| `GET  /api/inner-loop` | Manual trigger for the 10-min thinker |
| `GET  /api/learn` | Manual trigger for weekly training push |
| `GET  /api/learn/watch` | Poll Fireworks for fine-tune completion |
| `POST /api/fireworks/finetune` | Direct Fireworks SFT operations |

All cron endpoints require `Authorization: Bearer $CRON_SECRET`.
