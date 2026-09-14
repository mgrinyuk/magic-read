import test from "node:test";
import assert from "node:assert/strict";

import { decideTextOpen, isLifetimeOfferEligible, normalizeTextKey } from "../lib/planRules.js";

const trialEndsAt = "2026-06-10T12:00:00.000Z";

test("lifetime offer requires the explicit feature flag", () => {
  assert.equal(isLifetimeOfferEligible({
    enabled: false,
    plan: "free",
    trialEndsAt,
    now: "2026-06-11T12:00:00.000Z"
  }), false);
});

test("lifetime offer opens only after the trial and inside the configured window", () => {
  assert.equal(isLifetimeOfferEligible({
    enabled: true,
    plan: "free",
    trialEndsAt,
    now: "2026-06-09T12:00:00.000Z"
  }), false);

  assert.equal(isLifetimeOfferEligible({
    enabled: true,
    plan: "free",
    trialEndsAt,
    now: "2026-06-17T12:00:00.000Z",
    windowDays: 7
  }), true);

  assert.equal(isLifetimeOfferEligible({
    enabled: true,
    plan: "free",
    trialEndsAt,
    now: "2026-06-17T12:00:00.001Z",
    windowDays: 7
  }), false);
});

test("paid users and invalid trial dates never receive the lifetime offer", () => {
  assert.equal(isLifetimeOfferEligible({
    enabled: true,
    plan: "pro",
    trialEndsAt,
    now: "2026-06-11T12:00:00.000Z"
  }), false);

  assert.equal(isLifetimeOfferEligible({
    enabled: true,
    plan: "free",
    trialEndsAt: "not-a-date",
    now: "2026-06-11T12:00:00.000Z"
  }), false);
});

const keyA = "a".repeat(32);
const keyB = "b".repeat(32);

test("free users open one new text a day, and reopening it is free", () => {
  const first = decideTextOpen({ isPro: false, used: 0, openedKeys: [], textKey: keyA, limit: 1 });
  assert.deepEqual(first, { allowed: true, record: true, used: 1, openedKeys: [keyA] });

  const again = decideTextOpen({ isPro: false, used: 1, openedKeys: first.openedKeys, textKey: keyA, limit: 1 });
  assert.equal(again.allowed, true);
  assert.equal(again.record, false);

  const second = decideTextOpen({ isPro: false, used: 1, openedKeys: first.openedKeys, textKey: keyB, limit: 1 });
  assert.equal(second.allowed, false);
});

test("opens without a text key still count for free users", () => {
  assert.equal(decideTextOpen({ isPro: false, used: 1, openedKeys: [], textKey: null, limit: 1 }).allowed, false);
});

test("pro and trial users are never limited but still recorded", () => {
  assert.deepEqual(
    decideTextOpen({ isPro: true, used: 40, openedKeys: [], textKey: null, limit: 1 }),
    { allowed: true, record: true, used: 41, openedKeys: [] }
  );
});

test("text keys must be hex hashes", () => {
  assert.equal(normalizeTextKey(keyA), keyA);
  assert.equal(normalizeTextKey("not a hash"), null);
  assert.equal(normalizeTextKey(42), null);
});
