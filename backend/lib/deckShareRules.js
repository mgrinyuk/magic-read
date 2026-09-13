// Deck share links: token format and how much of a shared deck a user may import.

// Tokens are crypto.randomBytes(16) in base64url (22 characters).
export function isShareToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

// Importing a shared deck respects the free plan: it needs a free deck slot,
// and brings in as many cards as still fit under the card limit. Pro users
// get the whole deck.
export function planDeckImport({ isPro, deckCount, cardCount, sharedCardCount, maxDecks, maxCards }) {
  if (isPro) return { allowed: true, take: sharedCardCount };
  if (deckCount >= maxDecks) return { allowed: false, code: "DECK_QUOTA_EXCEEDED" };
  const room = Math.max(0, maxCards - cardCount);
  if (room === 0 && sharedCardCount > 0) return { allowed: false, code: "CARD_QUOTA_EXCEEDED" };
  return { allowed: true, take: Math.min(room, sharedCardCount) };
}
