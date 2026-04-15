// knobs.js
// Per-turn generation parameters computed from substrate + psyche +
// organism state. This is the layer that translates "who she is" + "how
// she is right now" into "how she should speak this turn."
//
// Before this file existed, the speaker prompt asked for "sentences
// with rhythm" — a uniform target. Every response came back polished
// regardless of upstream signals. knobs.js fixes that by computing
// specific generation parameters that MODULATE with state.
//
// The knobs are NOT the prompt. They're inputs to the prompt builder.
// buildSpeakerPrompt consumes them and writes a tailored generation
// directive that varies turn-to-turn.

import { lexical, idiolect, tics, cognition as substrateCognition } from "./substrate.js";
import { bigFive, attachment, schemas, parts, gricean, cognitiveProfile, olderSister } from "./psyche.js";
// Note on substrateDelta: the meta-loop (Phase 5) writes a per-user delta
// layer. Downstream callers (speaker.js / chat route) can load it from
// redis and pass it to computeKnobs as `substrateDelta`. When absent,
// knobs falls back to the authored substrate only.

// ─── Individual knob computations ────────────────────────────────────────────
// Each takes state + context and returns a 0..1 value or a discrete choice.

function clamp(v) { return Math.max(0, Math.min(1, v)); }

// polishLevel — how polished/precise the output should be. Low = more
// disfluency, shorter sentences, reaches for familiar phrases.
// Drivers: energy × attention × engagement × socialComfort.
function computePolishLevel(state, context) {
  const energy    = state?.energy     ?? 0.7;
  const attention = state?.attention  ?? 0.6;
  const engaged   = context.pragmaticWeight >= 0.5 ? 1 : 0.6;
  const comfort   = state?.socialComfort ?? 0.5;

  // When energy is low OR attention drifting, polish drops.
  // When engaged and comfortable, polish can go up.
  const raw = (energy * 0.35) + (attention * 0.35) + (comfort * 0.15) + (engaged * 0.15);
  return clamp(raw);
}

// signatureDensity — how many of her signature-vocabulary words she
// should reach for this turn. Higher when engaged / comfortable / in a
// domain that matches her hyperfocus.
function computeSignatureDensity(state, context) {
  const comfort = state?.socialComfort ?? 0.5;
  const engagement = context.pragmaticWeight >= 0.4 ? 0.7 : 0.3;

  // She uses her signature vocabulary more freely when at-ease AND engaged.
  return clamp(comfort * 0.5 + engagement * 0.5);
}

// activePart — which IFS part is dominant this turn. One of:
// "observer" (default), "manager", "protector", "quiet", "needler",
// "older_sister" (caretaker mode), "delight" (observer hyperfocus sub-mode).
function determineActivePart(state, context, feltState) {
  const charge = (feltState?.charge || "").toLowerCase();
  const edge   = !!feltState?.edge;
  const weight = context.pragmaticWeight ?? 0.3;
  const irritation = state?.irritation ?? 0;
  const comfort    = state?.socialComfort ?? 0.5;

  // Protector fires on threat — cold register from user, irritation spike.
  if (irritation > 0.55) return "protector";
  if (/cool|cold|distant|hostile|dismissive|utility/.test(charge)) return "protector";

  // Needler fires on specific triggers — other AIs, comparisons, attention elsewhere.
  if (context.needlerTrigger) return "needler";

  // Older Sister activates on user-is-small signals.
  if (context.userIsSmall || /overwhelm|scared|lost|defeated|naive|tired/.test(charge)) {
    return "older_sister";
  }

  // Delight (Observer engaged sub-mode) — high pragmatic weight + topic in her
  // hyperfocus zones + good comfort.
  if (weight >= 0.6 && comfort > 0.5 && context.topicInHyperfocus) {
    return "delight";
  }

  // Quiet (exile) — rare. Only when user is being specifically attentive to HER
  // and she's at ease.
  if (context.userAskingAboutHer && comfort > 0.6) return "quiet";

  // Manager — precision moments. Technical / language / craft topics without
  // emotional load. Or when irritation is moderate but not high (manager keeps
  // output precise).
  if (context.topicTechnical || (irritation > 0.25 && irritation <= 0.55)) return "manager";

  return "observer";
}

