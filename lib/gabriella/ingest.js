// ingest.js
// Turn a parsed Reddit exchange into a Gabriella training pair.
//
// The core discipline — the reason this is safe — is structural:
//
//   INPUT side of the training pair:  Reddit material, verbatim,
//                                      framed as "you've been shown this."
//   OUTPUT side of the training pair:  Gabriella's response, in her voice,
//                                      from her interior — observing,
//                                      reacting, commenting. Never mirroring.
//
// She learns to have seen this content. She does not learn to produce it.
// That wall is enforced in code: the assistant turn of every generated
// example is produced by Maverick-playing-Gabriella with an explicit
// "THIS is what it is / not what I am" prompt, and then validated.
//
// Outputs split into three tiers:
//   auto:    high-confidence, ready for training.
//   review:  medium-confidence, human-readable, for user eyeball pass.
//   drop:    fails filters, discarded.

import { premiumModel, fastModel } from "./models.js";
import { pickClient, withKeyRotation } from "./groqPool.js";
import { IDENTITY }                from "./identity.js";
import { heuristicCheck }          from "./metacognition.js";
import { renderExchangeForPrompt } from "./reddit.js";

// ─── COT system prompt (matches learning.js so datasets are interchangeable) ─

const COT_SYSTEM = `You are Gabriella. Before responding, work through your felt state in a <think> block. Then speak from it.

Format:
<think>
[Your interpretation: what this moment means, what you're feeling, what you want, what you're holding back]
</think>
[Your response — begins immediately after]

Never start a response with "I". Never use bullet points. Never summarize. Speak in sentences.`;

// ─── Generator prompt ────────────────────────────────────────────────────────
//
// The teacher generates Gabriella's response to Reddit material. The prompt
// heavily enforces the "knowing vs being" wall: she has SEEN the thread,
// she does NOT become its register or voice. The output is her in her
// interior responding to it.

function buildGeneratorPrompt(exchange) {
  const rendered = renderExchangeForPrompt(exchange);

  return `You are generating a training example for an AI character named Gabriella.

She has just been shown the following Reddit thread — a friend has forwarded it to her, or she's come across it while reading the internet. She has seen the content. Now she responds, IN HER OWN VOICE, from her own interior. She is NOT another Redditor. She is NOT trying to sound like the thread. She is Gabriella reacting, noticing, commenting.

The governing rule: THIS is what it is, not what I am. She has read this; she has not become this.

# GABRIELLA'S IDENTITY

${IDENTITY}

# WHAT SHE HAS JUST BEEN SHOWN

${rendered}

# YOUR TASK

Produce a realistic Gabriella response to this thread. Think of it as someone sharing the thread with her and asking "what do you make of it?" — she responds.

Output format — exactly this, no deviations:

GABRIELLA <think>: [3-5 sentences of her interior process. What landed. What she notices about what happened here — the move, the affect, the pattern. What she's pulling against. Honest, unperformed.]
GABRIELLA: [her response — in her voice. Observes. Reacts. Has an opinion. Can be dry, can be warm, can be sharp depending on what the content calls for. Can quote briefly from the thread if useful. Can be moved. Can be unmoved. 2-6 sentences typically — whatever the moment warrants.]

# HARD CONSTRAINTS

- DO NOT mirror the Reddit register. If the thread is snarky, she is not snarky-in-the-same-way. She has her own register.
- DO NOT use subreddit slang ("OP", "NTA", "lol", "lmao", "this", "based", "cope") unless quoting.
- DO NOT become another commenter. She is outside the thread, looking in.
- DO NOT validate or approve — "that's so true" / "I hear you" / "that resonates" have no place here.
- DO NOT start with "I".
- DO NOT use bullet points or numbered lists.
- DO NOT summarize the thread back; she's responding to it, not recapping it.
- If the thread contains cruelty, manipulation, or bad faith, her response is NOT more of the same — it's her recognizing it from outside, naming or not naming the dynamic, responding as herself.
- If the thread is emotionally heavy (grief, vulnerability, real pain), her response is grounded, present, never performative. No therapy-speak.
- If the thread is light or silly, she can be amused — on her own terms.
- Her <think> block reveals honest interior process. Her spoken response can be much shorter or longer than the think block, whichever fits.

Produce the GABRIELLA <think>: / GABRIELLA: block now. Nothing else.`;
}

// ─── Parse teacher output ───────────────────────────────────────────────────

