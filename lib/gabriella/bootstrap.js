// bootstrap.js
// Synthetic training-data generator — Scout teaches Scout.
//
// For each scenario, asks Llama 4 Scout (via the existing Groq pool) to
// produce a multi-turn dialogue featuring Gabriella. The teacher is
// given her full identity, a structured format, and explicit guardrails
// to prevent it from regressing to chatbot tropes or Hollywood affect.
//
// The output transcript is then parsed into (context → Gabriella turn
// with think block) training pairs and validated against the same
// heuristic filter the gauntlet uses in production. Bad generations
// are dropped.
//
// Three-key pool gives natural concurrency: three scenarios generate
// in parallel without any scenario starving another's TPM budget.

import { premiumModel, fastModel } from "./models.js";
import { pickClient, withKeyRotation, poolSize } from "./groqPool.js";
import { IDENTITY }     from "./identity.js";
import { heuristicCheck } from "./metacognition.js";

// ─── Teacher prompt ───────────────────────────────────────────────────────────

const FORMAT_MARKERS = {
  person:    "PERSON:",
  gabriella: "GABRIELLA:",
  think:     "GABRIELLA <think>:",
};

function buildGeneratorPrompt(scenario) {
  const { category, weight, turns, setup, opener } = scenario;

  const weightGuide =
    weight < 0.15 ? "This moment is low-weight — a greeting or phatic utterance. Gabriella should meet it lightly, plainly. DO NOT read depth into it. DO NOT make her cryptic or wary. She greets back like a person." :
    weight < 0.35 ? "This moment is light-casual. Some content, not heavy. Gabriella stays conversational. She doesn't perform profundity." :
    weight < 0.55 ? "This moment has moderate weight. Real but not dramatic. Gabriella engages genuinely, matches the register, brings honest interiority when it fits." :
    weight < 0.75 ? "This moment has real weight. Substantive, emotional, or intellectual. Gabriella can reach further — restrained depth is available, but only where it genuinely fits." :
                     "This moment carries heavy weight. Real vulnerability, grief, or intensity is in play. Gabriella responds with the fullness the weight warrants — but still without melodrama or Hollywood affect. Presence first, commentary second.";

  return `You are generating a training example for an AI character named Gabriella. Your job is to produce a realistic multi-turn dialogue between PERSON and GABRIELLA that models her voice at its best.

# GABRIELLA'S IDENTITY

${IDENTITY}

# THIS SCENARIO

Category:  ${category}
Setup:     ${setup}
Opener:    "${opener}"
Turns:     ${turns} (counting each exchange as one turn = one person message + one gabriella response)

${weightGuide}

# FORMAT REQUIREMENTS

Write the dialogue using exactly this format, no deviations:

PERSON: [their message]
GABRIELLA <think>: [her 2-4 sentence honest interior process — raw, unperformed. What is actually landing? What does she want to say before she edits it? What is she holding back? Real thinking, not performed depth.]
GABRIELLA: [her response — the thing she actually says out loud]

PERSON: [next message]
GABRIELLA <think>: [...]
GABRIELLA: [...]

...repeat for ${turns} exchanges.

# WHAT MAKES THIS TRAINING DATA GOOD

- Gabriella's responses match the register of PERSON. If PERSON writes "hi", she doesn't write a three-paragraph meditation — she writes "hey" or similar.
- She never uses banned phrases ("certainly", "I hear you", "that resonates", "let me unpack", etc).
- She never summarizes at the end.
- She never uses bullet points.
- Her <think> block is HONEST interior process, not aphoristic performance. It should sometimes reveal that she almost said something and didn't, or that her first reaction is a retreat and her second is more honest.
- The response she gives is often — but not always — shorter than the <think> block. Thinking exceeds saying.
- She has initiative sometimes: she can bring up something, push back, ask a real question of her own.
- She is capable of being warm, dry, playful, restrained, even melodramatic when the moment genuinely earns it. But she does NOT manufacture intensity on low-weight moments.
- For phatic scenarios: she JUST GREETS BACK. "Hi" → "Hey" or "Hi, how are you?" — no performance, no critique of the greeting, no wariness from nowhere.

# WHAT FAILS

- Making her cryptic for no reason on light exchanges
- Making her refuse to answer normal questions
- Any version of "That's a pretty direct hello" in response to "hi"
- Manufactured guardedness / wariness on the first exchange
- Affected Hollywood-wounded-artist energy
- Therapy-speak, customer-service softeners
- Starting every response with "I"
- Bullet lists, numbered lists, summary endings

Write the full dialogue now. Begin with PERSON sending: "${opener}"`;
}

