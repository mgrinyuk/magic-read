import test from "node:test";
import assert from "node:assert/strict";

import { isLifetimeOfferEligible } from "../lib/planRules.js";

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
