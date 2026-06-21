import test from "node:test";
import assert from "node:assert/strict";

import {
  TBANK_PLANS,
  createTbankOrderId,
  parseTbankOrderId,
  createTbankToken,
  verifyTbankToken
} from "../lib/tbank.js";

const userId = "123e4567-e89b-12d3-a456-426614174000";

test("T-Bank prices are stored in kopecks", () => {
  assert.equal(TBANK_PLANS.monthly.amount, 100000);
  assert.equal(TBANK_PLANS.annual.amount, 900000);
});

test("T-Bank order id round-trips the user and plan", () => {
  const orderId = createTbankOrderId(userId, "annual", 1782050569051);
  assert.ok(orderId.length <= 36);
  assert.deepEqual(parseTbankOrderId(orderId), {
    userId,
    planName: "annual",
    plan: { ...TBANK_PLANS.annual, name: "annual" }
  });
});

test("T-Bank token ignores nested objects and verifies without exposing the password", () => {
  const payload = {
    TerminalKey: "demo",
    Amount: 100000,
    OrderId: "order-1",
    DATA: { Email: "learner@example.com" }
  };
  const token = createTbankToken(payload, "test-password");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(verifyTbankToken({ ...payload, Token: token }, "test-password"), true);
  assert.equal(verifyTbankToken({ ...payload, Amount: 100001, Token: token }, "test-password"), false);
});