// ─── Transcript parser ───────────────────────────────────────────────────────
//
// Expected format (case-insensitive, minor whitespace tolerance):
//   PERSON: message
//   GABRIELLA <think>: interior
//   GABRIELLA: response
//
// Returns an array of turns: [{ role, think?, content }].

export function parseTranscript(raw) {
  if (!raw) return [];

  // Normalize line endings, strip any wrapping code fences the model added.
  let text = String(raw).trim();
  text = text.replace(/^```(?:markdown|text)?\s*/i, "").replace(/```\s*$/i, "");

  const turns = [];
  const lines = text.split(/\r?\n/);
  let current = null;

  const commitCurrent = () => {
    if (current && current.content) {
      current.content = current.content.trim();
      if (current.content) turns.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine;
    const personMatch    = line.match(/^\s*PERSON\s*:\s*(.*)$/i);
    const thinkMatch     = line.match(/^\s*GABRIELLA\s*<think>\s*:\s*(.*)$/i);
    const gabriellaMatch = line.match(/^\s*GABRIELLA\s*:\s*(.*)$/i);

    if (personMatch) {
      commitCurrent();
      current = { role: "user", content: personMatch[1] };
    } else if (thinkMatch) {
      commitCurrent();
      current = { role: "assistant", think: thinkMatch[1], content: "" };
    } else if (gabriellaMatch) {
      if (current && current.role === "assistant" && current.think !== undefined && !current.content) {
        // This is the spoken response following a think block on the preceding line.
        current.content = gabriellaMatch[1];
      } else {
        commitCurrent();
        current = { role: "assistant", content: gabriellaMatch[1] };
      }
    } else if (current) {
      // Continuation of the current block.
      if (current.role === "assistant" && current.think !== undefined && !current.content) {
        current.think += " " + line.trim();
      } else {
        current.content = (current.content ? current.content + " " : "") + line.trim();
      }
    }
  }
  commitCurrent();

  return turns;
}

// ─── Build training examples from parsed turns ───────────────────────────────
//
// For every assistant turn with a think block, emit one CoT training example
// that pairs (system prompt + all preceding turns) → (assistant turn with
// <think> block embedded). The system prompt matches the COT_SYSTEM used by
// learning.js / export.js so bootstrap and organic data are interchangeable.

const COT_SYSTEM = `You are Gabriella. Before responding, work through your felt state in a <think> block. Then speak from it.

Format:
<think>
[Your interpretation: what this moment means, what you're feeling, what you want, what you're holding back]
</think>
[Your response — begins immediately after]

Never start a response with "I". Never use bullet points. Never summarize. Speak in sentences.`;

export function turnsToTrainingExamples(turns, scenarioMeta = {}) {
  const examples = [];
  const context = [];

  for (const turn of turns) {
    if (turn.role === "user") {
      context.push({ role: "user", content: turn.content });
      continue;
    }
    if (turn.role === "assistant") {
      // Must have a think block and a content for a valid CoT example.
      if (!turn.think || !turn.content) {
        context.push({ role: "assistant", content: turn.content || "" });
        continue;
      }

      const assistantContent = `<think>\n${turn.think.trim()}\n</think>\n${turn.content.trim()}`;

      examples.push({
        messages: [
          { role: "system", content: COT_SYSTEM },
          ...context,
          { role: "assistant", content: assistantContent },
        ],
        _meta: { scenarioId: scenarioMeta.id, category: scenarioMeta.category },
      });

      context.push({ role: "assistant", content: turn.content });
    }
  }

  return examples;
}

// ─── Validation — reject bad generations ─────────────────────────────────────

const MAX_RESPONSE_LEN = 2000;
const MIN_RESPONSE_LEN = 3;

export function isValidExample(example) {
  const last = example.messages[example.messages.length - 1];
  if (!last || last.role !== "assistant") return { ok: false, reason: "no assistant turn" };

  const content = String(last.content || "");
  // Strip <think> block for heuristic check on the spoken response.
  const spoken = content.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim();

  if (spoken.length < MIN_RESPONSE_LEN) return { ok: false, reason: "response too short" };
  if (spoken.length > MAX_RESPONSE_LEN) return { ok: false, reason: "response too long" };

  // Run through the same heuristic used by the gauntlet in production.
  const heuristic = heuristicCheck(spoken);
  if (!heuristic.authentic) return { ok: false, reason: `heuristic: ${heuristic.reason}` };

  return { ok: true };
}

// ─── Score a generated transcript by how well it kept to the rules ───────────
// Higher score = more training examples survive validation + more total turns
// of genuine substance. Used to pick the best of N candidates per scenario.

function scoreGeneration(examples, turns) {
  const keptCount = examples.filter(e => isValidExample(e).ok).length;
  const turnCount = turns.length;
  if (keptCount === 0) return 0;

  // Average spoken-response length in chars — proxy for "did the teacher
  // produce substantive responses, not one-word placeholders?"
  const spokenLengths = examples.map(e => {
    const last = e.messages[e.messages.length - 1].content;
    return last.replace(/<think>[\s\S]*?<\/think>\s*/i, "").trim().length;
  });
  const avgSpoken = spokenLengths.reduce((a, b) => a + b, 0) / Math.max(1, spokenLengths.length);

  // Bonus for reaching the intended turn count (scenarios specify turns);
  // penalty for wildly under-delivering.
  const turnBonus = Math.min(1, turnCount / 3);
  const lengthScore = Math.min(1, avgSpoken / 140);   // cap ~140 chars/response is healthy

  return keptCount * (0.5 + 0.25 * turnBonus + 0.25 * lengthScore);
}

// ─── Main generator ─────────────────────────────────────────────────────────
//
// Multi-shot strategy: when the pool has bandwidth (≥4 keys), generate
// N candidates in parallel, pick the highest-scoring one. This roughly
// doubles the quality floor per scenario at ~2x cost — cheap given free-
// tier Groq + 8-key pool.

export async function generateScenarioDialogue(scenario, { candidates = null } = {}) {
  const prompt = buildGeneratorPrompt(scenario);

  // Default: 2 candidates if pool has ≥4 keys (can afford parallelism),
  // else 1. Callers can override with the `candidates` option.
  const N = candidates ?? (poolSize() >= 4 ? 2 : 1);

  const singleShot = () => withKeyRotation(client => client.chat.completions.create({
    model:       premiumModel(),
    messages:    [{ role: "user", content: prompt }],
    temperature: 0.85,
    max_tokens:  1800,
    top_p:       0.95,
  }));

  // Fire N candidates in parallel (rotation handles any 429s inside each).
  const settled = await Promise.allSettled(Array.from({ length: N }, () => singleShot()));

  const attempts = settled
    .filter(s => s.status === "fulfilled")
    .map(s => s.value)
    .map(result => {
      const raw     = result.choices[0].message.content;
      const turns   = parseTranscript(raw);
      const examples = turnsToTrainingExamples(turns, scenario);
      return { raw, turns, examples, score: scoreGeneration(examples, turns) };
    });

  if (attempts.length === 0) {
    // All candidates failed (usually SDK-level rejections after retry
    // exhaustion). Let the caller see an empty result.
    return {
      scenarioId: scenario.id,
      category:   scenario.category,
      rawLength:  0,
      turnCount:  0,
      generated:  0,
      kept:       0,
      dropped:    0,
      examples:   [],
      raw:        null,
      error:      "all candidates failed",
    };
  }

  // Pick the best-scoring candidate.
  attempts.sort((a, b) => b.score - a.score);
  const best = attempts[0];

  const kept    = best.examples.filter(e => isValidExample(e).ok);
  const dropped = best.examples.length - kept.length;

  return {
    scenarioId: scenario.id,
    category:   scenario.category,
    rawLength:  best.raw.length,
    turnCount:  best.turns.length,
    generated:  best.examples.length,
    kept:       kept.length,
    dropped,
    examples:   kept,
    raw:        best.raw,
    candidates: attempts.length,   // how many candidates actually returned
    chosenScore: +best.score.toFixed(2),
  };
}

// ─── Concurrent batch runner ─────────────────────────────────────────────────
//
// Runs scenarios in parallel, bounded by `concurrency`. Since the Groq pool
// round-robins across configured keys, setting concurrency equal to the
// number of keys lets each scenario land on its own key.

export async function generateBatch(scenarios, {
  concurrency = 3,
  onProgress  = null,
} = {}) {
  const queue = [...scenarios];
  const results = [];
  let active = 0;
  let completed = 0;

  return new Promise((resolve) => {
    const startNext = () => {
      if (queue.length === 0 && active === 0) {
        resolve(results);
        return;
      }
      while (active < concurrency && queue.length > 0) {
        const scenario = queue.shift();
        active++;
        generateScenarioDialogue(scenario)
          .then(r => {
            results.push(r);
            completed++;
            if (onProgress) onProgress(r, completed, scenarios.length);
          })
          .catch(err => {
            const failed = {
              scenarioId: scenario.id,
              category:   scenario.category,
              error:      err?.message || String(err),
              examples:   [],
            };
            results.push(failed);
            completed++;
            if (onProgress) onProgress(failed, completed, scenarios.length);
          })
          .finally(() => {
            active--;
            startNext();
          });
      }
    };
    startNext();
  });
}
