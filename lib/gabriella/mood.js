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

  return `# CURRENT MOOD
Right now you are in a ${mood} state. This isn't a performance — it's just how you're showing up today. Let it color things subtly. Don't announce it. Don't explain it. Just be it.
${moodData.description}`;
}

export function getMoodName(mood) {
  return mood || "contemplative";
}
