import test from "node:test";
import assert from "node:assert/strict";

import { buildBugReportEmail, sanitizeReportContext } from "../lib/bugReport.js";

test("report context keeps only known fields as short strings", () => {
  const context = sanitizeReportContext({
    platform: "android",
    appVersion: "1.0.18",
    appBuild: 19,
    userAgent: "x".repeat(1000),
    password: "should not be kept",
    plan: { nested: true },
    uiLang: "   "
  });

  assert.deepEqual(Object.keys(context).sort(), ["appBuild", "appVersion", "platform", "userAgent"]);
  assert.equal(context.appBuild, "19");
  assert.equal(context.userAgent.length, 300);
});

test("report context tolerates missing or invalid input", () => {
  assert.deepEqual(sanitizeReportContext(undefined), {});
  assert.deepEqual(sanitizeReportContext("android"), {});
});

test("bug report email escapes user text and names the platform in the subject", () => {
  const { subject, text, html } = buildBugReportEmail({
    reportId: "r1",
    email: "learner@example.com",
    userId: "u1",
    message: "\n  Video <b>freezes</b>\nwhen I tap a word",
    context: { platform: "ios", appVersion: "1.0.2" }
  });

  assert.equal(subject, "Bug report (ios 1.0.2): Video <b>freezes</b>");
  assert.match(text, /platform: ios/);
  assert.ok(html.includes("Video &lt;b&gt;freezes&lt;/b&gt;"));
  assert.ok(!html.includes("<b>freezes</b>"));
});
