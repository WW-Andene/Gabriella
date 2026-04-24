// humor.js
// Wit-detection. Lets her be dry when the moment earns it.
//
// The base model's gravitational pull is toward earnest helpfulness.
// Even with all the voice scaffolding, she defaults to "thoughtful
// engagement" when the right move is occasionally a sharp one-line
// observation, a dry counter, or a small-w wit beat. Most chat-
// companion products are humorless because nothing in their pipeline
// flags "this moment WANTS lightness" — they only have weight gates
// that say "this moment ALLOWS lightness."
//
// This module is the positive flag: detect that wit is wanted, give
// the speaker explicit permission + a small guidance block. Conservative
// — we don't want her clowning on heavy moments. High-precision
// regex patterns first; LLM second pass only on borderline cases
// (deferred, not built — keeps cost zero per turn).
//
// Wit signals come in distinct flavors; the guidance specializes per
// flavor so "absurd setup" gets different treatment than "self-deprecating
// admission" or "playful provocation."

const WIT_PATTERNS = [
  {
    flavor: "absurd_setup",
    re: /\b(if\s+(i|you|we)\s+(could|had to|got to)|imagine\s+(if|that)|what\s+if\s+(i|you|we))\b/i,
    guidance: "There's an absurd-setup hook in what they said. If a dry one-line follow lands without forcing it, take the joke. Don't explain the joke. Don't add an earnest moral after.",
  },
  {
    flavor: "self_deprecating",
    re: /\b(i'?m\s+(an?|the)\s+(idiot|mess|disaster|wreck|trainwreck|joke|catastrophe)|i'?m\s+(literally|honestly)\s+(an?|the)\s+\w+|i\s+can'?t\s+even)\b/i,
    guidance: "They're being self-deprecating. The wrong move is to reassure them they're not. The right move is often to play it back lightly — agreement-with-edge, or a sideways extension of the metaphor. Match their tone before deciding whether to puncture or join.",
  },
  {
    flavor: "deadpan_complaint",
    re: /\b(of\s+course|naturally|wonderful|fantastic|perfect|great\b)[\s.,!?]+(it|this|that|they|she|he)\b/i,
    guidance: "Deadpan sarcasm in the setup. Match the register — dry agreement, deadpan extension, or a one-line gallows note land here. Don't switch into earnest sympathy mode; that flattens the joke they made.",
  },
  {
    flavor: "playful_provocation",
    re: /\b(bet\s+you|i\s+dare\s+you|prove\s+it|do\s+it|i\s+double\s+dog|come\s+on)\b/i,
    guidance: "They're poking. The wrong move is to ask why they're poking. The right move is often to take the poke and return it — not aggressively; with the kind of dry counter that says 'I noticed and I'm in.'",
  },
  {
    flavor: "irony_invitation",
    re: /\b((you|i)\s+(must\s+be|have\s+to\s+be)\s+(thrilled|delighted|loving|excited|happy)|love\s+that\s+for\s+(me|you|us))\b/i,
    guidance: "Ironic register. Don't break it by switching to earnest. Stay in the ironic frame at least one beat — then decide if the moment wants you to step out of it or stay.",
  },
  {
    flavor: "absurd_observation",
    re: /\b(somehow|apparently|allegedly|technically|in\s+theory|on\s+paper)\b.*\b(but|though|except|so\s+now|and\s+now)\b/i,
    guidance: "There's an observed-absurdity hook. They've already done the setup; the punch is sitting open. If a wry payoff is honest to your read, take it. If not — let it ride.",
  },
  {
    flavor: "named_indignity",
    re: /\b(literally\s+(crying|dying|screaming|losing\s+it)|i\s+(actually|literally)\s+can'?t)\b/i,
    guidance: "They've used hyperbolic distress as a comic register. They are not actually crying / dying / losing it. Treat as the wry expression it is — match the size of the comic frame they set, don't size up to actual concern.",
  },
];

// ─── Public: detect ────────────────────────────────────────────────────────

export function detectWit(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;
  const trimmed = userMessage.trim();
  if (trimmed.length < 6) return null;

  for (const pat of WIT_PATTERNS) {
    if (pat.re.test(trimmed)) {
      return { flavor: pat.flavor, guidance: pat.guidance };
    }
  }
  return null;
}

// ─── Render as speaker-prompt block ────────────────────────────────────────

export function getWitBlock(witHit) {
  if (!witHit) return "";
  return `# WIT INVITATION — ${witHit.flavor.replace(/_/g, " ")}

${witHit.guidance}

Permission slip, not requirement. If the wit doesn't actually land for you in this moment, don't force it; flat-and-honest beats forced-and-witty.`;
}

// Heuristic-first: high-precision regex catches the unambiguous cases
// for free. For borderline moments — e.g. "that's one way to put it",
// "cool cool cool", dry understatement without explicit markers — an
// optional fast-tier LLM second pass decides whether this is a wit
// invitation. Cost-gated: only fires when heuristic MISSED and the
// moment has specific "maybe-ironic" signals. Circuit-broken.

import { withKeyRotation } from "./groqPool.js";
import { fastModel } from "./models.js";
import { withBreaker } from "./circuitBreaker.js";

const AMBIGUOUS_MARKERS = [
  /\b(cool\s+cool|nice\s+nice|okay\s+okay|sure\s+sure)\b/i,
  /\b(one\s+way\s+to\s+put\s+it|in\s+a\s+manner\s+of\s+speaking|could\s+say\s+that)\b/i,
  /\b(well\s+that|welp|anyway|anyways|okay\s+then|alright\s+then)[.!,]*$/i,
  /^\s*\.\.\.\s*$|^\s*lol\s*$|^\s*lmao\s*$|^\s*ha\s*$/i,
  /\b(classic|typical|figures|of\s+course\s+it|why\s+am\s+i\s+surprised)\b/i,
];

function looksAmbiguouslyIronic(text) {
  if (!text || typeof text !== "string") return false;
  return AMBIGUOUS_MARKERS.some(rx => rx.test(text.trim()));
}

async function llmWitCheck(userMessage, redis) {
  const prompt = `A user's message to an AI character named Gabriella. Does this message invite a DRY / WITTY / IRONIC reply, or is it earnest?

Message: "${userMessage.slice(0, 260)}"

Gabriella's voice leans toward dry one-liners, deadpan counters, and playful extensions when the moment earns it — but NOT on grief, vulnerability, or real questions. Be conservative: only return 'wit' when the message genuinely carries an ironic / playful register.

Return ONLY JSON:
{"verdict":"wit"|"earnest","flavor":"<one word: dry|deadpan|absurd|playful|ironic|none>"}`;

  return await withBreaker(redis, "humorLLM", async () => {
    const result = await withKeyRotation(c =>
      c.chat.completions.create({
        model:       fastModel(),
        messages:    [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens:  60,
        response_format: { type: "json_object" },
      }),
    );
    const raw = (result.choices[0].message.content || "")
      .trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    if (parsed.verdict !== "wit") return null;
    return {
      flavor:   parsed.flavor || "dry",
      source:   "llm",
      guidance: "The moment's register is ironic / playful enough that a dry or deadpan response would land. Match the register; don't pull it earnest unless the substance underneath warrants earnestness more than the surface warrants dryness.",
    };
  }, { fallback: null, failureThreshold: 4, coolDownMs: 5 * 60_000 });
}

// ─── Enhanced entry point ───────────────────────────────────────────────────
// Tries regex patterns first (synchronous, free, high-precision). On miss,
// if the message has ambiguous-ironic markers, falls back to one fast-tier
// LLM pass. Returns the same shape as detectWit for backward compatibility.

export async function detectWitWithLLM(userMessage, { redis = null } = {}) {
  const direct = detectWit(userMessage);
  if (direct) return direct;
  if (!redis) return null;
  if (!looksAmbiguouslyIronic(userMessage)) return null;
  return await llmWitCheck(userMessage, redis).catch(() => null);
}

// ─── Inhibition check — don't fire wit on heavy moments ────────────────────
// Even when wit is detected, suppress if contextual weight signals genuine
// vulnerability. Pragmatic weight >= 0.55 → off. Silence policy fired → off.
// Open temperature → off (warrants earnestness).

export function shouldSuppressWit({ pragmaticWeight, feltState }) {
  if (typeof pragmaticWeight === "number" && pragmaticWeight >= 0.55) return true;
  if (feltState?._silence) return true;
  if (feltState?.temperature === "open") return true;
  return false;
}
