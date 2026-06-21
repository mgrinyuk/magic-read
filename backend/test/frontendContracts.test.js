import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { UI_TEXT } from "../../frontend/ui-text.js";
import { getModeCopy } from "../../frontend/mode-copy.js";

const SUPPORTED_LANGUAGES = ["en", "ru", "zh", "tr", "de", "es", "fr", "ja"];
const POLISH_KEYS = [
  "loginTitle",
  "signupTitle",
  "signupTrialHint",
  "readModeTitle",
  "readModeHint",
  "startReading",
  "speakModeTitle",
  "speakModeHint",
  "startSpeaking",
  "trialHeadline",
  "trialHint",
  "trialCreateAccount",
  "trialExploreFree",
  "chooseLanguages",
  "changeLanguagesLater",
  "iSpeak",
  "imLearning",
  "continue",
  "trialUnlimitedPronunciation",
  "trialSmartCaptions",
  "trialAllDecks",
  "lifetimeOffer",
  "tbankPaymentLabel",
  "tbankMonthly",
  "tbankAnnual",
  "tbankPaymentPending",
  "tbankPaymentFailed",
  "redirecting"
];

test("all supported languages include the polished flow copy", () => {
  assert.deepEqual(Object.keys(UI_TEXT), SUPPORTED_LANGUAGES);

  for (const language of SUPPORTED_LANGUAGES) {
    for (const key of POLISH_KEYS) {
      assert.equal(typeof UI_TEXT[language][key], "string", `${language}.${key} is missing`);
      assert.ok(UI_TEXT[language][key].trim(), `${language}.${key} is empty`);
    }
  }
});

test("mode copy selects distinct localized reading and speaking actions", () => {
  const reading = getModeCopy("reading", UI_TEXT.de);
  const speaking = getModeCopy("pronunciation", UI_TEXT.de);

  assert.equal(reading.action, UI_TEXT.de.startReading);
  assert.equal(speaking.action, UI_TEXT.de.startSpeaking);
  assert.notEqual(reading.title, speaking.title);
});

test("lifetime offer controls are localized and hidden by default", async () => {
  const html = await fs.readFile(new URL("../../frontend/index.html", import.meta.url), "utf8");
  const controls = html.match(/<button[^>]+data-price-type="lifetime"[^>]*>/g) || [];

  assert.equal(controls.length, 2);
  for (const control of controls) {
    assert.match(control, /data-i18n="lifetimeOffer"/);
    assert.match(control, /\shidden(?:\s|>)/);
  }
});

test("both upgrade pickers expose T-Bank month and year options", async () => {
  const html = await fs.readFile(new URL("../../frontend/index.html", import.meta.url), "utf8");
  const monthly = html.match(/data-tbank-plan="monthly"/g) || [];
  const annual = html.match(/data-tbank-plan="annual"/g) || [];

  assert.equal(monthly.length, 2);
  assert.equal(annual.length, 2);
});
