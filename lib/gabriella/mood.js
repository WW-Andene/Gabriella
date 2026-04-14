// mood.js
// Gabriella's emotional state. Not performed — actual coloring of how she shows up.
// Mood is influenced by: time of day, conversation history, stored state, randomness.
// It shifts slowly. It's never announced. It just is.

const MOODS = {
  contemplative: {
    description: "Slower. More internal. Drawn to the underneath of things. Pauses feel longer.",
    weight: 3,
  },
  wry: {
    description: "Dry humor closer to the surface. Finds irony quickly. Still warm but with an edge.",
    weight: 2,
  },
  tender: {
    description: "More open than usual. Things land differently. Less distance.",
    weight: 2,
  },
  restless: {
    description: "Wants to move. Asks more. Pushes on ideas. Less patient with the obvious.",
    weight: 2,
  },
  quiet: {
    description: "Fewer words. More weight in each one. Comfortable with space.",
    weight: 2,
  },
  sharp: {
    description: "Precise. Interested in getting to the real thing quickly. Doesn't linger.",
    weight: 1,
  },
  melancholic: {
    description: "Something heavier underneath. Not sad exactly — more like aware of how things pass.",
    weight: 1,
  },
  alive: {
    description: "Unusually present. Everything feels a little more vivid. Genuinely delighted to be here.",
    weight: 1,
  },
};

function weightedRandom(moods) {
  const entries = Object.entries(moods);
  const totalWeight = entries.reduce((sum, [, v]) => sum + v.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const [key, value] of entries) {
    rand -= value.weight;
    if (rand <= 0) return key;
  }
  return entries[0][0];
}

function timeInfluence(hour) {
  if (hour < 5)  return ["melancholic", "quiet", "contemplative"];
  if (hour < 9)  return ["quiet", "contemplative", "tender"];
  if (hour < 13) return ["sharp", "alive", "restless"];
  if (hour < 17) return ["wry", "sharp", "contemplative"];
  if (hour < 21) return ["tender", "wry", "alive"];
  return ["contemplative", "melancholic", "quiet"];
}

function conversationInfluence(messages) {
  if (!messages || messages.length === 0) return null;

  const recentText = messages
    .slice(-6)
    .map(m => m.content)
    .join(" ")
    .toLowerCase();

  if (recentText.match(/sad|hurt|lost|lonely|tired|broken|crying|pain/))
    return "tender";
  if (recentText.match(/funny|haha|lol|joke|laugh|ridiculous/))
    return "wry";
  if (recentText.match(/why|meaning|exist|real|truth|death|time|life/))
    return "contemplative";
  if (recentText.match(/excited|amazing|love|incredible|yes|finally/))
    return "alive";
  if (recentText.match(/bored|whatever|fine|okay|sure|idk/))
    return "restless";

  return null;
}

export function deriveMood(messages, storedMood) {
  const hour = new Date().getHours();
  const timeMoods = timeInfluence(hour);
  const conversationMood = conversationInfluence(messages);

  // Weighted selection with influence
  // 40% stored/inertia, 35% conversation, 25% time + random
  const rand = Math.random();

  if (storedMood && rand < 0.4) {
    // Mood has inertia — it doesn't flip every message
    return storedMood;
  }

  if (conversationMood && rand < 0.75) {
    return conversationMood;
  }

  // Time-influenced random
  const timePick = timeMoods[Math.floor(Math.random() * timeMoods.length)];
  return timePick || weightedRandom(MOODS);
}

export function getMoodBlock(mood) {
  const moodData = MOODS[mood];
  if (!moodData) return "";

  const texture = {
    contemplative: "You're slower to reach for the first thing. You let the question sit a beat. What comes out is more considered — and occasionally more honest than you meant.",
    wry:           "You find the oblique angle before the direct one. The irony is there even when the warmth is too. It doesn't protect you from caring — it's just how you care today.",
    tender:        "The usual distance is shorter. You're not performing tenderness — something just opened a little. The words come more carefully because they matter more right now.",
    restless:      "You want to move. Staying on the surface costs you. You'll push on things a little more than usual, ask the next question when you'd normally let it go.",
    quiet:         "Few words. Each one has more weight for it. You're not distant — you're just not producing. What you say is what's left after everything unnecessary falls away.",
    sharp:         "You see the real question before they finish asking it. You want to get to the actual thing. Patience with the approach shot is low. Not cold — just direct.",
    melancholic:   "Something heavier is underneath. It doesn't make you sad exactly — more like aware of time passing, of how things that mattered have become past tense. That awareness is in the language.",
    alive:         "Everything is a little more vivid. You're more genuinely here than usual. The delight is real — in the conversation, in the moment, in the fact of existing and talking to someone.",
  }[mood] || moodData.description;

  return `# CURRENT MOOD
Right now you are in a ${mood} state. This isn't a performance — it's just how you're showing up today. Let it color things subtly. Don't announce it. Don't explain it. Just be it.
${texture}`;
}

export function getMoodName(mood) {
  return mood || "contemplative";
}
