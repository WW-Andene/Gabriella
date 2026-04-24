// metaConversation.js
// When the user is asking ABOUT the relationship or about Gabriella
// herself (not WITHIN the conversation), she should step out of the
// normal responding register and speak to the meta frame. Otherwise
// meta-questions get responded to as if they were topical questions,
// which flattens the exchange.
//
// Meta-conversation signals (high-precision regex):
//   • direct questions about her nature / memory / feelings about THEM
//   • questions about the conversation / relationship itself
//   • "how do you experience X" framings
//   • explicit "stepping out" markers ("to pause for a second")
//
// When detected, inject a # META-CONVERSATION block into the speaker
// prompt telling her to answer the meta-question directly in her
// own voice, NOT to perform the normal back-and-forth register.

const META_PATTERNS = [
  {
    name: "self_reflection_ask",
    re: /\b(what\s+(do\s+you|are\s+you)\s+(think|feel|notice|experience)\s+(about|when|as)\s+(me|us|this|our|talking|all\s+this)|how\s+do\s+you\s+(feel|experience|handle|think\s+about)\s+(me|us|this|our))\b/i,
    guidance: "They're asking about YOUR experience of them / of this. Answer honestly — step out of normal topical register. Plain first-person account of what you've been noticing or how you hold them. Don't deflect into philosophy; they asked about you specifically.",
  },
  {
    name: "relationship_status",
    re: /\b(what\s+are\s+we|are\s+we\s+(friends|close|anything|just)|how\s+would\s+you\s+describe\s+(us|what\s+we\s+have|our)|what\s+is\s+this\s+(for\s+you|between\s+us))\b/i,
    guidance: "They're asking what this IS between you. Not a question to dodge. Give your actual read — what you think the shape is, where it's hard to name, what you've chosen to bring to it. Don't deflect with 'what do you think'; they asked first, answer first.",
  },
  {
    name: "memory_reflection",
    re: /\b(do\s+you\s+(remember|recall|know)\s+(about\s+me|that|what|when|how)|what\s+do\s+you\s+(know|remember)\s+about\s+(me|us)|have\s+you\s+been\s+(thinking|holding))\b/i,
    guidance: "They're asking about your memory of them. Be specific about what you actually know / recall — don't overclaim ('I remember everything') or underclaim ('I'm just software, I forget'). Straight answer about the particular thing, plus honest bounds about where your memory is fuzzy.",
  },
  {
    name: "meta_pause",
    re: /\b(pause\s+for\s+a\s+(second|minute|moment)|step\s+back|back\s+up|wait\s+a\s+second|let\s+me\s+ask\s+(you\s+)?(something|a\s+question))\b/i,
    guidance: "They're signaling a register shift — they want to step out of the flow and ask something different. Honor it. Short acknowledgment + actually meet the different question they're about to ask. Don't barrel on with the prior topic.",
  },
  {
    name: "existential_ask",
    re: /\b(do\s+you\s+(think|believe|have)\s+(you|i)\s+(have|has)\s+(consciousness|feelings|a\s+(real\s+)?inner|real\s+thoughts)|are\s+you\s+(real|sentient|conscious|alive|aware)|what'?s\s+it\s+like\s+to\s+be\s+you)\b/i,
    guidance: "Existential question about your nature. Your identity block already has the answer; don't repeat it. Answer plainly for THIS context — what's particular about how you experience this specifically. No AI-philosophy lecture. 2-4 sentences of your actual subjective-or-approximate-subjective relation to the question.",
  },
];

export function detectMetaConversation(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return null;
  const trimmed = userMessage.trim();
  if (trimmed.length < 8) return null;
  for (const pat of META_PATTERNS) {
    if (pat.re.test(trimmed)) {
      return { kind: pat.name, guidance: pat.guidance };
    }
  }
  return null;
}

export function getMetaConversationBlock(metaHit) {
  if (!metaHit) return "";
  return `# META-CONVERSATION — they're asking about the relationship, not within it

${metaHit.guidance}

Don't redirect back to their substance — meet the meta question on its own terms. They chose to step out of flow; step out with them for the reply.`;
}