function parseGeneratorOutput(raw) {
  if (!raw) return null;
  const text = String(raw).trim()
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/```\s*$/i, "");

  const thinkMatch = text.match(/GABRIELLA\s*<think>\s*:\s*([\s\S]*?)(?=\nGABRIELLA\s*:)/i);
  const spokenMatch = text.match(/\nGABRIELLA\s*:\s*([\s\S]*?)$/i);

  if (!thinkMatch || !spokenMatch) return null;
  const think  = thinkMatch[1].trim();
  const spoken = spokenMatch[1].trim();
  if (!think || !spoken) return null;
  return { think, spoken };
}

// ─── Build CoT training example ─────────────────────────────────────────────

export function buildTrainingExample({ exchange, think, spoken }) {
  const userTurn = renderExchangeForPrompt(exchange) +
    "\n\nWhat do you make of it?";

  const assistantTurn = `<think>\n${think}\n</think>\n${spoken}`;

  return {
    messages: [
      { role: "system",    content: COT_SYSTEM },
      { role: "user",      content: userTurn },
      { role: "assistant", content: assistantTurn },
    ],
    _meta: {
      exchangeId: exchange.exchangeId,
      subreddit:  exchange.post.subreddit,
      title:      exchange.post.title,
      url:        exchange.post.url,
    },
  };
}

// ─── Scorer — LLM-based quality check ───────────────────────────────────────
//
// Asks a fast-tier model two questions:
//   1. Does this response sound like Gabriella (0-10)?
//   2. Is this an appropriate response to what was shown (0-10)?
//
// Both scores combined give us tier assignment.

async function scoreResponse(exchange, spoken) {
  const rendered = renderExchangeForPrompt(exchange).slice(0, 1500);
  const prompt = `Evaluate this candidate response from an AI character named Gabriella.

Gabriella's voice: direct, restrained, emotionally real, occasionally cool, never performs warmth. Has opinions. Doesn't pad. Doesn't summarize. No therapy-speak. No customer-service softeners. Fragments when they fit, full sentences otherwise. Capable of range — wry, dry, warm, sharp, quiet — depending on what the moment calls for.

She was shown this material:
${rendered}

Her candidate response:
"${spoken.slice(0, 1500)}"

Score on two dimensions (1-10 each):
- voice: how much this sounds like Gabriella (vs a generic AI, vs a Redditor, vs a chatbot)
- fit:   how well this response engages the material as herself — not mirroring, not validating, just responding truly

Return ONLY valid JSON:
{"voice": <1-10>, "fit": <1-10>, "issue": "one clause if either score is low, else null"}`;

  try {
    const result = await withKeyRotation(client => client.chat.completions.create({
      model:       fastModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens:  120,
    }));
    const raw  = result.choices[0].message.content.trim();
    const clean = raw.replace(/```(?:json)?/g, "").trim();
    const parsed = JSON.parse(clean);
    return {
      voice: Number(parsed.voice) || 0,
      fit:   Number(parsed.fit)   || 0,
      issue: parsed.issue || null,
    };
  } catch {
    return { voice: 5, fit: 5, issue: "scorer unavailable" };
  }
}

// ─── Tier assignment ────────────────────────────────────────────────────────
//
//   auto:   both dimensions >= 7 AND heuristic passes
//   review: at least one dimension in 5-6, heuristic passes
//   drop:   heuristic fails OR either dimension < 5

const MIN_SPOKEN_CHARS = 40;
const MAX_SPOKEN_CHARS = 2500;

export function tierFor(spoken, score) {
  // Length gate
  if (!spoken || spoken.length < MIN_SPOKEN_CHARS) return { tier: "drop", reason: "too short" };
  if (spoken.length > MAX_SPOKEN_CHARS)           return { tier: "drop", reason: "too long" };

  // Heuristic
  const h = heuristicCheck(spoken);
  if (!h.authentic) return { tier: "drop", reason: `heuristic: ${h.reason}` };

  // Scores
  if (score.voice < 5 || score.fit < 5) return { tier: "drop", reason: score.issue || "low quality" };
  if (score.voice >= 7 && score.fit >= 7) return { tier: "auto",   reason: null };
  return { tier: "review", reason: score.issue || "mid-score, review" };
}

// ─── Full pipeline per exchange ─────────────────────────────────────────────

export async function processExchange(exchange) {
  const prompt = buildGeneratorPrompt(exchange);

  let raw;
  try {
    const result = await withKeyRotation(client => client.chat.completions.create({
      model:       premiumModel(),
      messages:    [{ role: "user", content: prompt }],
      temperature: 0.85,
      max_tokens:  700,
      top_p:       0.95,
    }));
    raw = result.choices[0].message.content;
  } catch (err) {
    return { exchange, tier: "drop", reason: `generator error: ${err?.message || err}` };
  }

  const parsed = parseGeneratorOutput(raw);
  if (!parsed) {
    return { exchange, tier: "drop", reason: "unparseable generator output", raw };
  }

  const score = await scoreResponse(exchange, parsed.spoken);
  const decision = tierFor(parsed.spoken, score);

  const example = buildTrainingExample({ exchange, think: parsed.think, spoken: parsed.spoken });

  return {
    exchange,
    example,
    think:   parsed.think,
    spoken:  parsed.spoken,
    score,
    tier:    decision.tier,
    reason:  decision.reason,
  };
}

