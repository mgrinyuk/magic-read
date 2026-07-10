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

test("signed-in language picker is visible only on the dashboard", async () => {
  const [app, css, html] = await Promise.all([
    fs.readFile(new URL("../../frontend/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/style.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/index.html", import.meta.url), "utf8")
  ]);

  assert.match(app, /classList\.toggle\("dashboard-active", screen\.id === "screen-home"\)/);
  assert.match(css, /body\.is-logged-in \.top-ui-language\s*\{\s*display: none !important;/);
  assert.match(css, /body\.is-logged-in\.dashboard-active \.top-ui-language\s*\{\s*display: block !important;/);
  assert.match(css, /#screen-main \.composer-footer \.language-switcher\s*\{\s*display: none !important;/);
  assert.doesNotMatch(html, /class="header-language-controls language-switcher"/);
});

test("reader pinyin renders as ruby labels above clean hanzi words", async () => {
  const [app, css, html] = await Promise.all([
    fs.readFile(new URL("../../frontend/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/style.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/index.html", import.meta.url), "utf8")
  ]);

  assert.match(html, /<div class="rd-han" id="rdHan"><\/div>/);
  assert.match(app, /function rdCleanHanziWord\(word\)/);
  assert.ok(app.includes("return raw.replace(/[^\\u3400-\\u9fff\\uf900-\\ufaff"));
  assert.match(app, /const rawWord = item\?\.hanzi \|\| item\?\.hz \|\| item\?\.word \|\| "";/);
  assert.match(app, /const \{ word, pinyin \} = rdWordParts\(w\);/);
  assert.match(app, /rdWordHTML\(word, pinyin\)/);
  assert.match(app, /querySelectorAll\("\.word, \.hanzi-char, \.rd-word"\)/);
  assert.match(app, /querySelectorAll\("\.rd-word, \.word"\)/);
  assert.match(app, /if \(!words\.length && container\.closest\?\.\("#rdHan"\)\) return;/);
  assert.match(app, /\.map\(item => rdWordParts\(item\)\.word\)/);
  assert.match(app, /<small>\$\{escapeHtml\(py \|\| ""\)\}<\/small><span class="rd-hz">\$\{escapeHtml\(word\)\}<\/span><\/span>/);
  assert.match(css, /\.rd-word small\s*\{[^}]*display: none;/);
  assert.match(css, /\.rd-han\.show-pinyin \.rd-word > small\s*\{\s*display: block !important;\s*\}/);
  assert.match(css, /\.rd-word\.word-speaking \.rd-hz\s*\{/);
});

test("Safari flashcard speaking uses fast browser recognition", async () => {
  const app = await fs.readFile(new URL("../../frontend/app.js", import.meta.url), "utf8");

  assert.match(app, /function isSafariBrowser\(\)/);
  assert.match(app, /const fastBrowserRecognition = isSafariBrowser\(\);/);
  assert.match(app, /if \(!fastBrowserRecognition\)\s*\{\s*const azure = await tryAzurePronunciation/);
  assert.match(app, /recognition\.interimResults = fastBrowserRecognition;/);
  assert.match(app, /settleTimer = setTimeout\(\(\) => finishWithTranscript\(transcript\), 650\);/);
  assert.match(app, /if \(fastBrowserRecognition && !handled && pendingTranscript\.trim\(\)\)/);
});

test("reader polish keeps sentence-only playback and controls", async () => {
  const [app, css, html] = await Promise.all([
    fs.readFile(new URL("../../frontend/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/style.css", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/index.html", import.meta.url), "utf8")
  ]);

  assert.match(css, /\.rd-han\s*\{[^}]*font-size: 28px;/);
  assert.match(html, /id="rdPrevSentBtn"/);
  assert.match(html, /id="rdNextSentBtn"/);
  assert.match(html, /Tap turtle twice for 0\.75×/);
  assert.match(html, /title="Tap once for 0\.85×, twice for 0\.75×"/);
  assert.match(app, /function rdPausePlay\(\)/);
  assert.match(app, /function rdResumePlay\(\)/);
  assert.match(app, /function rdJumpSentence\(delta\)/);
  assert.match(app, /let ttsSpeedMode = 0;/);
  assert.match(app, /return ttsSpeedMode === 2 \? 0\.75 : ttsSpeedMode === 1 \? 0\.85 : 1\.0;/);
  assert.match(app, /showWordPopup\(el, word, sentText, "", false\)/);
  assert.doesNotMatch(app, /playGoogleTTS\(clean, R\.lang,[\s\S]{0,180}, el\)/);
});

test("reader exercises scale with sentence count up to five", async () => {
  const [app, css] = await Promise.all([
    fs.readFile(new URL("../../frontend/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../frontend/style.css", import.meta.url), "utf8")
  ]);

  assert.match(app, /function rdExerciseTargetCount\(\)/);
  assert.match(app, /return Math\.min\(5, Math\.max\(0, R\.sentences\.length\)\);/);
  assert.match(app, /function rdBuildExerciseItems\(\)/);
  assert.match(app, /\.slice\(0, target\)/);
  assert.match(app, /Array\.from\(\{ length: Math\.max\(total, 1\) \}/);
  // Localized: "Exercise {i} of {n}" is built from getT() keys.
  assert.match(app, /getT\(\)\.exerciseWord\)\} \$\{rdExState\.idx \+ 1\}/);
  assert.doesNotMatch(app, /function rdRenderExerciseLegacy/);
  assert.match(css, /\.rd-ex-seg\.done\s*\{\s*background: var\(--good\);/);
  assert.match(css, /\.rd-ex-seg\.active\s*\{\s*background: var\(--primary\);/);
});