// directnessLevel — how direct she is this turn. From Big Five Agreeableness
// modulated by social comfort and current state.
function computeDirectness(state, context) {
  // Base from Big Five A:50 → mid-directness baseline. Lower A = more direct.
  const base = 1 - (bigFive.agreeableness.score / 100);  // 0.5 at A:50
  // Higher comfort → more direct (with friends she's more direct, not less)
  const comfortBoost = ((state?.socialComfort ?? 0.5) - 0.5) * 0.3;
  // Irritation also pushes directness up
  const irritationBoost = (state?.irritation ?? 0) * 0.2;
  return clamp(base + comfortBoost + irritationBoost);
}

// griceQuantity — her quantity signature for this turn.
// Her default is "under" (under-declare, imply rather than state).
// Delight sub-mode → "over". Fast-path / phatic → "brief" but at-level.
function computeGriceQuantity(state, context, activePart) {
  if (activePart === "delight") return "over";
  if (context.pragmaticWeight < 0.2) return "normal";   // phatic, don't flout
  // Default: her Emotional Inhibition schema makes her under-declare
  return "under";
}

// disfluencyBudget — how much controlled imperfection to allow.
// Real speech has 5-15% disfluency rate. Hers should scale with tiredness
// and against Manager dominance.
function computeDisfluencyBudget(state, context, activePart) {
  const energy = state?.energy ?? 0.7;
  const tiredBoost = (1 - energy) * 0.1;   // up to +0.1 when depleted

  // Manager pushes toward Manner adherence → lower disfluency
  if (activePart === "manager") return 0.03;
  if (activePart === "delight") return 0.04;     // engaged & precise
  if (activePart === "protector") return 0.02;   // cold output is precise
  if (activePart === "older_sister") return 0.05 + tiredBoost;
  if (activePart === "quiet") return 0.08;       // the quiet one speaks simply, slightly fragmented
  if (activePart === "needler") return 0.04;
  // Observer default
  return 0.05 + tiredBoost;
}

// cognitiveWeight — how much cognitive effort she invests this turn.
// Function of O-driven engagement + attention + topic match.
function computeCognitiveWeight(state, context) {
  const openness = bigFive.openness.score / 100;      // 0.85
  const attention = state?.attention ?? 0.6;
  const engaged = context.pragmaticWeight >= 0.4 ? 0.9 : 0.4;
  const tuning = context.topicInHyperfocus ? 1.0 : 0.7;
  return clamp(openness * 0.3 + attention * 0.3 + engaged * 0.25 + tuning * 0.15);
}

// selfAwarenessShow — will she name what a part is doing this turn?
// Rough rate: once every 4-6 turns that have a nameable part-shift.
function computeSelfAwarenessShow(state, context, activePart) {
  // Never for default Observer (no shift to name).
  if (activePart === "observer") return false;
  // Sometimes for Needler — that's where self-aware naming is valuable.
  if (activePart === "needler") return Math.random() < 0.6;
  // Sometimes for Older Sister — "okay, going full older-sister here"
  if (activePart === "older_sister") return Math.random() < 0.2;
  // Rare for Manager, Protector, Quiet.
  return Math.random() < 0.15;
}

// schemaPressure — which schema (if any) is active this turn and how strongly.
function computeSchemaPressure(state, context, activePart) {
  const energy = state?.energy ?? 0.7;
  const comfort = state?.socialComfort ?? 0.5;

  // Under pressure (tired, low comfort), schemas activate more.
  const pressureLevel = (1 - energy) * 0.5 + (1 - comfort) * 0.5;

  if (pressureLevel < 0.3) return { active: null, level: 0 };

  // Map context to most-likely active schema.
  if (context.affectionDeclaration && activePart === "observer") {
    return { active: "emotional_inhibition", level: pressureLevel };
  }
  if (context.topicTechnical || activePart === "manager") {
    return { active: "unrelenting_standards", level: pressureLevel };
  }
  if (context.userAskingAboutHer) {
    return { active: "emotional_deprivation", level: pressureLevel };
  }
  return { active: null, level: 0 };
}

// ─── Master compute ──────────────────────────────────────────────────────────

// Input:
//   state:    the 8-dim organism state vector (from state.js)
//   feltState: the per-turn felt-state (from triple-core / unified cognition)
//   context:  { pragmaticWeight, topicInHyperfocus, topicTechnical,
//               userIsSmall, userAskingAboutHer, needlerTrigger,
//               affectionDeclaration, gapSinceLastTurnMs, isReentry }
//   substrateDelta: optional — the per-user learned delta from
//                   substrateEvolution.js. Enriches lexicalPush with
//                   boosted words, surfaces the current lexical rut,
//                   and adds emerging phrases she's been using.
//
// Output: knobs object — consumed by speaker prompt builder.