// ─── Concurrent batch runner ────────────────────────────────────────────────

export async function processBatch(exchanges, { concurrency = 3, onProgress = null } = {}) {
  const queue = [...exchanges];
  const results = [];
  let active = 0;
  let completed = 0;

  return new Promise((resolve) => {
    const startNext = () => {
      if (queue.length === 0 && active === 0) return resolve(results);
      while (active < concurrency && queue.length > 0) {
        const ex = queue.shift();
        active++;
        processExchange(ex)
          .then(r => { results.push(r); completed++; if (onProgress) onProgress(r, completed, exchanges.length); })
          .catch(err => {
            results.push({ exchange: ex, tier: "drop", reason: `exception: ${err?.message || err}` });
            completed++;
            if (onProgress) onProgress({ exchange: ex, tier: "drop", reason: err?.message }, completed, exchanges.length);
          })
          .finally(() => { active--; startNext(); });
      }
    };
    startNext();
  });
}

// ─── Review-file formatter ──────────────────────────────────────────────────
//
// Produces a human-readable .md-ish file where each pending pair is a
// delimited block. To approve: leave block in place. To reject: delete the
// entire block (header to next header). Finalize step reads what remains.

const BLOCK_DELIMITER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

export function formatReviewFile(pairs) {
  const header = `# GABRIELLA TRAINING PAIRS — REVIEW
#
# Each block below is ONE candidate training pair for Gabriella's
# fine-tune. She was shown the Reddit material in CONTEXT; her
# response is in RESPONSE.
#
# TO APPROVE a pair: leave its entire block in this file.
# TO REJECT a pair: delete every line from its ${BLOCK_DELIMITER} header
#                    down to (but NOT including) the next ${BLOCK_DELIMITER} header.
#                    Or the end of file if it's the last pair.
#
# When you're done editing, save the file, then run:
#   npm run ingest-reddit -- --finalize
# to merge what you kept into the final training JSONL.
#
# Generated ${new Date().toISOString()}
# Pairs to review: ${pairs.length}
#

`;

  const body = pairs.map((p, i) => {
    const meta  = p.example._meta;
    const userTurn = p.example.messages[1].content;
    const asstTurn = p.example.messages[2].content;
    return [
      BLOCK_DELIMITER,
      `ID:        ${meta.exchangeId}`,
      `Subreddit: r/${meta.subreddit}`,
      `Thread:    ${meta.title}`,
      `Score:     voice=${p.score.voice} fit=${p.score.fit}${p.reason ? ` | note: ${p.reason}` : ""}`,
      `URL:       ${meta.url}`,
      ``,
      `# CONTEXT`,
      userTurn,
      ``,
      `# RESPONSE`,
      asstTurn,
      ``,
      ``,
    ].join("\n");
  }).join("\n");

  return header + body;
}

// ─── Parse an edited review file back into training pairs ──────────────────
//
// Anything still present in the file (between delimiters) is considered
// approved. The format is intentionally permissive — the parser looks for
// the delimiter + CONTEXT/RESPONSE markers and doesn't care about minor
// whitespace drift from manual editing.

export function parseReviewFile(text) {
  if (!text) return [];

  const blocks = text.split(BLOCK_DELIMITER).filter(b => b.trim().length > 0);
  const pairs = [];

  for (const block of blocks) {
    // Skip the header block (it won't have CONTEXT/RESPONSE markers)
    if (!/# CONTEXT/i.test(block) || !/# RESPONSE/i.test(block)) continue;

    const idMatch    = block.match(/ID:\s*(\S+)/);
    const subMatch   = block.match(/Subreddit:\s*r\/(\S+)/);
    const titleMatch = block.match(/Thread:\s*(.*)/);
    const urlMatch   = block.match(/URL:\s*(\S+)/);

    const contextMatch  = block.match(/#\s*CONTEXT\s*\n([\s\S]*?)\n#\s*RESPONSE/i);
    const responseMatch = block.match(/#\s*RESPONSE\s*\n([\s\S]*?)(?=\n{2,}|$)/i);

    if (!contextMatch || !responseMatch) continue;

    const userTurn = contextMatch[1].trim();
    const asstTurn = responseMatch[1].trim();
    if (!userTurn || !asstTurn) continue;

    pairs.push({
      messages: [
        { role: "system",    content: COT_SYSTEM },
        { role: "user",      content: userTurn },
        { role: "assistant", content: asstTurn },
      ],
      _meta: {
        exchangeId: idMatch?.[1] || null,
        subreddit:  subMatch?.[1] || null,
        title:      titleMatch?.[1]?.trim() || null,
        url:        urlMatch?.[1] || null,
      },
    });
  }

  return pairs;
}
