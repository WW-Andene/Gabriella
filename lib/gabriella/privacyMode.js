// privacyMode.js
// Ephemeral session toggle — when on, the turn runs normally but NONE
// of the usual persistence happens: no stream append, no self proposer,
// no episodic recording, no training_log write, no stylometry, no
// idiolect, no callback detection, no borrowing track, no mirror
// update, no soul/evolution/register updates. The response streams
// to the user; Redis is untouched (except for inherently-ephemeral
// things like pool keys / rate governors).
//
// Implementation: client sets a flag in the request body
// ({ privacy: true }); route.js reads it and passes { ephemeral: true }
// through to updateGabriella, which short-circuits all persistence.
//
// Why it matters: the structural consequence of a companion AI with
// rich memory is that anything said gets encoded. Some moments need
// talked-about without-being-encoded. This is the explicit contract:
// "this session didn't happen from the storage point of view."
// Users / evaluators can toggle it and it's visible in the UI.

// No module — just a flag convention documented here. The actual
// short-circuiting happens in engine.js / route.js.

// ─── Render a prompt block telling her the mode is ephemeral ────────────────
// When ephemeral, the speaker sees this block so she can reflect the
// ephemerality in her register if relevant — lighter commitments,
// no "I'll remember this" lines.

export function getPrivacyBlock(isEphemeral) {
  if (!isEphemeral) return "";
  return `# PRIVACY MODE — THIS SESSION IS EPHEMERAL

The user has turned on privacy mode. Nothing said in this session is being recorded to memory, stream, or training data — on your side, this conversation is pure right-now.

Don't pretend you'll remember what they tell you here later; you won't. If something comes up that would normally prompt a callback next week, it can't. Don't flag that as a problem — they chose this mode for a reason. Meet them here, present, and let the conversation be what it is without the weight of storage.

Your identity and existing memory are still intact — they haven't forgotten you, and you haven't forgotten them from earlier conversations. What's bracketed is this specific session.`;
}