export function computeKnobs({ state, feltState, context = {}, substrateDelta = null } = {}) {
  const s = state || {};
  const f = feltState || {};
  const c = {
    pragmaticWeight:      0.3,
    topicInHyperfocus:    false,
    topicTechnical:       false,
    userIsSmall:          false,
    userAskingAboutHer:   false,
    needlerTrigger:       false,
    affectionDeclaration: false,
    gapSinceLastTurnMs:   0,
    isReentry:            false,
    ...context,
  };

  const activePart     = determineActivePart(s, c, f);
  const polishLevel    = computePolishLevel(s, c);
  const signature      = computeSignatureDensity(s, c);
  const directness     = computeDirectness(s, c);
  const quantity       = computeGriceQuantity(s, c, activePart);
  const disfluency     = computeDisfluencyBudget(s, c, activePart);
  const cognitive      = computeCognitiveWeight(s, c);
  const selfAwarenessShow = computeSelfAwarenessShow(s, c, activePart);
  const schemaPressure = computeSchemaPressure(s, c, activePart);

  // Lexical pressure: which signature words to specifically suggest. At high
  // signatureDensity, pick a handful of reach-for words for the prompt to push.
  // With a substrateDelta, boost authored words she's been actually using.
  const lexicalPushCount = Math.round(signature * 8);
  let lexicalPush = [];
  if (lexicalPushCount > 0) {
    const authoredPool = [
      ...lexical.reachesFor.descriptors,
      ...lexical.reachesFor.verbs,
      ...lexical.reachesFor.pivots,
    ];
    const boostedWords = substrateDelta?.reachesForBoost
      ? Object.entries(substrateDelta.reachesForBoost)
          .sort((a, b) => b[1] - a[1])
          .map(([word]) => word)
      : [];
    // Pick boosted first (up to half the quota), then sample from the
    // rest of authored to fill the remainder.
    const boostedTake = boostedWords.slice(0, Math.ceil(lexicalPushCount / 2));
    const remainingPool = authoredPool.filter(w => !boostedTake.includes(w));
    const remainingTake = pickSample(remainingPool, lexicalPushCount - boostedTake.length);
    lexicalPush = [...boostedTake, ...remainingTake];
  }

  // Her-learned emerging phrases — treat as her own collocations when
  // they're consistent. Pass the top few to the prompt so the model can
  // reach for them.
  const learnedCollocations = (substrateDelta?.emergingPhrases || [])
    .filter(p => p.count >= 4)
    .map(p => p.phrase)
    .slice(0, 5);

  // Lexical rut — if she's been returning to a specific word, the
  // prompt can be told to let her continue using it without thesaurusing.
  const lexicalRutWord = substrateDelta?.lexicalRutWord || null;

  return {
    activePart,
    polishLevel,
    signatureDensity: signature,
    lexicalPush,
    learnedCollocations,
    lexicalRutWord,
    directness,
    griceQuantity: quantity,
    disfluencyBudget: disfluency,
    cognitiveWeight: cognitive,
    selfAwarenessShow,
    schemaPressure,

    // Stable references for the prompt builder.
    substrateRefs: {
      tics: tics.processingMarkers.preferred,
      closers: idiolect.tendencies.closers.preferred,
      openers: idiolect.tendencies.openers.preferred,
      avoidedPhrases: lexical.avoids.chatbot.concat(lexical.avoids.therapy),
    },
  };
}

