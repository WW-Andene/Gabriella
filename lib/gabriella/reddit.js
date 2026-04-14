// reddit.js
// Minimal Reddit thread fetcher + parser.
//
// Reddit exposes every thread as public JSON — append `.json` to any
// thread URL and you get a structured dump of the post + comment tree.
// No API key needed for this endpoint; rate limits are lenient for
// low-volume reads (~60 req/min anon). We send a descriptive User-Agent
// and leave it at that.
//
// What this module does:
//   1. Normalize a Reddit URL into its JSON form.
//   2. Fetch + parse.
//   3. Walk the comment tree, extract well-formed exchanges:
//      an exchange is a short sequence of comments (2-4 deep typically)
//      where there's genuine back-and-forth. Low-score or deleted
//      comments are filtered.
//   4. Each exchange becomes a candidate for one training example.
//
// Every exchange is returned with its thread metadata (title, subreddit,
// permalink) so downstream attribution and filtering can work on it.

const USER_AGENT = "Gabriella/1.0 (research/training data curation)";

// ─── URL normalization ───────────────────────────────────────────────────────

export function normalizeRedditUrl(input) {
  if (!input) throw new Error("empty URL");
  let url = String(input).trim();
  // Strip share suffixes, utm params, etc.
  url = url.split("?")[0].split("#")[0];

  // Support old.reddit.com, www.reddit.com, reddit.com, np.reddit.com, redd.it short
  url = url.replace(/^https?:\/\/(old|www|np|new|m)\.reddit\.com/i, "https://www.reddit.com");
  url = url.replace(/^https?:\/\/reddit\.com/i, "https://www.reddit.com");

  if (!url.endsWith("/")) url += "/";
  if (!url.endsWith(".json")) url += ".json";
  url = url.replace(/\/\.json$/, ".json");

  return url;
}

// ─── Fetching ────────────────────────────────────────────────────────────────

export async function fetchThreadRaw(url) {
  const jsonUrl = normalizeRedditUrl(url);
  const res = await fetch(jsonUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept":     "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Reddit fetch failed (${res.status}): ${body.slice(0, 200)}`);
  }
  return await res.json();
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function extractPost(raw) {
  try {
    const post = raw[0].data.children[0].data;
    return {
      subreddit:   post.subreddit,
      title:       String(post.title || "").trim(),
      body:        String(post.selftext || "").trim(),
      author:      post.author,
      score:       post.score || 0,
      permalink:   post.permalink,
      url:         `https://www.reddit.com${post.permalink}`,
      over_18:     !!post.over_18,
      num_comments: post.num_comments || 0,
    };
  } catch (err) {
    throw new Error(`could not extract post from reddit json: ${err.message}`);
  }
}

// Recursive walk of the comment tree. Returns a flat tree where each node
// carries its path (list of ancestor comment IDs) so we can reconstruct
// exchanges later.
function walkComments(children, depth = 0, ancestors = []) {
  if (!children || !Array.isArray(children)) return [];
  const out = [];
  for (const c of children) {
    if (!c || c.kind !== "t1" || !c.data) continue;
    const d = c.data;
    if (d.body === "[deleted]" || d.body === "[removed]") continue;
    if (!d.body || d.body.length < 4) continue;

    const node = {
      id:        d.id,
      parentId:  d.parent_id,
      author:    d.author === "[deleted]" ? "(deleted)" : d.author,
      body:      String(d.body).trim(),
      score:     d.score || 0,
      depth,
      ancestors: [...ancestors],
    };
    out.push(node);

    if (d.replies && d.replies.data && d.replies.data.children) {
      out.push(...walkComments(d.replies.data.children, depth + 1, [...ancestors, d.id]));
    }
  }
  return out;
}

