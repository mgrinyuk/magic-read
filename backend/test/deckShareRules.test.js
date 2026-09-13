import test from "node:test";
import assert from "node:assert/strict";

import { isShareToken, planDeckImport } from "../lib/deckShareRules.js";

const limits = { maxDecks: 2, maxCards: 100 };

test("share tokens must look like generated tokens", () => {
  assert.equal(isShareToken("Q2hlY2tpbmdUb2tlbl8tYQ"), true);
  assert.equal(isShareToken("short"), false);
  assert.equal(isShareToken("../../etc/passwd-aaaaaaaaaaaa"), false);
  assert.equal(isShareToken(undefined), false);
});

test("pro users import the whole deck", () => {
  assert.deepEqual(
    planDeckImport({ isPro: true, deckCount: 9, cardCount: 900, sharedCardCount: 250, ...limits }),
    { allowed: true, take: 250 }
  );
});

test("free users need a free deck slot", () => {
  assert.deepEqual(
    planDeckImport({ isPro: false, deckCount: 2, cardCount: 10, sharedCardCount: 5, ...limits }),
    { allowed: false, code: "DECK_QUOTA_EXCEEDED" }
  );
});

test("free users get as many cards as still fit", () => {
  assert.deepEqual(
    planDeckImport({ isPro: false, deckCount: 1, cardCount: 70, sharedCardCount: 50, ...limits }),
    { allowed: true, take: 30 }
  );
  assert.deepEqual(
    planDeckImport({ isPro: false, deckCount: 1, cardCount: 100, sharedCardCount: 50, ...limits }),
    { allowed: false, code: "CARD_QUOTA_EXCEEDED" }
  );
});
