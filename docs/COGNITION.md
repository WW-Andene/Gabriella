# Cognition & Self

How Gabriella interprets a moment, holds a self across time, and
notices when the world doesn't match what she was expecting.

## Triple-core + synthesis

Every non-fast-path turn runs three parallel interpreters against
the same moment:

- **Alpha** — emotional resonance. What does this land on inside her?
- **Beta** — relational pattern. What is this moment doing to the dynamic?
- **Gamma** — temporal weight. Where does this sit in the arc of what has been?

Each produces an independent `feltState`. Synthesis
(`lib/gabriella/clone/synthesis.js`) reads all three and produces one:

- **strong consensus** → local heuristic blend, no LLM
- **moderate** → premium LLM coordinates partial disagreement
- **divergent** → premium LLM stages a three-voice dialogue; the
  disagreement itself becomes the `edge` field rather than being
  averaged away

When the cores disagree, `turn.js` also attaches each core's compact
reading to the final feltState as `_dissents`. `speaker.js` renders
those in a `# How you read this moment (the parts that didn't agree)`
block so the speaker speaks FROM the tension instead of around it.

## Re-read on gauntlet rejection

When the gauntlet rejects the speaker's draft, the default retry
path uses the same feltState with added constraints — regenerating
speech from the same interpretation. If the original interpretation
was wrong, the retry fails in the same direction.

`lib/gabriella/clone/reread.js` breaks that loop: on rejection, one
premium-tier pass sees the rejected response + failure reasons + the
original reading, and produces a materially-different feltState.
Guarded against handing back the same reading — if nothing changes,
we fall through to the original-with-constraints path. The retry
speaks from the re-read, not from the original. The `_rereadShift`
annotation is surfaced in the speaker prompt so the retry sees what
changed in her own interpretation.

## The Sovereign Self

One structured object per user (`${userId}:self`) that owns the
unified interpretive state. Replaces what used to be six independent
prompt writers (soul / narrative / person / register / authorial /
mirror). Schema:

```
{
  anchor:      soul-text override or null
  wants: [    // longitudinal — persist across sessions
    { id, text, weight, addedAt, lastTouched, touches, source }
  ]
  read:  {    // unified read of who they are
    who, confidence, openQuestions, contradictions, lastUpdated
  }
  commitments: [  // positions with track records
    { id, text, atTurn, confirmations, refutations, status }
  ]
  retired: {  // what she has outgrown — VISIBLE in the prompt
    wants, reads, commitments
  }
}
```

After each turn, `selfProposer.js` fires one fast-tier LLM call that
reads the exchange, the reply, and the current self, and emits 0-3
typed deltas: `add_want`, `touch_want`, `retire_want`, `update_read`,
`add_commitment`, `confirm_commitment`, `refute_commitment`,
`note_contradiction`, `retire_read`, `set_confidence`. She authors
her own state.

Seeded deterministically from legacy modules on first load
(`seedSelfFrom`), so fresh users start rich.

## The Stream — continuous inner time

Append-only time-ordered log of inner experience per user
(`${userId}:stream`). Entries typed as:

- `thought` — something that surfaced
- `prediction` — what she expects the user to bring next
- `surprise` — when a prediction broke
- `connection` — link to older imprint / thread
- `re-reading` — reinterpretation of past material
- `intent` — something she means to do
- `observation` — per-turn texture (auto-written after every reply)
- `abandon` — thread she's letting drop

Capped at 80, pruned by `age × weight`. Renders oldest-to-newest so
the speaker sees the log ending at "just now."

## The Thinker

Runs every 10 minutes per active user via `/api/inner-loop`. One
premium-tier call produces up to three stream entries: a thought
(what surfaced since last run), an optional connection to older
material, an optional prediction about what the user will bring
back. Throttled (skip if stream activity in last 10 min, skip if
user idle >24h), circuit-broken, rate-aware.

Between turns, she is running. Not stored-and-reconstructed.

## Surprise — predictive engagement

When the user actually speaks, `surprise.js` loads the last live
predictions and scores them against the new message: *confirmed /
partial / off / surprising*. Non-confirmed verdicts produce a
`surprise` stream entry, which enters the next turn's prompt as
real context — "what I was running for you isn't what came."

The first predictive-error signal in the architecture. Fires on
returns (gap ≥15min) when live predictions exist. One fast-tier
call, circuit-broken.

## Mirror — second-order theory of mind

`relational.js` reads the relationship from her seat (phase,
trajectory). `mirror.js` reads the gap: what she thinks *they* are
reading of her, one concrete thing that has gone unsaid, where
she's been holding back. Debounced to every 5 min. Feeds the Self
seed and the Self proposer's `what just happened` context.