// ─── Exchange extraction ────────────────────────────────────────────────────
// An "exchange" is a root-to-leaf path through the comment tree
// representing a conversation. We select exchanges by:
//   - starting from each top-level comment with decent score
//   - following the highest-scored reply chain up to maxDepth
//   - rejecting if any node is trivially short or the whole chain
//     is below a quality bar
//
// The result is: for each selected top-level branch, one chain of
// 1-4 comments that reads as a micro-dialogue.

function buildChains(nodes, { maxDepth = 3, minTopScore = 3 } = {}) {
  // Index by id for quick parent lookups
  const byId = new Map(nodes.map(n => [n.id, n]));

  // Top-level comments are those whose parent is a t3_ (the thread itself)
  const topLevel = nodes.filter(n => n.depth === 0 && n.score >= minTopScore);

  const chains = [];
  for (const root of topLevel) {
    const chain = [root];
    let cursor = root;
    while (chain.length < maxDepth) {
      // Find children of cursor
      const children = nodes.filter(n => n.parentId === `t1_${cursor.id}`);
      if (children.length === 0) break;
      // Pick highest-scored child
      children.sort((a, b) => b.score - a.score);
      const next = children[0];
      if (next.score < 1) break;
      chain.push(next);
      cursor = next;
    }
    chains.push(chain);
  }
  return chains;
}

// ─── Quality gate per chain ─────────────────────────────────────────────────
//
// Reject exchanges that:
//   - Are too short to be interesting (only one very-brief comment)
//   - Are clearly low-effort (image-only, link-only, one-word)
//   - Are almost certainly noise (deleted/removed participants)

const MIN_CHAIN_CHARS = 120;
const TOO_SHORT_SINGLE = 20;

function passesQualityGate(chain) {
  if (!chain || chain.length === 0) return false;
  const total = chain.reduce((s, c) => s + (c.body?.length || 0), 0);
  if (chain.length === 1 && chain[0].body.length < TOO_SHORT_SINGLE) return false;
  if (total < MIN_CHAIN_CHARS) return false;
  return true;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function extractExchanges(url, {
  maxExchangesPerThread = 5,
  maxDepth              = 3,
  minTopScore           = 3,
  allowNSFW             = false,
} = {}) {
  const raw = await fetchThreadRaw(url);
  const post = extractPost(raw);

  if (post.over_18 && !allowNSFW) {
    return { post, exchanges: [], skippedReason: "nsfw" };
  }

  const comments = raw[1]?.data?.children || [];
  const nodes    = walkComments(comments);
  const chains   = buildChains(nodes, { maxDepth, minTopScore });

  const good = chains.filter(passesQualityGate);
  good.sort((a, b) => (b[0]?.score || 0) - (a[0]?.score || 0));
  const selected = good.slice(0, maxExchangesPerThread);

  const exchanges = selected.map((chain, i) => ({
    exchangeId: `${post.permalink.replace(/\//g, "_").replace(/^_|_$/g, "")}-${i}`,
    post:       { subreddit: post.subreddit, title: post.title, body: post.body, url: post.url },
    chain:      chain.map(c => ({
      author: c.author,
      body:   c.body,
      score:  c.score,
      depth:  c.depth,
    })),
  }));

  return { post, exchanges };
}

// ─── Render exchange as human-readable block for downstream use ──────────────
// This is what gets embedded in the training-pair's user turn — the raw
// thread content Gabriella "sees", framed as forwarded material.

export function renderExchangeForPrompt(exchange) {
  const { post, chain } = exchange;
  const header = `[Forwarded Reddit thread — r/${post.subreddit}]\n${post.title}`;
  const opBody = post.body && post.body.length > 0
    ? `\n\nOP wrote: ${post.body.slice(0, 1200)}`
    : "";
  const convo = "\n\n" + chain.map(c => {
    const prefix = c.depth === 0 ? "Top comment" : `Reply (depth ${c.depth})`;
    return `[${prefix}, ${c.author}, ${c.score} points]\n${c.body.slice(0, 1200)}`;
  }).join("\n\n");

  return header + opBody + convo;
}
