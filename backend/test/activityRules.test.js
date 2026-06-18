import test from "node:test";
import assert from "node:assert/strict";

import { getActivityRpcArgs } from "../lib/activityRules.js";

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