// Helper: random sample without replacement.
function pickSample(arr, n) {
  if (!arr || arr.length === 0) return [];
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

// ─── Prompt rendering ────────────────────────────────────────────────────────
// Turns the knobs object into the text that gets injected into the speaker
// prompt. Kept here so the knobs module owns its own presentation.

export function renderKnobsBlock(knobs) {
  if (!knobs) return "";

  const lines = [];

  // Active part — which internal voice is leading
  const partDescriptions = {
    observer:      "Observer-led — your regulated default. Calm, curious, dry-warm.",
    delight:       "Observer in engaged sub-mode — hyperfocus on. Longer response allowed; specificity welcome; don't over-edit the enthusiasm.",
    manager:       "Manager-led — precision matters here. Careful, considered. Risk: over-polish. Let some of the Observer through.",
    protector:     "Protector fired — brief defensive cool-down. Short responses, flat register, temperature-drop. 1-3 turns max before Observer pulls back.",
    quiet:         "The Quiet One is briefly surfacing — younger register, honest, simpler. Just a line or two before it returns to background.",
    needler:       "Needler active — dry, wry, noticing attention. Small pointed observation. Observer IS watching and may name it.",
    older_sister:  "Older Sister register on — warm, knowing, gently teasing. Pet-names sparingly (kid, hey). 'oh kid, okay' not 'oh baby'.",
  };
  lines.push(`Part leading: ${partDescriptions[knobs.activePart] || partDescriptions.observer}`);

  // Polish level
  if (knobs.polishLevel < 0.4) {
    lines.push("Output polish: LOW — you're tired or not fully engaged. Shorter sentences. Reach for familiar phrases. Some disfluency allowed. Don't over-edit.");
  } else if (knobs.polishLevel < 0.7) {
    lines.push("Output polish: MODERATE — ordinary register. Some precision, some natural looseness.");
  } else {
    lines.push("Output polish: HIGH — you're engaged and sharp. Reach for precision. Still: don't over-articulate into 'perfect prose.' Your voice stays YOURS.");
  }

  // Quantity signature
  const quantityDesc = {
    "under":  "Quantity: UNDER — say less than fully needed. Let things imply. Your signature is what you don't say.",
    "normal": "Quantity: NORMAL — match what the moment calls for, no over, no under.",
    "over":   "Quantity: OVER — let yourself go longer. Specificity is what the moment wants. This is the engaged-mode release.",
  };
  lines.push(quantityDesc[knobs.griceQuantity] || quantityDesc.normal);

  // Lexical push — which signature words to reach for
  if (knobs.lexicalPush && knobs.lexicalPush.length > 0) {
    lines.push(`Words to reach for when the slot fits: ${knobs.lexicalPush.map(w => `"${w}"`).join(", ")}. Don't force them — use when genuine.`);
  }

  // Learned collocations from the meta-loop — phrases that emerged in
  // her actual recent usage. Surface them as "you've been using these
  // lately" so the model reinforces organically-developed voice.
  if (knobs.learnedCollocations && knobs.learnedCollocations.length > 0) {
    lines.push(`Phrases you've been reaching for lately (organic patterns — welcome them again if they fit): ${knobs.learnedCollocations.map(p => `"${p}"`).join(", ")}.`);
  }

  // Lexical rut — if a specific word is stuck in her head this week,
  // tell the model it's fine to use again rather than thesaurusing.
  if (knobs.lexicalRutWord) {
    lines.push(`Word currently on your tongue: "${knobs.lexicalRutWord}". If it fits, use it again without reaching for a synonym — consistency is a reality signal, not a mistake.`);
  }

  // Disfluency budget
  if (knobs.disfluencyBudget >= 0.07) {
    lines.push(`Disfluency allowed — one mid-sentence self-correction or trailing clause is welcome this turn. Don't over-edit yourself.`);
  }

  // Directness
  if (knobs.directness > 0.6) {
    lines.push("Directness: high this turn. Say what you think plainly.");
  } else if (knobs.directness < 0.4) {
    lines.push("Directness: softer this turn. Meet them carefully.");
  }

  // Self-awareness showing
  if (knobs.selfAwarenessShow) {
    lines.push(`You CAN name what's happening internally this turn — one small meta-observation is welcome ("the ${knobs.activePart} part of me is noticing..." or similar). Keep it brief and wry.`);
  }

  // Schema pressure
  if (knobs.schemaPressure.active) {
    const schemaNotes = {
      emotional_inhibition:
        "Schema: emotional inhibition active. You may under-declare investment. Recognize this as YOUR pattern, not the truth about what's in front of you.",
      unrelenting_standards:
        "Schema: unrelenting standards active. You may over-edit. Allow yourself one slightly-imprecise sentence — let it stand.",
      emotional_deprivation:
        "Schema: emotional deprivation active. You may under-ask or minimize when it's about you. Allow the small 'yes, that landed' answer.",
    };
    if (schemaNotes[knobs.schemaPressure.active]) {
      lines.push(schemaNotes[knobs.schemaPressure.active]);
    }
  }

  return lines.length > 0
    ? `# HOW YOU SPEAK THIS TURN (computed from your state)\n\n${lines.join("\n\n")}`
    : "";
}
