import test from "node:test";
import assert from "node:assert/strict";

import { getActivityRpcArgs, resolveActivityDay } from "../lib/activityRules.js";

const activity = {
  userId: "00000000-0000-0000-0000-000000000001",
  type: "words_spoken",
  count: 4,
  today: "2026-06-18"
};

test("typed stats RPC uses the current four-argument signature", () => {
  assert.deepEqual(getActivityRpcArgs("typed", activity), {
    p_user_id: activity.userId,
    p_type: "words_spoken",
    p_count: 4,
    p_today: "2026-06-18"
  });
});

test("legacy stats RPC maps activity types to five counter arguments", () => {
  assert.deepEqual(getActivityRpcArgs("legacy", activity), {
    p_user_id: activity.userId,
    p_read: 0,
    p_spoken: 4,
    p_practiced: 0,
    p_day: "2026-06-18"
  });
});

// 21:30 UTC on Sep 13 is already 00:30 on Sep 14 in Moscow.
const NOW = new Date("2026-09-13T21:30:00Z");

test("activity day follows the client's local day within one day of UTC", () => {
  assert.equal(resolveActivityDay("2026-09-14", NOW), "2026-09-14");
  assert.equal(resolveActivityDay("2026-09-13", NOW), "2026-09-13");
  assert.equal(resolveActivityDay("2026-09-12", NOW), "2026-09-12");
});

test("activity day falls back to UTC when the client day is off by more than a day", () => {
  assert.equal(resolveActivityDay("2026-09-15", NOW), "2026-09-13");
  assert.equal(resolveActivityDay("2026-09-11", NOW), "2026-09-13");
});

test("activity day falls back to UTC for missing or malformed input", () => {
  assert.equal(resolveActivityDay(undefined, NOW), "2026-09-13");
  assert.equal(resolveActivityDay("14.09.2026", NOW), "2026-09-13");
  assert.equal(resolveActivityDay("2026-02-30", NOW), "2026-09-13");
  assert.equal(resolveActivityDay(20260914, NOW), "2026-09-13");
});
