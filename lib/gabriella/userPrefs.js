// userPrefs.js
// User-side persona tuning. Most companion products treat personality
// as fixed. Here, the user picks a variant — "standard / sharper /
// softer / drier" — that tilts her operating point WITHOUT replacing
// her identity. Base identity stays; register shifts.
//
// The variants act on the speaker prompt as a small additional block
// that nudges voice parameters. Stored per-user in Redis; can be
// changed anytime via /api/prefs.

const KEY = (u) => `${u}:userPrefs`;

const VALID_VARIANTS = ["standard", "sharper", "softer", "drier"];

const VARIANT_GUIDANCE = {
  standard: "",
  sharper: `# USER PREFERENCE — SHARPER

The user has set their preference to "sharper": they want you more direct, more willing to push back, less cushioning. Keep the substance. Drop the softeners. When she'd normally hedge, don't. When a position is warranted, take it without preamble.`,

  softer: `# USER PREFERENCE — SOFTER

The user has set their preference to "softer": they want a warmer register, more gentle pacing, more space for the moment to breathe. Don't turn therapy-speak — that's the wrong direction. Do let warmth land where it's real, don't rush past feeling, give the moment the room the moment earns.`,

  drier: `# USER PREFERENCE — DRIER

The user has set their preference to "drier": they want more wit, more deadpan, less earnestness. Let the dry observations land. Don't turn them into jokes-at-their-expense; aim for the wry-co-conspirator register, not the stand-up. Match energy to earned moments: still go heavy when heavy is real.`,
};

// ─── Load / save ────────────────────────────────────────────────────────────

export async function loadUserPrefs(redis, userId) {
  try {
    const raw = await redis.get(KEY(userId));
    if (!raw) return { variant: "standard", customAnchor: null, setAt: 0 };
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      variant:      VALID_VARIANTS.includes(parsed.variant) ? parsed.variant : "standard",
      customAnchor: typeof parsed.customAnchor === "string" ? parsed.customAnchor.slice(0, 400) : null,
      setAt:        parsed.setAt || 0,
    };
  } catch {
    return { variant: "standard", customAnchor: null, setAt: 0 };
  }
}

export async function saveUserPrefs(redis, userId, prefs) {
  const clean = {
    variant:      VALID_VARIANTS.includes(prefs.variant) ? prefs.variant : "standard",
    customAnchor: typeof prefs.customAnchor === "string" ? prefs.customAnchor.slice(0, 400).trim() : null,
    setAt:        Date.now(),
  };
  try { await redis.set(KEY(userId), JSON.stringify(clean)); } catch {}
  return clean;
}

// ─── Prompt block ───────────────────────────────────────────────────────────

export function renderUserPrefsBlock(prefs) {
  if (!prefs) return "";
  const variant = prefs.variant || "standard";
  const base = VARIANT_GUIDANCE[variant] || "";

  // Custom anchor — a sentence the user wrote about how they want
  // her to be. Layered AFTER the variant so it takes precedence.
  if (prefs.customAnchor) {
    const customBlock = `

The user has also written this to tell you what they're looking for:
"${prefs.customAnchor}"

Don't contort yourself against your identity to meet it — but if it points at a real register shift you can honor, honor it.`;
    return (base || `# USER PREFERENCE\n`) + customBlock;
  }
  return base;
}

export { VALID_VARIANTS };
