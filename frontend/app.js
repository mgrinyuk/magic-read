import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { UI_TEXT } from "./ui-text.js?v=20260727.1";
import { getModeCopy } from "./mode-copy.js?v=20260618.2";
import {
  assessPronunciation,
  startPronunciationSession,
  renderAssessment,
  collectFailedChunks,
  GREEN_THRESHOLD
} from "./azure-pronunciation.js";

const SUPABASE_URL = "https://nudirmexwisvvcmskhtn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8rz-fBIcvrR4qSNuG4j_7w_c_nZ79cU";
const API_BASE = "https://magic-read.onrender.com";

// --- Azure pronunciation assessment ---
// Flip to true AFTER the backend AZURE_SPEECH_* env vars are set and
// pronunciation-setup.sql has been run in Supabase. While false, the app
// keeps the original browser-based scoring with zero behavior change.
const AZURE_PRONUNCIATION = true;
const SPEECH_TOKEN_URL = `${API_BASE}/api/speech-token`;
// Set once we learn Azure isn't usable for this session (guest / unconfigured /
// SDK load failure) so we stop calling the endpoint and just use legacy scoring.
let azurePronDisabled = false;

// --- Tutor-style pronunciation drill ---
// After the first full-sentence attempt, the app drills only the parts that
// didn't get a green light, one chunk at a time, until each is said correctly.
const DRILL_PASS_SCORE = GREEN_THRESHOLD; // a chunk passes at this accuracy
const DRILL_MAX_ATTEMPTS = 3;             // then we encourage and move on
// Guards re-entrancy so a second tap doesn't start a parallel drill.
let drillActive = false;

// Attempts Azure scoring. Returns { score } if it handled the attempt (success
// or a user-facing message), or null if the caller should fall back to legacy
// browser scoring. `renderTo` is the element to show results in.
async function tryAzurePronunciation(referenceText, lang, renderTo, recordBtn, t) {
  if (!AZURE_PRONUNCIATION || azurePronDisabled || !referenceText) return null;

  if (renderTo) {
    renderTo.hidden = false;
    renderTo.innerHTML = `<p>${escapeHtml(t?.listening || "Listening…")}</p>`;
  }
  if (recordBtn) recordBtn.disabled = true;

  try {
    const result = await assessPronunciation(referenceText, lang, {
      tokenUrl: SPEECH_TOKEN_URL,
      fetchWithAuth
    });
    if (renderTo) renderTo.innerHTML = renderAssessment(result, lang);
    fetchMyPlan(); // refresh today's pronunciation count / plan state
    return { score: Math.round(result.pronunciation ?? result.accuracy ?? 0), result };
  } catch (err) {
    // Guest / not configured / SDK unavailable -> use legacy scoring instead.
    if (err.code === "NO_AUTH" || err.code === "NOT_CONFIGURED" || err.code === "SDK_LOAD_FAILED") {
      azurePronDisabled = true;
      return null;
    }
    // Out of free checks: show a contextual upgrade prompt at the result area.
    if (err.code === "QUOTA_EXCEEDED") {
      if (renderTo) renderTo.hidden = false;
      showUpgradePrompt("QUOTA_EXCEEDED", renderTo);
      return { score: 0 };
    }
    const messages = {
      MIC_DENIED: micBlockedMessage(),
      NO_SPEECH: "I didn't hear anything. Tap and speak again.",
      TOKEN_FAILED: "Pronunciation service is busy. Please try again.",
      CANCELED: "Recording stopped. Please try again.",
      SDK_ERROR: "Something went wrong scoring your speech. Please try again."
    };
    if (renderTo) {
      renderTo.hidden = false;
      renderTo.innerHTML = `<p>${escapeHtml(messages[err.code] || "Could not score your speech.")}</p>`;
    }
    return { score: 0 };
  } finally {
    if (recordBtn) recordBtn.disabled = false;
  }
}

// Run a single Azure check against `referenceText`. Returns { score, result }
// on success, or { error } with a typed code for the caller to handle. Unlike
// tryAzurePronunciation this does its own rendering, so it returns raw data.
async function assessChunk(referenceText, lang) {
  try {
    const result = await assessPronunciation(referenceText, lang, {
      tokenUrl: SPEECH_TOKEN_URL,
      fetchWithAuth
    });
    return { score: Math.round(result.pronunciation ?? result.accuracy ?? 0), result };
  } catch (err) {
    return { error: err };
  }
}

// Build the chunks to drill from a full assessment. For space-delimited
// languages we just group consecutive non-green words. For Chinese/Japanese we
// must respect *word* boundaries — Azure scores per character, so grouping on
// its raw output splits real words (带着 → 带 + 着) and produces meaningless,
// differently-pronounced fragments like 着这. We map per-character scores onto
// the segmenter's word boundaries, then bridge single short good words between
// bad ones so a coherent phrase (带着这两个人) stays intact.
const MAX_CHUNK_CHARS = 6; // keep drill bites phrase-sized, not whole sentences

async function buildDrillChunks(result, shortLang) {
  const speechLang = mapToSpeechLang(shortLang);
  const isCJK = shortLang === "zh" || shortLang === "ja";
  if (!isCJK) return collectFailedChunks(result, speechLang);

  // Per-character badness in reference order (skip insertions — not in the text).
  const chars = [];
  for (const w of result?.words || []) {
    if ((w.errorType || "None") === "Insertion") continue;
    const bad =
      (w.errorType && w.errorType !== "None") ||
      (w.accuracy != null && w.accuracy < GREEN_THRESHOLD);
    for (const ch of w.word || "") {
      if (/\s/.test(ch)) continue;
      chars.push({ ch, bad });
    }
  }
  if (!chars.length) return collectFailedChunks(result, speechLang);
  const refText = chars.map((c) => c.ch).join("");

  // Segment into real words.
  let segWords = [];
  try {
    const resp = await fetchWithAuth(`${API_BASE}/api/segment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: refText })
    });
    const data = await resp.json();
    if (resp.ok && Array.isArray(data.words)) {
      segWords = data.words.map((x) => x.word).filter(Boolean);
    }
  } catch {
    /* fall back below */
  }
  if (!segWords.length) return collectFailedChunks(result, speechLang);

  // A segmented word is bad if any of its characters scored poorly.
  const segs = [];
  let pos = 0;
  for (const sw of segWords) {
    const swChars = [...sw].filter((c) => !/\s/.test(c));
    let bad = false;
    let text = "";
    for (let k = 0; k < swChars.length && pos < chars.length; k++) {
      if (chars[pos].bad) bad = true;
      text += chars[pos].ch;
      pos++;
    }
    if (text) segs.push({ text, bad });
  }

  // Group consecutive bad words into phrase-sized chunks. A single short good
  // word is bridged between two bad words (带[ok]着 → keep 带着 together), and a
  // chunk may start with one short good word of left-context so a syllable
  // isn't drilled out of the context that determines its pronunciation/tone.
  const len = (txt) => [...txt].length;
  const isShort = (txt) => len(txt) <= 2;
  const chunks = [];
  let cur = null; // current chunk being built
  let gap = null; // a short good word held as a potential bridge
  let lead = null; // last short good word, usable as left-context for next chunk
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = null;
    gap = null;
  };
  for (const s of segs) {
    if (s.bad) {
      if (!cur) {
        cur = { text: lead ? lead.text : "" };
      } else if (gap) {
        const bridgeText = gap.text; // capture before flush() clears gap
        const fits = len(cur.text) + len(bridgeText) + len(s.text) <= MAX_CHUNK_CHARS;
        if (fits) {
          cur.text += bridgeText;
        } else {
          flush();
          cur = { text: bridgeText }; // the bridge word leads the new chunk
        }
      } else if (len(cur.text) + len(s.text) > MAX_CHUNK_CHARS) {
        flush();
        cur = { text: "" };
      }
      gap = null;
      lead = null;
      cur.text += s.text;
    } else {
      const short = isShort(s.text);
      if (cur && gap == null && short) {
        gap = s; // hold as a potential bridge
      } else {
        flush();
        lead = short ? s : null;
      }
    }
  }
  flush();
  return chunks;
}

// Pinyin syllables for a Chinese string, one per character (or null on failure).
async function getPinyinSyllables(text) {
  try {
    const py = await getPinyinForText(text);
    return py.split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
}

// "Focus on: 差 chà 40% · 役 yì 55%" — names exactly which syllables fell short
// so the learner knows what to fix, not just an opaque overall score.
function renderWeakSpots(result, shortLang, pinyinSyllables, t) {
  const isZh = shortLang === "zh";
  const parts = [];
  let ci = 0;
  for (const w of result.words || []) {
    if ((w.errorType || "None") === "Insertion") continue;
    const charCount = isZh ? [...(w.word || "")].length || 1 : 1;
    const acc = w.accuracy;
    const isOmission = w.errorType === "Omission";
    const bad = (w.errorType && w.errorType !== "None") || (acc != null && acc < GREEN_THRESHOLD);
    if (bad) {
      let label = escapeHtml(w.word || "");
      if (isZh && pinyinSyllables) {
        const py = pinyinSyllables.slice(ci, ci + charCount).join(" ");
        if (py) label += ` <em>${escapeHtml(py)}</em>`;
      }
      const detail = isOmission
        ? (t?.drillMissed || "missed")
        : acc != null
          ? `${Math.round(acc)}%`
          : "";
      parts.push(`<span class="pa-weak">${label}${detail ? ` ${detail}` : ""}</span>`);
    }
    ci += charCount;
  }
  if (!parts.length) return "";
  return `<p class="pa-drill-breakdown"><span class="pa-weak-label">${escapeHtml(
    t?.drillFocus || "Focus on"
  )}:</span> ${parts.join(" · ")}</p>`;
}

// Tutor-style follow-up. Walks each failed chunk: models the native audio,
// lets the learner repeat just that part, re-scores it on its own, and either
// advances (>= DRILL_PASS_SCORE) or retries up to DRILL_MAX_ATTEMPTS before
// encouraging them and moving on. Resolves when the sentence is mastered,
// skipped, or interrupted. Mic/no-speech issues don't consume an attempt;
// a quota wall stops the drill.
async function runPronunciationDrill(chunks, shortLang, resultBox, t) {
  if (!chunks.length || !resultBox) return;

  const speechLang = mapToSpeechLang(shortLang);

  // A dedicated container appended below the scored sentence.
  const drill = document.createElement("div");
  drill.className = "pa-drill";
  resultBox.appendChild(drill);
  drill.scrollIntoView({ behavior: "smooth", block: "center" });

  const tt = (key, fallback) => (t && t[key]) || fallback;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const passed = await drillOneChunk(chunk, i, chunks.length);
    if (passed === "abort") {
      return false; // quota / fatal — message already shown, don't advance
    }
  }

  drill.insertAdjacentHTML(
    "beforeend",
    `<p class="pa-drill-done"><strong>${escapeHtml(
      tt("drillMastered", "Nice — you nailed every part! 🎉")
    )}</strong></p>`
  );
  return true;

  // Drives one chunk to completion. Resolves true on pass, false when we give
  // up after max attempts, or "abort" on a quota/fatal error.
  function drillOneChunk(chunk, index, total) {
    return new Promise((resolve) => {
      let attempts = 0;

      const panel = document.createElement("div");
      panel.className = "pa-drill-chunk";
      drill.appendChild(panel);

      const header = tt("drillPracticeThis", "Let's practice this part")
        .replace("{n}", String(index + 1))
        .replace("{total}", String(total));

      panel.innerHTML = `
        <p class="pa-drill-label">${escapeHtml(header)} (${index + 1}/${total})</p>
        <p class="pa-drill-target">${escapeHtml(chunk.text)}</p>
        <div class="pa-drill-actions">
          <button type="button" class="pa-drill-hear card-primary-btn">🔊 ${escapeHtml(
            tt("drillHear", "Hear it")
          )}</button>
          <button type="button" class="pa-drill-say card-primary-btn">🎤 ${escapeHtml(
            tt("drillRepeat", "Repeat it")
          )}</button>
          <button type="button" class="pa-drill-skip card-secondary-btn">${escapeHtml(
            tt("drillSkip", "Skip")
          )}</button>
        </div>
        <div class="pa-drill-feedback" aria-live="polite"></div>
      `;
      panel.scrollIntoView({ behavior: "smooth", block: "center" });

      const hearBtn = panel.querySelector(".pa-drill-hear");
      const sayBtn = panel.querySelector(".pa-drill-say");
      const skipBtn = panel.querySelector(".pa-drill-skip");
      const feedback = panel.querySelector(".pa-drill-feedback");

      const setBusy = (busy) => {
        hearBtn.disabled = busy;
        sayBtn.disabled = busy;
        skipBtn.disabled = busy;
      };

      const finish = (outcome) => {
        setBusy(true);
        hearBtn.disabled = false; // can still replay after finishing
        resolve(outcome);
      };

      hearBtn.addEventListener("click", async () => {
        unlockAudioForMobile();
        const ttsText = await prepareTTSInput(chunk.text, shortLang);
        playGoogleTTS(ttsText, shortLang);
      });

      skipBtn.addEventListener("click", () => {
        feedback.innerHTML = `<p>${escapeHtml(tt("drillSkipped", "Skipped — moving on."))}</p>`;
        finish(false);
      });

      sayBtn.addEventListener("click", async () => {
        setBusy(true);
        stopAllTTS();
        feedback.innerHTML = `<p>${escapeHtml(tt("listening", "Listening…"))}</p>`;

        const outcome = await assessChunk(chunk.text, speechLang);

        if (outcome.error) {
          const code = outcome.error.code;
          if (code === "QUOTA_EXCEEDED") {
            feedback.innerHTML = `<p>${escapeHtml(
              outcome.error.info?.error ||
                tt("drillQuota", "You're out of today's free checks.")
            )}</p>`;
            showUpgradePrompt("QUOTA_EXCEEDED");
            finish("abort");
            return;
          }
          // Mic / no-speech / transient: let them try again, no attempt spent.
          const retryMsgs = {
            NO_SPEECH: tt("drillNoSpeech", "I didn't hear anything. Tap Repeat and speak."),
            MIC_DENIED: tt("drillMicDenied", "Microphone is blocked. Allow mic access and try again."),
            CANCELED: tt("drillTryAgain", "Recording stopped. Tap Repeat to try again."),
            TOKEN_FAILED: tt("drillBusy", "Service is busy. Tap Repeat to try again."),
            SDK_ERROR: tt("drillTryAgain", "Something went wrong. Tap Repeat to try again.")
          };
          feedback.innerHTML = `<p>${escapeHtml(retryMsgs[code] || tt("drillTryAgain", "Tap Repeat to try again."))}</p>`;
          setBusy(false);
          return;
        }

        attempts += 1;
        const { score, result } = outcome;
        const heard = result.transcript ? ` <span class="pa-drill-heard">${escapeHtml(result.transcript)}</span>` : "";

        if (score >= DRILL_PASS_SCORE) {
          feedback.innerHTML = `<p class="pa-drill-pass"><strong>✓ ${escapeHtml(
            tt("drillGotIt", "Got it!")
          )}</strong> ${score}%${heard}</p>`;
          finish(true);
          return;
        }

        // Name exactly which syllables fell short so "what did I do wrong" is clear.
        const pinyinSyllables = shortLang === "zh" ? await getPinyinSyllables(chunk.text) : null;
        const breakdown = renderWeakSpots(result, shortLang, pinyinSyllables, t);

        if (attempts >= DRILL_MAX_ATTEMPTS) {
          feedback.innerHTML = `<p class="pa-drill-moveon">${escapeHtml(
            tt("drillKeepGoing", "Close — keep practicing this one. Let's move on for now.")
          )} (${score}%)${heard}</p>${breakdown}`;
          finish(false);
          return;
        }

        const left = DRILL_MAX_ATTEMPTS - attempts;
        feedback.innerHTML = `<p class="pa-drill-again">${escapeHtml(
          tt("drillAlmost", "Almost — listen again and repeat.")
        )} (${score}%)${heard} <span class="pa-drill-tries">${left} ${escapeHtml(
          tt("drillTriesLeft", "tries left")
        )}</span></p>${breakdown}`;
        // Re-model the audio to scaffold the next attempt, then re-enable.
        const ttsText = await prepareTTSInput(chunk.text, shortLang);
        playGoogleTTS(ttsText, shortLang);
        setBusy(false);
      });
    });
  }
}

// In the native WebViews supabase-js's Navigator Locks usage can deadlock and
// leave auth calls (signInWithPassword etc.) pending forever, so the single-tab
// app shells run auth operations without the cross-tab lock. The multi-tab
// website keeps the default locking behavior.
const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  window.Capacitor?.isNativePlatform?.()
    ? { auth: { lock: (_name, _acquireTimeout, fn) => fn() } }
    : undefined
);

async function fetchWithAuth(url, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return fetch(url, options);
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` }
  });
}

function withTimeout(promise, ms, message = "Timed out") {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/* -----------------------------
   DOM
----------------------------- */

const authScreen = document.getElementById("authScreen");
const authNameGroup = document.getElementById("authNameGroup");
const authMessage = document.getElementById("authMessage");
const mainApp = document.querySelector(".main");
const landingHow = document.querySelector(".landing-page");

const logoutBtn = document.getElementById("logoutBtn");
const guestLoginBtn = document.getElementById("guestLoginBtn");
const signUpBtn = document.getElementById("signUpBtn");
const loginBtn = document.getElementById("loginBtn");

const uiLangSelect = document.getElementById("uiLang");
const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");

const screenHome = document.getElementById("screen-home");
const screenMain = document.getElementById("screen-main");
const screenFlashcards = document.getElementById("screen-flashcards");
const screenWriting = document.getElementById("screen-writing");
const screenOnboarding = document.getElementById("screen-onboarding");
const screenAccount = document.getElementById("screen-account");
const screenVideo = document.getElementById("screen-video");
const screenSpeakPractice = document.getElementById("screen-speak-practice");
const screenSpeakComplete = document.getElementById("screen-speak-complete");
const screenReadReader = document.getElementById("screen-read-reader");
const screenReadExercise = document.getElementById("screen-read-exercise");
const screenReadSetup = document.getElementById("screen-read-setup");
const screenSpeakSetup = document.getElementById("screen-speak-setup");

const createBtn = document.getElementById("createCardsBtn");
const inputText = document.getElementById("inputText");
const container = document.getElementById("cardsContainer");

// Live "~N sentences · about Xm" hint under the composer (spotlight setup look).
function updateComposerHint() {
  const hint = document.getElementById("composerHint");
  if (!hint || !inputText) return;
  const text = (inputText.value || "").trim();
  if (!text) { hint.hidden = true; return; }
  const parts = text.split(/[.!?。！？\n]+/).map(s => s.trim()).filter(Boolean);
  const n = Math.max(1, parts.length);
  const mins = Math.max(1, Math.round((n * 20) / 60)); // ~20s of practice per sentence
  hint.textContent = `~${n} sentence${n === 1 ? "" : "s"} · about ${mins} min`;
  hint.hidden = false;
}
inputText?.addEventListener("input", updateComposerHint);

const editTextBtn = document.getElementById("editTextBtn");
const replaceTextBtn = document.getElementById("replaceTextBtn");
const globalSlowBtn = document.getElementById("globalSlowBtn");

const fullTextPanel = document.getElementById("fullTextPanel");
const fullTextContent = document.getElementById("fullTextContent");
const fullTextPinyin = document.getElementById("fullTextPinyin");
const fullTextTranslation = document.getElementById("fullTextTranslation");
const startComposerArea = document.getElementById("startComposerArea");

const textLibraryPanel = document.getElementById("textLibraryPanel");
const textLibraryList = document.getElementById("textLibraryList");
const openLibraryBtn = document.getElementById("openLibraryBtn");

const savedTextsPanel = document.getElementById("savedTextsPanel");
const savedTextsList = document.getElementById("savedTextsList");
const showSavedTextsBtn = document.getElementById("showSavedTextsBtn");

const profileMenuBtn = document.getElementById("profileMenuBtn");
const profileDropdown = document.getElementById("profileDropdown");

const writingInput = document.getElementById("writingInput");
const createWritingSheetBtn = document.getElementById("createWritingSheetBtn");
const writingResult = document.getElementById("writingResult");

/* -----------------------------
   STATE
----------------------------- */

let authPromptShown = false;
let authFriendlyShown = false;
let authMode = "login";

const guestUsage = {
  cardsPlayed: 0,
  wordClicks: 0,
  translations: 0,
  fullTextsGenerated: 0,
  graceModeActive: false,
  graceListens: 0,
  graceWords: 0
};

const wordPopupCache = new Map();

let currentRecognition = null;
let currentFlashcardRecognition = null;
let flashcardSpeakingMode = null; // null | "easy" | "hard"
let flashcardSpeakingUnlocked = true;
const FLASHCARD_PASS_SCORE = 75;

let currentAudio = null;       // the shared ttsAudioEl while a TTS clip is active
let audioCtxSuspended = false; // true while TTS playback is paused
let currentAudioText = "";
let currentAudioRate = 1.0;
let activePopup = null;
let activeHighlightTimer = null;

let ttsSpeedMode = 0; // 0 normal, 1 slow, 2 extra slow
let popupTimeout = null;

let currentText = "";
let currentSentences = [];
let currentTextId    = null;  // "lib_<id>" for library texts, UUID for saved texts, null for pasted
let currentTextTitle = "";
let _resumeProgress  = null;
let savedTextsCache = null;
const segmentCache = new Map();
const ttsCache = new Map();
const libraryCache = {};

// All TTS plays through one persistent <audio> element. iOS treats element
// playback as "media" (audible even with the ring/silent switch on silent),
// unlike Web Audio, which the switch mutes on the speaker. The element is
// "blessed" with a silent clip on the first user touch so play() calls that
// happen after a network await are still allowed by iOS.
const SILENT_WAV = "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ttsAudioEl = new Audio();
ttsAudioEl.preload = "auto";
let ttsAudioBlessed = false;

document.addEventListener("touchstart", unlockAudioForMobile, { once: true, passive: true });
document.addEventListener("click", unlockAudioForMobile, { once: true });

/* -----------------------------
   VOICE PICKER
----------------------------- */

const VOICE_LIST = {
  zh: [
    { name: "cmn-CN-Wavenet-D", label: "Voice D", gender: "Male" },
    { name: "cmn-CN-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "cmn-CN-Wavenet-A", label: "Voice A", gender: "Female" },
    { name: "cmn-CN-Wavenet-C", label: "Voice C", gender: "Female" },
  ],
  en: [
    { name: "en-US-Wavenet-D", label: "Voice D", gender: "Male" },
    { name: "en-US-Wavenet-A", label: "Voice A", gender: "Male" },
    { name: "en-US-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "en-US-Wavenet-C", label: "Voice C", gender: "Female" },
    { name: "en-US-Wavenet-E", label: "Voice E", gender: "Female" },
    { name: "en-US-Wavenet-F", label: "Voice F", gender: "Female" },
    { name: "en-US-Wavenet-G", label: "Voice G", gender: "Female" },
    { name: "en-US-Wavenet-H", label: "Voice H", gender: "Female" },
  ],
  de: [
    { name: "de-DE-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "de-DE-Wavenet-A", label: "Voice A", gender: "Female" },
    { name: "de-DE-Wavenet-C", label: "Voice C", gender: "Female" },
    { name: "de-DE-Wavenet-D", label: "Voice D", gender: "Female" },
    { name: "de-DE-Wavenet-E", label: "Voice E", gender: "Male" },
  ],
  es: [
    { name: "es-ES-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "es-ES-Wavenet-C", label: "Voice C", gender: "Female" },
    { name: "es-ES-Wavenet-D", label: "Voice D", gender: "Female" },
  ],
  fr: [
    { name: "fr-FR-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "fr-FR-Wavenet-A", label: "Voice A", gender: "Female" },
    { name: "fr-FR-Wavenet-C", label: "Voice C", gender: "Female" },
    { name: "fr-FR-Wavenet-D", label: "Voice D", gender: "Male" },
    { name: "fr-FR-Wavenet-E", label: "Voice E", gender: "Female" },
  ],
  ja: [
    { name: "ja-JP-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "ja-JP-Wavenet-C", label: "Voice C", gender: "Male" },
    { name: "ja-JP-Wavenet-A", label: "Voice A", gender: "Female" },
    { name: "ja-JP-Wavenet-D", label: "Voice D", gender: "Female" },
  ],
  ru: [
    { name: "ru-RU-Wavenet-A", label: "Voice A", gender: "Female" },
    { name: "ru-RU-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "ru-RU-Wavenet-C", label: "Voice C", gender: "Female" },
    { name: "ru-RU-Wavenet-D", label: "Voice D", gender: "Male" },
    { name: "ru-RU-Wavenet-E", label: "Voice E", gender: "Female" },
  ],
  tr: [
    { name: "tr-TR-Wavenet-A", label: "Voice A", gender: "Female" },
    { name: "tr-TR-Wavenet-B", label: "Voice B", gender: "Male" },
    { name: "tr-TR-Wavenet-C", label: "Voice C", gender: "Female" },
    { name: "tr-TR-Wavenet-D", label: "Voice D", gender: "Male" },
    { name: "tr-TR-Wavenet-E", label: "Voice E", gender: "Female" },
  ],
};

const SAMPLE_SENTENCES = {
  zh: "今天天气真的很好，我们出去走走吧。",
  en: "The quick brown fox jumps over the lazy dog.",
  de: "Das Wetter ist heute wirklich schön.",
  es: "El sol brilla con fuerza esta mañana.",
  fr: "Le soleil brille fort ce matin.",
  ja: "今日はとても良い天気ですね。",
  ru: "Сегодня очень хорошая погода.",
  tr: "Bugün hava gerçekten çok güzel.",
};

function getSelectedVoice(lang) {
  return localStorage.getItem(`tts_voice_${lang}`) || null;
}

function setSelectedVoice(lang, name) {
  localStorage.setItem(`tts_voice_${lang}`, name);
}

function openVoicePicker() {
  const panel = document.getElementById("voicePickerPanel");
  const list = document.getElementById("voicePickerList");
  if (!panel || !list) return;

  const lang = sourceLangSelect.value;
  const voices = VOICE_LIST[lang] || [];
  const selected = getSelectedVoice(lang);

  if (panel.hidden === false) {
    panel.hidden = true;
    return;
  }

  list.innerHTML = "";

  if (voices.length === 0) {
    list.innerHTML = `<p class="voice-picker-empty">No voices available for this language.</p>`;
    panel.hidden = false;
    return;
  }

  voices.forEach(v => {
    const isSelected = (selected === v.name) || (!selected && v.name === voices[0].name);
    const item = document.createElement("div");
    item.className = "voice-option" + (isSelected ? " voice-selected" : "");
    item.dataset.voiceName = v.name;
    item.innerHTML = `
      <div class="voice-info">
        <span class="voice-name">${v.label}</span>
        <span class="voice-gender">${v.gender}</span>
      </div>
      <button class="voice-preview-btn" type="button" title="Preview">&#9654;</button>
    `;

    item.querySelector(".voice-preview-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      const sample = SAMPLE_SENTENCES[lang] || "Hello.";
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const response = await fetchWithAuth(`${API_BASE}/api/tts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sample, sourceLang: lang, speakingRate: 1.0, voiceName: v.name })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "TTS failed");
        const blob = new Blob([base64ToArrayBuffer(data.audioBase64)], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const preview = new Audio(url);
        preview.onended = () => { URL.revokeObjectURL(url); btn.disabled = false; btn.innerHTML = "&#9654;"; };
        await preview.play();
      } catch (err) {
        console.error("Voice preview failed:", err);
        showToast(err.message || "Preview failed", "error");
        btn.disabled = false;
        btn.innerHTML = "&#9654;";
      }
    });

    item.addEventListener("click", (e) => {
      if (e.target.closest(".voice-preview-btn")) return;
      setSelectedVoice(lang, v.name);
      ttsCache.forEach(entry => { if (entry?.url) URL.revokeObjectURL(entry.url); });
      ttsCache.clear();
      list.querySelectorAll(".voice-option").forEach(el => el.classList.remove("voice-selected"));
      item.classList.add("voice-selected");
    });

    list.appendChild(item);
  });

  panel.hidden = false;
}

const FLASHCARD_STORAGE_KEY = "magicread_flashcard_decks";
let flashcardDecks = [];
let currentDeckId = null;
// Which user's decks are in memory — lets checkAuth() reload them after a
// fresh in-app login (decks used to load only once at startup, so logging in
// on a new device showed an empty flashcards screen until an app restart).
let flashcardsLoadedForUserId = null;
let currentFlashcardIndex = 0;
let flashcardFlipped = false;

window.speechSynthesis?.getVoices();

/* -----------------------------
   I18N
----------------------------- */

function getT() {
  const lang = localStorage.getItem("magicread_ui_lang") || "en";
  return UI_TEXT[lang] || UI_TEXT.en;
}

function applyLocalization(lang = "en") {
  const t = UI_TEXT[lang] || UI_TEXT.en;

  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    if (t[key]) el.textContent = t[key];
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const key = el.dataset.i18nPlaceholder;
    if (t[key]) el.placeholder = t[key];
  });

  localStorage.setItem("magicread_ui_lang", lang);
  updateSlowLabels();
}

function detectUserLanguage() {
  const supported = ["en", "ru", "zh", "tr", "de", "es", "fr", "ja"];
  for (const pref of (navigator.languages || [navigator.language || "en"])) {
    const code = pref.slice(0, 2).toLowerCase();
    if (supported.includes(code)) return code;
  }
  return "en";
}

const savedUiLang = localStorage.getItem("magicread_ui_lang")
  ?? (() => {
    const detected = detectUserLanguage();
    localStorage.setItem("magicread_ui_lang", detected);
    return detected;
  })();

if (uiLangSelect) {
  uiLangSelect.value = savedUiLang;
  uiLangSelect.addEventListener("change", () => {
    applyLocalization(uiLangSelect.value);
    updateModeCopy();
  });
}

applyLocalization(savedUiLang);

/* -----------------------------
   AUTH
----------------------------- */
document.getElementById("closeAuthOverlayBtn")?.addEventListener("click", () => {
  document.getElementById("authOverlay")?.setAttribute("hidden", "");
  document.body.style.overflow = "";
});

/* -----------------------------
   PLAN STATE (free / pro / welcome-week trial)
----------------------------- */

// Single source of truth for the signed-in user's plan + today's usage.
// Populated from GET /api/my-plan; defaults assume guest/free.
let userPlan = {
  plan: "free",
  effectivePlan: "free",
  trialActive: false,
  trialEndsAt: null,
  planEndsAt: null,
  planProvider: null,
  isPaidPro: false,
  isLifetimePro: false,
  tbankAvailable: false,
  lifetimeOfferEligible: false,
  textUsedToday: 0,
  pronouncedToday: 0,
  videosOpened: 0,
  wordsRead: 0,
  wordsSpoken: 0,
  wordsPracticed: 0,
  currentStreak: 0,
  limits: { textPerDay: 3, pronunciationPerDay: 20, savedTexts: 5, decks: 2, cards: 100, videosPerTrial: 3 }
};

const GUEST_PLAN = { ...userPlan };
const GOOGLE_PLAY_PRODUCTS = {
  monthly: { productId: "magic_read_pro_monthly", basePlanId: "monthly" },
  annual: { productId: "magic_read_pro_annual", basePlanId: "annual" }
};

// Pull the plan + usage snapshot from the backend and re-render plan UI.
async function fetchMyPlan() {
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/my-plan`);
    if (!res.ok) return;
    const data = await res.json();
    userPlan = { ...userPlan, ...data, limits: { ...userPlan.limits, ...(data.limits || {}) } };
    renderPlanUI();
  } catch {
    // Keep last-known plan on a network hiccup.
  }
}

// Fire-and-forget stats ping. Never throws — a stats failure must not block the user.
function recordActivity(type, count) {
  if (!document.body.classList.contains("is-logged-in")) return;
  fetchWithAuth(`${API_BASE}/api/record-activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, count })
  }).catch(() => {});
}

let _saveProgressTimer = null;
function saveProgress(activity, itemId, position, title) {
  if (!itemId || !document.body.classList.contains("is-logged-in")) return;
  clearTimeout(_saveProgressTimer);
  _saveProgressTimer = setTimeout(async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    supabase.from("user_progress").upsert(
      { user_id: user.id, activity, item_id: String(itemId), position, title: title || "", updated_at: new Date().toISOString() },
      { onConflict: "user_id,activity,item_id" }
    ).then(({ error }) => { if (error) console.error("[Progress] upsert:", error.message); });
  }, 1500);
}

function trialDaysLeft() {
  if (!userPlan.trialEndsAt) return 0;
  const ms = new Date(userPlan.trialEndsAt) - new Date();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function isPaidProUser() {
  return userPlan.isPaidPro || userPlan.plan === "pro";
}

function isLifetimeProUser() {
  return userPlan.isLifetimePro || userPlan.planProvider === "lifetime" || userPlan.planProvider === "forever";
}

// Drives the profile dropdown (upgrade button / Pro badge / trial badge),
// the welcome-week banner, and the soft text counter.
function renderPlanUI() {
  const upgradeBtn = document.getElementById("upgradeBtn");
  const proBadge = document.getElementById("proBadge");
  const trialBadge = document.getElementById("trialBadge");

  const loggedIn = document.body.classList.contains("is-logged-in");
  const paidPro = isPaidProUser();

  if (!loggedIn) {
    if (upgradeBtn) upgradeBtn.hidden = true;
    if (proBadge) proBadge.hidden = true;
    if (trialBadge) trialBadge.hidden = true;
  } else if (paidPro) {
    if (proBadge) proBadge.hidden = false;
    if (trialBadge) trialBadge.hidden = true;
    if (upgradeBtn) upgradeBtn.hidden = true;
  } else if (userPlan.trialActive && !paidPro) {
    const days = trialDaysLeft();
    if (trialBadge) {
      trialBadge.textContent = getT().proTrialDaysLeft.replace("{n}", days);
      trialBadge.hidden = false;
    }
    if (proBadge) proBadge.hidden = true;
    // Let trial users convert early.
    if (upgradeBtn) upgradeBtn.hidden = false;
  } else {
    if (upgradeBtn) upgradeBtn.hidden = false;
    if (proBadge) proBadge.hidden = true;
    if (trialBadge) trialBadge.hidden = true;
  }

  // Show a small plan dot on the profile button so plan state is visible
  // during regular app use (dropdown is replaced by the full account screen).
  const profileBtn = document.getElementById("profileMenuBtn");
  if (profileBtn) {
    if (paidPro) {
      profileBtn.dataset.planBadge = "pro";
    } else if (userPlan.trialActive && !paidPro) {
      profileBtn.dataset.planBadge = "trial";
    } else {
      delete profileBtn.dataset.planBadge;
    }
  }

  renderWelcomeBanner();
  renderTextCounter();
  renderSpeakMeter();
  renderVidFreeChip();
  renderLifetimeOffer();
  renderTbankOptions();

  // Hide the "lite" wordmark suffix and speak-meter label for paid Pro users.
  const isLite = !paidPro;
  document.querySelectorAll(".brand-lite, .speak-meter-lite").forEach(el => {
    el.hidden = !isLite;
  });
}

function renderLifetimeOffer() {
  document.querySelectorAll('[data-price-type="lifetime"]').forEach(option => {
    option.hidden = isAndroidCapacitorShell() || isPaidProUser() || !userPlan.lifetimeOfferEligible;
  });
}

function renderTbankOptions() {
  document.querySelectorAll("[data-tbank-plan], .tbank-plan-label").forEach(element => {
    element.hidden = isAndroidCapacitorShell() || !userPlan.tbankAvailable;
  });
}

function renderWelcomeBanner() {
  const banner = document.getElementById("welcomeWeekBanner");
  if (!banner) return;

  const dismissed = sessionStorage.getItem("welcomeWeekDismissed") === "1";
  if (userPlan.trialActive && !isPaidProUser() && !dismissed) {
    const end = userPlan.trialEndsAt ? new Date(userPlan.trialEndsAt) : null;
    const dateStr = end ? end.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const textEl = banner.querySelector(".welcome-week-text");
    if (textEl) {
      textEl.textContent = getT().welcomeWeekMsg
        .replace("{date}", dateStr)
        .replace("{texts}", userPlan.limits.textPerDay)
        .replace("{checks}", userPlan.limits.pronunciationPerDay);
    }
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function renderTextCounter() {
  const counter = document.getElementById("textQuotaCounter");
  if (!counter) return;

  const loggedIn = document.body.classList.contains("is-logged-in");
  if (loggedIn && userPlan.effectivePlan === "free") {
    counter.textContent = `${userPlan.textUsedToday || 0} of ${userPlan.limits.textPerDay} texts used today`;
    counter.hidden = false;
  } else {
    counter.hidden = true;
  }
}

function renderSpeakMeter() {
  const meter = document.getElementById("speakUsageMeter");
  if (!meter) return;

  const loggedIn = document.body.classList.contains("is-logged-in");
  const isFree = loggedIn && userPlan.effectivePlan === "free";

  if (!isFree) {
    meter.hidden = true;
    return;
  }

  const limit = userPlan.limits.pronunciationPerDay;
  const used = userPlan.pronouncedToday || 0;
  const left = Math.max(0, limit - used);
  const pct = Math.round((left / limit) * 100);

  meter.querySelector(".speak-meter-left").textContent = left;
  meter.querySelector(".speak-meter-total").textContent = limit;
  meter.querySelector(".speak-meter-bar").style.width = `${pct}%`;
  meter.hidden = false;
}

document.getElementById("welcomeWeekDismiss")?.addEventListener("click", () => {
  sessionStorage.setItem("welcomeWeekDismissed", "1");
  const banner = document.getElementById("welcomeWeekBanner");
  if (banner) banner.hidden = true;
});

/* -----------------------------
   CONTEXTUAL UPGRADE PROMPTS
----------------------------- */

function getUpgradeMessage(code) {
  const lim = userPlan.limits;
  const t = getT();
  const fill = (str, n) => String(str || "").replace("{n}", n);
  const msgs = {
    QUOTA_EXCEEDED: {
      title: t.quotaChecksTitle,
      sub: fill(t.quotaChecksSub, lim.pronunciationPerDay),
      reassurance: t.quotaResetTomorrow
    },
    TEXT_QUOTA_EXCEEDED: {
      title: t.quotaTextsTitle,
      sub: fill(t.quotaTextsSub, lim.textPerDay),
      reassurance: null
    },
    SAVE_TEXT_QUOTA_EXCEEDED: {
      title: t.quotaTextsTitle,
      sub: fill(t.quotaSavedSub, lim.savedTexts),
      reassurance: null
    },
    DECK_QUOTA_EXCEEDED: {
      title: t.quotaLimitTitle,
      sub: fill(t.quotaDeckSub, lim.decks),
      reassurance: null
    },
    CARD_QUOTA_EXCEEDED: {
      title: t.quotaLimitTitle,
      sub: fill(t.quotaCardSub, lim.cards),
      reassurance: null
    },
    VIDEO_QUOTA_EXCEEDED: {
      title: t.quotaVideoTitle,
      sub: fill(t.quotaVideoSub, lim.videosPerTrial),
      reassurance: null
    },
    TTS_QUOTA_EXCEEDED: {
      title: t.quotaTtsTitle,
      sub: t.quotaTtsSub,
      reassurance: t.quotaTtsReset
    },
    TRANSLATE_QUOTA_EXCEEDED: {
      title: t.quotaTransTitle,
      sub: t.quotaTransSub,
      reassurance: t.quotaTransReset
    }
  };
  return msgs[code] || { title: t.upgradeDefaultTitle, sub: t.upgradeDefaultSub, reassurance: null };
}

// Show a dismissible upgrade modal at hard limits. The inline usage meter
// (renderSpeakMeter) stays visible independently — this modal is additive.
function showUpgradePrompt(code) {
  document.querySelectorAll(".upgrade-modal-overlay, .upgrade-inline").forEach(el => el.remove());
  const msg = getUpgradeMessage(code);
  const t = getT();

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay upgrade-modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box upgrade-modal">
      <h3 class="upgrade-modal-title">${escapeHtml(msg.title)}</h3>
      <p class="upgrade-modal-sub">${escapeHtml(msg.sub)}</p>
      <div class="upgrade-compare">
        <div class="uc-row uc-head"><span></span><span>${escapeHtml(t.freeLabel)}</span><span class="uc-pro">${escapeHtml(t.proLabel)}</span></div>
        <div class="uc-row"><span>${escapeHtml(t.cmpTextsDay)}</span><span>3</span><span class="uc-pro">∞</span></div>
        <div class="uc-row"><span>${escapeHtml(t.cmpChecksDay)}</span><span>20</span><span class="uc-pro">∞</span></div>
        <div class="uc-row"><span>${escapeHtml(t.cmpSavedTexts)}</span><span>5</span><span class="uc-pro">∞</span></div>
        <div class="uc-row"><span>${escapeHtml(t.cmpDecksCards)}</span><span>2 · 100</span><span class="uc-pro">∞</span></div>
        <div class="uc-row"><span>${escapeHtml(t.cmpVideos)}</span><span>—</span><span class="uc-pro">✓</span></div>
      </div>
      <div class="upgrade-modal-plans">
        <button class="upgrade-plan-btn" data-price-type="annual" type="button">
          ${escapeHtml(t.annualPlanBtn)} <span class="upgrade-plan-save">${escapeHtml(t.savePct)}</span>
        </button>
        <button class="upgrade-plan-btn upgrade-plan-secondary" data-price-type="monthly" type="button">
          ${escapeHtml(t.monthlyPlanBtn)}
        </button>
        ${userPlan.tbankAvailable && !isAndroidCapacitorShell() ? `
          <div class="tbank-plan-label">${escapeHtml(getT().tbankPaymentLabel || "Russian card or SBP")}</div>
          <button class="upgrade-plan-btn tbank-upgrade-btn" data-tbank-plan="annual" type="button">
            ${escapeHtml(getT().tbankAnnual || "1 year — 5,000 ₽")}
          </button>
          <button class="upgrade-plan-btn upgrade-plan-secondary tbank-upgrade-btn" data-tbank-plan="monthly" type="button">
            ${escapeHtml(getT().tbankMonthly || "1 month — 600 ₽")}
          </button>
        ` : ""}
      </div>
      <button class="upgrade-modal-cta" data-price-type="annual" type="button">${escapeHtml(t.upgradeDefaultTitle)}</button>
      ${msg.reassurance ? `<p class="upgrade-modal-reset">${escapeHtml(msg.reassurance)}</p>` : ""}
      <button class="upgrade-modal-dismiss" type="button">${escapeHtml(t.maybeLater)}</button>
    </div>
  `;

  const close = () => overlay.remove();
  overlay.querySelector(".upgrade-modal-dismiss").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll("[data-price-type]").forEach(btn => {
    btn.addEventListener("click", () => {
      close();
      startPlanCheckout(btn.dataset.priceType, null);
    });
  });
  overlay.querySelectorAll("[data-tbank-plan]").forEach(btn => {
    btn.addEventListener("click", () => {
      close();
      startTbankCheckout(btn.dataset.tbankPlan, null);
    });
  });

  document.body.appendChild(overlay);
}

// Gate deck/card creation. intent: 'new-deck' | 'add-card'. Returns true if
// allowed; shows an inline upgrade prompt and returns false if blocked.
async function checkDeckQuota(intent, targetEl) {
  const { data: sess } = await supabase.auth.getSession();
  if (!sess.session) return true; // decks require login elsewhere
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/check-deck-quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent })
    });
    const data = await res.json();
    if (!res.ok) {
      if (data.code) showUpgradePrompt(data.code, targetEl);
      else showToast(data.error || "Limit reached.", "error");
      return false;
    }
    return true;
  } catch {
    return true; // fail open on network error
  }
}

async function checkAuth() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    document.body.classList.add("is-logged-in");
    document.body.classList.remove("is-logged-out");
    document.body.classList.remove("auth-active");

    if (authScreen) authScreen.hidden = true;
    if (landingHow) landingHow.hidden = false;
    if (mainApp) mainApp.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;

    fetchMyPlan();
    syncGooglePlayPurchases();

    // Pull this user's decks if they aren't in memory yet (no-op when already
    // loaded) — covers logging in after startup on a fresh device.
    loadFlashcardsFromStorage().then(() => {
      renderDeckSelector();
      renderFlashcards();
    });

    // If the user landed on the onboarding screen (because session wasn't known yet),
    // redirect them straight to the home dashboard — via the one-time feature
    // tour in the native apps.
    const activeScreen = document.querySelector(".app-screen.active");
    if (!activeScreen || activeScreen.id === "screen-onboarding") {
      maybeShowTour(() => {
        renderHomeScreen();
        showScreen(screenHome);
      });
    }
  } else {
    document.body.classList.add("is-logged-out");
    document.body.classList.remove("is-logged-in");

    if (authScreen) authScreen.hidden = true;
    if (landingHow) landingHow.hidden = isNativeCapacitorShell();
    if (mainApp) mainApp.hidden = isNativeCapacitorShell();
    if (logoutBtn) logoutBtn.hidden = true;

    userPlan = { ...GUEST_PLAN };
    renderPlanUI();
    flashcardsLoadedForUserId = null;
    flashcardDecks = [];
    currentDeckId = null;
    // The native apps have no marketing landing — signed-out users go straight
    // to the auth screen (its close button is hidden via body.is-native).
    if (isNativeCapacitorShell()) {
      openAuthFromOverlay("login");
    } else {
      showLandingPage();
    }
  }
}

function closeAuthScreen() {
  if (authScreen) authScreen.hidden = true;
  document.body.classList.remove("auth-active");
  const loginError = document.getElementById("loginError");
  if (loginError) loginError.hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("authCloseBtn")?.addEventListener("click", closeAuthScreen);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.classList.contains("auth-active")) {
    closeAuthScreen();
  }
});

function openAuthFromOverlay(mode = "signup") {
  const overlay = document.getElementById("authOverlay");
  if (overlay) overlay.hidden = true;

  if (authScreen) authScreen.hidden = false;
  document.body.classList.add("auth-active");

  const loginError = document.getElementById("loginError");
  if (loginError) loginError.hidden = true;

  authMode = mode;
  const authTitleText = document.getElementById("authTitleText");
  const authHintText = document.getElementById("authHintText");
  const authSwitchText = document.getElementById("authSwitchText");
  const forgotPasswordBtn = document.getElementById("forgotPasswordBtn");

  if (mode === "signup") {
    if (authNameGroup) authNameGroup.hidden = false;
    if (authTitleText) authTitleText.textContent = getT().signupTitle;
    if (authHintText) authHintText.textContent = getT().signupTrialHint;
    if (authSwitchText) authSwitchText.hidden = false;
    if (forgotPasswordBtn) forgotPasswordBtn.hidden = true;

    if (loginBtn) loginBtn.hidden = true;
    if (signUpBtn) {
      signUpBtn.hidden = false;
      signUpBtn.textContent = getT().createAccount;
    }

    if (authMessage) {
      authMessage.textContent =
        getT().createAccountHint;
    }
  }

  if (mode === "login") {
    if (authNameGroup) authNameGroup.hidden = true;
    if (authTitleText) authTitleText.textContent = getT().loginTitle;
    if (authHintText) authHintText.textContent = getT().loginToContinue;
    if (authSwitchText) authSwitchText.hidden = true;
    if (forgotPasswordBtn) forgotPasswordBtn.hidden = false;

    if (loginBtn) loginBtn.hidden = false;
    if (signUpBtn) {
      signUpBtn.hidden = false;
      signUpBtn.textContent = getT().createAccount;
    }

    if (authMessage) {
      authMessage.textContent = getT().loginToContinue;
    }
  }

  // The native auth screen fills the viewport — centering it with a smooth
  // scroll causes visible jumps when the keyboard opens, so just go to top.
  if (isNativeCapacitorShell()) {
    window.scrollTo(0, 0);
  } else {
    authScreen?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

document.getElementById("openSignupBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("signup");
});

document.getElementById("openLoginBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("login");
});

guestLoginBtn?.addEventListener("click", () => {
  openAuthFromOverlay("login");
});

signUpBtn?.addEventListener("click", async () => {
  if (authNameGroup?.hidden) {
    openAuthFromOverlay("signup");
    return;
  }

  const t = getT();

  const name = document.getElementById("authName")?.value.trim();
  const email = document.getElementById("authEmail")?.value.trim();
  const password = document.getElementById("authPassword")?.value.trim();

  if (!name || !email || !password) {
    if (authMessage) authMessage.textContent = t.enterAllFields;
    return;
  }

  signUpBtn.disabled = true;
  if (authMessage) authMessage.textContent = t.creatingAccount;

  try {
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name
        },
        // Land confirmed sign-ups on a unique URL so Google Ads can count them
        // as a "Sign-up" conversion (only verified accounts reach this page).
        emailRedirectTo: "https://magicread.app/?signup=confirmed"
      }
    });

    if (error) {
      if (authMessage) authMessage.textContent = error.message;
      return;
    }

    const authCard = document.querySelector("#authScreen .auth-card");

  if (authCard) {
    authCard.innerHTML = `
      <div class="auth-success">
        <div class="auth-success-icon">✓</div>
        <h2>Account created</h2>
        <p>
          Please check your mailbox and confirm your email address.
          After confirmation, you can log in and start saving your texts,
          flashcards, and practice progress.
        </p>
        <button class="primary-btn" type="button" onclick="location.reload()">
          Back to login
        </button>
      </div>
    `;
  }
  } catch (err) {
    console.error("Signup failed:", err);
    if (authMessage) authMessage.textContent = t.signupFailed;
  } finally {
    signUpBtn.disabled = false;
  }
});

document.getElementById("switchToLoginBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("login");
});

document.getElementById("loginBtn")?.addEventListener("click", async () => {
  authMode = "login";
  if (authNameGroup) authNameGroup.hidden = true;

  const email = document.getElementById("authEmail")?.value.trim();
  const password = document.getElementById("authPassword")?.value.trim();
  const t = getT();

  const loginError = document.getElementById("loginError");
  if (loginError) loginError.hidden = true;
  if (!email || !password) {
    if (loginError) {
      loginError.textContent = "Enter your email and password.";
      loginError.hidden = false;
    }
    return;
  }

  if (authMessage) authMessage.textContent = t.loggingIn;
  const btn = document.getElementById("loginBtn");
  if (btn) btn.disabled = true;

  try {
    const { error } = await withTimeout(
      supabase.auth.signInWithPassword({
        email,
        password
      }),
      15000,
      "Login timed out. Check your internet connection and try again."
    );

    if (error) {
      if (authMessage) authMessage.textContent = "";
      if (loginError) {
        loginError.textContent = error.message;
        loginError.hidden = false;
      }
      return;
    }

    if (loginError) loginError.hidden = true;
    if (authMessage) authMessage.textContent = "";
    await checkAuth();
  } catch (error) {
    if (authMessage) authMessage.textContent = "";
    if (loginError) {
      loginError.textContent = error?.message || "Could not reach the login service. Check your connection and try again.";
      loginError.hidden = false;
    }
  } finally {
    if (btn) btn.disabled = false;
  }
});

logoutBtn?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  if (profileDropdown) profileDropdown.hidden = true;
  await checkAuth();
  showLandingPage();
});

// "Upgrade to Pro ✨" reveals the 3-plan picker inside the dropdown.
document.getElementById("upgradeBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  const picker = document.getElementById("planPicker");
  if (picker) picker.hidden = !picker.hidden;
});

// Start Stripe Checkout for a specific plan: ask the backend for a session URL,
// then redirect. Disables all options and shows "Redirecting…" while in flight.
async function startPlanCheckout(priceType, clickedBtn) {
  if (isAndroidCapacitorShell()) {
    await startGooglePlayCheckout(priceType, clickedBtn);
    return;
  }

  const options = Array.from(document.querySelectorAll("#planPicker .plan-option, #acctPlanPicker .plan-option"));
  const labels = options.map(b => b.textContent);
  options.forEach(b => { b.disabled = true; });
  if (clickedBtn) clickedBtn.textContent = "Redirecting…";

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priceType })
    });
    const data = await response.json();
    if (data?.url) {
      window.location.href = data.url;
      return;
    }
    console.error("Checkout session error:", data?.error);
  } catch (err) {
    console.error("Checkout request failed:", err);
  }

  // Restore the picker on failure so the user can retry.
  options.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
}

function getPlayBillingPlugin() {
  return window.Capacitor?.Plugins?.PlayBilling || null;
}

function getPrimaryProductId(purchase) {
  const ids = purchase?.productIds;
  if (Array.isArray(ids)) return ids[0];
  if (typeof ids === "string") return ids;
  return null;
}

async function verifyGooglePlayPurchase(purchase, fallbackProductId = null) {
  const productId = getPrimaryProductId(purchase) || fallbackProductId;
  if (!purchase?.purchaseToken || !productId) {
    throw new Error("Missing Google Play purchase token or product id.");
  }

  const response = await fetchWithAuth(`${API_BASE}/api/google-play/verify-purchase`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      productId,
      purchaseToken: purchase.purchaseToken,
      packageName: purchase.packageName,
      orderId: purchase.orderId
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || "Google Play purchase could not be verified.");
  return data;
}

async function startGooglePlayCheckout(priceType, clickedBtn) {
  const playProduct = GOOGLE_PLAY_PRODUCTS[priceType];
  const productId = playProduct?.productId;
  if (!productId) {
    showToast("This plan is not available in the Android app.", "error");
    return;
  }

  const billing = getPlayBillingPlugin();
  if (!billing) {
    showToast("Google Play Billing is not available on this device.", "error");
    return;
  }

  const options = Array.from(document.querySelectorAll("#planPicker .plan-option, #acctPlanPicker .plan-option, .upgrade-plan-btn, .upgrade-modal-cta"));
  const labels = options.map(button => button.textContent);
  options.forEach(button => { button.disabled = true; });
  if (clickedBtn) clickedBtn.textContent = getT().redirecting || "Redirecting…";

  try {
    const purchase = await billing.purchase({
      productId,
      basePlanId: playProduct.basePlanId
    });
    await verifyGooglePlayPurchase(purchase, productId);
    showToast("Google Play purchase confirmed. Pro is active.", "success");
    await fetchMyPlan();
    renderAccountScreen();
  } catch (error) {
    if (error?.code !== "USER_CANCELED") {
      console.error("[Google Play] checkout failed:", error);
      showToast(error?.message || "Google Play purchase failed.", "error");
    }
  } finally {
    options.forEach((button, index) => {
      button.disabled = false;
      button.textContent = labels[index];
    });
  }
}

async function syncGooglePlayPurchases({ silent = true } = {}) {
  if (!isAndroidCapacitorShell()) return;
  const billing = getPlayBillingPlugin();
  if (!billing) return;

  try {
    const result = await billing.queryPurchases();
    const purchases = Array.isArray(result?.purchases) ? result.purchases : [];
    for (const purchase of purchases) {
      await verifyGooglePlayPurchase(purchase);
    }
    if (purchases.length) await fetchMyPlan();
  } catch (error) {
    if (!silent) {
      showToast(error?.message || "Could not restore Google Play purchases.", "error");
    }
    console.error("[Google Play] restore failed:", error);
  }
}

async function startTbankCheckout(plan, clickedBtn) {
  const options = Array.from(document.querySelectorAll("[data-tbank-plan]"));
  const labels = options.map(button => button.textContent);
  options.forEach(button => { button.disabled = true; });
  if (clickedBtn) clickedBtn.textContent = getT().redirecting || "Redirecting…";

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/tbank/create-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan })
    });
    const data = await response.json();
    if (response.ok && data?.url) {
      window.location.href = data.url;
      return;
    }
    showToast(data?.error || "Could not start T-Bank payment.", "error");
  } catch (error) {
    console.error("T-Bank checkout failed:", error);
    showToast("Could not start T-Bank payment.", "error");
  }

  options.forEach((button, index) => {
    button.disabled = false;
    button.textContent = labels[index];
  });
}

document.querySelectorAll("#planPicker .plan-option, #acctPlanPicker .plan-option").forEach(btn => {
  if (btn.dataset.tbankPlan) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    startPlanCheckout(btn.dataset.priceType, btn);
  });
});

document.querySelectorAll("[data-tbank-plan]").forEach(btn => {
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    startTbankCheckout(btn.dataset.tbankPlan, btn);
  });
});

// Native shell startup: keep the branded splash over first auth/session routing.
startNativeIntroSplash();

const initialAuthCheck = checkAuth();
initialAuthCheck.then(() => {
  const paymentStatus = new URLSearchParams(window.location.search).get("tbank");
  if (paymentStatus === "success") {
    showToast(getT().tbankPaymentPending || "Payment received. Pro access will appear shortly.", "success");
    setTimeout(fetchMyPlan, 2000);
  } else if (paymentStatus === "failed") {
    showToast(getT().tbankPaymentFailed || "Payment was not completed.", "error");
  }
});

/* -----------------------------
   PASSWORD RESET
----------------------------- */

const forgotPasswordBox = document.getElementById("forgotPasswordBox");
const recoveryEmailInput = document.getElementById("recoveryEmailInput");
const sendRecoveryEmailBtn = document.getElementById("sendRecoveryEmailBtn");
const recoveryMessage = document.getElementById("recoveryMessage");

function setRecoveryMessage(text) {
  if (!recoveryMessage) return;
  recoveryMessage.textContent = text;
  recoveryMessage.hidden = !text;
}

document.getElementById("forgotPasswordBtn")?.addEventListener("click", () => {
  const t = getT();

  if (forgotPasswordBox) forgotPasswordBox.hidden = false;
  setRecoveryMessage(t.enterEmailInstruction);
});

sendRecoveryEmailBtn?.addEventListener("click", async () => {
  const t = getT();
  const email = recoveryEmailInput?.value.trim();

  if (!email) {
    setRecoveryMessage(t.enterEmailError);
    return;
  }

  setRecoveryMessage(t.sendingRecovery);

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?reset=true`
  });

  if (error) {
    setRecoveryMessage(error.message);
    return;
  }

  setRecoveryMessage(t.recoverySent);
});

const resetPasswordScreen = document.getElementById("resetPasswordScreen");
const newPasswordInput = document.getElementById("newPasswordInput");
const updatePasswordBtn = document.getElementById("updatePasswordBtn");
const resetPasswordMessage = document.getElementById("resetPasswordMessage");

function showResetPasswordScreen() {
  const t = getT();

  document.body.classList.add("is-logged-out");
  document.body.classList.remove("is-logged-in");

  if (authScreen) authScreen.hidden = true;
  if (landingHow) landingHow.hidden = true;
  if (mainApp) mainApp.hidden = false;
  if (logoutBtn) logoutBtn.hidden = true;
  if (resetPasswordScreen) resetPasswordScreen.hidden = false;
  if (resetPasswordMessage) resetPasswordMessage.textContent = t.createNewPassword;
}

const isReset =
  window.location.search.includes("reset=true") ||
  window.location.hash.includes("type=recovery");

if (isReset) showResetPasswordScreen();

supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") showResetPasswordScreen();
});

updatePasswordBtn?.addEventListener("click", async () => {
  const t = getT();
  const newPassword = newPasswordInput?.value.trim();

  if (!newPassword || newPassword.length < 6) {
    if (resetPasswordMessage) resetPasswordMessage.textContent = t.passwordTooShort;
    return;
  }

  if (resetPasswordMessage) resetPasswordMessage.textContent = t.savingPassword;

  const { error } = await supabase.auth.updateUser({
    password: newPassword
  });

  if (error) {
    if (resetPasswordMessage) resetPasswordMessage.textContent = error.message;
    return;
  }

  if (resetPasswordMessage) resetPasswordMessage.textContent = t.passwordUpdated;
  if (resetPasswordScreen) resetPasswordScreen.hidden = true;

  window.history.replaceState({}, document.title, window.location.origin);

  await checkAuth();
  showScreen(screenMain);
});

/* -----------------------------
   SCREEN / PROFILE
----------------------------- */

const TAB_BY_SCREEN = {
  "screen-home":            "home",
  "screen-flashcards":      "cards",
  "screen-video":           "video",
  "screen-speak-setup":     "speak",
  "screen-speak-practice":  "speak",
  "screen-speak-complete":  "speak",
  "screen-read-setup":      "read",
  "screen-read-reader":     "read",
  "screen-read-exercise":   "read",
  "screen-writing":         null,
  "screen-onboarding":      null,
  "screen-account":         null,
};

function isNativeCapacitorShell() {
  try {
    return !!window.Capacitor?.isNativePlatform?.();
  } catch {
    return !!window.Capacitor;
  }
}

function isAndroidCapacitorShell() {
  try {
    return isNativeCapacitorShell() && window.Capacitor?.getPlatform?.() === "android";
  } catch {
    return false;
  }
}

// The native apps have no "browser settings" — send users to the OS app
// settings instead. Web users go to the browser's site permissions.
function micBlockedMessage() {
  return isNativeCapacitorShell()
    ? "Microphone is blocked. Allow it for Magic Read in your phone's app settings, then try again."
    : "Microphone is blocked. Please allow mic access in your browser.";
}

function startNativeIntroSplash() {
  if (!isNativeCapacitorShell()) return;
  document.body.classList.add("is-native");
  const splash = document.getElementById("introSplash");
  if (!splash) return;
  splash.hidden = false;
  setTimeout(() => {
    splash.classList.add("fade");
    setTimeout(() => splash.remove(), 450);
  }, 1500);
}

function openVideoSurface(videoId = "") {
  // The video screen stays inside the app everywhere. In the native shells the
  // player iframe itself loads from the hosted origin (see mountYTPlayer), so
  // YouTube sees a real website and allows embedding — no need to navigate the
  // whole WebView to the hosted site anymore.
  showScreen(screenVideo);
  initVideoScreen();
  if (videoId) loadVideoById(videoId);
}

function showScreen(screen) {
  if (!screen) return;

  document.querySelectorAll(".app-screen").forEach(s => {
    s.classList.remove("active");
  });

  screen.classList.add("active");

  // Decks retry on every visit to the flashcards screen (no-op once loaded),
  // so one failed fetch on a flaky connection doesn't leave them empty forever.
  if (screen === screenFlashcards) {
    loadFlashcardsFromStorage().then(() => {
      renderDeckSelector();
      renderFlashcards();
    });
  }
  sessionStorage.setItem("activeScreenId", screen.id);
  document.body.classList.toggle("product-active", screen.id !== "screen-onboarding");
  document.body.classList.toggle("dashboard-active", screen.id === "screen-home");
  document.body.classList.toggle("video-active", screen.id === "screen-video");

  const appTabBar = document.getElementById("appTabBar");
  if (appTabBar) {
    appTabBar.hidden = screen.id === "screen-onboarding";
    const activeTab = screen.id === "screen-main"
      ? (appMode === "reading" ? "read" : "speak")
      : (TAB_BY_SCREEN[screen.id] ?? null);
    appTabBar.querySelectorAll(".sonic-tab").forEach(t =>
      t.classList.toggle("active", t.dataset.tab === activeTab)
    );
  }

  // Don't scroll the window when video is active — vid-scroll handles its own scrolling.
  if (screen.id !== "screen-video") {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

profileMenuBtn?.addEventListener("click", () => {
  renderAccountScreen();
  showScreen(screenAccount);
});

function renderAccountScreen() {
  supabase.auth.getUser().then(({ data }) => {
    const user = data?.user;
    const nameEl  = document.getElementById("acctName");
    const emailEl = document.getElementById("acctEmail");
    const avatarEl = document.getElementById("acctAvatar");
    const pillEl  = document.getElementById("acctPlanPill");
    const upgradeRow = document.getElementById("acctUpgradeRow");

    const name  = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "You";
    const email = user?.email || "";
    const initial = (name[0] || "?").toUpperCase();

    if (nameEl)   nameEl.textContent   = name;
    if (emailEl)  emailEl.textContent  = email;
    if (avatarEl) avatarEl.textContent = initial;

    if (pillEl) {
      const paidPro = isPaidProUser();
      if (paidPro) {
        const paidUntil = userPlan.planEndsAt
          ? new Date(userPlan.planEndsAt).toLocaleDateString()
          : null;
        pillEl.textContent = isLifetimeProUser() ? "Forever Pro" : (paidUntil ? `Pro · ${paidUntil}` : "Pro");
      } else if (userPlan.trialActive) {
        const days = trialDaysLeft();
        pillEl.textContent = `Pro trial · ${days} day${days === 1 ? "" : "s"} left`;
      } else {
        pillEl.textContent = getT().freePlanLabel;
      }
    }

    if (upgradeRow) {
      const isPro = isPaidProUser();
      upgradeRow.hidden = isPro;
    }

    const langLabel = document.getElementById("acctAppLangLabel");
    if (langLabel) {
      const uiLangEl = document.getElementById("uiLang");
      const langNames = { en: "English", ru: "Русский", zh: "中文", tr: "Türkçe", de: "Deutsch", es: "Español", fr: "Français", ja: "日本語" };
      langLabel.textContent = langNames[uiLangEl?.value] || "English";
    }
  });

  renderSubscriptionSection();
}

// Status-driven billing card: shows tier + dates and the right actions
// (upgrade / cancel / resume / extend) for the user's provider.
async function renderSubscriptionSection() {
  const card = document.getElementById("acctSubStatus");
  const upgradeRow = document.getElementById("acctUpgradeRow");
  const picker = document.getElementById("acctPlanPicker");
  if (!card) return;

  // Free / trial users: keep the buy flow, no status card.
  if (!isPaidProUser()) {
    card.hidden = true;
    return;
  }
  if (upgradeRow) upgradeRow.hidden = true;
  if (picker) picker.hidden = true;

  card.hidden = false;
  card.innerHTML = `<div class="acct-sub-loading">Loading subscription…</div>`;

  let s;
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/subscription-status`);
    s = await res.json();
    if (!res.ok) throw new Error(s?.error || "status failed");
  } catch {
    card.innerHTML = `<div class="acct-sub-title">Pro access active</div>
      <div class="acct-sub-line">For billing questions, email help@magicread.app.</div>`;
    return;
  }

  const fmt = (iso) => iso ? new Date(iso).toLocaleDateString() : null;
  const tierLabel = { monthly: "Monthly", annual: "Annual", lifetime: "Lifetime" }[s.tier] || "Pro";
  const purchased = fmt(s.purchasedAt);
  const periodEnd = fmt(s.currentPeriodEnd);

  const lines = [];
  if (purchased) lines.push(`<div class="acct-sub-line">Started <b>${purchased}</b></div>`);

  let actionsHtml = "";

  if (s.provider === "stripe") {
    if (s.tier === "lifetime") {
      lines.push(`<div class="acct-sub-line">Lifetime access — never expires.</div>`);
    } else if (s.cancelAtPeriodEnd) {
      if (periodEnd) lines.push(`<div class="acct-sub-line">Pro until <b>${periodEnd}</b> — won't renew.</div>`);
      actionsHtml = `<button class="plan-option acct-sub-act" data-sub-action="resume">Resume subscription</button>`;
    } else {
      if (periodEnd) lines.push(`<div class="acct-sub-line">Renews <b>${periodEnd}</b></div>`);
      const up = s.canUpgradeToAnnual
        ? `<button class="plan-option acct-sub-act" data-sub-action="upgrade-stripe">Upgrade to annual</button>` : "";
      actionsHtml = up + `<button class="plan-option acct-sub-secondary acct-sub-act" data-sub-action="cancel">Cancel subscription</button>`;
    }
  } else if (s.provider === "tbank") {
    if (periodEnd) lines.push(`<div class="acct-sub-line">Pro until <b>${periodEnd}</b> · Russian card / SBP · renews manually.</div>`);
    if (s.canUpgradeToAnnual) {
      actionsHtml = `<button class="plan-option acct-sub-act" data-sub-action="upgrade-tbank">Extend to annual — 5,000 ₽</button>`;
    }
  } else if (s.provider === "google_play") {
    if (periodEnd) lines.push(`<div class="acct-sub-line">Renews through Google Play on <b>${periodEnd}</b>.</div>`);
    lines.push(`<div class="acct-sub-line">Manage or cancel this subscription in Google Play.</div>`);
  } else {
    lines.push(`<div class="acct-sub-line">Your Pro access is active. For billing questions, email help@magicread.app.</div>`);
  }

  card.innerHTML = `
    <div class="acct-sub-head">
      <span class="acct-sub-title">Pro · ${tierLabel}</span>
    </div>
    ${lines.join("")}
    ${actionsHtml ? `<div class="acct-sub-actions">${actionsHtml}</div>` : ""}
  `;

  card.querySelectorAll("[data-sub-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleSubAction(btn.dataset.subAction, btn));
  });
}

async function handleSubAction(action, btn) {
  if (action === "upgrade-tbank") { startTbankCheckout("annual", btn); return; }

  if (action === "cancel") {
    const ok = await showConfirm("Cancel your subscription? You'll keep Pro until the end of your current billing period. No refund is issued for the remaining time.");
    if (!ok) return;
  }
  if (action === "upgrade-stripe") {
    const ok = await showConfirm("Switch to the annual plan now? You'll be charged the annual price (prorated for time already paid) and save vs. monthly.");
    if (!ok) return;
  }

  const endpoint = {
    "upgrade-stripe": "/api/upgrade-to-annual",
    "cancel": "/api/cancel-subscription",
    "resume": "/api/resume-subscription"
  }[action];
  if (!endpoint) return;

  btn.disabled = true;
  try {
    const res = await fetchWithAuth(`${API_BASE}${endpoint}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) { showToast(data?.error || "Something went wrong. Try again.", "error"); return; }
    const messages = {
      "upgrade-stripe": "You're now on the annual plan.",
      "cancel": "Subscription canceled. Pro stays active until your period ends.",
      "resume": "Subscription resumed — it will renew as normal."
    };
    showToast(messages[action], "success");
    await fetchMyPlan();
    renderSubscriptionSection();
  } catch {
    showToast("Something went wrong. Try again.", "error");
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("acctBackBtn")?.addEventListener("click", () => {
  showScreen(screenMain);
});

async function loadRecentProgress() {
  const resumeEl    = document.getElementById("homeResume");
  const resumeLabel = resumeEl?.querySelector(".hd-resume-label");
  const resumeTitle = document.getElementById("homeResumeTitle");
  if (!resumeEl) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { resumeEl.hidden = true; return; }

  const { data, error } = await supabase
    .from("user_progress")
    .select("*")
    .eq("user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) { resumeEl.hidden = true; return; }

  _resumeProgress = data;
  const _t = getT();
  const activityLabels = { reading: _t.continueReading, speaking: _t.continueSpeaking, flashcards: _t.continueCards, video: _t.continueVideo };
  if (resumeLabel) resumeLabel.textContent = activityLabels[data.activity] || _t.continue;
  if (resumeTitle) resumeTitle.textContent = data.title || "Untitled";
  resumeEl.hidden = false;
}

async function loadVideoHistory() {
  const wrap = document.getElementById("homeVideoHistory");
  const list = document.getElementById("homeVideoHistoryList");
  if (!wrap || !list) return;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { wrap.hidden = true; return; }

  const { data, error } = await supabase
    .from("user_progress")
    .select("item_id, title, updated_at")
    .eq("user_id", user.id)
    .eq("activity", "video")
    .order("updated_at", { ascending: false })
    .limit(8);

  if (error || !data?.length) { wrap.hidden = true; return; }

  // Deduplicate by video id (keep most recent)
  const seen = new Set();
  const videos = data.filter(r => {
    if (seen.has(r.item_id)) return false;
    seen.add(r.item_id);
    return true;
  });

  list.innerHTML = videos.map(r => {
    const thumb = `https://img.youtube.com/vi/${encodeURIComponent(r.item_id)}/mqdefault.jpg`;
    const label = r.title?.replace(/^YouTube:\s*/i, "") || r.item_id;
    return `
      <button class="hd-video-item" type="button" data-video-id="${escapeHtml(r.item_id)}">
        <img class="hd-video-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy">
        <div class="hd-video-label">${escapeHtml(label)}</div>
      </button>`;
  }).join("");

  list.querySelectorAll(".hd-video-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.videoId;
      showScreen(screenVideo);
      initVideoScreen();
      loadVideoById(id);
    });
  });

  wrap.hidden = false;
}

function renderHomeScreen() {
  supabase.auth.getUser().then(({ data }) => {
    const user = data?.user;
    const name = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "there";
    const initial = (name[0] || "?").toUpperCase();

    const nameEl   = document.getElementById("homeName");
    const avatarEl = document.getElementById("homeAvatar");
    const badgeEl  = document.getElementById("homePlanBadge");

    if (nameEl)   nameEl.textContent   = `${getT().helloName}, ${name}`;
    if (avatarEl) avatarEl.textContent = initial;

    if (badgeEl) {
      const paidPro = isPaidProUser();
      if (paidPro) {
        badgeEl.textContent = isLifetimeProUser() ? getT().foreverPro : "Pro";
        badgeEl.dataset.variant = "pro";
      } else if (userPlan.trialActive) {
        const days = trialDaysLeft();
        badgeEl.textContent = getT().proTrialDaysLeft.replace("{n}", days);
        badgeEl.dataset.variant = "trial";
      } else {
        badgeEl.textContent = getT().freePlanLabel;
        delete badgeEl.dataset.variant;
      }
      badgeEl.hidden = false;
    }
  });

  // Streak
  const streak = userPlan.currentStreak || 0;
  const streakN = document.getElementById("homeStreakN");
  if (streakN) streakN.textContent = getT().dayStreak.replace("{n}", streak);

  const dotsEl = document.getElementById("homeStreakDots");
  if (dotsEl) {
    const on = Math.min(streak, 7);
    dotsEl.innerHTML =
      Array(7 - on).fill('<span class="hd-day"></span>').join("") +
      Array(on).fill('<span class="hd-day hd-day-on"></span>').join("");
  }

  // Stat tiles
  const fmt = n => Number(n || 0).toLocaleString();
  const readEl      = document.getElementById("homeStatRead");
  const spokenEl    = document.getElementById("homeStatSpoken");
  const practicedEl = document.getElementById("homeStatPracticed");
  if (readEl)      readEl.textContent      = fmt(userPlan.wordsRead);
  if (spokenEl)    spokenEl.textContent    = fmt(userPlan.wordsSpoken);
  if (practicedEl) practicedEl.textContent = fmt(userPlan.wordsPracticed);

  syncHomeLangControls();
  loadRecentProgress();
  loadVideoHistory();
}

document.getElementById("acctUpgradeRow")?.addEventListener("click", () => {
  const picker = document.getElementById("acctPlanPicker");
  if (picker) picker.hidden = !picker.hidden;
});

// Subscription management lives in the status card rendered by
// renderSubscriptionSection() (see above); the old single "Manage subscription"
// row / Stripe-portal handler was replaced by it.

document.getElementById("acctSavedWordsBtn")?.addEventListener("click", () => {
  showScreen(screenFlashcards);
  renderDeckSelector();
  renderFlashcards();
});

document.getElementById("acctAppLanguageBtn")?.addEventListener("click", () => {
  const picker = document.getElementById("acctLangPicker");
  if (!picker) return;
  picker.hidden = !picker.hidden;
});

document.getElementById("acctTutorialBtn")?.addEventListener("click", () => {
  showTourScreen(() => {
    renderAccountScreen();
    showScreen(screenAccount);
  });
});

const langNames = { en: "English", ru: "Русский", zh: "中文", tr: "Türkçe", de: "Deutsch", es: "Español", fr: "Français", ja: "日本語" };

document.querySelectorAll(".acct-lang-opt").forEach(btn => {
  btn.addEventListener("click", () => {
    const lang = btn.dataset.lang;
    applyLocalization(lang);
    const uiLangEl = document.getElementById("uiLang");
    if (uiLangEl) uiLangEl.value = lang;
    const label = document.getElementById("acctAppLangLabel");
    if (label) label.textContent = langNames[lang] || lang;
    // mark active
    document.querySelectorAll(".acct-lang-opt").forEach(b => b.classList.toggle("active", b.dataset.lang === lang));
    document.getElementById("acctLangPicker").hidden = true;
  });
});

// Sync label and active state on load
(function syncLangPickerLabel() {
  const saved = localStorage.getItem("magicread_ui_lang") || "en";
  const label = document.getElementById("acctAppLangLabel");
  if (label) label.textContent = langNames[saved] || "English";
  document.querySelectorAll(".acct-lang-opt").forEach(b => b.classList.toggle("active", b.dataset.lang === saved));
})();

document.getElementById("acctAboutBtn")?.addEventListener("click", () => {
  showToast("Magic Read — Phase 1.", "info");
});

document.getElementById("acctHelpBtn")?.addEventListener("click", () => {
  showToast("Email us at help@magicread.app for support.", "info");
});

document.getElementById("acctDeleteAccountBtn")?.addEventListener("click", async () => {
  const t = getT();
  const firstConfirm = await showConfirm(
    t.deleteAccountConfirm ||
    "Delete your Magic Read account and saved learning data? If you have an active subscription, please cancel it separately in Stripe or Google Play."
  );
  if (!firstConfirm) return;

  const finalConfirm = await showConfirm(
    t.deleteAccountFinalConfirm ||
    "This cannot be undone. Permanently delete your account now?"
  );
  if (!finalConfirm) return;

  try {
    const res = await fetchWithAuth(`${API_BASE}/api/delete-account`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Could not delete account.");

    await supabase.auth.signOut();
    await checkAuth();
    showLandingPage();
    showToast(t.deleteAccountDone || "Your account has been deleted.", "success");
  } catch (error) {
    console.error("Delete account error:", error);
    showToast(error.message || t.deleteAccountError || "Could not delete account. Please contact support.", "error");
  }
});

document.getElementById("acctLogoutBtn")?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  await checkAuth();
  showLandingPage();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".profile-menu") && profileDropdown) {
    profileDropdown.hidden = true;
    const picker = document.getElementById("planPicker");
    if (picker) picker.hidden = true;
  }
});

document.querySelectorAll("[data-tool-screen]").forEach(btn => {
  btn.addEventListener("click", () => {
    const screen = btn.dataset.toolScreen;

    if (profileDropdown) profileDropdown.hidden = true;

    if (screen === "flashcards") {
      showScreen(screenFlashcards);
      renderDeckSelector();
      renderFlashcards();
    }

    if (screen === "calligraphy") {
      showScreen(screenWriting);
    }
  });
});

// Home dashboard action tile clicks
document.querySelectorAll("[data-hd-target]").forEach(btn => {
  btn.addEventListener("click", async () => {
    const target = btn.dataset.hdTarget;
    if (target === "read") {
      appMode = "reading";
      openReadSetup();
    } else if (target === "speak") {
      appMode = "pronunciation";
      showScreen(screenSpeakSetup);
    } else if (target === "cards") {
      showScreen(screenFlashcards);
      renderDeckSelector();
      renderFlashcards();
    } else if (target === "write") {
      showScreen(screenWriting);
    } else if (target === "video") {
      openVideoSurface();
    } else if (target === "tour") {
      showTourScreen(() => showScreen(screenHome));
    }
  });
});

document.getElementById("homeResume")?.addEventListener("click", async () => {
  if (!_resumeProgress) { showScreen(screenMain); return; }
  const { activity, item_id, position } = _resumeProgress;

  if (activity === "video") {
    openVideoSurface(item_id);
    return;
  }

  if (activity === "flashcards") {
    currentDeckId = item_id;
    currentFlashcardIndex = position?.card ?? 0;
    renderDeckSelector();
    renderFlashcards();
    showScreen(screenFlashcards);
    return;
  }

  showMagicLoadingOverlay();
  try {
    await activateReaderMode(activity === "reading" ? "reading" : "pronunciation");
    if (item_id.startsWith("lib_")) {
      await loadLibraryText(item_id.slice(4));
    } else {
      const { data: saved } = await supabase.from("saved_texts").select("*").eq("id", item_id).single();
      if (saved) {
        if (saved.source_lang) sourceLangSelect.value = saved.source_lang;
        if (saved.target_lang) targetLangSelect.value = saved.target_lang;
        updateLanguageBasedUI();
        await startReadingFromText(saved.text || "");
      }
    }
    const sentenceIdx = position?.sentence ?? 0;
    if (activity === "speaking") {
      // startReadingFromText already launched the spotlight — jump to the saved sentence.
      if (sentenceIdx > 0 && sentenceIdx < spState.sentences.length) {
        spState.idx = sentenceIdx;
        spState.phase = "idle";
        spRenderPractice();
      }
    } else {
      // Reading already launched the reader screen — highlight the saved sentence.
      if (sentenceIdx > 0 && sentenceIdx < R.sentences.length) {
        R.idx = sentenceIdx;
        rdUpdateDock();
        rdUpdateHighlight();
      }
    }
  } finally {
    hideMagicLoadingOverlay();
  }
});

// Bottom tab bar navigation
document.querySelectorAll(".sonic-tab").forEach(tab => {
  tab.addEventListener("click", async () => {
    const t = tab.dataset.tab;
    if (t === "home") {
      renderHomeScreen();
      showScreen(screenHome);
    } else if (t === "read") {
      appMode = "reading";
      openReadSetup();
    } else if (t === "speak") {
      appMode = "pronunciation";
      showScreen(screenSpeakSetup);
    } else if (t === "cards") {
      showScreen(screenFlashcards);
      renderDeckSelector();
      renderFlashcards();
    } else if (t === "video") {
      openVideoSurface();
    }
  });
});

  const backToReaderBtn = document.getElementById("backToReaderBtn");
  const backToReaderBtnWriting = document.getElementById("backToReaderBtnWriting");

  backToReaderBtn?.addEventListener("click", goHome);
  backToReaderBtnWriting?.addEventListener("click", goHome);

  document.querySelector(".brand")?.addEventListener("click", (e) => {
    e.preventDefault();
    stopAllTTS();
    stopRecognition();
    document.body.classList.remove("auth-active");
    if (authScreen) authScreen.hidden = true;
    goHome();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

/* -----------------------------
   ONBOARDING
----------------------------- */

const onboardingStepA = document.getElementById("onboarding-step-a");
const onboardingSourceLangEl = document.getElementById("onboardingSourceLang");
const onboardingTargetLangEl = document.getElementById("onboardingTargetLang");
const homeBackBtn = document.getElementById("homeBackBtn");

let appMode = "pronunciation";
let pendingMode = "pronunciation";

function updateModeCopy() {
  const heading = document.querySelector("#startComposerArea .start-copy h1");
  const hint = document.querySelector("#startComposerArea .start-copy .subtle");
  const copy = getModeCopy(appMode, getT());

  if (heading) heading.textContent = copy.title;
  if (hint) hint.textContent = copy.hint;
  if (createBtn) createBtn.textContent = copy.action;
}

async function activateReaderMode(mode) {
  appMode = mode === "reading" ? "reading" : "pronunciation";
  pendingMode = appMode;
  updateModeCopy();

  // Both modes now use the composer as their setup screen; the actual
  // experience launches on its own screen ("Start reading"/"Start speaking").
  if (startComposerArea) startComposerArea.hidden = false;
  if (inputText) inputText.hidden = false;

  applyMode();
}

function syncOnboardingToMain() {
  if (onboardingSourceLangEl && sourceLangSelect) {
    sourceLangSelect.value = onboardingSourceLangEl.value;
    sourceLangSelect.dispatchEvent(new Event("change"));
  }
  if (onboardingTargetLangEl && targetLangSelect) {
    targetLangSelect.value = onboardingTargetLangEl.value;
  }
}

function syncMainToOnboarding() {
  if (onboardingSourceLangEl && sourceLangSelect) {
    onboardingSourceLangEl.value = sourceLangSelect.value;
  }
  if (onboardingTargetLangEl && targetLangSelect) {
    onboardingTargetLangEl.value = targetLangSelect.value;
  }
}

function showOnboardingStepA() {
  if (onboardingStepA) onboardingStepA.hidden = false;
  const trialStep = document.getElementById("onboarding-step-trial");
  if (trialStep) trialStep.hidden = true;
  sessionStorage.setItem("onboardingStep", "a");
  syncMainToOnboarding();
  showScreen(screenOnboarding);
}

function showOnboardingStepTrial() {
  if (onboardingStepA) onboardingStepA.hidden = true;
  const trialStep = document.getElementById("onboarding-step-trial");
  if (trialStep) trialStep.hidden = false;
  sessionStorage.setItem("onboardingStep", "trial");
  showScreen(screenOnboarding);
}

// Captured at startup: checkAuth() may route to home (writing a new
// activeScreenId) before DOMContentLoaded, so the live sessionStorage value
// is unreliable by the time restoreActiveScreen runs.
const initialScreenId = sessionStorage.getItem("activeScreenId");

// On reload, stay on the screen the user was last viewing instead of jumping home.
// Only called for signed-in users — logged-out visitors stay on the landing page.
function restoreActiveScreen() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("appScreen") === "video") {
    showScreen(screenVideo);
    initVideoScreen();
    const videoId = params.get("videoId");
    if (videoId) {
      const input = document.getElementById("vidUrlInput");
      if (input) input.value = `https://www.youtube.com/watch?v=${videoId}`;
      loadVideoById(videoId);
    }
    return;
  }

  const savedId = initialScreenId;
  if (!savedId) return; // fresh visit — checkAuth already routed to home

  const target = document.getElementById(savedId);

  if (!target || savedId === "screen-onboarding") {
    if (sessionStorage.getItem("onboardingStep") === "trial") {
      showOnboardingStepTrial();
    } else {
      showOnboardingStepA();
    }
    return;
  }

  // Speak screens hold no persisted text after a reload — back to speak setup.
  if (savedId === "screen-speak-setup" || savedId === "screen-speak-practice" || savedId === "screen-speak-complete") {
    appMode = "pronunciation";
    showScreen(screenSpeakSetup);
    return;
  }

  // Reader screens likewise hold no persisted passage after a reload.
  if (savedId === "screen-read-setup" || savedId === "screen-read-reader" || savedId === "screen-read-exercise") {
    appMode = "reading";
    openReadSetup();
    return;
  }

  if (savedId === "screen-home") renderHomeScreen();
  if (savedId === "screen-main") {
    updateModeCopy();
    applyMode();
  }
  showScreen(target);
}

function goHome() {
  showScreen(screenMain);
}

function showLandingPage() {
  document.querySelectorAll(".app-screen").forEach(s => s.classList.remove("active"));
  document.body.classList.remove("product-active", "dashboard-active", "video-active", "auth-active");
  sessionStorage.removeItem("activeScreenId");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.getElementById("onboardingContinueBtn")?.addEventListener("click", () => {
  syncOnboardingToMain();
  showOnboardingStepTrial();
});

document.getElementById("onboardingStartBtn")?.addEventListener("click", () => {
  if (document.body.classList.contains("is-logged-in")) {
    maybeShowTour(() => {
      renderHomeScreen();
      showScreen(screenHome);
    });
    return;
  }
  openAuthFromOverlay("signup");
});

document.getElementById("heroCtaBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("signup");
});

document.getElementById("finalCtaBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("signup");
});

// Landing pricing cards — visitors need an account first either way.
document.getElementById("pricingFreeBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("signup");
});
document.getElementById("pricingProBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("signup");
});

// In the native shells OAuth must round-trip through the system browser and
// come back via the magicread:// deep link — the app's internal origin
// (https://localhost) is unreachable from the browser.
const OAUTH_DEEP_LINK = "magicread://auth-callback";
let googleSignInConfigPromise = null;

function getGoogleAuthPlugin() {
  return window.Capacitor?.Plugins?.GoogleAuth || null;
}

async function getGoogleSignInConfig() {
  if (!googleSignInConfigPromise) {
    googleSignInConfigPromise = withTimeout(
      fetch(`${API_BASE}/api/auth/google-config`),
      10000,
      "Could not load Google Sign-In configuration."
    )
      .then((res) => res.ok ? res.json() : {})
      .catch(() => ({}));
  }
  return googleSignInConfigPromise;
}

async function signInWithNativeGoogle() {
  const googleAuth = getGoogleAuthPlugin();
  if (!googleAuth) {
    throw new Error("Native Google Sign-In is not available.");
  }

  const { webClientId } = await getGoogleSignInConfig();
  if (!webClientId) {
    throw new Error("Google Sign-In is not configured.");
  }

  const credential = await withTimeout(
    googleAuth.signIn({ serverClientId: webClientId }),
    30000,
    "Google Sign-In timed out."
  );
  if (!credential?.idToken) {
    throw new Error("Google Sign-In did not return an ID token.");
  }

  const { error } = await withTimeout(
    supabase.auth.signInWithIdToken({
      provider: "google",
      token: credential.idToken
    }),
    15000,
    "Google Sign-In reached Google but could not create an app session."
  );
  if (error) throw error;
  await checkAuth();
}

function friendlyGoogleSignInError(error) {
  const message = error?.message || String(error || "");
  const code = error?.code || "";
  if (/cancel/i.test(message) || /cancel/i.test(code)) {
    return "Google Sign-In was canceled. If you did not cancel it, check that the Android OAuth client uses package com.magicread.app and the Play App Signing SHA-1.";
  }
  if (/configured|client|audience|oauth|token/i.test(message)) {
    return `${message} Check the Web client ID in Render and the Android OAuth client SHA-1 in Google Cloud.`;
  }
  return message || "Google Sign-In failed.";
}

document.getElementById("googleAuthBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("googleAuthBtn");
  const original = btn?.innerHTML;
  if (btn) btn.disabled = true;
  if (authMessage) authMessage.textContent = getT().loggingIn || "Logging in...";

  try {
    if (isAndroidCapacitorShell()) {
      await signInWithNativeGoogle();
      return;
    }

    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: isNativeCapacitorShell() ? OAUTH_DEEP_LINK : window.location.origin
      }
    });
  } catch (error) {
    console.error("[Auth] Google sign-in failed:", error);
    const friendlyMessage = friendlyGoogleSignInError(error);
    showToast(friendlyMessage, "error");
    if (authMessage) authMessage.textContent = friendlyMessage;
  } finally {
    if (btn) {
      btn.disabled = false;
      if (original) btn.innerHTML = original;
    }
  }
});

// Native deep-link return: parse the tokens Supabase appended to the
// magicread:// URL and finish the session in the app.
// While the keyboard is open the viewport is small — hide the bottom tab bar
// (otherwise it rides up above the keyboard and covers half the visible app).
window.Capacitor?.Plugins?.Keyboard?.addListener?.("keyboardWillShow", () => {
  document.body.classList.add("kb-open");
});
window.Capacitor?.Plugins?.Keyboard?.addListener?.("keyboardWillHide", () => {
  document.body.classList.remove("kb-open");
});

window.Capacitor?.Plugins?.App?.addListener("appUrlOpen", async ({ url }) => {
  if (!url || !url.startsWith(OAUTH_DEEP_LINK)) return;
  try {
    const frag = url.includes("#") ? url.split("#")[1] : (url.split("?")[1] || "");
    const params = new URLSearchParams(frag);
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (access_token && refresh_token) {
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) throw error;
      await checkAuth();
      return;
    }
    // PKCE-style return (?code=...) — exchange it if that flow is ever enabled.
    const code = params.get("code");
    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      await checkAuth();
    }
  } catch (err) {
    console.error("[Auth] deep link sign-in failed:", err);
    showToast("Sign-in didn't complete. Please try again.", "error");
  }
});

/* -----------------------------
   FEATURE TOUR (onboarding carousel) + NATIVE INTRO SPLASH
----------------------------- */

const TOUR_SLIDE_COUNT = 11;
const TOUR_SEEN_KEY = "magicread_tour_seen";

function tourSlidesHTML() {
  let html = "";
  for (let i = 1; i <= TOUR_SLIDE_COUNT; i++) {
    const n = String(i).padStart(2, "0");
    html += `<figure class="tour-slide">
      <img src="img/onboarding/slide-${n}.webp" alt="" loading="lazy">
      <figcaption data-i18n="tourCap${i}"></figcaption>
    </figure>`;
  }
  return html;
}

// Shared slide/dot carousel. Returns { goTo, index() }.
function initTourCarousel(track, dots, { onIndexChange = null, autoplayMs = 0 } = {}) {
  if (!track) return null;
  track.innerHTML = tourSlidesHTML();
  applyLocalization(localStorage.getItem("magicread_ui_lang") || "en");

  if (dots) {
    dots.innerHTML = Array.from({ length: TOUR_SLIDE_COUNT }, (_, i) =>
      `<button class="tour-dot${i === 0 ? " on" : ""}" data-dot="${i}" type="button" aria-label="Slide ${i + 1}"></button>`).join("");
  }

  let idx = 0;
  const slideW = () => track.clientWidth;
  const goTo = (i, smooth = true) => {
    idx = Math.max(0, Math.min(TOUR_SLIDE_COUNT - 1, i));
    track.scrollTo({ left: idx * slideW(), behavior: smooth ? "smooth" : "auto" });
    update();
  };
  const syncFromScroll = () => {
    const i = Math.round(track.scrollLeft / Math.max(1, slideW()));
    if (i !== idx) { idx = i; update(); }
  };
  const update = () => {
    dots?.querySelectorAll(".tour-dot").forEach((d, i) => d.classList.toggle("on", i === idx));
    if (onIndexChange) onIndexChange(idx);
  };

  track.addEventListener("scroll", () => { syncFromScroll(); }, { passive: true });
  dots?.querySelectorAll(".tour-dot").forEach(d =>
    d.addEventListener("click", () => { goTo(Number(d.dataset.dot)); }));

  let timer = null;
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
  if (autoplayMs) {
    timer = setInterval(() => goTo((idx + 1) % TOUR_SLIDE_COUNT), autoplayMs);
    ["pointerenter", "touchstart", "pointerdown"].forEach(ev =>
      track.addEventListener(ev, stop, { passive: true }));
  }

  update();
  return { goTo, index: () => idx };
}

let _tourCarousel = null;
function showTourScreen(onDone) {
  const screen = document.getElementById("screen-tour");
  const nextBtn = document.getElementById("tourNextBtn");
  if (!screen || !nextBtn) { onDone(); return; }

  const finish = () => {
    localStorage.setItem(TOUR_SEEN_KEY, "1");
    onDone();
  };

  _tourCarousel = initTourCarousel(
    document.getElementById("tourTrack"),
    document.getElementById("tourDots"),
    { onIndexChange: (i) => {
        const t = getT();
        nextBtn.textContent = i >= TOUR_SLIDE_COUNT - 1 ? t.tourDone : t.next;
      } }
  );

  nextBtn.onclick = () => {
    if (_tourCarousel.index() >= TOUR_SLIDE_COUNT - 1) finish();
    else _tourCarousel.goTo(_tourCarousel.index() + 1);
  };
  document.getElementById("tourSkipBtn").onclick = finish;

  showScreen(screen);
}

// Native only: first-ever arrival at the dashboard shows the feature tour once.
function maybeShowTour(next) {
  if (!isNativeCapacitorShell() || localStorage.getItem(TOUR_SEEN_KEY)) { next(); return; }
  showTourScreen(next);
}

// Landing carousel (web) — autoplay, pauses on interaction.
(() => {
  const track = document.getElementById("landingTourTrack");
  if (!track) return;
  const c = initTourCarousel(track, document.getElementById("landingTourDots"), { autoplayMs: 4000 });
  document.getElementById("landingTourPrev")?.addEventListener("click", () => c.goTo(c.index() - 1));
  document.getElementById("landingTourNext")?.addEventListener("click", () => c.goTo(c.index() + 1));
})();

/* -----------------------------
   READER MODE (pronunciation vs reading)
----------------------------- */

// Toggle which parts of the reader are visible for the active mode.
// Pronunciation: practice cards only, no full text, no exercise.
// Reading: full text + fill-the-gap exercise, no pronunciation cards.
function applyMode() {
  const cardsSection = document.getElementById("cardsSection");
  const readingExercise = document.getElementById("readingExercise");
  const wordOrderExercise = document.getElementById("wordOrderExercise");
  const hasText = !!(currentSentences && currentSentences.length);

  // Both modes use the composer as setup; practice/reading happen on dedicated
  // screens, so the in-page reader panels stay hidden on #screen-main.
  if (cardsSection) cardsSection.hidden = true;
  if (readingExercise) readingExercise.hidden = true;
  if (fullTextPanel) fullTextPanel.hidden = true;
  if (wordOrderExercise) wordOrderExercise.hidden = true;
}

/* -----------------------------
   READING EXERCISE (cloze / fill the gaps)
----------------------------- */

const SPACE_LANGS = ["en", "ru", "de", "es", "fr", "tr"];
const MAX_CLOZE_SENTENCES = 10;
const OPTIONS_PER_BLANK = 4;

// Lowercase and strip surrounding punctuation so "Library," matches "library".
function normalizeWord(w) {
  return String(w || "").toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

// Spaced-language options are shown lowercased so the answer's capitalisation
// (e.g. at the start of a sentence) doesn't give it away.
function displayWord(word, isSpaced) {
  return isSpaced ? normalizeWord(word) : String(word || "").trim();
}

function clozeShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every word the learner has saved to any flashcard deck.
function getSavedVocabWords() {
  const words = new Set();
  (flashcardDecks || []).forEach(deck => {
    (deck.cards || []).forEach(card => {
      if (card && card.word) words.add(String(card.word).trim());
    });
  });
  return [...words].filter(Boolean);
}

// Choose one word to hide in a space-separated sentence and return the pieces
// around it. If savedNorm is provided, only saved vocab is eligible; otherwise
// (fallback) the longest content word is used.
function pickSpacedBlank(sentence, savedNorm) {
  const tokens = sentence.split(/(\s+)/);
  const candidates = [];
  tokens.forEach((tok, i) => {
    if (/^\s*$/.test(tok)) return;
    const norm = normalizeWord(tok);
    if (!norm) return;
    if (savedNorm) {
      if (savedNorm.has(norm)) candidates.push({ i, len: norm.length });
    } else if (norm.length >= 5) {
      candidates.push({ i, len: norm.length });
    }
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.len - a.len);

  const idx = candidates[0].i;
  const tok = tokens[idx];
  // Keep punctuation around the word (e.g. "library," -> ____ ,)
  const m = tok.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}].*?[\p{L}\p{N}]|[\p{L}\p{N}])([^\p{L}\p{N}]*)$/u);
  const prefix = m ? m[1] : "";
  const answer = m ? m[2] : tok;
  const suffix = m ? m[3] : "";

  return {
    before: tokens.slice(0, idx).join("") + prefix,
    answer,
    after: suffix + tokens.slice(idx + 1).join("")
  };
}

// Choose one word to hide in a non-spaced sentence (Chinese / Japanese). Saved
// vocab is matched as a substring; the fallback uses cached segmentation.
function pickUnspacedBlank(sentence, savedRaw) {
  let word = null;

  if (savedRaw && savedRaw.length) {
    const matches = savedRaw
      .filter(w => w && sentence.includes(w))
      .sort((a, b) => b.length - a.length);
    if (matches.length) word = matches[0];
  } else {
    const seg = segmentCache.get(sentence) || [];
    const candidates = seg
      .map(s => s.word)
      .filter(w => w && w.length >= 2 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(w))
      .sort((a, b) => b.length - a.length);
    if (candidates.length) word = candidates[0];
  }

  if (!word) return null;
  const idx = sentence.indexOf(word);
  if (idx < 0) return null;

  return {
    before: sentence.slice(0, idx),
    answer: word,
    after: sentence.slice(idx + word.length)
  };
}

// Pool of plausible wrong answers: saved vocab + the other blanks' answers +
// other content words from the same text.
function buildDistractorPool(items, savedRaw, isSpaced, sentences) {
  const pool = [];
  const add = w => { const d = displayWord(w, isSpaced); if (d) pool.push(d); };

  savedRaw.forEach(add);
  items.forEach(it => add(it.answer));

  if (isSpaced) {
    sentences.forEach(s => s.split(/\s+/).forEach(tok => {
      const n = normalizeWord(tok);
      if (n.length >= 4) pool.push(n);
    }));
  } else {
    sentences.forEach(s => (segmentCache.get(s) || []).forEach(seg => {
      if (seg.word && seg.word.length >= 2 &&
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(seg.word)) {
        pool.push(seg.word);
      }
    }));
  }
  return pool;
}

// Correct answer + up to 3 distinct distractors, shuffled.
function buildOptions(answerDisp, pool, isSpaced) {
  const seen = new Set([normalizeWord(answerDisp)]);
  const distractors = [];
  for (const w of clozeShuffle(pool)) {
    const disp = displayWord(w, isSpaced);
    const key = normalizeWord(disp);
    if (!disp || seen.has(key)) continue;
    seen.add(key);
    distractors.push(disp);
    if (distractors.length >= OPTIONS_PER_BLANK - 1) break;
  }
  return clozeShuffle([answerDisp, ...distractors]);
}

function renderClozeItem(item, i, isSpaced, pool) {
  const answerDisp = displayWord(item.answer, isSpaced);
  const options = buildOptions(answerDisp, pool, isSpaced);
  const optionsHtml = options.map(opt =>
    `<button type="button" class="cloze-option" data-blank="${i}" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</button>`
  ).join("");

  return `<div class="cloze-item">
    <p class="cloze-sentence">${escapeHtml(item.before)}<span class="cloze-slot" id="clozeSlot-${i}" data-blank="${i}" data-answer="${escapeHtml(answerDisp)}">____</span>${escapeHtml(item.after)}</p>
    <div class="cloze-options">${optionsHtml}</div>
  </div>`;
}

async function buildClozeExercise(sentences) {
  const body = document.getElementById("exerciseBody");
  const score = document.getElementById("exerciseScore");
  if (!body) return;

  body.innerHTML = "";
  if (score) { score.hidden = true; score.textContent = ""; score.classList.remove("all-correct"); }

  const isSpaced = SPACE_LANGS.includes(sourceLangSelect.value);
  const savedRaw = getSavedVocabWords();
  const savedNorm = new Set(savedRaw.map(normalizeWord).filter(Boolean));

  const pickBlank = (sentence, useSaved) =>
    isSpaced
      ? pickSpacedBlank(sentence, useSaved ? savedNorm : null)
      : pickUnspacedBlank(sentence, useSaved ? savedRaw : null);

  // Pass 1: hide saved / key vocabulary.
  const items = [];
  let usedSavedVocab = false;
  for (const sentence of sentences) {
    if (items.length >= MAX_CLOZE_SENTENCES) break;
    const it = pickBlank(sentence, true);
    if (it) { items.push(it); usedSavedVocab = true; }
  }

  // Pass 2 (fallback): no saved-vocab matches — hide content words instead.
  if (!items.length) {
    for (const sentence of sentences) {
      if (items.length >= MAX_CLOZE_SENTENCES) break;
      const it = pickBlank(sentence, false);
      if (it) items.push(it);
    }
  }

  if (!items.length) {
    body.innerHTML = `<p class="exercise-empty">${escapeHtml(getClozeEmptyMessage())}</p>`;
    setExerciseControlsEnabled(false);
    return;
  }

  const pool = buildDistractorPool(items, savedRaw, isSpaced, sentences);
  setExerciseControlsEnabled(true);

  const note = usedSavedVocab
    ? `<p class="exercise-note" data-i18n="exerciseSavedNote">Gaps use words you've saved to flashcards.</p>`
    : `<p class="exercise-note" data-i18n="exerciseKeyNote">Save words from this text to flashcards to make this quiz about your vocabulary.</p>`;
  body.innerHTML = note + items.map((it, i) => renderClozeItem(it, i, isSpaced, pool)).join("");
}

function getClozeEmptyMessage() {
  const t = getT();
  return t.exerciseEmpty || "Save a few words from this text to flashcards, then reopen Reading — we'll quiz you on them.";
}

function setExerciseControlsEnabled(enabled) {
  const check = document.getElementById("exerciseCheckBtn");
  const reveal = document.getElementById("exerciseRevealBtn");
  [check, reveal].forEach(btn => { if (btn) btn.disabled = !enabled; });
}

// Pick an option: fill its slot and highlight the chosen button.
function onClozeOptionClick(e) {
  const opt = e.target.closest(".cloze-option");
  if (!opt) return;
  const slot = document.getElementById(`clozeSlot-${opt.dataset.blank}`);
  opt.parentElement.querySelectorAll(".cloze-option").forEach(b =>
    b.classList.remove("selected", "option-correct", "option-wrong"));
  opt.classList.add("selected");
  if (slot) {
    slot.textContent = opt.dataset.value;
    slot.dataset.selected = opt.dataset.value;
    slot.classList.remove("cloze-correct", "cloze-wrong");
  }
}

function checkCloze() {
  const slots = document.querySelectorAll("#exerciseBody .cloze-slot");
  if (!slots.length) return;
  let correct = 0;

  slots.forEach(slot => {
    const answer = slot.dataset.answer || "";
    const selected = slot.dataset.selected;
    const ok = selected != null && normalizeWord(selected) === normalizeWord(answer);
    slot.classList.toggle("cloze-correct", ok);
    slot.classList.toggle("cloze-wrong", !ok);
    if (ok) correct++;

    const item = slot.closest(".cloze-item");
    item?.querySelectorAll(".cloze-option").forEach(b => {
      const isAnswer = normalizeWord(b.dataset.value) === normalizeWord(answer);
      b.classList.toggle("option-correct", isAnswer);
      b.classList.toggle("option-wrong", b.classList.contains("selected") && !isAnswer);
    });
  });

  const score = document.getElementById("exerciseScore");
  if (score) {
    score.hidden = false;
    score.textContent = `${correct} / ${slots.length}`;
    score.classList.toggle("all-correct", correct === slots.length);
  }
  if (correct === slots.length && typeof rdOnClozeComplete === "function") rdOnClozeComplete();
}

function revealCloze() {
  document.querySelectorAll("#exerciseBody .cloze-item").forEach(item => {
    const slot = item.querySelector(".cloze-slot");
    if (!slot) return;
    const answer = slot.dataset.answer || "";
    slot.textContent = answer;
    slot.dataset.selected = answer;
    slot.classList.remove("cloze-wrong");
    slot.classList.add("cloze-correct", "cloze-revealed");

    item.querySelectorAll(".cloze-option").forEach(b => {
      b.classList.remove("option-wrong", "selected");
      if (normalizeWord(b.dataset.value) === normalizeWord(answer)) {
        b.classList.add("option-correct", "selected");
      }
    });
  });
}

document.getElementById("exerciseBody")?.addEventListener("click", onClozeOptionClick);
document.getElementById("exerciseCheckBtn")?.addEventListener("click", checkCloze);
document.getElementById("exerciseRevealBtn")?.addEventListener("click", revealCloze);

homeBackBtn?.addEventListener("click", goHome);

/* -----------------------------
   LANGUAGE-BASED UI
----------------------------- */

function updateLanguageBasedUI() {
  const pinyinBtn = document.getElementById("toggleFullTextPinyinBtn");
  const calligraphyBtn = document.querySelector('[data-tool-screen="calligraphy"]');

  if (pinyinBtn) {
    pinyinBtn.style.display = sourceLangSelect?.value === "zh" ? "inline-flex" : "none";
  }

  if (calligraphyBtn) {
    calligraphyBtn.style.display =
      ["zh", "ru"].includes(sourceLangSelect?.value) ? "block" : "none";
  }

  updateWritingPlaceholder();
}

function updateWritingPlaceholder() {
  if (!writingInput || !sourceLangSelect) return;

  writingInput.placeholder = getT().writingPlaceholder;
}

sourceLangSelect?.addEventListener("change", () => {
  updateLanguageBasedUI();
  loadTextLibrary();
});

/* -----------------------------
   LEARNING LANGUAGE (global, set from the dashboard)
   The composer's #sourceLang / #targetLang selects stay the source of truth
   (read in many places); the dashboard control mirrors into them and we
   persist the choice so it survives reloads.
----------------------------- */
const homeSourceLang = document.getElementById("homeSourceLang");
const homeTargetLang = document.getElementById("homeTargetLang");

function applyStoredLearningLangs() {
  const src = localStorage.getItem("magicread_source_lang");
  const tgt = localStorage.getItem("magicread_target_lang");
  if (src && sourceLangSelect) sourceLangSelect.value = src;
  if (tgt && targetLangSelect) targetLangSelect.value = tgt;
  syncHomeLangControls();
}

function syncHomeLangControls() {
  if (homeSourceLang && sourceLangSelect) homeSourceLang.value = sourceLangSelect.value;
  if (homeTargetLang && targetLangSelect) homeTargetLang.value = targetLangSelect.value;
}

homeSourceLang?.addEventListener("change", () => {
  if (!sourceLangSelect) return;
  sourceLangSelect.value = homeSourceLang.value;
  localStorage.setItem("magicread_source_lang", homeSourceLang.value);
  sourceLangSelect.dispatchEvent(new Event("change"));
  updateLanguageBasedUI();
});

homeTargetLang?.addEventListener("change", () => {
  if (!targetLangSelect) return;
  targetLangSelect.value = homeTargetLang.value;
  localStorage.setItem("magicread_target_lang", homeTargetLang.value);
});

// Keep the dashboard control + storage in step when language changes elsewhere
// (composer, onboarding, resume).
sourceLangSelect?.addEventListener("change", () => {
  localStorage.setItem("magicread_source_lang", sourceLangSelect.value);
  syncHomeLangControls();
});
targetLangSelect?.addEventListener("change", () => {
  localStorage.setItem("magicread_target_lang", targetLangSelect.value);
  syncHomeLangControls();
});

applyStoredLearningLangs();
updateLanguageBasedUI();

/* -----------------------------
   MAIN READING FLOW
----------------------------- */

async function preloadChineseSegments(texts) {
  if (sourceLangSelect.value !== "zh") return;

  const uniqueTexts = [...new Set(texts.filter(Boolean))];

  const missingTexts = uniqueTexts.filter(text => !segmentCache.has(text));

  if (!missingTexts.length) return;

  const response = await fetchWithAuth(`${API_BASE}/api/segment-many`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ texts: missingTexts })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Batch segmentation failed");
  }

  (data.results || []).forEach(item => {
    if (segmentCache.size >= 100) segmentCache.delete(segmentCache.keys().next().value);
    segmentCache.set(item.text, item.words || []);
  });
}

async function startReadingFromText(text) {
  const cleanText = text.trim();

  if (!cleanText) {
    showToast("Please paste a text first.", "error");
    return;
  }

  showMagicLoadingOverlay();

  if (createBtn) {
    createBtn.disabled = true;
    createBtn.textContent = "Creating magic...";
  }

  try {
    const res = await fetchWithAuth(`${API_BASE}/api/split-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: cleanText,
        sourceLang: sourceLangSelect.value
      })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Split text failed");
    }

    const sentences = data.sentences || [];

    if (!sentences.length) {
      showToast("No sentences found. Try adding punctuation: . ! ? 。！？", "error");
      return;
    }

    currentText = cleanText;
    currentSentences = sentences;

    // Count words in the full text as a proxy for "words read this session".
    const wordCount = cleanText.trim().split(/\s+/).filter(Boolean).length || cleanText.replace(/\s/g, "").length;
    recordActivity("words_read", wordCount);
    saveProgress(appMode === "reading" ? "reading" : "speaking", currentTextId, { sentence: 0 }, currentTextTitle);

    if (sourceLangSelect.value === "zh") {
      await preloadChineseSegments([cleanText, ...sentences]);
    }

    inputText.value = cleanText;
    if (startComposerArea) startComposerArea.hidden = true;

    if (fullTextTranslation) fullTextTranslation.textContent = "";
    if (textLibraryPanel) textLibraryPanel.hidden = true;
    if (savedTextsPanel) savedTextsPanel.hidden = true;
    trackGuest("fullTextsGenerated");

    if (appMode === "reading") {
      // Reading: launch the dedicated flowing-passage reader screen.
      startReader(cleanText, sentences);
    } else {
      // Pronunciation: launch the one-sentence-at-a-time "spotlight" flow.
      startSpotlight(sentences);
    }
  } catch (error) {
    console.error("Start reading error:", error);
    showToast("Could not start reading.", "error");
  } finally {
    hideMagicLoadingOverlay();
    if (createBtn) {
      createBtn.disabled = false;
      updateModeCopy();
    }
  }
}

/* ============================================================================
   SPEAK · SPOTLIGHT  — one-sentence-at-a-time pronunciation flow.
   Setup (composer on #screen-main) → #screen-speak-practice → #screen-speak-complete.
   ============================================================================ */

const SP_LANG_LABELS = {
  zh: "中文", ru: "RU", tr: "TR", en: "EN", de: "DE",
  es: "ES", fr: "FR", hy: "HY", ka: "KA", ja: "日本語"
};
const SP_RING_C = 326.7; // ring circumference (r=52)

const spState = {
  sentences: [],
  lang: "zh",
  idx: 0,
  phase: "idle",          // idle | listening | recording | done
  fromComplete: false,
  results: [],            // per-sentence { score, accuracy, fluency, completeness, words:[{text,status}] } | null
  meta: [],               // per-sentence { pinyin, en } cache
  recording: false,
};

function spColor(score) { return score >= 85 ? "#16A34A" : score >= 70 ? "#E0A106" : "#DC2626"; }
function spMessage(score) {
  return score >= 95 ? "Native-like!" : score >= 85 ? "Sounds clean!" : score >= 70 ? "Almost there" : "Keep going";
}

// Map Azure's assessment JSON → the shape the spotlight UI renders.
function spMapAzure(result) {
  const round = (n) => Math.round(Number(n) || 0);
  const words = (result.words || [])
    .filter((w) => (w.errorType || "None") !== "Insertion")
    .map((w) => {
      let status = "good";
      if (w.errorType && w.errorType !== "None") status = "bad";
      else if (w.accuracy != null) status = w.accuracy >= 85 ? "good" : w.accuracy >= 70 ? "ok" : "bad";
      return { text: w.word || "", status };
    });
  return {
    score: round(result.pronunciation ?? result.accuracy),
    accuracy: round(result.accuracy),
    fluency: round(result.fluency),
    completeness: round(result.completeness),
    words,
  };
}

function startSpotlight(sentences) {
  spState.sentences = sentences;
  spState.lang = sourceLangSelect.value || "zh";
  spState.idx = 0;
  spState.phase = "idle";
  spState.fromComplete = false;
  spState.results = sentences.map(() => null);
  spState.meta = sentences.map(() => ({ pinyin: "", en: "" }));
  spRenderPractice();
  showScreen(screenSpeakPractice);
}

function spInitOnce() {
  if (spInitOnce._done) return;
  spInitOnce._done = true;

  document.getElementById("spBackBtn")?.addEventListener("click", () => {
    stopAllTTS(); stopRecognition();
    if (spState.session) { spState.session.cancel(); }
    spResetMic();
    showScreen(screenSpeakSetup);
  });
  document.getElementById("spMic")?.addEventListener("click", spOnMicTap);
  document.getElementById("spListenBtn")?.addEventListener("click", spOnListen);
  document.getElementById("spDetailsToggle")?.addEventListener("click", spToggleDetails);
  document.getElementById("spRetryBtn")?.addEventListener("click", spRetryCurrent);
  document.getElementById("spPrimaryBtn")?.addEventListener("click", spOnPrimary);
  document.getElementById("spcNewBtn")?.addEventListener("click", spNewText);
  document.getElementById("spcLibraryBtn")?.addEventListener("click", spNewText);
}

function spRenderMic() {
  const mic = document.getElementById("spMic");
  const label = document.getElementById("spMicLabel");
  if (!mic) return;
  mic.className = "sp-mic " + (spState.phase === "recording" ? "is-recording"
    : spState.phase === "scoring" ? "is-scoring"
    : spState.phase === "listening" ? "is-listening" : "is-idle");
  if (label) {
    const t = getT();
    label.textContent = spState.phase === "recording" ? t.speakNowTapDone
      : spState.phase === "scoring" ? t.scoringLabel
      : spState.phase === "listening" ? t.playingAudio
      : t.tapToSpeak;
  }
}

/* Voice-reactive mic meter: while recording, drive --mic-level (0..1) on the
   mic button from the live input level so it visibly reacts to speech. */
let spMicMeter = null;
async function spStartMicMeter() {
  if (spMicMeter) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const mic = document.getElementById("spMic");
    let raf = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 5);
      mic?.style.setProperty("--mic-level", level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    tick();
    spMicMeter = {
      stop() {
        cancelAnimationFrame(raf);
        try { src.disconnect(); } catch { /* ignore */ }
        try { ctx.close(); } catch { /* ignore */ }
        stream.getTracks().forEach(t => t.stop());
        mic?.style.removeProperty("--mic-level");
      }
    };
  } catch { /* no meter — recording still works */ }
}
function spStopMicMeter() {
  spMicMeter?.stop();
  spMicMeter = null;
}

async function spRenderPractice() {
  const s = spState.sentences[spState.idx];
  if (!s) return;
  const done = spState.phase === "done";
  const res = spState.results[spState.idx];

  document.getElementById("spNum").textContent = spState.idx + 1;
  document.getElementById("spTotal").textContent = spState.sentences.length;
  const langPill = document.getElementById("spLangPill");
  if (langPill) {
    langPill.textContent = SP_LANG_LABELS[spState.lang] || spState.lang.toUpperCase();
    langPill.classList.toggle("zh", spState.lang === "zh");
  }

  // segment progress
  document.getElementById("spSegments").innerHTML = spState.sentences
    .map((_, i) => `<i class="${i < spState.idx ? "done" : i === spState.idx ? "cur" : ""}"></i>`)
    .join("");

  // sentence — coloured per-word once scored, otherwise clickable plain words
  const zh = document.getElementById("spZh");
  if (done && res && res.words && res.words.length) {
    zh.innerHTML = res.words
      .map((w) => `<span class="sp-word w-${w.status} ${`sp-${w.status}`}" data-word="${escapeHtml(w.text)}">${escapeHtml(w.text)}</span>`)
      .join("");
  } else {
    zh.innerHTML = spBuildClickableTokens(s, spState.lang);
  }
  spAttachWordTaps(zh, s);

  // toggle mic vs result
  document.getElementById("spMicGroup").hidden = done;
  document.getElementById("spResult").hidden = !done;
  document.getElementById("spActions").hidden = !done;
  spRenderMic();

  // pinyin + english (lazy, cached)
  spLoadMeta(spState.idx);

  if (done && res) {
    const scoreEl = document.getElementById("spRingScore");
    scoreEl.innerHTML = res.score + "<s>%</s>";
    scoreEl.style.color = spColor(res.score);
    const ring = document.getElementById("spRing");
    ring.setAttribute("stroke", spColor(res.score));
    ring.style.strokeDashoffset = SP_RING_C;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      ring.style.strokeDashoffset = (SP_RING_C * (1 - res.score / 100)).toFixed(1);
    }));
    document.getElementById("spDot").style.background = spColor(res.score);
    const msg = document.getElementById("spMsg");
    msg.textContent = spMessage(res.score);
    msg.style.color = spColor(res.score);
    document.getElementById("spMAcc").textContent = res.accuracy;
    document.getElementById("spMFlu").textContent = res.fluency;
    document.getElementById("spMComp").textContent = res.completeness;
    // collapse details by default
    document.getElementById("spMetrics").classList.remove("show");
    const tog = document.getElementById("spDetailsToggle");
    tog.classList.remove("open");
    tog.querySelector("span").textContent = "See details ";
    document.getElementById("spPrimaryBtn").textContent = spState.fromComplete
      ? "Back to summary"
      : (spState.idx >= spState.sentences.length - 1 ? "Finish text" : "Next sentence");
  }
}

// Build clickable word/character spans for the unscored sentence.
function spBuildClickableTokens(sentence, lang) {
  if (lang === "zh" || lang === "ja") {
    return [...sentence]
      .map((ch) => /\s/.test(ch)
        ? ch
        : `<span class="sp-word" data-word="${escapeHtml(ch)}">${escapeHtml(ch)}</span>`)
      .join("");
  }
  return sentence.split(/(\s+)/)
    .map((tok) => tok.trim()
      ? `<span class="sp-word" data-word="${escapeHtml(tok)}">${escapeHtml(tok)}</span>`
      : escapeHtml(tok))
    .join("");
}

// Word tap → translate/save popup (reuses the reader's popup).
function spAttachWordTaps(container, sentence) {
  container.querySelectorAll(".sp-word").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const word = el.dataset.word;
      if (!word) return;
      sourceLangSelect.value = spState.lang;
      showWordPopup(el, word, sentence, "", true).catch(console.error);
    });
  });
}

// Lazy-load pinyin (zh) + a short translation for the current sentence.
async function spLoadMeta(idx) {
  const s = spState.sentences[idx];
  const meta = spState.meta[idx];
  const pyEl = document.getElementById("spPy");
  const enEl = document.getElementById("spEn");
  if (!s || !meta) return;

  // pinyin
  if (spState.lang === "zh") {
    if (meta.pinyin) { pyEl.textContent = meta.pinyin; }
    else {
      pyEl.textContent = "";
      try { meta.pinyin = await getPinyinForText(s); }
      catch { meta.pinyin = ""; }
      if (spState.idx === idx) pyEl.textContent = meta.pinyin;
    }
  } else {
    pyEl.textContent = "";
  }

  // translation
  if (meta.en) { enEl.textContent = meta.en; }
  else {
    enEl.textContent = "";
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: s, sourceLang: spState.lang, targetLang: targetLangSelect.value || "en" }),
      });
      const data = await res.json();
      meta.en = res.ok ? (data.translation || "") : "";
    } catch { meta.en = ""; }
    if (spState.idx === idx) enEl.textContent = meta.en;
  }
}

/* INTEGRATION #1 — record + score the current sentence. */
/* Push-to-talk: first tap starts recording, second tap stops and scores. */
async function spOnMicTap() {
  if (spState.phase === "scoring") return;
  if (spState.phase === "recording") { spStopAndScore(); return; }

  unlockAudioForMobile();
  stopAllTTS();
  spState.recording = true;
  spState.phase = "recording";
  spState.stopRequested = false;
  spRenderMic();
  spStartMicMeter();

  const sentence = spState.sentences[spState.idx];
  const azureLang = mapToSpeechLang(spState.lang);

  try {
    const session = await startPronunciationSession(sentence, azureLang, {
      tokenUrl: SPEECH_TOKEN_URL,
      fetchWithAuth
    });
    spState.session = session;
    // The user may have tapped "done" while the session was still connecting.
    if (spState.stopRequested) spStopAndScore();
  } catch (err) {
    if (err && err.code === "QUOTA_EXCEEDED") { showUpgradePrompt("QUOTA_EXCEEDED"); spResetMic(); return; }
    if (err && err.code === "MIC_DENIED") {
      showToast(micBlockedMessage(), "error");
      spResetMic();
      return;
    }
    // Azure unavailable — fall back to browser SpeechRecognition (auto-stops).
    try {
      await spFallbackRecognition(sentence);
    } catch (e) {
      console.error("[Spotlight] scoring error:", e);
      showToast("Could not score your speech. Try again.", "error");
      spResetMic();
    }
  }
}

async function spStopAndScore() {
  const session = spState.session;
  if (!session) {
    // Session still connecting — flag the stop; spOnMicTap will finish it.
    // If we're in the browser-recognition fallback, stop that instead.
    if (spState.fallbackRec) { try { spState.fallbackRec.stop(); } catch { /* ignore */ } return; }
    spState.stopRequested = true;
    return;
  }
  spState.session = null;
  spState.phase = "scoring";
  spRenderMic();
  spStopMicMeter();

  try {
    const result = await session.stop();
    spApplyScore(spMapAzure(result));
    recordActivity("words_spoken", (result.words || []).length || 1);
    fetchMyPlan();
  } catch (err) {
    if (err && err.code === "NO_SPEECH") {
      showToast("I didn't hear anything — tap the mic and try again.", "error");
    } else {
      console.error("[Spotlight] scoring error:", err);
      showToast("Could not score your speech. Try again.", "error");
    }
    spResetMic();
  }
}

// Legacy browser scoring (guests / Azure not configured). No per-word data.
function spFallbackRecognition(sentence) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast("Speech scoring isn't available in this browser.", "error"); spResetMic(); resolve(); return; }
    const rec = new SR();
    spState.fallbackRec = rec;
    const lang = mapToSpeechLang(spState.lang);
    rec.lang = lang; rec.continuous = false; rec.interimResults = false; rec.maxAlternatives = 1;
    rec.onend = () => { spState.fallbackRec = null; };
    rec.onresult = (event) => {
      const transcript = event.results[0][0].transcript || "";
      const { score } = compareText(sentence, transcript, lang);
      const tokens = spState.lang === "zh" || spState.lang === "ja"
        ? [...sentence].filter((c) => !/\s/.test(c))
        : sentence.split(/\s+/).filter(Boolean);
      spApplyScore({
        score, accuracy: score, fluency: score, completeness: 100,
        words: tokens.map((t) => ({ text: t, status: score >= 85 ? "good" : score >= 70 ? "ok" : "bad" })),
      });
      resolve();
    };
    rec.onerror = () => { showToast("I didn't catch that. Try again.", "error"); spResetMic(); resolve(); };
    try { rec.start(); } catch { spResetMic(); resolve(); }
  });
}

function spResetMic() {
  spState.recording = false;
  spState.phase = "idle";
  spState.session = null;
  spState.stopRequested = false;
  spStopMicMeter();
  spRenderMic();
}

/* INTEGRATION #2 — feed a normalised result in. */
function spApplyScore(result) {
  spState.recording = false;
  spState.session = null;
  spStopMicMeter();
  spState.results[spState.idx] = result;
  spState.phase = "done";
  spRenderPractice();
  spFireConfetti("spConfetti", result.score >= 85);
  saveProgress("speaking", currentTextId, { sentence: spState.idx }, currentTextTitle);
}

/* INTEGRATION #1b — Listen (Google TTS). */
async function spOnListen() {
  if (spState.phase === "recording") return;
  unlockAudioForMobile();
  spState.phase = "listening";
  spRenderMic();
  const sentence = spState.sentences[spState.idx];
  const done = () => { if (spState.phase === "listening") { spState.phase = "idle"; spRenderMic(); } };
  try { await playGoogleTTS(sentence, spState.lang, done); }
  catch { done(); }
}

function spToggleDetails() {
  const m = document.getElementById("spMetrics");
  const t = document.getElementById("spDetailsToggle");
  const open = m.classList.toggle("show");
  t.classList.toggle("open", open);
  t.querySelector("span").textContent = open ? "Hide details " : "See details ";
}

function spRetryCurrent() { spState.phase = "idle"; spRenderPractice(); }

function spOnPrimary() {
  if (spState.fromComplete) {
    spState.fromComplete = false;
    spRenderComplete();
    showScreen(screenSpeakComplete);
    return;
  }
  if (spState.idx >= spState.sentences.length - 1) {
    spRenderComplete();
    showScreen(screenSpeakComplete);
    spFireConfetti("spcConfetti", true);
    return;
  }
  spState.idx++;
  spState.phase = "idle";
  spRenderPractice();
  document.querySelector("#screen-speak-practice .sp-body")?.scrollTo({ top: 0, behavior: "smooth" });
}

function spRetrySentence(i) {
  spState.idx = i;
  spState.phase = "idle";
  spState.fromComplete = true;
  spRenderPractice();
  showScreen(screenSpeakPractice);
}

function spNewText() {
  stopAllTTS(); stopRecognition();
  spState.phase = "idle";
  spState.fromComplete = false;
  const inp = document.getElementById("spSetupInput");
  if (inp) inp.value = "";
  spSetupSetTab("paste");
  showScreen(screenSpeakSetup);
}

function spRenderComplete() {
  const scored = spState.results.map((r, i) => (r ? r.score : 0));
  const counted = scored.filter((_, i) => spState.results[i]);
  const overall = counted.length ? Math.round(counted.reduce((a, b) => a + b, 0) / counted.length) : 0;
  document.getElementById("spcTotal").textContent = spState.sentences.length;
  const scoreEl = document.getElementById("spcScore");
  scoreEl.innerHTML = overall + "<s>%</s>";
  scoreEl.style.color = spColor(overall);
  const ring = document.getElementById("spcRing");
  ring.setAttribute("stroke", spColor(overall));
  ring.style.strokeDashoffset = SP_RING_C;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    ring.style.strokeDashoffset = (SP_RING_C * (1 - overall / 100)).toFixed(1);
  }));

  document.getElementById("spcRecap").innerHTML = spState.sentences.map((_, i) => {
    const r = spState.results[i];
    const sc = r ? r.score : null;
    const label = sc == null ? "–" : sc;
    const col = sc == null ? "var(--text-dim)" : spColor(sc);
    return `
      <button type="button" data-sp-retry="${i}">
        <div class="sp-chip" style="color:${col}">${label}
          <div class="sp-badge"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-retry"/></svg></div>
        </div>
        <small>Sent ${i + 1}</small>
      </button>`;
  }).join("");
  document.querySelectorAll("#spcRecap [data-sp-retry]").forEach((btn) => {
    btn.addEventListener("click", () => spRetrySentence(Number(btn.dataset.spRetry)));
  });
}

function spFireConfetti(id, on) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!on) { el.hidden = true; el.innerHTML = ""; return; }
  const cols = ["#E5267E", "#0AB4D6", "#16A34A", "#E0A106"];
  el.innerHTML = Array.from({ length: 14 }, (_, i) => {
    const ang = (i / 14) * Math.PI * 2, d = 64 + ((i * 37) % 46);
    const tx = (Math.cos(ang) * d).toFixed(1), ty = (Math.sin(ang) * d).toFixed(1);
    return `<i style="border-radius:${i % 2 ? "999px" : "3px"};background:${cols[i % 4]};--tx:${tx}px;--ty:${ty}px;animation-delay:${(i % 5) * 0.03}s"></i>`;
  }).join("");
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; el.innerHTML = ""; }, 1300);
}

spInitOnce();

/* ============================================================================
   READER · FLOWING PASSAGE  — dedicated reading screens.
   Setup (composer on #screen-main) → #screen-read-reader → #screen-read-exercise.
   ============================================================================ */

const R = {
  text: "",
  lang: "zh",
  paras: [],        // [{ text, sents:[{ text, gi }], en:"" }]
  sentences: [],    // flat [{ text }] in render order; gi = global index
  idx: -1,
  playing: false,
  paused: false,
  playSession: 0,
  pinyin: false,
  trans: false,
};
let rdOnClozeComplete = null; // completion hook fired from checkCloze
const rdExState = { view: "menu", done: { order: false, choice: false } };

function startReader(text, sentences) {
  R.text = text;
  R.lang = sourceLangSelect.value || "zh";
  R.idx = -1;
  R.playing = false;
  R.paused = false;
  R.pinyin = false;
  R.trans = false;
  // Reset exercises for the new text.
  rdEx1.slots = []; rdEx1.target = []; rdEx1.bank = []; rdEx1.fb = null;
  rdEx2.sent = ""; rdEx2.opts = []; rdEx2.choice = null; rdEx2.fb = null;
  rdExState.done = { order: false, choice: false };
  rdExState.view = "menu";
  rdExState.items = [];
  rdExState.idx = 0;
  const bm = document.getElementById("rdBookmarkBtn");
  bm?.classList.toggle("on", !!currentTextId && !String(currentTextId).startsWith("lib_"));
  rdBuildParagraphs(text, sentences);
  rdRenderPassage();
  rdUpdateToolbar();
  rdUpdateDock();
  showScreen(screenReadReader);
  document.querySelector("#screen-read-reader .rd-surface")?.scrollTo({ top: 0 });
}

// Build paragraphs (blank-line, else single-newline, else whole text) → sentences.
function rdBuildParagraphs(text, sentences) {
  let chunks = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (chunks.length <= 1) chunks = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (!chunks.length) chunks = [text.trim()];

  R.paras = [];
  R.sentences = [];
  let gi = 0;
  for (const chunk of chunks) {
    const sents = (chunk.match(/[^.!?。！？]+[.!?。！？]*/g) || [chunk])
      .map(s => s.trim()).filter(Boolean)
      .map(s => ({ text: s, gi: gi++ }));
    R.paras.push({ text: chunk, sents, en: "" });
    sents.forEach(s => R.sentences.push(s));
  }
  // Fallback: if our split produced nothing useful, use the server sentences.
  if (!R.sentences.length && sentences?.length) {
    R.paras = [{ text, sents: sentences.map((t, i) => ({ text: t, gi: i })), en: "" }];
    R.sentences = R.paras[0].sents;
  }
}

async function rdSegment(sentence) {
  let words = segmentCache.get(sentence);
  if (!words) {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence, lang: R.lang })
      });
      const data = await res.json();
      words = res.ok ? (data.words || []) : [];
      if (segmentCache.size >= 100) segmentCache.delete(segmentCache.keys().next().value);
      segmentCache.set(sentence, words);
    } catch { words = []; }
  }
  return words;
}

function rdWordHTML(word, py) {
  if (/^[，。！？；：、“”‘’（）()\[\]{}…,.!?;:\s]+$/.test(word)) {
    return `<span class="rd-punc">${escapeHtml(word)}</span>`;
  }
  return `<span class="rd-word" data-word="${escapeHtml(word)}" data-pinyin="${escapeHtml(py || "")}">` +
    `<small>${escapeHtml(py || "")}</small><span class="rd-hz">${escapeHtml(word)}</span></span>`;
}

function rdCleanHanziWord(word) {
  const raw = String(word || "");
  // Japanese words mix kanji and kana (e.g. \u98df\u3079\u308b) \u2014 leave them intact.
  if (R.lang === "ja") return raw;
  if (!/[\u3400-\u9fff\uf900-\ufaff]/u.test(raw)) return raw;
  return raw.replace(/[^\u3400-\u9fff\uf900-\ufaff，。！？；：、“”‘’（）()\[\]{}…,.!?;:\s]/gu, "");
}

function rdWordParts(item) {
  if (typeof item === "string") {
    return { word: rdCleanHanziWord(item), pinyin: "" };
  }
  const rawWord = item?.hanzi || item?.hz || item?.word || "";
  return {
    word: rdCleanHanziWord(rawWord),
    pinyin: item?.pinyin || item?.py || ""
  };
}

async function rdRenderPassage() {
  const han = document.getElementById("rdHan");
  if (!han) return;
  han.innerHTML = `<p class="rd-loading">Loading…</p>`;

  const isCJK = R.lang === "zh" || R.lang === "ja";
  const paraHTML = [];
  for (const pa of R.paras) {
    const sentHTML = [];
    for (const s of pa.sents) {
      let inner;
      if (isCJK) {
        const words = await rdSegment(s.text);
        inner = words.length
          ? words.map(w => {
              const { word, pinyin } = rdWordParts(w);
              return rdWordHTML(word, pinyin);
            }).join("")
          : escapeHtml(s.text);
      } else {
        inner = s.text.split(/(\s+)/).map(tok =>
          tok.trim()
            ? rdWordHTML(tok, "")
            : escapeHtml(tok)
        ).join("");
      }
      sentHTML.push(`<span class="rd-sent" data-i="${s.gi}">${inner}</span>`);
    }
    paraHTML.push(`<div class="rd-para">${sentHTML.join(" ")}<div class="rd-trans">${escapeHtml(pa.en || "")}</div></div>`);
  }
  han.innerHTML = paraHTML.join("");
  han.classList.toggle("show-pinyin", R.pinyin);
  han.classList.toggle("show-trans", R.trans);

  // Word tap → inline word sheet (real dictionary lookup + real save).
  han.querySelectorAll(".rd-word").forEach(el => {
    const word = el.dataset.word;
    if (word) {
      const sentEl = el.closest(".rd-sent");
      const sentText = sentEl ? R.sentences.find(s => String(s.gi) === sentEl.dataset.i)?.text || "" : "";

      el.addEventListener("mouseenter", () => {
        if (el._popupTimer) clearTimeout(el._popupTimer);
        el._popupTimer = setTimeout(() => {
          showWordPopup(el, word, sentText, "", false).catch(console.error);
        }, 250);
      });

      el.addEventListener("mouseleave", () => {
        if (el._popupTimer) {
          clearTimeout(el._popupTimer);
          el._popupTimer = null;
        }
      });
    }

    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const word = el.dataset.word;
      if (!word) return;
      const sentEl = el.closest(".rd-sent");
      const sentText = sentEl ? R.sentences.find(s => String(s.gi) === sentEl.dataset.i)?.text || "" : "";
      han.querySelectorAll(".rd-word-sel").forEach(w => w.classList.remove("rd-word-sel"));
      el.classList.add("rd-word-sel");
      rdShowWordSheet(word, el.dataset.pinyin || "", sentText);
    });
  });
  rdUpdateHighlight();
}

function rdUpdateToolbar() {
  const title = currentTextTitle || (R.lang === "zh" ? "阅读" : getT().readingTitle);
  const titleEl = document.getElementById("rdTitle");
  const subEl = document.getElementById("rdSub");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = `${R.sentences.length} ${R.sentences.length === 1 ? getT().sentenceOne : getT().sentenceMany}`;
  document.getElementById("rdPinyinPill")?.classList.toggle("on", R.pinyin);
  document.getElementById("rdTransPill")?.classList.toggle("on", R.trans);
  // Reading-aid pill: pinyin for Chinese, romaji for Japanese.
  const pinyinPill = document.getElementById("rdPinyinPill");
  if (pinyinPill) {
    pinyinPill.style.display = (R.lang === "zh" || R.lang === "ja") ? "" : "none";
    pinyinPill.textContent = R.lang === "ja" ? `ロ ${getT().romajiPill}` : `拼 ${getT().pinyinPill}`;
  }
  // Level badge from the selected library/setup item.
  const lvl = document.getElementById("rdLevel");
  if (lvl) {
    const level = rdSetupState?._level || "";
    lvl.textContent = level;
    lvl.hidden = !level;
  }
  // Voice pill shows the selected voice's short label.
  const voiceName = document.getElementById("rdVoiceName");
  if (voiceName) {
    const sel = getSelectedVoice(R.lang);
    const v = (VOICE_LIST[R.lang] || []).find(x => x.name === sel) || (VOICE_LIST[R.lang] || [])[0];
    const raw = (v && v.label) || "Voice";
    voiceName.textContent = raw.replace(/Voice/i, getT().voice || "Voice");
  }
  const transPill = document.getElementById("rdTransPill");
  if (transPill) transPill.textContent = getT().translatePill;
}

function rdUpdateDock() {
  const total = R.sentences.length;
  const cur = R.idx < 0 ? 0 : R.idx + 1;
  const prog = document.getElementById("rdProgress");
  if (prog) prog.style.width = total ? `${(cur / total) * 100}%` : "0%";
  const label = document.getElementById("rdSentLabel");
  if (label) label.textContent = `${cur} / ${total} ${getT().sentenceMany}`;
  const speed = document.getElementById("rdSpeed");
  if (speed) speed.textContent = getTtsSpeedLabel();
  const slowPill = document.getElementById("rdSlowPill");
  slowPill?.classList.toggle("on", ttsSpeedMode > 0);
  slowPill?.classList.toggle("extra-slow", ttsSpeedMode === 2);
  const slowLabel = document.getElementById("rdSlowLabel");
  if (slowLabel) slowLabel.textContent = ttsSpeedMode === 2 ? (getT().extraSlow || "Extra slow") : (getT().slow || "Slow");
  const useEl = document.getElementById("rdPlayUse");
  if (useEl) useEl.setAttribute("href", R.playing ? "#sonic-i-pause-fill" : "#sonic-i-play");
  document.getElementById("rdPrevSentBtn")?.toggleAttribute("disabled", total === 0 || cur <= 1);
  document.getElementById("rdNextSentBtn")?.toggleAttribute("disabled", total === 0 || cur >= total);
}

function rdUpdateHighlight() {
  document.querySelectorAll("#rdHan .rd-sent").forEach(el =>
    el.classList.toggle("active", Number(el.dataset.i) === R.idx));
  const active = document.querySelector("#rdHan .rd-sent.active");
  if (active && R.playing) active.scrollIntoView({ behavior: "smooth", block: "center" });
}

function rdStopPlay() {
  R.playing = false;
  R.paused = false;
  R.playSession++;
  stopAllTTS();
  rdUpdateDock();
}

function rdPausePlay() {
  if (currentAudio && !audioCtxSuspended) {
    ttsAudioEl.pause();
    audioCtxSuspended = true;
  } else if (window.speechSynthesis?.speaking && !window.speechSynthesis.paused) {
    window.speechSynthesis.pause();
  } else {
    return;
  }
  R.playing = false;
  R.paused = true;
  rdUpdateDock();
}

function rdResumePlay() {
  if (currentAudio && audioCtxSuspended) {
    ttsAudioEl.play().catch(() => {});
    audioCtxSuspended = false;
  } else if (window.speechSynthesis?.paused) {
    window.speechSynthesis.resume();
  } else {
    return false;
  }
  R.playing = true;
  R.paused = false;
  rdUpdateDock();
  rdUpdateHighlight();
  return true;
}

async function rdPlayFrom(i) {
  const session = ++R.playSession;
  R.playing = true;
  R.paused = false;
  rdUpdateDock();

  const playOne = async (idx) => {
    if (session !== R.playSession) return;
    if (idx >= R.sentences.length) { R.playing = false; R.paused = false; R.idx = R.sentences.length - 1; rdUpdateDock(); rdUpdateHighlight(); return; }
    R.idx = idx;
    rdUpdateDock();
    rdUpdateHighlight();
    const clean = await prepareTTSInput(R.sentences[idx].text, R.lang);
    if (session !== R.playSession) return;
    await playGoogleTTS(clean, R.lang, () => {
      if (session === R.playSession) playOne(idx + 1);
    });
  };
  playOne(i);
}

function rdTogglePlay() {
  unlockAudioForMobile();
  if (R.playing) { rdPausePlay(); return; }
  if (R.paused && rdResumePlay()) return;
  let start = R.idx;
  if (start < 0 || start >= R.sentences.length - 1) start = 0;
  rdPlayFrom(start);
}

function rdJumpSentence(delta) {
  if (!R.sentences.length) return;
  const current = R.idx < 0 ? (delta > 0 ? -1 : 0) : R.idx;
  const target = Math.max(0, Math.min(R.sentences.length - 1, current + delta));
  if (target === R.idx && !R.paused && !R.playing) return;
  if (R.playing || R.paused) {
    rdPlayFrom(target);
  } else {
    R.idx = target;
    rdUpdateDock();
    rdUpdateHighlight();
  }
}

let _rdInited = false;
function rdInitOnce() {
  if (_rdInited) return;
  _rdInited = true;

  document.getElementById("rdBackBtn")?.addEventListener("click", () => {
    rdStopPlay();
    openReadSetup();
  });
  document.getElementById("rdPlayBtn")?.addEventListener("click", rdTogglePlay);
  document.getElementById("rdPrevSentBtn")?.addEventListener("click", () => rdJumpSentence(-1));
  document.getElementById("rdNextSentBtn")?.addEventListener("click", () => rdJumpSentence(1));
  document.getElementById("rdSlowPill")?.addEventListener("click", () => {
    const wasActive = R.playing || R.paused;
    const start = R.idx < 0 ? 0 : R.idx;
    toggleSlowMode();
    R.paused = false;
    rdUpdateDock();
    if (wasActive) rdPlayFrom(start);
  });
  document.getElementById("rdVoicePill")?.addEventListener("click", () => rdOpenSheet("voice"));
  document.getElementById("rdScrim")?.addEventListener("click", rdCloseSheet);
  document.getElementById("rdPinyinPill")?.addEventListener("click", () => {
    R.pinyin = !R.pinyin;
    document.getElementById("rdHan")?.classList.toggle("show-pinyin", R.pinyin);
    document.getElementById("rdPinyinPill")?.classList.toggle("on", R.pinyin);
  });
  document.getElementById("rdTransPill")?.addEventListener("click", () => rdToggleTrans());
  document.getElementById("rdBookmarkBtn")?.addEventListener("click", () => {
    const btn = document.getElementById("rdBookmarkBtn");
    const willSave = !btn?.classList.contains("on");
    if (willSave) {
      btn?.classList.add("on");
      document.getElementById("saveTextBtn")?.click();
    } else {
      btn?.classList.remove("on");
      showToast("Removed from saved", "info");
    }
  });
  document.getElementById("rdPracticeBtn")?.addEventListener("click", () => {
    rdStopPlay();
    rdStartExerciseSession();
    rdRenderExercise();
    showScreen(screenReadExercise);
  });
  document.getElementById("rdExBackBtn")?.addEventListener("click", () => {
    showScreen(screenReadReader);
  });
}
rdInitOnce();

function rdStartExerciseSession() {
  rdExState.view = "exercise";
  rdExState.idx = 0;
  rdExState.items = rdBuildExerciseItems();
  if (!rdExState.items.length) rdExState.view = "empty";
}

async function rdToggleTrans() {
  R.trans = !R.trans;
  document.getElementById("rdTransPill")?.classList.toggle("on", R.trans);
  const han = document.getElementById("rdHan");
  han?.classList.toggle("show-trans", R.trans);
  if (!R.trans) return;
  // Lazy-load + cache each paragraph translation.
  for (let p = 0; p < R.paras.length; p++) {
    const pa = R.paras[p];
    if (pa.en) continue;
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: pa.text, sourceLang: R.lang, targetLang: targetLangSelect.value || "en" })
      });
      const data = await res.json();
      if (res.status === 429 && data?.code) {
        // Free-plan daily translation cap — stop the batch and offer Pro.
        showUpgradePrompt(data.code);
        return;
      }
      pa.en = res.ok ? (data.translation || "") : "";
    } catch { pa.en = ""; }
    const transEl = han?.querySelectorAll(".rd-para")[p]?.querySelector(".rd-trans");
    if (transEl) transEl.textContent = pa.en;
  }
}

/* ---- Exercises: sequential sentence-based practice ---- */
function rdExerciseTargetCount() {
  return Math.min(5, Math.max(0, R.sentences.length));
}

function rdShuffleItems(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function rdCreateOrderExercise(sentence, index) {
  const toks = rdEx1Tokens(sentence);
  if (toks.length < 2) return null;
  const target = toks.slice(0, 8);
  let bank = target.map((t, i) => ({ id: i, t })).sort(() => Math.random() - 0.5);
  if (bank.map(b => b.t).join("") === target.join("") && bank.length > 1) [bank[0], bank[1]] = [bank[1], bank[0]];
  return {
    type: "order",
    sentence,
    index,
    target,
    slots: new Array(target.length).fill(null),
    bank,
    fb: null
  };
}

function rdCreateClozeExercise(sentence, index) {
  const toks = rdEx1Tokens(sentence);
  if (toks.length < 4) return null;
  const ansIdx = Math.min(toks.length - 1, Math.max(1, Math.round(toks.length * 0.6)));
  const answer = toks[ansIdx];
  const joiner = (R.lang === "zh" || R.lang === "ja") ? "" : " ";
  const display = toks.map((t, i) => i === ansIdx ? "___" : t).join(joiner);
  const pool = [...new Set(R.sentences.flatMap(s => rdEx1Tokens(s.text)).filter(t => t !== answer && t.length === answer.length))];
  const distractors = rdShuffleItems(pool).slice(0, 3);
  let opts = [{ t: answer }, ...distractors.map(t => ({ t }))];
  while (opts.length < 2) opts.push({ t: answer + "?" });
  opts = rdShuffleItems(opts);
  return {
    type: "choice",
    sentence,
    index,
    sent: display,
    answer: opts.findIndex(o => o.t === answer),
    opts,
    choice: null,
    fb: null
  };
}

function rdBuildExerciseItems() {
  const target = rdExerciseTargetCount();
  const candidates = R.sentences
    .map((s, i) => ({ text: s.text, i, tokens: rdEx1Tokens(s.text) }))
    .filter(s => s.tokens.length >= 2)
    .slice(0, target);

  return candidates.map((s, pos) => {
    const preferChoice = pos % 2 === 1;
    return (preferChoice ? rdCreateClozeExercise(s.text, pos) : rdCreateOrderExercise(s.text, pos)) ||
      rdCreateOrderExercise(s.text, pos) ||
      rdCreateClozeExercise(s.text, pos);
  }).filter(Boolean);
}

function rdCompleteCurrentExercise(wordsRead = 1) {
  const item = rdExState.items[rdExState.idx];
  if (item) item.done = true;
  recordActivity("words_read", wordsRead);
  setTimeout(() => {
    if (rdExState.idx >= rdExState.items.length - 1) {
      rdExState.view = "done";
    } else {
      rdExState.idx += 1;
    }
    rdRenderExercise();
  }, 800);
}

function rdSkipCurrentExercise() {
  if (rdExState.idx >= rdExState.items.length - 1) {
    rdExState.view = "done";
  } else {
    rdExState.idx += 1;
  }
  rdRenderExercise();
}

function rdRenderExercise() {
  const body = document.getElementById("rdExBody");
  if (!body) return;
  if (!rdExState.items.length && rdExState.view !== "empty") rdStartExerciseSession();

  const total = rdExState.items.length;
  const current = Math.min(total, rdExState.idx + 1);
  const stepLabel = document.getElementById("rdExStepLabel");
  if (stepLabel) {
    stepLabel.textContent = rdExState.view === "done" ? `${total} ${getT().of} ${total} ${getT().completedLabel}`
      : rdExState.view === "empty" ? getT().notEnoughText
      : `${current} ${getT().of} ${total} ${getT().completedLabel}`;
  }

  const segWrap = document.querySelector(".rd-ex-segs");
  if (segWrap) {
    segWrap.innerHTML = Array.from({ length: Math.max(total, 1) }, (_, i) => {
      const done = rdExState.view === "done" || i < rdExState.idx || rdExState.items[i]?.done;
      const active = rdExState.view !== "done" && i === rdExState.idx;
      return `<div class="rd-ex-seg ${done ? "done" : ""} ${active ? "active" : ""}"></div>`;
    }).join("");
  }

  if (rdExState.view === "empty") {
    body.innerHTML = `<p class="rd-loading" style="padding:12px">${escapeHtml(getT().notEnoughText)}</p>`;
    return;
  }
  if (rdExState.view === "done") { rdRenderExDone(body); return; }

  const item = rdExState.items[rdExState.idx];
  if (!item) { rdExState.view = "done"; rdRenderExercise(); return; }
  if (item.type === "choice") { rdRenderSequentialCloze(body, item); return; }
  rdRenderSequentialOrder(body, item);
}

// Fetch (once) and show the exercise sentence's translation under the prompt.
async function rdFillExTranslation(el, holder, sentence) {
  if (!el || !sentence) return;
  if (!holder.trans) {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence, sourceLang: R.lang, targetLang: targetLangSelect.value || "en" })
      });
      const data = await res.json();
      holder.trans = res.ok ? (data.translation || "") : "";
    } catch { holder.trans = ""; }
  }
  el.textContent = holder.trans;
}

function rdRenderSequentialOrder(body, item) {
  const slots = item.slots.map((id, pos) =>
    id == null ? `<span class="rd-slot empty" data-slot="${pos}"></span>`
      : `<button class="rd-slot" data-slot="${pos}" type="button">${escapeHtml(item.bank.find(b => b.id === id)?.t || "")}</button>`).join("");
  const bank = item.bank.map(b => `<button class="rd-chip${item.slots.includes(b.id) ? " used" : ""}" data-bank-id="${b.id}" type="button">${escapeHtml(b.t)}</button>`).join("");
  const fb = item.fb ? `<div class="rd-exfb ${item.fb === "correct" ? "ok" : "no"}">${item.fb === "correct" ? escapeHtml(getT().correctOrder) : escapeHtml(getT().notQuiteTapBack)}</div>` : "";
  body.innerHTML = `
    <div class="rd-excard">
      <div style="display:flex;align-items:center;gap:9px"><span class="rd-extag">${escapeHtml(getT().exerciseWord)} ${rdExState.idx + 1} ${escapeHtml(getT().of)} ${rdExState.items.length}</span><span class="rd-extitle">${escapeHtml(getT().putWordsInOrder)}</span></div>
      <p class="rd-exdesc">${escapeHtml(getT().rebuildScrambled)}</p>
      <p class="rd-extrans" id="rdExTrans">${escapeHtml(item.trans || "")}</p>
      <div class="rd-slots${item.fb === "wrong" ? " wrong" : ""}">${slots}</div>
      <div class="rd-bank">${bank}</div>
      ${fb}
      <div class="rd-exrow">
        <button class="rd-excheck" id="rdExCheck" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg> ${escapeHtml(getT().check)}</button>
        <button class="rd-exskip" id="rdExSkip" type="button">${escapeHtml(getT().skip)}</button>
      </div>
    </div>`;

  rdFillExTranslation(document.getElementById("rdExTrans"), item, item.sentence);

  body.querySelectorAll(".rd-slot:not(.empty)").forEach(sl => sl.addEventListener("click", () => {
    item.slots[Number(sl.dataset.slot)] = null; item.fb = null; rdRenderSequentialOrder(body, item);
  }));
  body.querySelectorAll(".rd-chip").forEach(ch => ch.addEventListener("click", () => {
    const id = Number(ch.dataset.bankId);
    const i = item.slots.indexOf(null);
    if (i < 0 || item.slots.includes(id)) return;
    item.slots[i] = id; item.fb = null; rdRenderSequentialOrder(body, item);
  }));
  document.getElementById("rdExCheck")?.addEventListener("click", () => {
    const placed = item.slots.map(id => id == null ? null : item.bank.find(b => b.id === id)?.t);
    const ok = JSON.stringify(placed) === JSON.stringify(item.target);
    item.fb = ok ? "correct" : "wrong";
    rdRenderSequentialOrder(body, item);
    if (ok) rdCompleteCurrentExercise(item.target.length);
  });
  document.getElementById("rdExSkip")?.addEventListener("click", rdSkipCurrentExercise);
}

function rdRenderSequentialCloze(body, item) {
  const blankCol = item.fb === "correct" ? "var(--good)" : item.fb === "wrong" ? "var(--bad)" : "var(--primary)";
  const blankTxt = item.choice == null ? "＿＿" : item.opts[item.choice].t;
  const blankHtml = `<span style="display:inline-block;min-width:56px;text-align:center;border-bottom:3px solid ${blankCol};color:${item.choice == null ? "#B9B4C7" : blankCol};font-weight:700;margin:0 2px;padding:0 4px">${escapeHtml(blankTxt)}</span>`;
  const sentDisplay = escapeHtml(item.sent).replace("___", blankHtml);
  const opts = item.opts.map((op, i) => {
    let cls = "rd-opt";
    if (item.fb && i === item.answer) cls += " correct";
    else if (item.fb === "wrong" && item.choice === i) cls += " wrong";
    else if (item.choice === i) cls += " sel";
    return `<button class="${cls}" data-opt="${i}" type="button"><span class="zh" style="font-size:22px;font-weight:700">${escapeHtml(op.t)}</span></button>`;
  }).join("");
  const fb = item.fb ? `<div class="rd-exfb ${item.fb === "correct" ? "ok" : "no"}">${item.fb === "correct" ? escapeHtml(getT().correctExcl) : escapeHtml(getT().notQuiteTryAgain)}</div>` : "";
  body.innerHTML = `
    <div class="rd-excard">
      <div style="display:flex;align-items:center;gap:9px"><span class="rd-extag">${escapeHtml(getT().exerciseWord)} ${rdExState.idx + 1} ${escapeHtml(getT().of)} ${rdExState.items.length}</span><span class="rd-extitle">${escapeHtml(getT().chooseMissingWord)}</span></div>
      <p class="rd-exdesc">${escapeHtml(getT().whichWordCompletes)}</p>
      <div class="rd-cloze-sent zh">${sentDisplay}</div>
      <div class="rd-opts">${opts}</div>
      ${fb}
      <div class="rd-exrow">
        <button class="rd-excheck" id="rdExCheck" type="button" ${item.choice == null && !item.fb ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg> ${item.fb === "correct" ? escapeHtml(getT().correctExcl) : escapeHtml(getT().check)}</button>
        <button class="rd-exskip" id="rdExSkip" type="button">${escapeHtml(getT().skip)}</button>
      </div>
    </div>`;

  body.querySelectorAll(".rd-opt").forEach(btn => btn.addEventListener("click", () => {
    if (item.fb === "correct") return;
    item.choice = Number(btn.dataset.opt); item.fb = null; rdRenderSequentialCloze(body, item);
  }));
  document.getElementById("rdExCheck")?.addEventListener("click", () => {
    if (item.choice == null) return;
    const ok = item.choice === item.answer;
    item.fb = ok ? "correct" : "wrong";
    rdRenderSequentialCloze(body, item);
    if (ok) rdCompleteCurrentExercise(1);
  });
  document.getElementById("rdExSkip")?.addEventListener("click", rdSkipCurrentExercise);
}

/* Word-order (Type 1) — self-contained */
const rdEx1 = { slots: [], target: [], bank: [], fb: null };
function rdEx1Tokens(sentence) {
  if (R.lang === "zh" || R.lang === "ja") {
    const segs = segmentCache.get(sentence);
    if (segs && segs.length) return segs.map(s => s.word || s).filter(w => /\S/.test(w) && !/^[，。！？、；：]+$/.test(w));
    return [...sentence].filter(c => /\S/.test(c) && !/[，。！？、；：]/.test(c));
  }
  return sentence.trim().split(/\s+/).filter(Boolean);
}
function rdEx1Init() {
  const sent = R.sentences.map(s => s.text).find(t => {
    const n = rdEx1Tokens(t).length; return n >= 3 && n <= 8;
  }) || R.sentences[0]?.text || "";
  const toks = rdEx1Tokens(sent);
  if (toks.length < 2) { rdEx1.target = []; rdEx1.bank = []; rdEx1.slots = []; return; }
  rdEx1.sentence = sent;
  rdEx1.target = toks;
  rdEx1.slots = new Array(toks.length).fill(null);
  let bank = toks.map((t, i) => ({ id: i, t })).sort(() => Math.random() - 0.5);
  if (bank.map(b => b.t).join("") === toks.join("") && bank.length > 1) [bank[0], bank[1]] = [bank[1], bank[0]];
  rdEx1.bank = bank;
  rdEx1.fb = null;
}
function rdRenderExOrder(body) {
  if (!rdEx1.target.length) rdEx1Init();
  if (!rdEx1.target.length) { body.innerHTML = '<p class="rd-loading" style="padding:12px">Not enough text for this exercise.</p>'; return; }
  const slots = rdEx1.slots.map((id, pos) =>
    id == null ? `<span class="rd-slot empty" data-slot="${pos}"></span>`
      : `<button class="rd-slot" data-slot="${pos}" type="button">${escapeHtml(rdEx1.bank.find(b => b.id === id)?.t || "")}</button>`).join("");
  const bank = rdEx1.bank.map(b => `<button class="rd-chip${rdEx1.slots.includes(b.id) ? " used" : ""}" data-bank-id="${b.id}" type="button">${escapeHtml(b.t)}</button>`).join("");
  const fb = rdEx1.fb ? `<div class="rd-exfb ${rdEx1.fb === "correct" ? "ok" : "no"}">${rdEx1.fb === "correct" ? "太好了！Correct order." : "Not quite — tap a tile to send it back."}</div>` : "";
  body.innerHTML = `
    <div class="rd-excard">
      <div style="display:flex;align-items:center;gap:9px"><span class="rd-extag">Exercise 1</span><span class="rd-extitle">Put the words in order</span></div>
      <p class="rd-exdesc">Rebuild the scrambled sentence.</p>
      <p class="rd-extrans" id="rdEx1Trans">${escapeHtml(rdEx1.trans || "")}</p>
      <div class="rd-slots${rdEx1.fb === "wrong" ? " wrong" : ""}">${slots}</div>
      <div class="rd-bank">${bank}</div>
      ${fb}
      <div class="rd-exrow">
        <button class="rd-excheck" id="rdEx1Check" type="button"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg> Check</button>
        <button class="rd-exskip" id="rdEx1Skip" type="button">Skip</button>
      </div>
    </div>`;
  rdFillExTranslation(document.getElementById("rdEx1Trans"), rdEx1, rdEx1.sentence);

  body.querySelectorAll(".rd-slot:not(.empty)").forEach(sl => sl.addEventListener("click", () => {
    rdEx1.slots[Number(sl.dataset.slot)] = null; rdEx1.fb = null; rdRenderExOrder(body);
  }));
  body.querySelectorAll(".rd-chip").forEach(ch => ch.addEventListener("click", () => {
    const id = Number(ch.dataset.bankId);
    const i = rdEx1.slots.indexOf(null);
    if (i < 0 || rdEx1.slots.includes(id)) return;
    rdEx1.slots[i] = id; rdEx1.fb = null; rdRenderExOrder(body);
  }));
  document.getElementById("rdEx1Check")?.addEventListener("click", () => {
    const placed = rdEx1.slots.map(id => id == null ? null : rdEx1.bank.find(b => b.id === id)?.t);
    const ok = JSON.stringify(placed) === JSON.stringify(rdEx1.target);
    rdEx1.fb = ok ? "correct" : "wrong";
    rdRenderExOrder(body);
    if (ok) { recordActivity("words_read", rdEx1.target.length); setTimeout(() => { rdExState.done.order = true; rdExState.view = rdExState.done.choice ? "done" : "menu"; rdRenderExercise(); }, 900); }
  });
  document.getElementById("rdEx1Skip")?.addEventListener("click", () => { rdExState.view = "menu"; rdRenderExercise(); });
}

/* Cloze (Type 2) — self-contained */
const rdEx2 = { sent: "", answer: 0, opts: [], choice: null, fb: null };
function rdEx2Init() {
  const sent = R.sentences.map(s => s.text).find(t => rdEx1Tokens(t).length >= 4) || "";
  const toks = rdEx1Tokens(sent);
  if (toks.length < 4) { rdEx2.sent = ""; return; }
  // Blank a content word near the middle/end.
  const ansIdx = Math.min(toks.length - 1, Math.max(1, Math.round(toks.length * 0.6)));
  const answer = toks[ansIdx];
  const joiner = (R.lang === "zh" || R.lang === "ja") ? "" : " ";
  const display = toks.map((t, i) => i === ansIdx ? "___" : t).join(joiner);
  // Distractors from other tokens in the passage.
  const pool = [...new Set(R.sentences.flatMap(s => rdEx1Tokens(s.text)).filter(t => t !== answer && t.length === answer.length))];
  const distractors = pool.sort(() => Math.random() - 0.5).slice(0, 3);
  let opts = [{ t: answer }, ...distractors.map(t => ({ t }))];
  while (opts.length < 2) opts.push({ t: answer + "?" });
  opts = opts.sort(() => Math.random() - 0.5);
  rdEx2.sent = display;
  rdEx2.opts = opts;
  rdEx2.answer = opts.findIndex(o => o.t === answer);
  rdEx2.choice = null;
  rdEx2.fb = null;
}
function rdRenderExCloze(body) {
  if (!rdEx2.sent) rdEx2Init();
  if (!rdEx2.sent) { body.innerHTML = '<p class="rd-loading" style="padding:12px">Not enough text for this exercise.</p>'; return; }
  const blankCol = rdEx2.fb === "correct" ? "var(--good)" : rdEx2.fb === "wrong" ? "var(--bad)" : "var(--primary)";
  const blankTxt = rdEx2.choice == null ? "＿＿" : rdEx2.opts[rdEx2.choice].t;
  const blankHtml = `<span style="display:inline-block;min-width:56px;text-align:center;border-bottom:3px solid ${blankCol};color:${rdEx2.choice == null ? "#B9B4C7" : blankCol};font-weight:700;margin:0 2px;padding:0 4px">${escapeHtml(blankTxt)}</span>`;
  const sentDisplay = escapeHtml(rdEx2.sent).replace("___", blankHtml);
  const opts = rdEx2.opts.map((op, i) => {
    let cls = "rd-opt";
    if (rdEx2.fb && i === rdEx2.answer) cls += " correct";
    else if (rdEx2.fb === "wrong" && rdEx2.choice === i) cls += " wrong";
    else if (rdEx2.choice === i) cls += " sel";
    return `<button class="${cls}" data-opt="${i}" type="button"><span class="zh" style="font-size:22px;font-weight:700">${escapeHtml(op.t)}</span></button>`;
  }).join("");
  const fb = rdEx2.fb ? `<div class="rd-exfb ${rdEx2.fb === "correct" ? "ok" : "no"}">${rdEx2.fb === "correct" ? "对了！" : "Not quite — try again."}</div>` : "";
  body.innerHTML = `
    <div class="rd-excard">
      <div style="display:flex;align-items:center;gap:9px"><span class="rd-extag">Exercise 2</span><span class="rd-extitle">Choose the missing word</span></div>
      <p class="rd-exdesc">Which word completes the sentence?</p>
      <div class="rd-cloze-sent zh">${sentDisplay}</div>
      <div class="rd-opts">${opts}</div>
      ${fb}
      <div class="rd-exrow">
        <button class="rd-excheck" id="rdEx2Check" type="button" ${rdEx2.choice == null && !rdEx2.fb ? "disabled" : ""}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg> ${rdEx2.fb === "correct" ? "Correct ✓" : "Check"}</button>
        <button class="rd-exskip" id="rdEx2Skip" type="button">Skip</button>
      </div>
    </div>`;
  body.querySelectorAll(".rd-opt").forEach(btn => btn.addEventListener("click", () => {
    if (rdEx2.fb === "correct") return;
    rdEx2.choice = Number(btn.dataset.opt); rdEx2.fb = null; rdRenderExCloze(body);
  }));
  document.getElementById("rdEx2Check")?.addEventListener("click", () => {
    if (rdEx2.choice == null) return;
    const ok = rdEx2.choice === rdEx2.answer;
    rdEx2.fb = ok ? "correct" : "wrong";
    rdRenderExCloze(body);
    if (ok) setTimeout(() => { rdExState.done.choice = true; rdExState.view = rdExState.done.order ? "done" : "menu"; rdRenderExercise(); }, 900);
  });
  document.getElementById("rdEx2Skip")?.addEventListener("click", () => { rdExState.view = "menu"; rdRenderExercise(); });
}

function rdRenderExMenu(body) {
  const card = (kind, icon, tag, title, desc, hue) => {
    const done = rdExState.done[kind];
    return `<button class="rd-menucard ${done ? "done" : ""}" data-rd-ex="${kind}" type="button">
      <div class="rd-menuicon" style="background:${hue}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#${icon}"/></svg></div>
      <div class="rd-menutext"><div class="rd-menutag">${tag}</div><div class="rd-menutitle">${title}</div><div class="rd-menudesc">${desc}</div></div>
      <span class="rd-menuchev ${done ? "done" : ""}"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#${done ? "sonic-i-check" : "sonic-i-right"}"/></svg></span>
    </button>`;
  };
  body.innerHTML = `
    <div class="rd-ex-h">Choose an exercise</div>
    <div class="rd-ex-sub">Two ways to practise the text you just read.</div>
    ${card("order", "sonic-i-order", "Type 1", "Put the words in order", "Rebuild a scrambled sentence tile by tile.", "linear-gradient(135deg,#E5267E,#FF4D9D)")}
    ${card("choice", "sonic-i-cloze", "Type 2", "Choose the missing word", "Pick the word that completes the sentence.", "linear-gradient(135deg,#0AB4D6,#0E7490)")}
  `;
  body.querySelectorAll("[data-rd-ex]").forEach(btn => {
    btn.addEventListener("click", () => { rdExState.view = btn.dataset.rdEx; rdRenderExercise(); });
  });
}

function rdRenderExDone(body) {
  body.innerHTML = `
    <div class="rd-done">
      <div class="rd-confetti" id="rdConfetti"></div>
      <div class="rd-done-badge"><svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="var(--good)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg></div>
      <div class="rd-done-title">Exercises complete!</div>
      <div class="rd-done-sub">Nice work — you ordered the sentence and filled the blank correctly.</div>
      <div class="rd-done-cta">
        <button class="sp-btn sp-btn-primary" id="rdDoneBack" type="button"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-book"/></svg> <span>Back to reading</span></button>
        <button class="sp-btn sp-btn-ghost" id="rdDoneRetry" type="button"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-retry"/></svg> <span>Try again</span></button>
      </div>
    </div>`;
  spFireConfetti("rdConfetti", true);
  document.getElementById("rdDoneBack")?.addEventListener("click", () => showScreen(screenReadReader));
  document.getElementById("rdDoneRetry")?.addEventListener("click", () => {
    rdExState.done = { order: false, choice: false };
    rdExState.view = "menu";
    rdRenderExercise();
  });
}

/* ============================================================
   READER SETUP  (card-grid setup screen)
   ============================================================ */
const rdSetupState = { tab: "library", sel: { kind: "library", id: null, title: "" }, _libText: null, _level: "" };

function openReadSetup() {
  showScreen(screenReadSetup);
  rdSetupSetTab(rdSetupState.tab || "library");
}

let _rdSetupInited = false;
function rdSetupInit() {
  if (_rdSetupInited) return;
  _rdSetupInited = true;
  document.getElementById("rdSetupSeg")?.querySelectorAll(".rd-setup-seg-btn").forEach(btn => {
    btn.addEventListener("click", () => rdSetupSetTab(btn.dataset.tab));
  });
  document.getElementById("rdSetupInput")?.addEventListener("input", e => {
    const c = document.getElementById("rdSetupCharCount");
    if (c) c.textContent = e.target.value.length;
  });
  document.getElementById("rdSetupStartBtn")?.addEventListener("click", rdSetupStart);
}
rdSetupInit();

function rdSetupSetTab(tab) {
  rdSetupState.tab = tab;
  document.getElementById("rdSetupSeg")?.querySelectorAll(".rd-setup-seg-btn")
    .forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  const paste = document.getElementById("rdSetupPasteTab");
  const lib = document.getElementById("rdSetupLibraryTab");
  const saved = document.getElementById("rdSetupSavedTab");
  if (paste) paste.hidden = tab !== "paste";
  if (lib) lib.hidden = tab !== "library";
  if (saved) saved.hidden = tab !== "saved";
  if (tab === "library") rdSetupLoadLibrary();
  if (tab === "saved") rdSetupLoadSaved();
  rdSetupUpdateStartLabel();
}

function rdSetupUpdateStartLabel() {
  const label = document.getElementById("rdSetupStartLabel");
  if (!label) return;
  if (rdSetupState.tab === "paste") { label.textContent = "Start reading"; return; }
  const title = rdSetupState.sel.title;
  label.textContent = title ? `Start reading · ${title}` : "Start reading";
}

async function rdSetupLoadLibrary() {
  const grid = document.getElementById("rdSetupLibraryTab");
  if (!grid) return;
  const lang = sourceLangSelect?.value || "zh";
  if (libraryCache[lang]) { rdSetupRenderLibrary(libraryCache[lang]); return; }
  grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">Loading…</p>';
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/game-texts?lang=${lang}`);
    const data = await res.json();
    const texts = res.ok ? (data.texts || []) : [];
    libraryCache[lang] = texts;
    rdSetupRenderLibrary(texts);
  } catch {
    grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">Could not load library.</p>';
  }
}

function rdSetupRenderLibrary(texts) {
  const grid = document.getElementById("rdSetupLibraryTab");
  if (!grid) return;
  if (!texts.length) { grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">No texts yet.</p>'; return; }
  grid.innerHTML = texts.map(t => {
    const glyph = (t.title || "文")[0];
    const sel = rdSetupState.sel.kind === "library" && String(rdSetupState.sel.id) === String(t.id);
    const sub = [t.topic, t.level].filter(Boolean).join(" · ");
    return `<div class="rd-savedrow${sel ? " sel" : ""}" data-lib-id="${escapeHtml(t.id)}">
      <button class="rd-savedrow-main" data-lib-id="${escapeHtml(t.id)}" type="button">
        <div class="rd-savedrow-thumb" style="background:linear-gradient(135deg,var(--cyan),var(--cyan-ink))"><span class="rd-savedrow-thumb-glyph">${escapeHtml(glyph)}</span></div>
        <div class="rd-savedrow-body">
          <div class="rd-savedrow-title">${escapeHtml(t.title || "Untitled")}</div>
          <div class="rd-savedrow-sub">${escapeHtml(sub)}</div>
        </div>
      </button>
    </div>`;
  }).join("");
  grid.querySelectorAll(".rd-savedrow-main").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.libId;
      const t = texts.find(x => String(x.id) === String(id));
      if (!t) return;
      rdSetupState.sel = { kind: "library", id, title: t.title || "" };
      rdSetupState._libText = t;
      grid.querySelectorAll(".rd-savedrow").forEach(r => r.classList.toggle("sel", r.dataset.libId === id));
      rdSetupUpdateStartLabel();
    });
  });
  if ((!rdSetupState.sel.id || rdSetupState.sel.kind !== "library") && texts.length) {
    rdSetupState.sel = { kind: "library", id: texts[0].id, title: texts[0].title || "" };
    rdSetupState._libText = texts[0];
    grid.querySelector(".rd-savedrow")?.classList.add("sel");
    rdSetupUpdateStartLabel();
  }
}

async function rdSetupLoadSaved() {
  const list = document.getElementById("rdSetupSavedTab");
  if (!list) return;
  list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Loading…</p>';
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Log in to see saved texts.</p>'; return; }
  try {
    const { data, error } = await supabase
      .from("saved_texts")
      .select("id, title, text, source_lang, target_lang, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    rdSetupRenderSaved(data || []);
  } catch {
    list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Could not load saved texts.</p>';
  }
}

function rdSetupRenderSaved(items) {
  const list = document.getElementById("rdSetupSavedTab");
  if (!list) return;
  if (!items.length) { list.innerHTML = '<p class="rd-loading" style="padding:12px 0">No saved texts yet.</p>'; return; }
  list.innerHTML = items.map(t => {
    const glyph = (t.title || "文")[0];
    const sel = rdSetupState.sel.kind === "saved" && String(rdSetupState.sel.id) === String(t.id);
    return `<div class="rd-savedrow${sel ? " sel" : ""}" data-saved-id="${escapeHtml(t.id)}">
      <button class="rd-savedrow-main" data-saved-id="${escapeHtml(t.id)}" type="button">
        <div class="rd-savedrow-thumb" style="background:linear-gradient(135deg,var(--cyan),var(--cyan-ink))"><span class="rd-savedrow-thumb-glyph">${escapeHtml(glyph)}</span></div>
        <div class="rd-savedrow-body">
          <div class="rd-savedrow-title">${escapeHtml(t.title || "Untitled")}</div>
          <div class="rd-savedrow-sub">${escapeHtml((t.source_lang || "") + (t.target_lang ? " → " + t.target_lang : ""))}</div>
        </div>
      </button>
      <button class="rd-savedrow-del" data-del-id="${escapeHtml(t.id)}" type="button" aria-label="Delete saved text">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-trash"/></svg>
      </button>
    </div>`;
  }).join("");
  list.querySelectorAll(".rd-savedrow-main").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.savedId;
      const t = items.find(x => String(x.id) === String(id));
      if (!t) return;
      rdSetupState.sel = { kind: "saved", id, title: t.title || "", text: t.text || "", source_lang: t.source_lang, target_lang: t.target_lang };
      list.querySelectorAll(".rd-savedrow").forEach(r => r.classList.toggle("sel", r.dataset.savedId === id));
      rdSetupUpdateStartLabel();
    });
  });
  list.querySelectorAll(".rd-savedrow-del").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const confirmed = await showConfirm("Delete this saved text?");
      if (!confirmed) return;
      const { error } = await supabase.from("saved_texts").delete().eq("id", id);
      if (error) { console.error("Delete saved text error:", error); showToast("Could not delete saved text.", "error"); return; }
      savedTextsCache = null;
      if (String(rdSetupState.sel.id) === String(id)) rdSetupState.sel = { kind: "library", id: null, title: "" };
      showToast("Saved text deleted.", "success");
      rdSetupLoadSaved();
      rdSetupUpdateStartLabel();
    });
  });
}

async function rdSetupStart() {
  const startBtn = document.getElementById("rdSetupStartBtn");
  if (startBtn) startBtn.disabled = true;
  appMode = "reading";
  try {
    if (rdSetupState.tab === "paste") {
      const text = document.getElementById("rdSetupInput")?.value || "";
      if (!text.trim()) { showToast("Paste a text first.", "error"); return; }
      currentTextId = null;
      currentTextTitle = "";
      rdSetupState._level = "";
      await startReadingFromText(text);
    } else if (rdSetupState.tab === "library") {
      if (!rdSetupState.sel.id) { showToast("Pick a text first.", "error"); return; }
      rdSetupState._level = rdSetupState._libText?.level || "";
      showMagicLoadingOverlay();
      await loadLibraryText(rdSetupState.sel.id); // sets currentTextId/Title + startReadingFromText
    } else if (rdSetupState.tab === "saved") {
      if (!rdSetupState.sel.id || !rdSetupState.sel.text) { showToast("Pick a text first.", "error"); return; }
      if (rdSetupState.sel.source_lang) sourceLangSelect.value = rdSetupState.sel.source_lang;
      if (rdSetupState.sel.target_lang) targetLangSelect.value = rdSetupState.sel.target_lang;
      updateLanguageBasedUI();
      currentTextId = rdSetupState.sel.id;
      currentTextTitle = rdSetupState.sel.title;
      rdSetupState._level = "";
      await startReadingFromText(rdSetupState.sel.text);
    }
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

/* ============================================================
   READER BOTTOM SHEETS  (voice + word)
   ============================================================ */
function rdOpenSheet(which) {
  document.getElementById("rdScrim")?.classList.add("open");
  document.getElementById("rdVoiceSheet")?.classList.toggle("open", which === "voice");
  document.getElementById("rdWordSheet")?.classList.toggle("open", which === "word");
  if (which === "voice") rdRenderVoiceSheet();
}
function rdCloseSheet() {
  document.getElementById("rdScrim")?.classList.remove("open");
  document.getElementById("rdVoiceSheet")?.classList.remove("open");
  document.getElementById("rdWordSheet")?.classList.remove("open");
  document.querySelectorAll("#rdHan .rd-word.rd-word-sel").forEach(el => el.classList.remove("rd-word-sel"));
}

const RD_VOICE_HUES = ["#0AB4D6", "#E5267E", "#F5B400", "#16A34A"];
function rdRenderVoiceSheet() {
  const list = document.getElementById("rdVoiceList");
  if (!list) return;
  const voices = VOICE_LIST[R.lang] || [];
  if (!voices.length) { list.innerHTML = '<p class="rd-sheet-sub">No voices for this language.</p>'; return; }
  const current = getSelectedVoice(R.lang) || voices[0].name;
  list.innerHTML = voices.map((v, i) => {
    const sel = v.name === current;
    const initial = (v.label || v.name || "•")[0];
    return `<button class="rd-vrow${sel ? " sel" : ""}" data-voice-name="${escapeHtml(v.name)}" type="button">
      <div class="rd-vava" style="background:${RD_VOICE_HUES[i % RD_VOICE_HUES.length]}">${escapeHtml(initial)}</div>
      <div class="rd-vrow-info"><div class="rd-vrow-name">${escapeHtml(v.label || v.name)}</div><div class="rd-vrow-tag">${escapeHtml(v.gender || "")}</div></div>
      ${sel ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg>` : ""}
    </button>`;
  }).join("");
  list.querySelectorAll(".rd-vrow").forEach(row => row.addEventListener("click", () => {
    setSelectedVoice(R.lang, row.dataset.voiceName);
    rdUpdateToolbar();
    rdCloseSheet();
  }));
}

async function rdShowWordSheet(word, pinyin, sentence) {
  const hz = document.getElementById("rdWordHz");
  const py = document.getElementById("rdWordPy");
  const pos = document.getElementById("rdWordPos");
  const en = document.getElementById("rdWordEn");
  if (hz) hz.textContent = word;
  if (py) py.textContent = pinyin || "";
  if (pos) pos.textContent = "";
  if (en) en.textContent = "Looking up…";
  rdOpenSheet("word");

  document.getElementById("rdWordTtsBtn").onclick = () => {
    unlockAudioForMobile();
    playGoogleTTS(word, R.lang, null, null).catch(console.error);
  };

  // Real dictionary lookup (same endpoints as the reader word popup).
  let translation = "";
  let lookedPinyin = pinyin || "";
  try {
    const dictRes = await fetchWithAuth(`${API_BASE}/api/dictionary`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word })
    });
    const dict = await dictRes.json();
    if (dictRes.ok && dict.entries && dict.entries.length) {
      translation = dict.entries[0].definitions.slice(0, 3).join("; ");
      lookedPinyin = dict.entries[0].pinyin || lookedPinyin;
    } else {
      const trRes = await fetchWithAuth(`${API_BASE}/api/translate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sentence: word, sourceLang: R.lang, targetLang: targetLangSelect.value || "en" })
      });
      const tr = await trRes.json();
      translation = trRes.ok ? (tr.translation || "") : "";
    }
  } catch { translation = "Lookup failed."; }
  if (py && lookedPinyin) py.textContent = lookedPinyin;
  if (en) en.textContent = translation || "—";

  // Save button → real flashcard save.
  rdRenderWordSaveBtn(word, false);
  document.getElementById("rdWordSaveBtn").onclick = async () => {
    const saved = await addFlashcard({
      word,
      pinyin: lookedPinyin || "",
      sentence: sentence || "",
      sentencePinyin: "",
      translation: translation || "",
      lang: R.lang
    });
    rdRenderWordSaveBtn(word, true);
    showToast(saved ? "Saved to cards." : "Already saved.", "success");
  };
}

function rdRenderWordSaveBtn(word, saved) {
  const btn = document.getElementById("rdWordSaveBtn");
  if (!btn) return;
  btn.className = "rd-word-save-btn" + (saved ? " saved" : "");
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#${saved ? "sonic-i-check" : "sonic-i-plus"}"/></svg> ${saved ? "Saved to cards" : "Save to cards"}`;
}

/* ============================================================
   SPEAK SETUP
   ============================================================ */
const spSetupState = {
  tab: "paste",
  sel: { kind: "paste", id: null, title: "" },
  _libText: null,
};

function spSetupInit() {
  if (spSetupInit._done) return;
  spSetupInit._done = true;
  document.getElementById("spSetupSeg")?.querySelectorAll(".rd-setup-seg-btn").forEach(btn => {
    btn.addEventListener("click", () => spSetupSetTab(btn.dataset.tab));
  });
  document.getElementById("spSetupInput")?.addEventListener("input", e => {
    const c = document.getElementById("spSetupCharCount");
    if (c) c.textContent = e.target.value.length;
  });
  document.getElementById("spSetupStartBtn")?.addEventListener("click", spSetupStart);
}

function spSetupSetTab(tab) {
  spSetupState.tab = tab || "paste";
  document.getElementById("spSetupSeg")?.querySelectorAll(".rd-setup-seg-btn")
    .forEach(b => b.classList.toggle("on", b.dataset.tab === spSetupState.tab));
  const paste = document.getElementById("spSetupPasteTab");
  const lib = document.getElementById("spSetupLibraryTab");
  const saved = document.getElementById("spSetupSavedTab");
  if (paste) paste.hidden = spSetupState.tab !== "paste";
  if (lib) lib.hidden = spSetupState.tab !== "library";
  if (saved) saved.hidden = spSetupState.tab !== "saved";
  if (spSetupState.tab === "library") spSetupLoadLibrary();
  if (spSetupState.tab === "saved") spSetupLoadSaved();
  spSetupUpdateStartLabel();
}

function spSetupUpdateStartLabel() {
  const label = document.getElementById("spSetupStartLabel");
  if (!label) return;
  if (spSetupState.tab === "paste") {
    label.textContent = "Start speaking";
    return;
  }
  const title = spSetupState.sel.title;
  label.textContent = title ? `Start speaking · ${title}` : "Start speaking";
}

async function spSetupLoadLibrary() {
  const grid = document.getElementById("spSetupLibraryTab");
  if (!grid) return;
  const lang = sourceLangSelect?.value || "zh";
  if (libraryCache[lang]) {
    spSetupRenderLibrary(libraryCache[lang]);
    return;
  }
  grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">Loading…</p>';
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/game-texts?lang=${lang}`);
    const data = await res.json();
    const texts = res.ok ? (data.texts || []) : [];
    libraryCache[lang] = texts;
    spSetupRenderLibrary(texts);
  } catch {
    grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">Could not load library.</p>';
  }
}

function spSetupRenderLibrary(texts) {
  const grid = document.getElementById("spSetupLibraryTab");
  if (!grid) return;
  if (!texts.length) {
    grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">No texts yet.</p>';
    return;
  }
  grid.innerHTML = texts.map(t => {
    const glyph = (t.title || "文")[0];
    const sel = spSetupState.sel.kind === "library" && String(spSetupState.sel.id) === String(t.id);
    const sub = [t.topic, t.level].filter(Boolean).join(" · ");
    return `<div class="rd-savedrow${sel ? " sel" : ""}" data-lib-id="${escapeHtml(t.id)}">
      <button class="rd-savedrow-main" data-lib-id="${escapeHtml(t.id)}" type="button">
        <div class="rd-savedrow-thumb" style="background:linear-gradient(135deg,var(--cyan),var(--cyan-ink))"><span class="rd-savedrow-thumb-glyph">${escapeHtml(glyph)}</span></div>
        <div class="rd-savedrow-body">
          <div class="rd-savedrow-title">${escapeHtml(t.title || "Untitled")}</div>
          <div class="rd-savedrow-sub">${escapeHtml(sub)}</div>
        </div>
      </button>
    </div>`;
  }).join("");
  grid.querySelectorAll(".rd-savedrow-main").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.libId;
      const t = texts.find(x => String(x.id) === String(id));
      if (!t) return;
      spSetupState.sel = { kind: "library", id, title: t.title || "" };
      spSetupState._libText = t;
      grid.querySelectorAll(".rd-savedrow").forEach(r => r.classList.toggle("sel", r.dataset.libId === id));
      spSetupUpdateStartLabel();
    });
  });
  if ((!spSetupState.sel.id || spSetupState.sel.kind !== "library") && texts.length) {
    spSetupState.sel = { kind: "library", id: texts[0].id, title: texts[0].title || "" };
    spSetupState._libText = texts[0];
    grid.querySelector(".rd-savedrow")?.classList.add("sel");
    spSetupUpdateStartLabel();
  }
}

async function spSetupLoadSaved() {
  const list = document.getElementById("spSetupSavedTab");
  if (!list) return;
  list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Loading…</p>';
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Log in to see saved texts.</p>';
    return;
  }
  try {
    const { data, error } = await supabase
      .from("saved_texts")
      .select("id, title, text, source_lang, target_lang, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    spSetupRenderSaved(data || []);
  } catch {
    list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Could not load saved texts.</p>';
  }
}

function spSetupRenderSaved(items) {
  const list = document.getElementById("spSetupSavedTab");
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<p class="rd-loading" style="padding:12px 0">No saved texts yet.</p>';
    return;
  }
  list.innerHTML = items.map(t => {
    const glyph = (t.title || "文")[0];
    const sel = spSetupState.sel.kind === "saved" && String(spSetupState.sel.id) === String(t.id);
    return `<div class="rd-savedrow${sel ? " sel" : ""}" data-saved-id="${escapeHtml(t.id)}">
      <button class="rd-savedrow-main" data-saved-id="${escapeHtml(t.id)}" type="button">
        <div class="rd-savedrow-thumb" style="background:linear-gradient(135deg,var(--primary),var(--primary-soft))"><span class="rd-savedrow-thumb-glyph">${escapeHtml(glyph)}</span></div>
        <div class="rd-savedrow-body">
          <div class="rd-savedrow-title">${escapeHtml(t.title || "Untitled")}</div>
          <div class="rd-savedrow-sub">${escapeHtml((t.source_lang || "") + (t.target_lang ? " → " + t.target_lang : ""))}</div>
        </div>
      </button>
      <button class="rd-savedrow-del" data-del-id="${escapeHtml(t.id)}" type="button" aria-label="Delete saved text">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-trash"/></svg>
      </button>
    </div>`;
  }).join("");
  list.querySelectorAll(".rd-savedrow-main").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.savedId;
      const t = items.find(x => String(x.id) === String(id));
      if (!t) return;
      spSetupState.sel = { kind: "saved", id, title: t.title || "", text: t.text || "", source_lang: t.source_lang, target_lang: t.target_lang };
      list.querySelectorAll(".rd-savedrow").forEach(r => r.classList.toggle("sel", r.dataset.savedId === id));
      spSetupUpdateStartLabel();
    });
  });
  list.querySelectorAll(".rd-savedrow-del").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = btn.dataset.delId;
      const confirmed = await showConfirm("Delete this saved text?");
      if (!confirmed) return;
      const { error } = await supabase.from("saved_texts").delete().eq("id", id);
      if (error) {
        console.error("Delete saved text error:", error);
        showToast("Could not delete saved text.", "error");
        return;
      }
      savedTextsCache = null;
      if (String(spSetupState.sel.id) === String(id)) spSetupState.sel = { kind: "paste", id: null, title: "" };
      showToast("Saved text deleted.", "success");
      spSetupLoadSaved();
      spSetupUpdateStartLabel();
    });
  });
}

async function spSetupStart() {
  const startBtn = document.getElementById("spSetupStartBtn");
  if (startBtn) startBtn.disabled = true;
  appMode = "pronunciation";
  try {
    if (spSetupState.tab === "paste") {
      const text = document.getElementById("spSetupInput")?.value || "";
      if (!text.trim()) { showToast("Paste a text first.", "error"); return; }
      currentTextId = null;
      currentTextTitle = "";
      await startReadingFromText(text);
    } else if (spSetupState.tab === "library") {
      if (!spSetupState.sel.id) { showToast("Pick a text first.", "error"); return; }
      showMagicLoadingOverlay();
      await loadLibraryText(spSetupState.sel.id);
    } else if (spSetupState.tab === "saved") {
      if (!spSetupState.sel.id || !spSetupState.sel.text) { showToast("Pick a text first.", "error"); return; }
      if (spSetupState.sel.source_lang) sourceLangSelect.value = spSetupState.sel.source_lang;
      if (spSetupState.sel.target_lang) targetLangSelect.value = spSetupState.sel.target_lang;
      updateLanguageBasedUI();
      currentTextId = spSetupState.sel.id;
      currentTextTitle = spSetupState.sel.title;
      await startReadingFromText(spSetupState.sel.text);
    }
  } finally {
    hideMagicLoadingOverlay();
    if (startBtn) startBtn.disabled = false;
  }
}

spSetupInit();

createBtn?.addEventListener("click", async () => {
  // Gate text processing for signed-in users (guests are unlimited). Free users
  // get FREE_DAILY_TEXT_LIMIT/day; this call also meters the count.
  const { data: sess } = await supabase.auth.getSession();
  if (sess.session) {
    try {
      const res = await fetchWithAuth(`${API_BASE}/api/check-text-quota`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (!res.ok) {
        if (typeof data.used === "number") userPlan.textUsedToday = data.used;
        renderTextCounter();
        if (data.code) showUpgradePrompt(data.code, createBtn);
        else showToast(data.error || "Could not start.", "error");
        return;
      }
      if (typeof data.used === "number") {
        userPlan.textUsedToday = data.used;
        renderTextCounter();
      }
    } catch {
      // Fail open on network error — don't block a legitimate user.
    }
  }
  currentTextId    = null;
  currentTextTitle = "";
  await startReadingFromText(inputText.value);
});

editTextBtn?.addEventListener("click", () => {
  if (startComposerArea) startComposerArea.hidden = false;
  if (inputText) inputText.hidden = false;

  inputText?.scrollIntoView({ behavior: "smooth", block: "center" });
  inputText?.focus();
});

replaceTextBtn?.addEventListener("click", () => {
  stopAllTTS();
  stopRecognition();

  currentText = "";
  currentSentences = [];

  if (inputText) inputText.value = "";
  if (inputText) inputText.hidden = false;
  if (startComposerArea) startComposerArea.hidden = false;
  if (container) container.innerHTML = "";
  if (fullTextContent) fullTextContent.innerHTML = "";
  if (fullTextPinyin) fullTextPinyin.textContent = "";
  if (fullTextTranslation) fullTextTranslation.textContent = "";
  if (fullTextPanel) fullTextPanel.hidden = true;

  inputText?.scrollIntoView({ behavior: "smooth", block: "center" });
  inputText?.focus();
});

document.getElementById("toggleFullTextBtn")?.addEventListener("click", () => {
  if (!fullTextContent) return;

  const btn = document.getElementById("toggleFullTextBtn");
  const isHidden = fullTextContent.hidden;

  fullTextContent.hidden = !isHidden;

  if (btn) {
    btn.textContent = isHidden ? getT().hideFullText : getT().showFullText;
  }
});
/* -----------------------------
   LIBRARY
----------------------------- */

openLibraryBtn?.addEventListener("click", async () => {
  if (savedTextsPanel) savedTextsPanel.hidden = true;
  if (textLibraryPanel) textLibraryPanel.hidden = !textLibraryPanel.hidden;

  if (!textLibraryPanel.hidden) {
    await loadTextLibrary();
  }
});

async function loadTextLibrary() {
  if (!textLibraryList || !sourceLangSelect) return;

  const lang = sourceLangSelect.value;

  if (libraryCache[lang]) {
    renderLibraryList(libraryCache[lang]);
    return;
  }

  textLibraryList.innerHTML = `<p class="subtle">Loading library...</p>`;

  try {
    const res = await fetchWithAuth(`${API_BASE}/api/game-texts?lang=${lang}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load library");
    }

    const texts = data.texts || [];
    libraryCache[lang] = texts;
    renderLibraryList(texts);
  } catch (err) {
    console.error("Library load error:", err);
    textLibraryList.innerHTML = `<p class="subtle">Could not load library.</p>`;
  }
}

function renderLibraryList(texts) {
  if (!textLibraryList) return;

    if (!texts.length) {
      textLibraryList.innerHTML = `<p class="subtle">No library texts for this language yet.</p>`;
      return;
    }

    textLibraryList.innerHTML = texts.map(text => `
      <button class="text-library-item" data-id="${escapeHtml(text.id)}">
        <span class="text-library-title">${escapeHtml(text.title || "Untitled")}</span>
        <span class="text-library-meta">
          ${escapeHtml(text.level || "Text")}
          ${text.topic ? ` · ${escapeHtml(text.topic)}` : ""}
          ${text.cardCount ? ` · ${text.cardCount} cards` : ""}
        </span>
      </button>
    `).join("");

    textLibraryList.querySelectorAll(".text-library-item").forEach(item => {
      item.addEventListener("click", async () => {
        textLibraryPanel.hidden = true;
        showMagicLoadingOverlay();
        await loadLibraryText(item.dataset.id);
      });
    });
}

async function loadLibraryText(id) {
  try {
    const lang = sourceLangSelect.value;
    const res = await fetchWithAuth(`${API_BASE}/api/game-texts/${id}?lang=${lang}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load text");
    }

    const fullText = (data.sentences || []).join(" ").trim();

    if (!fullText) {
      showToast("This library text is empty.", "error");
      return;
    }

    currentTextId    = `lib_${id}`;
    currentTextTitle = data.title || "Library text";
    await startReadingFromText(fullText);
  } catch (err) {
    console.error("Text load error:", err);
    showToast("Could not open this text.", "error");
  } finally {
    hideMagicLoadingOverlay();
  }
}

/* -----------------------------
   SAVED TEXTS
----------------------------- */

showSavedTextsBtn?.addEventListener("click", async () => {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    document.getElementById("authOverlay")?.removeAttribute("hidden");
    document.body.style.overflow = "hidden";
    return;
  }

  if (textLibraryPanel) textLibraryPanel.hidden = true;

  if (!savedTextsPanel.hidden) {
    savedTextsPanel.hidden = true;
    return;
  }

  await loadSavedTexts(true);
});

document.getElementById("savedTextsBtnToolbar")?.addEventListener("click", async () => {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    document.getElementById("authOverlay")?.removeAttribute("hidden");
    document.body.style.overflow = "hidden";
    return;
  }
  if (textLibraryPanel) textLibraryPanel.hidden = true;
  await loadSavedTexts(true);
});

async function loadSavedTexts(forceOpen = false) {
  if (!savedTextsPanel || !savedTextsList) return;

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    showToast("Please log in first.", "error");
    return;
  }

  if (!forceOpen) {
    savedTextsPanel.hidden = !savedTextsPanel.hidden;
  } else {
    savedTextsPanel.hidden = false;
  }

  if (savedTextsPanel.hidden) return;

  savedTextsList.innerHTML = "Loading saved texts...";

  let data = savedTextsCache;
  let error = null;

  if (!data) {
    const result = await supabase
      .from("saved_texts")
      .select("id, title, text, source_lang, target_lang, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    data = result.data;
    error = result.error;
    savedTextsCache = data;
  }

  if (error) {
    console.error("Load saved texts error:", error);
    savedTextsList.innerHTML = getT().savedTextsError;
    return;
  }

  if (!data || !data.length) {
    savedTextsList.innerHTML = `<p class="subtle">No saved texts yet.</p>`;
    return;
  }

  savedTextsList.innerHTML = data.map(item => `
    <div class="saved-text-item" data-id="${escapeHtml(item.id)}">
      <div>
        <strong>${escapeHtml(item.title || "Untitled text")}</strong>
        <p>${escapeHtml(item.source_lang || "")} → ${escapeHtml(item.target_lang || "")}</p>
      </div>
      <div class="saved-text-actions">
        <button class="load-saved-text-btn" data-id="${escapeHtml(item.id)}">Open</button>
        <button class="delete-saved-text-btn" data-id="${escapeHtml(item.id)}">Delete</button>
      </div>
    </div>
  `).join("");

  savedTextsList.querySelectorAll(".load-saved-text-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const savedText = data.find(item => item.id === btn.dataset.id);
      if (!savedText) return;

      savedTextsPanel.hidden = true;
      showMagicLoadingOverlay();

      if (savedText.source_lang) sourceLangSelect.value = savedText.source_lang;
      if (savedText.target_lang) targetLangSelect.value = savedText.target_lang;

      updateLanguageBasedUI();
      currentTextId    = savedText.id;
      currentTextTitle = savedText.title || "Saved text";
      await startReadingFromText(savedText.text || "");
    });
  });

  savedTextsList.querySelectorAll(".delete-saved-text-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const confirmed = await showConfirm("Delete this saved text?");
    if (!confirmed) return;

    const { error } = await supabase
      .from("saved_texts")
      .delete()
      .eq("id", btn.dataset.id);

    if (error) {
      console.error("Delete saved text error:", error);
      showToast("Could not delete saved text.", "error");
      return;
    }
    savedTextsCache = null;
    savedTextsPanel.hidden = true;
    await loadSavedTexts(true);
  });
});
}

document.querySelectorAll("#saveTextBtn, #saveTextBtnReading").forEach(btn => {
  btn?.addEventListener("click", async () => {
  const text = inputText.value.trim();

  if (!text) {
    showToast("Please paste a text first.", "error");
    return;
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    showToast("Please log in first.", "error");
    return;
  }

  // Gate: free users can save up to FREE_MAX_SAVED_TEXTS texts.
  try {
    const q = await fetchWithAuth(`${API_BASE}/api/check-save-text-quota`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const qd = await q.json();
    if (!q.ok) {
      if (qd.code) showUpgradePrompt(qd.code, btn);
      else showToast(qd.error || "Could not save text.", "error");
      return;
    }
  } catch {
    // Fail open on network error.
  }

  const title = (await showPrompt("Text title:", "Untitled text")) || "Untitled text";

  const { error } = await supabase.from("saved_texts").insert({
    user_id: user.id,
    title,
    text,
    source_lang: sourceLangSelect.value,
    target_lang: targetLangSelect.value
  });

  if (error) {
    console.error("Save text error:", error);
    showToast("Could not save text.", "error");
    return;
  }
  savedTextsCache = null;
  showToast("Text saved!", "success");
});
});

/* -----------------------------
   FULL TEXT
----------------------------- */

async function showImportedText(text) {
  if (!fullTextPanel || !fullTextContent || !fullTextPinyin) return;

  fullTextPanel.hidden = false;

  if (sourceLangSelect.value === "zh") {
    const html = await renderChineseSentence(text);
    fullTextContent.innerHTML = html;
    attachWordListeners(fullTextContent);

    const cachedWords = segmentCache.get(text) || [];

    fullTextPinyin.textContent = cachedWords
      .map(item => item.pinyin || item.word)
      .join(" ");
      } else {
        fullTextContent.innerHTML = renderClickableSentence(text, sourceLangSelect.value);
        fullTextPinyin.textContent = "";
        attachWordListeners(fullTextContent);
      }

  if (fullTextTranslation) fullTextTranslation.textContent = "";
  fullTextPinyin.hidden = true;

  const toggleBtn = document.getElementById("toggleFullTextPinyinBtn");
  if (toggleBtn) {
    toggleBtn.classList.remove("is-active");
    toggleBtn.setAttribute("aria-pressed", "false");
  }
}

document.getElementById("toggleFullTextPinyinBtn")?.addEventListener("click", () => {
  if (!fullTextPinyin) return;

  const btn = document.getElementById("toggleFullTextPinyinBtn");
  const willShow = fullTextPinyin.hidden;

  fullTextPinyin.hidden = !willShow;
  if (btn) {
    btn.classList.toggle("is-active", willShow); // label stays; switch shows on/off
    btn.setAttribute("aria-pressed", willShow ? "true" : "false");
  }
});

document.getElementById("readFullTextBtn")?.addEventListener("click", async () => {
  unlockAudioForMobile();
  window.speechSynthesis?.cancel();
  if (!fullTextContent) return;

  const text = fullTextContent.dataset.fullSentence || fullTextContent.textContent.trim();
  if (!text) return;

  const cleanText = await prepareTTSInput(text, sourceLangSelect.value);
  stopAllTTS();
  await playGoogleTTS(cleanText, sourceLangSelect.value, null, fullTextContent);
});

document.getElementById("translateFullTextBtn")?.addEventListener("click", async () => {
  if (!fullTextContent || !fullTextTranslation) return;

  const text = fullTextContent.dataset.fullSentence || fullTextContent.textContent.trim();
  if (!text) return;
  trackGuest("translations");

  try {
    fullTextTranslation.textContent = "Translating...";

    const response = await fetchWithAuth(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sentence: text,
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Translation failed");
    }

    fullTextTranslation.textContent = data.translation || "";
  } catch (error) {
    console.error("Full text translation error:", error);
    fullTextTranslation.textContent = "Translation failed.";
  }
});



/* -----------------------------
   SLOW MODE
----------------------------- */

function updateSlowLabels() {
  const t = getT();
  const label = ttsSpeedMode === 2 ? (t.extraSlow || "Extra slow") : (t.slow || "Slow");

  ["globalSlowBtn", "flashcardSlowBtn", "spSlowBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const lbl = el.querySelector(".toggle-label");
    if (lbl) lbl.textContent = label;
    el.classList.toggle("is-active", ttsSpeedMode > 0);
    el.classList.toggle("is-extra-slow", ttsSpeedMode === 2);
    el.setAttribute("aria-pressed", ttsSpeedMode > 0 ? "true" : "false");
  });
}

function toggleSlowMode() {
  ttsSpeedMode = (ttsSpeedMode + 1) % 3;
  stopAllTTS();
  updateSlowLabels();
}

function getTtsRate() {
  return ttsSpeedMode === 2 ? 0.75 : ttsSpeedMode === 1 ? 0.85 : 1.0;
}

function getTtsSpeedLabel() {
  return `${getTtsRate().toFixed(2).replace(/0$/, "")}×`;
}

globalSlowBtn?.addEventListener("click", toggleSlowMode);
document.getElementById("spSlowBtn")?.addEventListener("click", toggleSlowMode);

/* -----------------------------
   "MORE" OVERFLOW MENUS
----------------------------- */

function closeAllMoreMenus() {
  document.querySelectorAll(".tb-more-menu").forEach(m => { m.hidden = true; });
  document.querySelectorAll("[data-more-toggle]").forEach(b => b.setAttribute("aria-expanded", "false"));
}

document.querySelectorAll("[data-more-toggle]").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = btn.parentElement.querySelector(".tb-more-menu");
    if (!menu) return;
    const willOpen = menu.hidden;
    closeAllMoreMenus();
    menu.hidden = !willOpen;
    btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
  });
});

// Clicking any item closes its menu (the item's own handler still runs).
document.querySelectorAll(".tb-more-menu").forEach(menu => {
  menu.addEventListener("click", () => {
    menu.hidden = true;
    menu.closest(".tb-more")
      ?.querySelector("[data-more-toggle]")
      ?.setAttribute("aria-expanded", "false");
  });
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".tb-more")) closeAllMoreMenus();
});

document.getElementById("voicePickerBtn")?.addEventListener("click", openVoicePicker);
document.getElementById("voicePickerBtnComposer")?.addEventListener("click", openVoicePicker);
document.addEventListener("click", (e) => {
  const panel = document.getElementById("voicePickerPanel");
  if (!panel || panel.hidden) return;
  if (!e.target.closest("#voicePickerPanel") &&
      !e.target.closest("#voicePickerBtn") &&
      !e.target.closest("#voicePickerBtnComposer")) {
    panel.hidden = true;
  }
});
sourceLangSelect?.addEventListener("change", () => {
  const panel = document.getElementById("voicePickerPanel");
  if (panel) panel.hidden = true;
}, { capture: true });
document.getElementById("flashcardSlowBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSlowMode();
});

/* -----------------------------
   SENTENCE RENDERING
----------------------------- */

function renderClickableSentence(sentence, lang) {
  return sentence
    .split(/(\s+)/)
    .map(part => {
      if (/^\s+$/.test(part)) return part;

      const cleanWord = part.replace(/[.,!?;:«»"'()\[\]{}…。，！？、]/g, "");
      if (!cleanWord) return escapeHtml(part);

      return `<span class="word" data-word="${escapeHtml(cleanWord)}">${escapeHtml(part)}</span>`;
    })
    .join("");
}

async function renderChineseSentence(sentence) {
  let words = segmentCache.get(sentence);

  if (!words) {
    const response = await fetchWithAuth(`${API_BASE}/api/segment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: sentence })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Segmentation failed");
    }

    words = data.words || [];
    if (segmentCache.size >= 100) segmentCache.delete(segmentCache.keys().next().value);
    segmentCache.set(sentence, words);
  }

  return words.map(item => {
    const word = item.word;
    const py = item.pinyin || "";

    if (/[，。！？；：、“”‘’（）,.!?;:]/.test(word)) {
      return `<span class="punctuation">${escapeHtml(word)}</span>`;
    }

    return `<span class="word" data-word="${escapeHtml(word)}" data-pinyin="${escapeHtml(py)}">${escapeHtml(word)}</span>`;
  }).join("");
}


function trackGuest(event) {
  if (document.body.classList.contains("is-logged-in")) return;

  if (guestUsage.graceModeActive) {
    if (event === "cardsPlayed") guestUsage.graceListens++;
    if (event === "wordClicks")  guestUsage.graceWords++;
    if (guestUsage.graceListens >= 5 && guestUsage.graceWords >= 5) {
      maybeShowAuthOverlay();
    }
    return;
  }

  if (event in guestUsage) guestUsage[event]++;

  const limitReached =
    guestUsage.fullTextsGenerated >= 2 ||
    guestUsage.cardsPlayed >= 12 ||
    guestUsage.wordClicks >= 20 ||
    guestUsage.translations >= 8;

  if (limitReached) maybeShowAuthOverlay();
}

async function maybeShowAuthOverlay() {
  const { data } = await supabase.auth.getSession();
  if (data.session) return;
  if (authPromptShown) return;
  authPromptShown = true;

  if (!authFriendlyShown) {
    authFriendlyShown = true;

    const nudge = document.createElement("div");
    nudge.className = "modal-overlay";
    nudge.innerHTML = `
      <div class="modal-box guest-nudge-box">
        <h3 class="guest-nudge-title">Enjoying Magic Read?</h3>
        <p class="guest-nudge-body">Create a free account to save texts, flashcards, and progress.</p>
        <div class="modal-actions">
          <button class="modal-cancel ghost-btn">Continue for now</button>
          <button class="modal-confirm primary-btn">Create free account</button>
        </div>
      </div>
    `;
    document.body.appendChild(nudge);

    nudge.querySelector(".modal-confirm").addEventListener("click", () => {
      nudge.remove();
      openAuthFromOverlay("signup");
    });

    nudge.querySelector(".modal-cancel").addEventListener("click", () => {
      nudge.remove();
      guestUsage.graceModeActive = true;
      guestUsage.graceListens = 0;
      guestUsage.graceWords = 0;
      authPromptShown = false;
    });
  } else {
    const overlay = document.getElementById("authOverlay");
    if (overlay) {
      overlay.hidden = false;
      document.body.style.overflow = "hidden";
    }
  }
}

async function renderCards(sentences) {
  if (!container) return;

  container.innerHTML = `<p class="subtle">Creating practice cards...</p>`;

  const labels = {
    zh: "中文",
    ru: "RU",
    tr: "TR",
    en: "EN",
    de: "DE",
    es: "ES",
    fr: "FR",
    hy: "HY",
    ka: "KA",
    ja: "日本語"
  };

  const t = getT();
  const badgeText =
    labels[sourceLangSelect.value] ||
    sourceLangSelect.value.toUpperCase();

  const cardHtmlList = await Promise.all(
    sentences.map(async (sentence, index) => {
      const sentenceHtml =
        sourceLangSelect.value === "zh"
          ? await renderChineseSentence(sentence)
          : renderClickableSentence(sentence, sourceLangSelect.value);

      return `
        <div class="card" data-card-index="${index}">
          <div class="card-head">
            <p class="card-progress">Sentence ${index + 1} <span class="card-progress-total">of ${sentences.length}</span></p>
            <span class="card-badge">${badgeText}</span>
          </div>

          <p class="sentence clickable-sentence" data-full-sentence="${escapeHtml(sentence)}">${sentenceHtml}</p>
          <div class="sentence-pinyin-box panel-box" hidden></div>

          <div class="card-action-row">
            <button class="tts-btn card-primary-btn">${escapeHtml(t.listen)}</button>
            <button class="record-btn card-primary-btn">${escapeHtml(t.yourTurn || "Speak now")}</button>

            <div class="card-more">
              <button class="more-btn" type="button" aria-label="More">⋯</button>
              <div class="more-menu" hidden>
                ${sourceLangSelect.value === "zh"
                  ? `<button class="sentence-pinyin-btn" type="button">Show pinyin</button>`
                  : ""}
                <button class="translate-btn" type="button">${escapeHtml(t.showTranslation)}</button>
              </div>
            </div>
          </div>

          <div class="translation-box panel-box"></div>
          <div class="pronunciation-box panel-box"></div>
        </div>
      `;
    })
  );

  container.innerHTML = cardHtmlList.join("");

  container.querySelectorAll(".card").forEach((card, index) => {
    const sentence = sentences[index];

    const ttsBtn = card.querySelector(".tts-btn");
    const recordBtn = card.querySelector(".record-btn");
    const translateBtn = card.querySelector(".translate-btn");
    const sentencePinyinBtn = card.querySelector(".sentence-pinyin-btn");
    const sentencePinyinBox = card.querySelector(".sentence-pinyin-box");
    const moreBtn = card.querySelector(".more-btn");
    const moreMenu = card.querySelector(".more-menu");
    const sentenceEl = card.querySelector(".clickable-sentence");

    attachWordListeners(sentenceEl);

    moreBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (moreMenu) moreMenu.hidden = !moreMenu.hidden;
    });

    ttsBtn?.addEventListener("click", async () => {
      unlockAudioForMobile();
      trackGuest("cardsPlayed");
      saveProgress("speaking", currentTextId, { sentence: index }, currentTextTitle);

      const cleanSentence = await prepareTTSInput(sentence, sourceLangSelect.value);

      const isSameAudio =
        currentAudio &&
        currentAudioText === cleanSentence &&
        currentAudioRate === getTtsRate();

      if (isSameAudio && !audioCtxSuspended) {
        ttsAudioEl.pause();
        audioCtxSuspended = true;
        ttsBtn.textContent = t.listen;
        return;
      }

      if (isSameAudio && audioCtxSuspended) {
        ttsAudioEl.play().catch(() => {});
        audioCtxSuspended = false;
        ttsBtn.textContent = getT().pause;
        return;
      }

      ttsBtn.textContent = getT().pause;

      const onSentenceEnd = () => {
        ttsBtn.textContent = getT().listen || "Listen";
        if (recordBtn) {
          recordBtn.hidden = false;
          recordBtn.textContent = getT().yourTurn || "Your turn";
        }
      };

      await playGoogleTTS(cleanSentence, sourceLangSelect.value, onSentenceEnd, sentenceEl);
    });

    translateBtn?.addEventListener("click", () => {
      if (moreMenu) moreMenu.hidden = true;
      translateSentence(sentence, card);
    });

    sentencePinyinBtn?.addEventListener("click", async () => {
      if (moreMenu) moreMenu.hidden = true;
      if (!sentencePinyinBox) return;

      if (!sentencePinyinBox.textContent.trim()) {
        sentencePinyinBox.textContent = "Loading pinyin...";

        try {
          const response = await fetchWithAuth(`${API_BASE}/api/segment`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ text: sentence })
          });

          const data = await response.json();

          if (!response.ok) {
            throw new Error(data.error || "Pinyin failed");
          }

          sentencePinyinBox.textContent = (data.words || [])
            .map(item => item.pinyin || item.word)
            .join(" ");
        } catch (err) {
          console.error("Sentence pinyin error:", err);
          sentencePinyinBox.textContent = getT().pinyinError;
        }
      }

      sentencePinyinBox.hidden = !sentencePinyinBox.hidden;
      sentencePinyinBtn.textContent = sentencePinyinBox.hidden
        ? getT().showPinyin
        : getT().hidePinyin;
    });

    recordBtn?.addEventListener("click", () => {
      saveProgress("speaking", currentTextId, { sentence: index }, currentTextTitle);
      record(sentence, card, recordBtn);
    });

  });

  buildWordOrderExercise(sentences);
}

/* -----------------------------
   WORD ORDER EXERCISE
----------------------------- */

function buildWordOrderExercise(sentences, onComplete) {
  const section = document.getElementById("wordOrderExercise");
  if (!section || !sentences.length) return;

  const isZh = sourceLangSelect.value === "zh";
  const picks = sentences.slice(0, 3);
  let currentIdx = 0;

  function tokenize(sentence) {
    if (isZh) {
      const segs = segmentCache.get(sentence);
      if (segs && segs.length) return segs.map(s => s.word || s).filter(w => /\S/.test(w));
      return [...sentence].filter(c => /\S/.test(c));
    }
    return sentence.trim().split(/\s+/);
  }

  function renderStep(idx) {
    if (idx >= picks.length) {
      section.innerHTML = '<p class="wo-done">All done! ✓</p>';
      onComplete?.();
      return;
    }
    const sentence = picks[idx];
    const words = tokenize(sentence);
    if (words.length < 2) { renderStep(idx + 1); return; }

    const shuffled = [...words].sort(() => Math.random() - 0.5);
    if (JSON.stringify(shuffled) === JSON.stringify(words) && shuffled.length > 1) {
      [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
    }

    let placed = [];

    section.innerHTML = `
      <div class="wo-head">
        <span class="wo-tag">Exercise</span>
        <h3>Put the words in order</h3>
      </div>
      <p class="subtle wo-prompt">Tap a word to place it. Tap a placed word to return it.</p>
      <div class="wo-slots" id="woSlots"></div>
      <div class="wo-bank" id="woBank">
        ${shuffled.map((w, i) => `<button class="wo-chip" data-idx="${i}" type="button">${escapeHtml(w)}</button>`).join("")}
      </div>
      <div class="wo-foot">
        <button id="woCheckBtn" class="primary-btn" type="button">Check</button>
        <button id="woSkipBtn" class="text-link-btn" type="button">Skip</button>
      </div>
    `;

    const slotsEl = document.getElementById("woSlots");
    const bankEl = document.getElementById("woBank");

    function addSlot(word, chipIdx) {
      placed.push({ word, chipIdx });
      const btn = document.createElement("button");
      btn.className = "wo-slot";
      btn.type = "button";
      btn.textContent = word;
      btn.dataset.chipIdx = String(chipIdx);
      btn.addEventListener("click", () => {
        placed = placed.filter(p => p.chipIdx !== Number(chipIdx));
        btn.remove();
        bankEl.querySelector(`[data-idx="${chipIdx}"]`)?.classList.remove("wo-chip-used");
      });
      slotsEl.appendChild(btn);
    }

    bankEl.querySelectorAll(".wo-chip").forEach(chip => {
      chip.addEventListener("click", () => {
        if (chip.classList.contains("wo-chip-used")) return;
        chip.classList.add("wo-chip-used");
        addSlot(chip.textContent, Number(chip.dataset.idx));
      });
    });

    document.getElementById("woCheckBtn")?.addEventListener("click", () => {
      const answer = placed.map(p => p.word).join(isZh ? "" : " ");
      const correct = words.join(isZh ? "" : " ");
      if (answer === correct) {
        showToast("Correct!", "success");
        currentIdx++;
        setTimeout(() => renderStep(currentIdx), 700);
      } else {
        showToast("Not quite — try again!", "info");
      }
    });

    document.getElementById("woSkipBtn")?.addEventListener("click", () => {
      currentIdx++;
      renderStep(currentIdx);
    });
  }

  renderStep(0);
  section.hidden = false;
}

/* -----------------------------
   TRANSLATION
----------------------------- */

async function translateSentence(sentence, card) {
  trackGuest("translations");
  const translationBox = card.querySelector(".translation-box");

  try {
    translationBox.textContent = "Translating...";

    const response = await fetchWithAuth(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sentence,
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Translation failed");
    }

    translationBox.textContent = data.translation || "";
  } catch (error) {
    console.error("Translation error:", error);
    translationBox.textContent = "Translation failed.";
  }
}

/* -----------------------------
   TONE FEEDBACK / REPEAT CARD
----------------------------- */

function renderToneFeedback(result, lang, sentence) {
  const words = result.words || [];
  const isZh = /^zh/i.test(lang);

  // Build pinyin map from segmentCache for Chinese
  const pinyinMap = {};
  if (isZh) {
    const segs = segmentCache.get(sentence) || [];
    segs.forEach(s => { if (s.word) pinyinMap[s.word] = s.pinyin || ""; });
  }

  const interesting = words.filter(w => {
    if ((w.errorType || "None") === "Insertion") return false;
    const hasMiscue = w.errorType && w.errorType !== "None";
    return hasMiscue || (w.accuracy != null && w.accuracy < 80);
  }).slice(0, 5);

  const fluencyRow = (result.fluency != null && result.fluency < 65)
    ? `<div class="tone-row">
        <span class="tone-dot" style="background:var(--close)"></span>
        <span class="tone-hz">—</span>
        <span class="tone-msg" style="color:var(--close)">Work on fluency!</span>
       </div>`
    : "";

  if (!interesting.length && !fluencyRow) {
    return `<div class="tone-feedback">
      <div class="tone-row">
        <span class="tone-dot" style="background:var(--good)"></span>
        <span class="tone-msg" style="color:var(--good)">Sounds clean!</span>
      </div>
    </div>`;
  }

  const rowsHtml = interesting.map(w => {
    const acc = w.accuracy ?? 0;
    const hasMiscue = w.errorType && w.errorType !== "None";
    let color, msg;
    if (hasMiscue || acc < 60) {
      color = "var(--retry)"; msg = "Check the sound!";
    } else {
      color = "var(--close)"; msg = "Check the tone!";
    }
    const py = pinyinMap[w.word] || "";
    return `<div class="tone-row">
      <span class="tone-dot" style="background:${color}"></span>
      <span class="tone-hz">${escapeHtml(w.word)}</span>
      ${py ? `<span class="tone-py">${escapeHtml(py)}</span>` : ""}
      <span class="tone-msg" style="color:${color}">${msg}</span>
    </div>`;
  }).join("");

  return `<div class="tone-feedback">
    <div class="tone-lbl">Tone feedback</div>
    ${rowsHtml}${fluencyRow}
  </div>`;
}

function renderRepeatCard(result, lang, sentence) {
  const words = result.words || [];
  const isZh = /^zh/i.test(lang);

  const pinyinMap = {};
  if (isZh) {
    const segs = segmentCache.get(sentence) || [];
    segs.forEach(s => { if (s.word) pinyinMap[s.word] = s.pinyin || ""; });
  }

  // Find the worst-scoring non-insertion word
  const candidates = words
    .filter(w => (w.errorType || "None") !== "Insertion")
    .filter(w => {
      const hasMiscue = w.errorType && w.errorType !== "None";
      return hasMiscue || (w.accuracy != null && w.accuracy < 80);
    });
  if (!candidates.length) return "";

  const worst = candidates.reduce((a, b) => {
    const aScore = a.accuracy ?? (a.errorType !== "None" ? 0 : 100);
    const bScore = b.accuracy ?? (b.errorType !== "None" ? 0 : 100);
    return bScore < aScore ? b : a;
  });

  const py = pinyinMap[worst.word] || "";
  return `<div class="pa-repeat">
    <div class="pa-repeat-lbl">Repeat this word</div>
    <div class="pa-repeat-word">${escapeHtml(worst.word)}</div>
    ${py ? `<div class="pa-repeat-py">${escapeHtml(py)}</div>` : ""}
  </div>`;
}

/* -----------------------------
   WORD POPUP / FLASHCARD SAVE
----------------------------- */

function buildSentencePinyinFromWords(sentenceEl) {
  if (!sentenceEl) return "";

  return Array.from(sentenceEl.querySelectorAll(".word"))
    .map(el => el.dataset.pinyin || "")
    .filter(Boolean)
    .join(" ");
}

function attachWordListeners(sentenceEl) {
  if (!sentenceEl) return;

  const wordEls = sentenceEl.querySelectorAll(".word");
  const sentenceText = sentenceEl.dataset.fullSentence || sentenceEl.textContent.trim();
  const sentencePinyin = buildSentencePinyinFromWords(sentenceEl);

  wordEls.forEach(wordEl => {
    if (wordEl.dataset.listenerAttached === "true") return;

    wordEl.addEventListener("mouseenter", () => {
      const word = wordEl.dataset.word;
      if (!word) return;
      if (wordEl._popupTimer) clearTimeout(wordEl._popupTimer);
      wordEl._popupTimer = setTimeout(() => {
        showWordPopup(wordEl, word, sentenceText, sentencePinyin, false).catch(console.error);
      }, 300);
    });

    wordEl.addEventListener("mouseleave", () => {
      if (wordEl._popupTimer) {
        clearTimeout(wordEl._popupTimer);
        wordEl._popupTimer = null;
      }
    });

    wordEl.addEventListener("click", (event) => {
      unlockAudioForMobile();
      event.stopPropagation();

      const word = wordEl.dataset.word;
      if (!word) return;

      stopAllTTS();
      playGoogleTTS(word, sourceLangSelect.value);
      showWordPopup(wordEl, word, sentenceText, sentencePinyin, true).catch(console.error);
    });

    wordEl.dataset.listenerAttached = "true";
  });
}

function removeExistingPopup() {
  if (activePopup) {
    activePopup.remove();
    activePopup = null;
  }
  document.querySelectorAll(".word-popup").forEach(el => el.remove());
  if (popupTimeout) {
    clearTimeout(popupTimeout);
    popupTimeout = null;
  }
}

function renderPopupDeckSelect() {
  if (!flashcardDecks.length) return "";

  return `
    <select class="popup-deck-select">
      ${flashcardDecks.map(deck => `
        <option value="${escapeHtml(deck.id)}" ${deck.id === currentDeckId ? "selected" : ""}>
          ${escapeHtml(deck.name)}
        </option>
      `).join("")}
    </select>
  `;
}

async function showWordPopup(wordEl, word, sentence = "", sentencePinyin = "", allowSave = true) {
  trackGuest("wordClicks");
  removeExistingPopup();

  const popup = document.createElement("div");
  popup.className = "word-popup";
  popup.textContent = "Loading...";

  document.body.appendChild(popup);

  const rect = wordEl.getBoundingClientRect();
  popup.style.top = `${rect.bottom + window.scrollY + 6}px`;
  popup.style.left = `${rect.left + window.scrollX}px`;

  const pinyinText = wordEl.dataset.pinyin || "";

  function attachSaveButton(saveBtn, translationText, py = "") {
    saveBtn?.addEventListener("click", async () => {
      const selectedDeckId = popup.querySelector(".popup-deck-select")?.value;

      if (selectedDeckId) {
        currentDeckId = selectedDeckId;
      }

      const saved = await addFlashcard({
        word,
        pinyin: py || pinyinText || "",
        sentence: allowSave ? sentence : "",
        sentencePinyin: allowSave ? sentencePinyin : "",
        translation: translationText || "",
        lang: sourceLangSelect.value
      });

      if (saved) {
        saveBtn.textContent = getT().saved;
        wordEl.classList.add("word-saved");

        const deckId = popup.querySelector(".popup-deck-select")?.value;
        const deckName = flashcardDecks.find(d => String(d.id) === String(deckId))?.name;
        showToast(deckName ? `Saved to ${deckName}.` : getT().saved + ".", "success");

        popup.style.transform = "scale(0.95)";
        popup.style.opacity = "0.6";

        setTimeout(() => popup.remove(), 350);
      } else {
        saveBtn.textContent = "Already saved";
      }
    });
  }

  function renderPopupContent({ translation = "", pinyin = "" }) {
    popup.innerHTML = `
      <div class="popup-row">
        <div class="popup-left">
          <div class="popup-word">${escapeHtml(word)}</div>
          ${pinyin ? `<div class="popup-pinyin">${escapeHtml(pinyin)}</div>` : ""}
        </div>
        <div class="popup-translation">${escapeHtml(translation)}</div>
        ${allowSave ? `<button class="popup-save-btn" aria-label="Save to flashcards">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>` : ""}
      </div>
      ${allowSave ? renderPopupDeckSelect() : ""}
    `;

    if (allowSave) {
      attachSaveButton(
        popup.querySelector(".popup-save-btn"),
        translation,
        pinyin
      );
    }
  }

  const cacheKey = `${word}|${sourceLangSelect.value}|${targetLangSelect.value}`;
  let result = wordPopupCache.get(cacheKey) || { translation: "", pinyin: pinyinText };

  if (!wordPopupCache.has(cacheKey)) {
    try {
      const dictResponse = await fetchWithAuth(`${API_BASE}/api/dictionary`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word })
      });

      if (dictResponse.status === 429) {
        result = { translation: "Too many requests. Please wait a moment.", pinyin: pinyinText };
      } else {
        const dictData = await dictResponse.json();

        if (dictResponse.ok && dictData.entries && dictData.entries.length > 0) {
          const firstEntry = dictData.entries[0];
          result = {
            translation: firstEntry.definitions.slice(0, 3).join("; "),
            pinyin: firstEntry.pinyin || pinyinText
          };
          wordPopupCache.set(cacheKey, result);
        } else {
          const response = await fetchWithAuth(`${API_BASE}/api/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sentence: word,
              sourceLang: sourceLangSelect.value,
              targetLang: targetLangSelect.value
            })
          });

          if (response.status === 429) {
            result = { translation: "Too many requests. Please wait a moment.", pinyin: pinyinText };
          } else {
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Translation failed");
            result = { translation: data.translation || "", pinyin: pinyinText };
            wordPopupCache.set(cacheKey, result);
          }
        }
      }
    } catch (err) {
      console.error("Word popup error:", err);
      result = { translation: "Lookup failed", pinyin: pinyinText };
    }
  }

  if (!document.body.contains(popup)) return;

  renderPopupContent(result);
  activePopup = popup;

  function closePopup(event) {
    if (!popup.contains(event.target)) {
      popup.remove();
      if (activePopup === popup) activePopup = null;
      document.removeEventListener("click", closePopup);
      window.removeEventListener("scroll", closePopup);
      document.removeEventListener("keydown", onEscape);
    }
  }

  function onEscape(event) {
    if (event.key === "Escape") {
      popup.remove();
      if (activePopup === popup) activePopup = null;
      document.removeEventListener("click", closePopup);
      window.removeEventListener("scroll", closePopup);
      document.removeEventListener("keydown", onEscape);
    }
  }

  popupTimeout = setTimeout(() => {
    if (document.body.contains(popup)) popup.remove();
    if (activePopup === popup) activePopup = null;
    popupTimeout = null;
    document.removeEventListener("click", closePopup);
    window.removeEventListener("scroll", closePopup);
    document.removeEventListener("keydown", onEscape);
  }, 4000);

  setTimeout(() => document.addEventListener("click", closePopup), 0);
  window.addEventListener("scroll", closePopup, { once: true });
  document.addEventListener("keydown", onEscape);
}

async function showVideoWordPopup(wordEl, word, sentence = "", sentencePinyin = "", allowSave = true) {
  const prevSource = sourceLangSelect?.value;
  const prevTarget = targetLangSelect?.value;
  if (sourceLangSelect && videoLang) sourceLangSelect.value = videoLang;
  if (targetLangSelect && videoHelpLang) targetLangSelect.value = videoHelpLang;
  try {
    await showWordPopup(wordEl, word, sentence, sentencePinyin, allowSave);
  } finally {
    if (sourceLangSelect && prevSource) sourceLangSelect.value = prevSource;
    if (targetLangSelect && prevTarget) targetLangSelect.value = prevTarget;
  }
}

/* -----------------------------
   TTS / SPEECH
----------------------------- */

function mapToSpeechLang(lang) {
  const map = {
    ru: "ru-RU",
    tr: "tr-TR",
    zh: "zh-CN",
    en: "en-US",
    de: "de-DE",
    es: "es-ES",
    fr: "fr-FR",
    hy: "hy-AM",
    ka: "ka-GE",
    ja: "ja-JP"
  };

  return map[lang] || "en-US";
}

async function prepareTTSInput(text, lang) {
  if (!text) return "";

  if (lang === "zh") {
    try {
      const response = await fetchWithAuth(`${API_BASE}/api/segment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text })
      });

      const data = await response.json();

      if (response.ok && data.words) {
        return data.words
          .map(item => rdWordParts(item).word)
          .join(" ")
          .replace(/\s+([，。！？])/g, "$1 ")
          .trim();
      }
    } catch (error) {
      console.error("Chinese TTS prep failed:", error);
    }

    return text.trim();
  }

  return text.trim();
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isSafariBrowser() {
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);
}

function unlockAudioForMobile() {
  // Runs synchronously inside a user gesture: play a silent clip once so iOS
  // marks the shared TTS element as user-activated for all later play() calls.
  try {
    if (ttsAudioBlessed || currentAudio) return;
    ttsAudioBlessed = true;
    ttsAudioEl.src = SILENT_WAV;
    ttsAudioEl.play().catch(() => {});
  } catch (error) {
    console.warn("Audio unlock failed:", error);
  }
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function clearWordHighlights() {
  if (activeHighlightTimer) {
    clearTimeout(activeHighlightTimer);
    activeHighlightTimer = null;
  }
  document.querySelectorAll(".word-speaking").forEach(el => el.classList.remove("word-speaking"));
}

function highlightByCharIndex(container, charIndex) {
  if (!container) return;
  const units = Array.from(container.querySelectorAll(".word, .hanzi-char, .rd-word"));
  if (!units.length) return;
  units.forEach(u => u.classList.remove("word-speaking"));
  let pos = 0;
  for (const unit of units) {
    const len = ((unit.querySelector?.(".rd-hz")?.textContent) || unit.textContent || "").length;
    if (charIndex >= pos && charIndex < pos + len) {
      unit.classList.add("word-speaking");
      break;
    }
    pos += len;
  }
}

function highlightWordsSequentially(container, durationMs) {
  if (!container) return;
  clearWordHighlights();

  let words = Array.from(container.querySelectorAll(".rd-word, .word")).filter(el => {
    const text = el.querySelector?.(".rd-hz")?.textContent || el.textContent || "";
    return text.trim();
  });

  if (!words.length) {
    words = Array.from(container.querySelectorAll(".hanzi-char")).filter(el => el.textContent.trim());
  }

  if (!words.length && container.closest?.("#rdHan")) return;

  if (!words.length) {
    const chars = [...container.textContent].filter(c => c.trim());
    if (!chars.length) return;
    container.innerHTML = chars.map(c => `<span class="word">${c}</span>`).join("");
    words = Array.from(container.querySelectorAll(".word"));
  }

  if (!words.length) return;

  const lang = document.getElementById("sourceLang")?.value || "en";
  const isCJK = ["zh", "ja"].includes(lang);

  const safeDuration = isCJK
    ? Math.max(words.length * 520, 2200)
    : Math.max(durationMs || words.length * 260, 1200);

  const step = safeDuration / words.length;
  let index = 0;

  function highlightNext() {
    words.forEach(w => w.classList.remove("word-speaking"));
    if (index >= words.length) { clearWordHighlights(); return; }
    words[index].classList.add("word-speaking");
    index += 1;
    activeHighlightTimer = setTimeout(highlightNext, step);
  }

  highlightNext();
}

async function playGoogleTTS(text, langOverride = null, onEnd = null, sentenceEl = null) {
  if (!text) return;

  const effectiveLang = langOverride || sourceLangSelect.value;
  const effectiveRate = getTtsRate();

  // Toggle pause/resume for same audio
  if (currentAudio && currentAudioText === text && currentAudioRate === effectiveRate) {
    if (audioCtxSuspended) {
      ttsAudioEl.play().catch(() => {});
      audioCtxSuspended = false;
    } else {
      ttsAudioEl.pause();
      audioCtxSuspended = true;
    }
    return;
  }

  // Stop any current audio
  clearWordHighlights();
  if (currentAudio) {
    ttsAudioEl.onended = null;
    try { ttsAudioEl.pause(); } catch (_) {}
    currentAudio = null;
  }
  audioCtxSuspended = false;
  currentAudioText = "";
  currentAudioRate = 1.0;

  window.speechSynthesis?.cancel();

  try {
    const selectedVoice = getSelectedVoice(effectiveLang);
    const cacheKey = `${text}|${effectiveLang}|${effectiveRate}|${selectedVoice || ""}`;
    let cached = ttsCache.get(cacheKey);

    if (!cached) {
      const ttsBody = { text, sourceLang: effectiveLang, speakingRate: effectiveRate };
      if (selectedVoice) ttsBody.voiceName = selectedVoice;

      const response = await fetchWithAuth(`${API_BASE}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ttsBody)
      });

      if (response.status === 429) {
        let body = null;
        try { body = await response.json(); } catch { /* non-JSON body */ }
        // Free-plan daily cap → upgrade modal; plain IP rate limit → toast.
        if (body?.code) throw Object.assign(new Error("TTS_CAP"), { upgradeCode: body.code });
        throw new Error("RATE_LIMIT");
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "TTS failed");

      const blob = new Blob([base64ToArrayBuffer(data.audioBase64)], { type: "audio/mpeg" });

      if (ttsCache.size >= 50) {
        const oldestKey = ttsCache.keys().next().value;
        const oldest = ttsCache.get(oldestKey);
        if (oldest?.url) URL.revokeObjectURL(oldest.url);
        ttsCache.delete(oldestKey);
      }
      cached = { url: URL.createObjectURL(blob) };
      ttsCache.set(cacheKey, cached);
    }

    const el = ttsAudioEl;
    el.onended = null;
    el.src = cached.url;
    el.playbackRate = 1.0;

    currentAudio = el;
    currentAudioText = text;
    currentAudioRate = effectiveRate;
    audioCtxSuspended = false;

    if (sentenceEl) {
      const isCJK = ["zh", "ja"].includes(effectiveLang);
      if (isCJK) {
        highlightWordsSequentially(sentenceEl, null);
      } else if (Number.isFinite(el.duration) && el.duration > 0) {
        highlightWordsSequentially(sentenceEl, el.duration * 1000);
      } else {
        // Blob metadata loads near-instantly; start highlights when the real
        // clip duration is known so their pace matches the audio.
        el.addEventListener("loadedmetadata", () => {
          if (currentAudio === el && currentAudioText === text) {
            highlightWordsSequentially(sentenceEl, (el.duration * 1000) || null);
          }
        }, { once: true });
      }
    }

    el.onended = () => {
      clearWordHighlights();
      if (currentAudio === el) {
        currentAudio = null;
        currentAudioText = "";
        currentAudioRate = 1.0;
        audioCtxSuspended = false;
      }
      if (typeof onEnd === "function") onEnd();
    };

    await el.play();
  } catch (error) {
    currentAudio = null;
    currentAudioText = "";
    currentAudioRate = 1.0;
    audioCtxSuspended = false;
    if (error.upgradeCode) {
      showUpgradePrompt(error.upgradeCode);
      return;
    }
    if (error.message === "RATE_LIMIT") {
      showToast("Too many requests. Please wait a moment.", "error");
      return;
    }
    console.error("Google TTS failed, falling back to browser TTS:", error);
    playBrowserTTS(text, effectiveLang, sentenceEl, onEnd);
  }
}

function playBrowserTTS(text, langOverride = null, sentenceEl = null, onEnd = null, onError = null) {
  // Android WebView has no Web Speech API — degrade silently instead of throwing.
  if (!window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
    if (typeof onEnd === "function") onEnd();
    return;
  }
  if (!text) return;

  unlockAudioForMobile();
  clearWordHighlights();

  const lang = mapToSpeechLang(langOverride || sourceLangSelect.value);
  const rate = getTtsRate();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.volume = 1;

  let boundaryFired = false;

  utterance.onboundary = (event) => {
    boundaryFired = true;
    if (!sentenceEl || event.charIndex == null) return;
    highlightByCharIndex(sentenceEl, event.charIndex);
  };

  if (sentenceEl) {
    setTimeout(() => {
      if (!boundaryFired) {
        highlightWordsSequentially(sentenceEl, null);
      }
    }, 700);
  }

  utterance.onend = () => {
    clearWordHighlights();
    if (typeof onEnd === "function") onEnd();
  };

  utterance.onerror = (event) => {
    clearWordHighlights();
    console.error("Browser TTS error:", event);
    if (typeof onError === "function") onError(event);
    if (typeof onEnd === "function") onEnd();
  };

  window.speechSynthesis.cancel();
  if (isIOS()) {
    window.speechSynthesis.speak(utterance);
  } else {
    setTimeout(() => window.speechSynthesis?.speak(utterance), 0);
  }
}

function stopAllTTS() {
  clearWordHighlights();
  window.speechSynthesis?.cancel();
  if (currentAudio) {
    ttsAudioEl.onended = null;
    try { ttsAudioEl.pause(); } catch (_) {}
    currentAudio = null;
  }
  audioCtxSuspended = false;
  currentAudioText = "";
  currentAudioRate = 1.0;
}

function stopRecognition() {
  if (currentRecognition) {
    try {
      currentRecognition.abort();
    } catch (error) {
      console.warn("Recognition already stopped:", error);
    }

    currentRecognition = null;
  }
}

function stopFlashcardRecognition() {
  if (currentFlashcardRecognition) {
    try { currentFlashcardRecognition.abort(); } catch { /* already stopped */ }
    currentFlashcardRecognition = null;
  }
}

function normalizePinyin(text = "") {
  return String(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // strip tone diacritics: wēi → wei
    .replace(/ü/g, "v")
    .replace(/\s+/g, " ")
    .trim();
}

async function getPinyinForText(text) {
  const res = await fetchWithAuth(`${API_BASE}/api/pinyin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Pinyin failed");
  return data.pinyin || "";
}

async function scoreFlashcardTranscript({ transcript, card, cardLang, speechLang, resultEl }) {
  const expected = card.word || "";
  const isChinese = cardLang === "zh";
  let result;

  if (isChinese) {
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Scoring..."; }
    try {
      const transcriptPinyin = await getPinyinForText(transcript);
      const expectedNorm = normalizePinyin(card.pinyin || expected);
      const actualNorm = normalizePinyin(transcriptPinyin);

      const score = (actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm))
        ? 100
        : compareByEditDistance(expectedNorm, actualNorm);

      result = { score, message: score >= FLASHCARD_PASS_SCORE ? "Great" : "Try again" };
      flashcardSpeakingUnlocked = result.score >= FLASHCARD_PASS_SCORE;

      if (resultEl) {
        resultEl.hidden = false;
        resultEl.innerHTML =
          `<strong>${flashcardSpeakingUnlocked ? "✓ " + escapeHtml(result.message) + "!" : "Try again"}</strong>` +
          `<p>You said: ${escapeHtml(transcript)}</p>` +
          `<p>Pronunciation: ${escapeHtml(transcriptPinyin)}</p>` +
          `<p>Expected: ${escapeHtml(card.pinyin || expected)}</p>` +
          `<p>Score: ${result.score}%</p>`;
      }
    } catch {
      result = compareText(expected, transcript, speechLang);
      flashcardSpeakingUnlocked = result.score >= FLASHCARD_PASS_SCORE;
      if (resultEl) {
        resultEl.hidden = false;
        resultEl.innerHTML =
          `<strong>${flashcardSpeakingUnlocked ? "✓ " + escapeHtml(result.message) + "!" : "Try again"}</strong>` +
          `<p>You said: ${escapeHtml(transcript)}</p><p>Score: ${result.score}%</p>`;
      }
    }
  } else {
    result = compareText(expected, transcript, speechLang);
    flashcardSpeakingUnlocked = result.score >= FLASHCARD_PASS_SCORE;
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.innerHTML = flashcardSpeakingUnlocked
        ? `<strong>✓ ${escapeHtml(result.message)}!</strong><p>You said: ${escapeHtml(transcript)}</p><p>Score: ${result.score}%</p>`
        : `<strong>Try again</strong><p>You said: ${escapeHtml(transcript)}</p><p>Score: ${result.score}%</p>`;
    }
  }

  renderFlashcards();
}

async function startFlashcardSpeakingPractice() {
  if (drillActive) return; // a drill is already running for this card
  const cards = getCurrentCards();
  const card = cards[currentFlashcardIndex];
  if (!card) return;

  const cardLang = card.lang || sourceLangSelect.value;
  const expected = card.word || "";
  const speechLang = mapToSpeechLang(cardLang);
  const resultEl = document.getElementById("flashcardSpeakingResult");

  // Azure pronunciation assessment (signed-in users, when enabled).
  const fastBrowserRecognition = isSafariBrowser();
  if (!fastBrowserRecognition) {
    const azure = await tryAzurePronunciation(expected, speechLang, resultEl, null, getT());
    if (azure) {
      // Passed outright — unlock and move on (flashcards stay lightweight).
      if (azure.score >= FLASHCARD_PASS_SCORE) {
        flashcardSpeakingUnlocked = true;
        renderFlashcards();
        return;
      }
      // Didn't pass — drill the parts that fell short, unlock only if mastered.
      const chunks = azure.result ? await buildDrillChunks(azure.result, cardLang) : [];
      if (chunks.length) {
        drillActive = true;
        let mastered = false;
        try {
          mastered = await runPronunciationDrill(chunks, cardLang, resultEl, getT());
        } finally {
          drillActive = false;
        }
        flashcardSpeakingUnlocked = !!mastered;
      } else {
        flashcardSpeakingUnlocked = false;
      }
      renderFlashcards();
      return;
    }
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Speech recognition is not supported in this browser."; }
    return;
  }

  stopAllTTS();
  stopFlashcardRecognition();

  const recognition = new SpeechRecognition();
  currentFlashcardRecognition = recognition;
  recognition.lang = speechLang;
  recognition.continuous = false;
  recognition.interimResults = fastBrowserRecognition;
  recognition.maxAlternatives = 1;
  let handled = false;
  let settleTimer = null;
  let pendingTranscript = "";

  if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Listening…"; }

  const finishWithTranscript = async (transcript) => {
    if (handled || !transcript.trim()) return;
    handled = true;
    if (settleTimer) clearTimeout(settleTimer);
    try { recognition.stop(); } catch { /* already stopped */ }
    await scoreFlashcardTranscript({ transcript, card, cardLang, speechLang, resultEl });
  };

  recognition.onresult = (event) => {
    const resultList = event.results[event.results.length - 1];
    const transcript = resultList?.[0]?.transcript || "";
    if (!transcript.trim()) return;
    pendingTranscript = transcript;

    if (!fastBrowserRecognition || resultList.isFinal) {
      finishWithTranscript(transcript);
      return;
    }

    if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Got it, scoring..."; }
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => finishWithTranscript(transcript), 650);
  };

  recognition.onerror = () => {
    if (settleTimer) clearTimeout(settleTimer);
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Could not hear you. Please try again."; }
    currentFlashcardRecognition = null;
  };

  recognition.onend = () => {
    if (settleTimer) clearTimeout(settleTimer);
    currentFlashcardRecognition = null;
    if (fastBrowserRecognition && !handled && pendingTranscript.trim()) {
      finishWithTranscript(pendingTranscript);
    }
  };

  recognition.start();
}

/* -----------------------------
   SPEECH RECOGNITION
----------------------------- */

function normalizeText(text, lang = "") {
  let cleaned = text.toLowerCase();
  try {
    cleaned = cleaned.replace(/[\p{P}\p{S}]/gu, "");
  } catch {
    cleaned = cleaned.replace(/[.,!?;:«»"'`()\[\]{}…。，！？、—–·•\/\\|@#$%^&*+=~<>]/g, "");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (lang.startsWith("zh") || lang.startsWith("ja")) {
    cleaned = cleaned.replace(/\s+/g, "");
  }
  return cleaned;
}

function compareByWords(expected, actual) {
  const expectedWords = expected.split(" ").filter(Boolean);
  const actualWords = actual.split(" ").filter(Boolean);

  if (!expectedWords.length) return 0;

  let matches = 0;

  expectedWords.forEach((word, index) => {
    if (actualWords[index] === word) matches += 1;
  });

  return Math.round((matches / expectedWords.length) * 100);
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

function compareByEditDistance(expected, actual) {
  const distance = levenshteinDistance(expected, actual);
  const maxLength = Math.max(expected.length, actual.length);

  if (maxLength === 0) return 100;

  return Math.max(0, Math.round((1 - distance / maxLength) * 100));
}

function compareText(expected, actual, lang) {
  const normalizedExpected = normalizeText(expected, lang);
  const normalizedActual = normalizeText(actual, lang);

  if (!normalizedExpected) {
    return { score: 0, message: "Try again" };
  }

  const score = lang.startsWith("zh")
    ? compareByEditDistance(normalizedExpected, normalizedActual)
    : compareByWords(normalizedExpected, normalizedActual);

  let message = "Try again";
  if (score >= 90) message = "Nice";
  else if (score >= 70) message = "Good";
  else if (score >= 40) message = "Almost";

  return { score, message };
}

async function record(sentence, card, recordBtn = null) {
  const resultBox = card.querySelector(".pronunciation-box");
  const t = getT();

  // Azure pronunciation assessment (signed-in users, when enabled).
  // Falls through to legacy browser scoring for guests / unconfigured.
  const shortLang = sourceLangSelect.value;
  const azureLang = mapToSpeechLang(shortLang);
  const azure = await tryAzurePronunciation(sentence, azureLang, resultBox, recordBtn, t);
  if (azure) {
    if (azure.result && resultBox) {
      resultBox.insertAdjacentHTML("beforeend",
        renderToneFeedback(azure.result, shortLang, sentence) +
        renderRepeatCard(azure.result, shortLang, sentence)
      );
      // Count scored words as "words spoken" for the stats counter.
      const spokenCount = (azure.result.words || []).length || 1;
      recordActivity("words_spoken", spokenCount);
    }

    const advanceToNext = () => {
      const nextCard = card.nextElementSibling;
      setTimeout(() => {
        nextCard?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 600);
    };

    // Tutor loop: drill the parts that didn't get a green light, then advance.
    const chunks = azure.result ? await buildDrillChunks(azure.result, shortLang) : [];
    if (chunks.length && !drillActive) {
      drillActive = true;
      if (recordBtn) recordBtn.disabled = true; // block re-tap from wiping the drill
      let mastered = false;
      try {
        mastered = await runPronunciationDrill(chunks, shortLang, resultBox, t);
      } finally {
        drillActive = false;
        if (recordBtn) recordBtn.disabled = false;
      }
      if (mastered) advanceToNext();
      return;
    }

    if (azure.score >= 70) advanceToNext();
    return;
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    resultBox.innerHTML = "Speech recognition is not supported in this browser.";
    return;
  }

  // If already recording, finish normally.
  // IMPORTANT: use stop(), not abort().
  if (currentRecognition) {
    try {
      currentRecognition.stop();
    } catch (error) {
      console.warn("Recognition already stopped:", error);
    }

    return;
  }

  stopAllTTS();

  setTimeout(() => {
    startRecognitionNow();
  }, 300);

  function startRecognitionNow() {
    const recognition = new SpeechRecognition();
  currentRecognition = recognition;

  const lang = mapToSpeechLang(sourceLangSelect.value);
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  if (recordBtn) {
    recordBtn.textContent = t.done || "Done";
  }

  resultBox.innerHTML = t.listening || "Listening…";

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript || "";
    const result = compareText(sentence, transcript, lang);

    resultBox.innerHTML = `
      <p><strong>${escapeHtml(result.message)}</strong></p>
      <p>${escapeHtml(transcript)}</p>
      <p>${result.score}%</p>
    `;

    if (result.score >= 70) {
      const nextCard = card.nextElementSibling;

      setTimeout(() => {
        nextCard?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 600);
    }
  };

  recognition.onerror = (event) => {
  if (event.error === "aborted") return;

  const messages = {
    "not-allowed": micBlockedMessage(),
    "no-speech": "I didn't hear anything. Try again and speak after pressing the button.",
    "audio-capture": "No microphone found. Please check your device.",
    "network": "Speech recognition network error. Try again."
  };

  resultBox.innerHTML = messages[event.error] || `Recognition error: ${escapeHtml(event.error)}`;
};

  recognition.onend = () => {
    currentRecognition = null;

    if (recordBtn) {
      recordBtn.textContent = t.yourTurn;
    }
  };

  try {
    recognition.start();
  } catch (err) {
    console.error("Recognition start error:", err);
    resultBox.innerHTML = "Could not start recognition.";
    currentRecognition = null;

    if (recordBtn) {
      recordBtn.textContent = t.yourTurn;
    }
  }
 }
}

/* -----------------------------
   FLASHCARDS
----------------------------- */

async function loadFlashcardsFromStorage() {
  // getSession() reads the locally persisted session without a server
  // roundtrip — getUser() hit the network and one failure on a slow
  // connection left the decks empty with no retry.
  const {
    data: { session }
  } = await supabase.auth.getSession();
  const user = session?.user;

  if (!user) {
    flashcardsLoadedForUserId = null;
    flashcardDecks = [];
    currentDeckId = null;
    return;
  }

  if (flashcardsLoadedForUserId === user.id) return;
  flashcardsLoadedForUserId = user.id;

  const { data: decks, error: deckError } = await supabase
    .from("flashcard_decks")
    .select(`
      id,
      name,
      flashcards (
        id,
        word,
        pinyin,
        sentence,
        sentence_pinyin,
        translation,
        lang
      )
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (deckError) {
    console.error("Load decks error:", deckError);
    flashcardsLoadedForUserId = null;
    flashcardDecks = [];
    return;
  }

  flashcardDecks = (decks || []).map(deck => ({
    id: deck.id,
    name: deck.name,
    cards: (deck.flashcards || []).map(card => ({
      id: card.id,
      word: card.word,
      pinyin: card.pinyin,
      sentence: card.sentence,
      sentencePinyin: card.sentence_pinyin,
      translation: card.translation,
      lang: card.lang
    }))
  }));

  await ensureDefaultDeck();
}

async function ensureDefaultDeck() {
  if (!flashcardDecks.length) {
    const {
      data: { session }
    } = await supabase.auth.getSession();
    const user = session?.user;

    if (!user) return;

    const { data, error } = await supabase
      .from("flashcard_decks")
      .insert({
        user_id: user.id,
        name: "My first deck"
      })
      .select()
      .single();

    if (error) {
      console.error("Create default deck error:", error);
      return;
    }

    flashcardDecks = [{
      id: data.id,
      name: data.name,
      cards: []
    }];

    currentDeckId = data.id;
  } else if (!currentDeckId || !flashcardDecks.some(deck => deck.id === currentDeckId)) {
    currentDeckId = flashcardDecks[0].id;
  }
}

function getCurrentDeck() {
  return flashcardDecks.find(deck => deck.id === currentDeckId) || null;
}

function getCurrentCards() {
  return getCurrentDeck()?.cards || [];
}

async function addFlashcard(cardData) {
  const deck = getCurrentDeck();
  if (!deck) return false;

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return false;

  const exists = deck.cards.some(
    item =>
      item.word === cardData.word &&
      item.sentence === cardData.sentence &&
      item.lang === cardData.lang
  );

  if (exists) return false;

  // Gate: free users can have up to FREE_MAX_CARDS cards total.
  const allowed = await checkDeckQuota("add-card", null);
  if (!allowed) return false;

  const { data, error } = await supabase
    .from("flashcards")
    .insert({
      user_id: user.id,
      deck_id: deck.id,
      word: cardData.word,
      pinyin: cardData.pinyin || "",
      sentence: cardData.sentence || "",
      sentence_pinyin: cardData.sentencePinyin || "",
      translation: cardData.translation || "",
      lang: cardData.lang || sourceLangSelect.value
    })
    .select()
    .single();

  if (error) {
    console.error("Add flashcard error:", error);
    return false;
  }

  deck.cards.push({
    id: data.id,
    word: data.word,
    pinyin: data.pinyin,
    sentence: data.sentence,
    sentencePinyin: data.sentence_pinyin,
    translation: data.translation,
    lang: data.lang
  });

  renderDeckSelector();
  renderFlashcards();
  return true;
}

function renderDeckSelector() {
  const selectEl = document.getElementById("flashcardDeckSelect");
  if (!selectEl) return;

  selectEl.innerHTML = flashcardDecks.map(deck => `
    <option value="${deck.id}">
      ${escapeHtml(deck.name)} (${deck.cards.length})
    </option>
  `).join("");

  selectEl.value = currentDeckId || "";
}

function cleanTranslation(str = "") {
  return String(str)
    .replace(/\*\*/g, "")
    .replace(/\[.*?\]/g, "")
    .replace(/^\s*\d+\.\s*/g, "")
    .replace(/^[·•\-–—]\s*/g, "")
    .replace(/^["""'']+|["""'']+$/g, "")
    .trim();
}

async function renderFlashcards() {
  const cards = getCurrentCards();
  const deck = getCurrentDeck();

  const emptyEl = document.getElementById("flashcardEmptyState");
  const deckEl = document.getElementById("flashcardDeck");
  const counterEl = document.getElementById("flashcardCounter");
  const cardEl = document.getElementById("flashcardCard");
  const wordEl = document.getElementById("flashcardWord");
  const wordPinyinEl = document.getElementById("flashcardWordPinyin");
  const wordBackEl = document.getElementById("flashcardWordBack");
  const translationEl = document.getElementById("flashcardTranslation");

  if (!emptyEl || !deckEl || !cardEl) return;

  if (!cards.length) {
    emptyEl.hidden = false;
    deckEl.hidden = true;
    return;
  }

  emptyEl.hidden = true;
  deckEl.hidden = false;

  // ── Mode tabs (Browse · Learn · Check) ───────────
  // A deck switch invalidates a running quiz session; too-small decks lose Learn.
  if (fcMode === "learn" && (cards.length < FC_LEARN_MIN_CARDS || fcLearn?.deckId !== deck?.id)) {
    if (cards.length < FC_LEARN_MIN_CARDS) fcMode = "browse";
    else fcStartLearn();
  }
  if (fcMode === "check" && fcCheck?.deckId !== deck?.id) fcStartCheck();

  document.querySelectorAll(".fc-mode-tab").forEach(b => {
    b.classList.toggle("on", b.dataset.fcMode === fcMode);
    if (b.dataset.fcMode === "learn") {
      b.classList.toggle("locked", cards.length < FC_LEARN_MIN_CARDS);
      b.title = cards.length < FC_LEARN_MIN_CARDS ? getT().learnLocked : "";
    }
  });

  const browsePanel = document.getElementById("fcBrowsePanel");
  const learnPanel = document.getElementById("fcLearnPanel");
  const checkPanel = document.getElementById("fcCheckPanel");
  if (browsePanel) browsePanel.hidden = fcMode !== "browse";
  if (learnPanel) learnPanel.hidden = fcMode !== "learn";
  if (checkPanel) checkPanel.hidden = fcMode !== "check";
  if (fcMode === "learn") { renderFcLearn(); return; }
  if (fcMode === "check") { renderFcCheck(); return; }

  if (currentFlashcardIndex >= cards.length) {
    currentFlashcardIndex = cards.length - 1;
  }

  const card = cards[currentFlashcardIndex];

  const t = getT();
  counterEl.textContent = `${deck?.name || t.deck} · ${t.card} ${currentFlashcardIndex + 1} ${t.of} ${cards.length}`;
  wordEl.textContent = card.word || "";
  wordPinyinEl.textContent = card.pinyin || "";
  if (wordBackEl) wordBackEl.textContent = card.word || "";
  if (translationEl) translationEl.textContent = cleanTranslation(card.translation);

  flashcardFlipped = false;
  cardEl.classList.remove("is-flipped");

  // ── Speaking mode UI ─────────────────────────────
  const speakBtn      = document.getElementById("flashcardSpeakBtn");
  const speakPromptEl = document.getElementById("flashcardSpeakPrompt");
  const hardTranslEl  = document.getElementById("flashcardHardTranslation");
  const resultEl      = document.getElementById("flashcardSpeakingResult");
  const nextBtn       = document.getElementById("flashcardNextBtn");
  const speakEasyBtn  = document.getElementById("flashcardSpeakEasyBtn");
  const speakHardBtn  = document.getElementById("flashcardSpeakHardBtn");
  const speakExitBtn  = document.getElementById("flashcardSpeakExitBtn");

  if (flashcardSpeakingMode) {
    if (speakEasyBtn) speakEasyBtn.hidden = true;
    if (speakHardBtn) speakHardBtn.hidden = true;
    if (speakExitBtn) speakExitBtn.hidden = false;
    if (nextBtn) nextBtn.disabled = !flashcardSpeakingUnlocked;

    if (flashcardSpeakingMode === "easy") {
      if (hardTranslEl)  hardTranslEl.hidden = true;
      if (speakPromptEl) speakPromptEl.hidden = true;
      if (speakBtn) { speakBtn.hidden = false; speakBtn.textContent = "Say it 🎤"; }
    }

    if (flashcardSpeakingMode === "hard") {
      if (!flashcardSpeakingUnlocked) {
        wordEl.textContent = "???";
        wordPinyinEl.textContent = "";
        if (wordBackEl) wordBackEl.textContent = "???";
        if (hardTranslEl) { hardTranslEl.hidden = false; hardTranslEl.textContent = card.translation || ""; }
        if (speakPromptEl) { speakPromptEl.hidden = false; speakPromptEl.textContent = "Say this in the target language"; }
        if (speakBtn) { speakBtn.hidden = false; speakBtn.textContent = "Say it 🎤"; }
      } else {
        if (hardTranslEl)  hardTranslEl.hidden = true;
        if (speakPromptEl) speakPromptEl.hidden = true;
        if (speakBtn)      speakBtn.hidden = true;
      }
    }
  } else {
    if (speakEasyBtn)  speakEasyBtn.hidden = false;
    if (speakHardBtn)  speakHardBtn.hidden = false;
    if (speakExitBtn)  speakExitBtn.hidden = true;
    if (speakBtn)      speakBtn.hidden = true;
    if (speakPromptEl) speakPromptEl.hidden = true;
    if (hardTranslEl)  hardTranslEl.hidden = true;
    if (nextBtn)       nextBtn.disabled = false;
  }
}

function flipFlashcard() {
  const cardEl = document.getElementById("flashcardCard");
  const cards = getCurrentCards();

  if (!cardEl || !cards.length) return;

  flashcardFlipped = !flashcardFlipped;
  cardEl.classList.toggle("is-flipped", flashcardFlipped);
}

function goToNextFlashcard() {
  const cards = getCurrentCards();
  if (!cards.length) return;

  if (flashcardSpeakingMode && !flashcardSpeakingUnlocked) {
    showToast("Pronounce the word correctly to continue.", "error");
    return;
  }

  currentFlashcardIndex = (currentFlashcardIndex + 1) % cards.length;
  if (flashcardSpeakingMode) {
    flashcardSpeakingUnlocked = false;
    stopFlashcardRecognition();
    const resultEl = document.getElementById("flashcardSpeakingResult");
    if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  }
  renderFlashcards();
}

function goToPrevFlashcard() {
  const cards = getCurrentCards();
  if (!cards.length) return;

  currentFlashcardIndex = (currentFlashcardIndex - 1 + cards.length) % cards.length;
  if (flashcardSpeakingMode) {
    flashcardSpeakingUnlocked = false;
    stopFlashcardRecognition();
    const resultEl = document.getElementById("flashcardSpeakingResult");
    if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  }
  renderFlashcards();
}

async function deleteCurrentFlashcard() {
  const deck = getCurrentDeck();
  if (!deck || !deck.cards.length) return;

  const card = deck.cards[currentFlashcardIndex];

  if (card?.id) {
    const { error } = await supabase.from("flashcards").delete().eq("id", card.id);
    if (error) {
      console.error("Delete flashcard error:", error);
      showToast("Could not delete card.", "error");
      return;
    }
  }

  deck.cards.splice(currentFlashcardIndex, 1);

  if (currentFlashcardIndex >= deck.cards.length) {
    currentFlashcardIndex = Math.max(0, deck.cards.length - 1);
  }

  renderDeckSelector();
  renderFlashcards();
}

async function clearFlashcards() {
  const deck = getCurrentDeck();
  if (!deck) return;

  const confirmed = await showConfirm(`Clear all cards in "${deck.name}"?`);
  if (!confirmed) return;

  const { error } = await supabase.from("flashcards").delete().eq("deck_id", deck.id);
  if (error) {
    console.error("Clear flashcards error:", error);
    showToast("Could not clear cards.", "error");
    return;
  }

  deck.cards = [];
  currentFlashcardIndex = 0;

  renderDeckSelector();
  renderFlashcards();
}

async function createDeck() {
  // Gate: free users can have up to FREE_MAX_DECKS decks.
  const allowed = await checkDeckQuota("new-deck", document.getElementById("flashcardNewDeckBtn"));
  if (!allowed) return;

  const name = await showPrompt("Deck name:");
  if (!name) return;

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return;

  const { data, error } = await supabase
    .from("flashcard_decks")
    .insert({
      user_id: user.id,
      name: name.trim()
    })
    .select()
    .single();

  if (error) {
    console.error("Create deck error:", error);
    showToast("Could not create deck.", "error");
    return;
  }

  flashcardDecks.push({
    id: data.id,
    name: data.name,
    cards: []
  });

  currentDeckId = data.id;
  currentFlashcardIndex = 0;

  renderDeckSelector();
  renderFlashcards();
}

async function deleteCurrentDeck() {
  if (flashcardDecks.length === 1) {
    showToast("You need at least one deck.", "error");
    return;
  }

  const deck = getCurrentDeck();
  if (!deck) return;

  const confirmed = await showConfirm(`Delete deck "${deck.name}"?`);
  if (!confirmed) return;

  const { error } = await supabase.from("flashcard_decks").delete().eq("id", deck.id);
  if (error) {
    console.error("Delete deck error:", error);
    showToast("Could not delete deck.", "error");
    return;
  }

  flashcardDecks = flashcardDecks.filter(d => d.id !== currentDeckId);
  currentDeckId = flashcardDecks[0]?.id || null;
  currentFlashcardIndex = 0;

  renderDeckSelector();
  renderFlashcards();
}

function limitMeanings(text, max = 3) {
  return String(text || "")
    .split(/[;,/|]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter((item, i, arr) => arr.indexOf(item) === i)
    .slice(0, max)
    .join("; ");
}

async function importWords() {
  const deck = getCurrentDeck();
  if (!deck) {
    showToast("Please select or create a deck first.", "error");
    return;
  }

  const lang = sourceLangSelect.value;
  const targetLang = targetLangSelect.value;
  const isZh = lang === "zh";

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box import-modal-box">
      <h3 class="import-modal-title">Import words</h3>
      <p class="import-modal-hint">One word per line, or separated by commas or semicolons.</p>
      <textarea class="import-modal-textarea" placeholder="图书馆&#10;学习&#10;天气&#10;朋友"></textarea>
      <div class="import-progress" hidden></div>
      <div class="modal-actions">
        <button class="modal-cancel ghost-btn">Cancel</button>
        <button class="modal-confirm primary-btn">Import</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const textarea = overlay.querySelector(".import-modal-textarea");
  const progressEl = overlay.querySelector(".import-progress");
  const confirmBtn = overlay.querySelector(".modal-confirm");
  const cancelBtn = overlay.querySelector(".modal-cancel");

  textarea.focus();

  cancelBtn.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  confirmBtn.addEventListener("click", async () => {
    const words = textarea.value
      .split(/[\n,;]+/)
      .map(w => w.trim())
      .filter(Boolean)
      .filter((w, i, arr) => arr.indexOf(w) === i);

    if (!words.length) {
      showToast("Please enter at least one word.", "error");
      return;
    }

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    textarea.disabled = true;
    progressEl.hidden = false;

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      progressEl.textContent = `Importing ${i + 1} of ${words.length}…`;

      try {
        let translation = "";
        let pinyin = "";

        if (isZh) {
          try {
            const dictRes = await fetchWithAuth(`${API_BASE}/api/dictionary`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ word })
            });
            const dictData = await dictRes.json();
            if (dictRes.ok && dictData.entries?.length) {
              const entry = dictData.entries[0];
              translation = entry.definitions
                .map(d => d.trim())
                .filter(Boolean)
                .slice(0, 3)
                .join("; ");
              pinyin = entry.pinyin || "";
            }
          } catch {
            // fall through to translate
          }
        }

        if (!translation) {
          const transRes = await fetchWithAuth(`${API_BASE}/api/translate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sentence: word, sourceLang: lang, targetLang })
          });
          const transData = await transRes.json();
          if (!transRes.ok) throw new Error(transData.error || "Translation failed");
          translation = limitMeanings(transData.translation || "", 3);
        }

        if (isZh && !pinyin) {
          try {
            const segRes = await fetchWithAuth(`${API_BASE}/api/segment`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: word })
            });
            const segData = await segRes.json();
            if (segRes.ok && segData.words) {
              pinyin = segData.words.map(s => s.pinyin || "").filter(Boolean).join(" ");
            }
          } catch {
            // pinyin is optional
          }
        }

        const added = await addFlashcard({ word, pinyin, sentence: "", sentencePinyin: "", translation, lang });
        if (added) { imported++; } else { skipped++; }
      } catch (err) {
        console.error(`Import failed for "${word}":`, err);
        failed++;
      }
    }

    overlay.remove();

    const parts = [];
    if (imported) parts.push(`${imported} word${imported !== 1 ? "s" : ""} imported`);
    if (skipped) parts.push(`${skipped} skipped (already in deck)`);
    if (failed) parts.push(`${failed} failed`);
    showToast(parts.join(", ") + ".", failed > 0 ? "error" : "success");
  });
}

async function exportCurrentDeck() {
  const deck = getCurrentDeck();

  if (!deck) {
    showToast("No deck selected.", "error");
    return;
  }

  if (!deck.cards || !deck.cards.length) {
    showToast("This deck is empty.", "error");
    return;
  }

  const words = deck.cards
    .map(card => (card.word || "").trim())
    .filter(Boolean);

  const deckEl = document.getElementById("flashcardDeck");
  let exportResult = document.getElementById("flashcardExportResult");

  if (!exportResult && deckEl) {
    exportResult = document.createElement("div");
    exportResult.id = "flashcardExportResult";
    exportResult.className = "translation-box panel-box";
    deckEl.appendChild(exportResult);
  }

  if (exportResult) exportResult.textContent = "Creating printable deck...";

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/export-flashcard-deck`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        deckName: deck.name,
        words
      })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Export failed");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    if (exportResult) {
      exportResult.innerHTML = "";

      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.className = "download-pdf-link";
      link.textContent = "Open printable deck";

      exportResult.appendChild(link);
    }
  } catch (error) {
    console.error("Deck export error:", error);

    if (exportResult) {
      exportResult.textContent = `Could not export printable deck: ${error.message}`;
    } else {
      showToast("Could not export printable deck.", "error");
    }
  }
}

document.getElementById("flashcardCard")?.addEventListener("click", flipFlashcard);
document.getElementById("flashcardNextBtn")?.addEventListener("click", goToNextFlashcard);
document.getElementById("flashcardPrevBtn")?.addEventListener("click", goToPrevFlashcard);
document.getElementById("flashcardDeleteBtn")?.addEventListener("click", deleteCurrentFlashcard);

document.addEventListener("keydown", (e) => {
  if (!screenFlashcards?.classList.contains("active")) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "ArrowLeft") { e.preventDefault(); goToPrevFlashcard(); }
  if (e.key === "ArrowRight") { e.preventDefault(); goToNextFlashcard(); }
  if (e.key === " " || e.key === "Enter") { e.preventDefault(); flipFlashcard(); }
});
document.getElementById("flashcardClearBtn")?.addEventListener("click", clearFlashcards);
document.getElementById("flashcardNewDeckBtn")?.addEventListener("click", createDeck);
document.getElementById("flashcardDeleteDeckBtn")?.addEventListener("click", deleteCurrentDeck);
document.getElementById("flashcardImportBtn")?.addEventListener("click", importWords);
document.getElementById("flashcardExportBtn")?.addEventListener("click", exportCurrentDeck);

document.getElementById("flashcardDeckSelect")?.addEventListener("change", (e) => {
  currentDeckId = e.target.value;
  currentFlashcardIndex = 0;
  flashcardSpeakingMode = null;
  flashcardSpeakingUnlocked = true;
  stopFlashcardRecognition();
  renderFlashcards();
});

document.getElementById("flashcardSpeakEasyBtn")?.addEventListener("click", () => {
  if (!getCurrentCards().length) { showToast(getT().noCardsInDeck, "error"); return; }
  fcMode = "browse";
  flashcardSpeakingMode = "easy";
  flashcardSpeakingUnlocked = false;
  stopFlashcardRecognition();
  const resultEl = document.getElementById("flashcardSpeakingResult");
  if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  renderFlashcards();
});

document.getElementById("flashcardSpeakHardBtn")?.addEventListener("click", () => {
  if (!getCurrentCards().length) { showToast(getT().noCardsInDeck, "error"); return; }
  fcMode = "browse";
  flashcardSpeakingMode = "hard";
  flashcardSpeakingUnlocked = false;
  stopFlashcardRecognition();
  const resultEl = document.getElementById("flashcardSpeakingResult");
  if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  renderFlashcards();
});

document.getElementById("flashcardSpeakExitBtn")?.addEventListener("click", () => {
  flashcardSpeakingMode = null;
  flashcardSpeakingUnlocked = true;
  stopFlashcardRecognition();
  const resultEl = document.getElementById("flashcardSpeakingResult");
  if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  renderFlashcards();
});

document.getElementById("flashcardSpeakBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  startFlashcardSpeakingPractice();
});

document.getElementById("flashcardPlayWordBtn")?.addEventListener("click", async (e) => {
  unlockAudioForMobile();
  e.stopPropagation();

  const cards = getCurrentCards();
  if (!cards.length) return;

  const card = cards[currentFlashcardIndex];
  const word = card?.word;
  const lang = card?.lang;

  if (word) {
    stopAllTTS();
    await playGoogleTTS(word, lang);
  }
});

/* -----------------------------
   FLASHCARD MODES: Learn (4-choice quiz) & Check (type the term)
----------------------------- */

let fcMode = "browse";        // "browse" | "learn" | "check"
let fcLearn = null;           // learn-session state
let fcCheck = null;           // check-session state

const FC_LEARN_MIN_CARDS = 5;

function fcShuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function setFcMode(mode) {
  fcMode = mode;
  // Any mode switch leaves speaking practice.
  flashcardSpeakingMode = null;
  flashcardSpeakingUnlocked = true;
  stopFlashcardRecognition();
  const resultEl = document.getElementById("flashcardSpeakingResult");
  if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  if (mode === "learn") fcStartLearn();
  if (mode === "check") fcStartCheck();
  renderFlashcards();
}

document.querySelectorAll(".fc-mode-tab").forEach(btn => btn.addEventListener("click", () => {
  const mode = btn.dataset.fcMode;
  if (mode === fcMode) return;
  if (mode === "learn" && (getCurrentDeck()?.cards.length || 0) < FC_LEARN_MIN_CARDS) {
    showToast(getT().learnLocked, "info");
    return;
  }
  if (mode === "check" && !(getCurrentDeck()?.cards.length)) {
    showToast(getT().noCardsInDeck, "error");
    return;
  }
  setFcMode(mode);
}));

/* ── Learn: multiple choice, alternating direction ── */

function fcStartLearn() {
  const deck = getCurrentDeck();
  fcLearn = {
    deckId: deck?.id,
    queue: fcShuffle(deck?.cards || []),
    idx: 0,
    correct: 0,
    current: null
  };
}

function fcBuildLearnQuestion() {
  const q = fcLearn.queue[fcLearn.idx];
  const deck = getCurrentDeck();
  // Alternate direction: even questions show the term, odd show the translation.
  const reverse = fcLearn.idx % 2 === 1;
  const answerOf = c => reverse ? (c.word || "") : cleanTranslation(c.translation || "");
  const correctText = answerOf(q);

  const seen = new Set([correctText]);
  const distractors = [];
  for (const c of fcShuffle(deck?.cards || [])) {
    if (c.id === q.id) continue;
    const t = answerOf(c);
    if (t && !seen.has(t)) { seen.add(t); distractors.push(t); }
    if (distractors.length === 3) break;
  }

  fcLearn.current = {
    prompt: reverse ? cleanTranslation(q.translation || "") : (q.word || ""),
    promptPinyin: reverse ? "" : (q.pinyin || ""),
    correctText,
    options: fcShuffle([correctText, ...distractors]),
    choice: null
  };
}

function renderFcLearn() {
  const panel = document.getElementById("fcLearnPanel");
  if (!panel || !fcLearn) return;

  if (fcLearn.idx >= fcLearn.queue.length) {
    panel.innerHTML = `
      <div class="fcq-summary">
        <p class="fcq-score">${fcLearn.correct} / ${fcLearn.queue.length}</p>
        <p class="fcq-score-sub">${escapeHtml(getT().answeredCorrectly)}</p>
        <button class="primary-btn" id="fcLearnAgainBtn" type="button">${escapeHtml(getT().practiceAgain)}</button>
      </div>`;
    document.getElementById("fcLearnAgainBtn")?.addEventListener("click", () => { fcStartLearn(); renderFcLearn(); });
    return;
  }

  if (!fcLearn.current) fcBuildLearnQuestion();
  const cur = fcLearn.current;
  const answered = cur.choice != null;

  panel.innerHTML = `
    <p class="fcq-progress">${fcLearn.idx + 1} ${escapeHtml(getT().of)} ${fcLearn.queue.length}</p>
    <div class="fcq-prompt">
      <h3>${escapeHtml(cur.prompt)}</h3>
      ${cur.promptPinyin ? `<p class="fcq-pinyin">${escapeHtml(cur.promptPinyin)}</p>` : ""}
    </div>
    <div class="fcq-opts">
      ${cur.options.map((op, i) => {
        let cls = "fcq-opt";
        if (answered && op === cur.correctText) cls += " correct";
        else if (answered && i === cur.choice) cls += " wrong";
        return `<button class="${cls}" data-opt="${i}" type="button" ${answered ? "disabled" : ""}>${escapeHtml(op)}</button>`;
      }).join("")}
    </div>
    ${answered ? `<button class="primary-btn fcq-next" id="fcLearnNextBtn" type="button">${fcLearn.idx + 1 >= fcLearn.queue.length ? escapeHtml(getT().seeResult) : escapeHtml(getT().next)}</button>` : ""}
  `;

  panel.querySelectorAll(".fcq-opt").forEach(btn => btn.addEventListener("click", () => {
    if (fcLearn.current.choice != null) return;
    const i = Number(btn.dataset.opt);
    fcLearn.current.choice = i;
    if (fcLearn.current.options[i] === fcLearn.current.correctText) {
      fcLearn.correct++;
      recordActivity("words_practiced", 1);
    }
    renderFcLearn();
  }));

  document.getElementById("fcLearnNextBtn")?.addEventListener("click", () => {
    fcLearn.idx++;
    fcLearn.current = null;
    renderFcLearn();
  });
}

/* ── Check: type the term for the shown translation ── */

function fcStartCheck() {
  const deck = getCurrentDeck();
  fcCheck = {
    deckId: deck?.id,
    queue: fcShuffle(deck?.cards || []),
    idx: 0,
    correct: 0,
    state: null // null = typing, "correct" | "wrong" after submit
  };
}

// Trim + collapse spaces; case-insensitive for scripts that have case.
function fcNormalizeAnswer(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function renderFcCheck() {
  const panel = document.getElementById("fcCheckPanel");
  if (!panel || !fcCheck) return;

  if (fcCheck.idx >= fcCheck.queue.length) {
    panel.innerHTML = `
      <div class="fcq-summary">
        <p class="fcq-score">${fcCheck.correct} / ${fcCheck.queue.length}</p>
        <p class="fcq-score-sub">${escapeHtml(getT().typedCorrectly)}</p>
        <button class="primary-btn" id="fcCheckAgainBtn" type="button">${escapeHtml(getT().practiceAgain)}</button>
      </div>`;
    document.getElementById("fcCheckAgainBtn")?.addEventListener("click", () => { fcStartCheck(); renderFcCheck(); });
    return;
  }

  const card = fcCheck.queue[fcCheck.idx];
  const answered = fcCheck.state != null;

  panel.innerHTML = `
    <p class="fcq-progress">${fcCheck.idx + 1} ${escapeHtml(getT().of)} ${fcCheck.queue.length}</p>
    <div class="fcq-prompt">
      <h3>${escapeHtml(cleanTranslation(card.translation || ""))}</h3>
      <p class="fcq-pinyin">${escapeHtml(getT().typeTheWord)}</p>
    </div>
    <input id="fcCheckInput" class="fcq-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" ${answered ? "disabled" : ""} />
    ${answered ? `
      <div class="fcq-feedback ${fcCheck.state === "correct" ? "ok" : "no"}">
        ${fcCheck.state === "correct"
          ? escapeHtml(getT().correctExcl)
          : `${escapeHtml(getT().correctAnswerIs)} <b>${escapeHtml(card.word || "")}</b>${card.pinyin ? ` <span class="fcq-pinyin-inline">${escapeHtml(card.pinyin)}</span>` : ""}`}
      </div>
      <button class="primary-btn fcq-next" id="fcCheckNextBtn" type="button">${fcCheck.idx + 1 >= fcCheck.queue.length ? escapeHtml(getT().seeResult) : escapeHtml(getT().next)}</button>`
    : `<button class="primary-btn fcq-next" id="fcCheckSubmitBtn" type="button">${escapeHtml(getT().check)}</button>`}
  `;

  const input = document.getElementById("fcCheckInput");
  if (answered) {
    input.value = fcCheck.lastAnswer || "";
  } else {
    input.focus();
  }

  const submit = () => {
    if (fcCheck.state != null) return;
    const typed = input.value;
    if (!fcNormalizeAnswer(typed)) return;
    fcCheck.lastAnswer = typed;
    const ok = fcNormalizeAnswer(typed) === fcNormalizeAnswer(card.word);
    fcCheck.state = ok ? "correct" : "wrong";
    if (ok) {
      fcCheck.correct++;
      recordActivity("words_practiced", 1);
    }
    renderFcCheck();
  };

  document.getElementById("fcCheckSubmitBtn")?.addEventListener("click", submit);
  input?.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    if (fcCheck.state == null) submit();
    else document.getElementById("fcCheckNextBtn")?.click();
  });
  document.getElementById("fcCheckNextBtn")?.addEventListener("click", () => {
    fcCheck.idx++;
    fcCheck.state = null;
    fcCheck.lastAnswer = "";
    renderFcCheck();
  });
}

/* -----------------------------
   CALLIGRAPHY
----------------------------- */

createWritingSheetBtn?.addEventListener("click", async (event) => {
  event.preventDefault();
  event.stopPropagation();

  showScreen(screenWriting);

  const text = writingInput.value.trim();

  if (!text) {
    writingResult.textContent = "Please paste some text first.";
    return;
  }

  writingResult.textContent = "Creating PDF...";

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/create-writing-sheet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        sourceLang: sourceLangSelect.value
      })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to create writing sheet");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    writingResult.innerHTML = "";

    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.className = "download-pdf-link";
    link.textContent = "Open PDF";

    writingResult.appendChild(link);
  } catch (error) {
    console.error("Writing sheet error:", error);
    writingResult.textContent = `Could not create printable: ${error.message}`;
  }
});

/* -----------------------------
   INIT
----------------------------- */

window.addEventListener("DOMContentLoaded", async () => {
  syncMainToOnboarding();
  // App screens are only for signed-in users — logged-out visitors stay on
  // the landing page regardless of URL params or a stale sessionStorage.
  await initialAuthCheck;
  if (document.body.classList.contains("is-logged-in")) restoreActiveScreen();
  updateLanguageBasedUI();
  updateSlowLabels();

  await loadFlashcardsFromStorage();
  renderDeckSelector();
  renderFlashcards();
});

/* -----------------------------
   HELPERS
----------------------------- */

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showMagicLoadingOverlay(message = "Please wait, magic is being created…") {
  let overlay = document.getElementById("magicLoadingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "magicLoadingOverlay";
    overlay.className = "magic-loading-overlay";
    overlay.innerHTML = `
      <div class="magic-loading-card">
        <div class="magic-loader"></div>
        <strong></strong>
        <p>This can take a moment.</p>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  overlay.querySelector("strong").textContent = message;
  overlay.hidden = false;
}

function hideMagicLoadingOverlay() {
  const overlay = document.getElementById("magicLoadingOverlay");
  if (overlay) overlay.hidden = true;
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function showConfirm(message) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box">
        <p>${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button class="modal-cancel ghost-btn">Cancel</button>
          <button class="modal-confirm primary-btn">Confirm</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector(".modal-confirm").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.querySelector(".modal-cancel").addEventListener("click", () => { overlay.remove(); resolve(false); });
  });
}

/* ======================================================
   VIDEO SCREEN
   ====================================================== */

let vidPlayer      = null;   // YT.Player instance
let vidCaptions    = [];     // enriched caption array from /api/video-captions
let videoLang      = "";     // caption language (e.g. "zh")
let videoHelpLang  = "";     // translation/help language (e.g. "ru")
let vidSlowOn      = false;
let vidPinyinOn    = true;
let vidTransOn     = true;   // caption translations visible by default
let vidHighlightId = null;   // setInterval handle for line highlighting
let vidReplayTimer = null;   // setTimeout handle for auto-pause after replay
let currentVideoId  = "";
let vidFrameWindow = null;
let vidFrameMessageHandler = null;
let vidProxyState = { state: -1, currentTime: 0, duration: 0 };

const HOSTED_VIDEO_PLAYER_URL = "/video-player.html";

// In the native shells the local origin (https://localhost) is refused by
// YouTube, so the player page is loaded from the hosted site instead.
function getHostedPlayerURL() {
  return isNativeCapacitorShell() ? `${API_BASE}${HOSTED_VIDEO_PLAYER_URL}` : HOSTED_VIDEO_PLAYER_URL;
}
function getHostedPlayerOrigin() {
  return isNativeCapacitorShell() ? API_BASE : window.location.origin;
}

function extractYouTubeId(input) {
  const s = (input || "").trim();
  const re = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const m = s.match(re) || s.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function getYouTubeEmbedOrigin() {
  const origin = window.location.origin || "";
  if (origin.startsWith("http://") || origin.startsWith("https://")) return origin;
  return "https://localhost";
}

function postHostedVideo(type, payload = {}) {
  if (!vidFrameWindow) return;
  vidFrameWindow.postMessage({ source: "magic-read-video-host", type, ...payload }, getHostedPlayerOrigin());
}

function makeHostedVideoProxy() {
  return {
    getCurrentTime: () => vidProxyState.currentTime || 0,
    getDuration: () => vidProxyState.duration || 0,
    getPlayerState: () => vidProxyState.state,
    playVideo: () => postHostedVideo("play"),
    pauseVideo: () => postHostedVideo("pause"),
    seekTo: (seconds) => {
      vidProxyState.currentTime = Math.max(0, Number(seconds) || 0);
      postHostedVideo("seek", { seconds: vidProxyState.currentTime });
    },
    setPlaybackRate: (rate) => postHostedVideo("rate", { rate })
  };
}

function showVideoExternalFallback(videoId, reason = "") {
  const container = document.getElementById("vidPlayerContainer");
  const placeholder = document.getElementById("vidPlayerPlaceholder");
  const transport = document.getElementById("vidTransport");
  if (placeholder) placeholder.hidden = true;
  if (transport) transport.hidden = true;
  if (!container || !videoId) return;
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const thumb = `https://img.youtube.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
  container.innerHTML = `
    <div class="vid-external-fallback">
      <img src="${escapeHtml(thumb)}" alt="" loading="lazy">
      <div class="vid-external-shade"></div>
      <div class="vid-external-content">
        <div class="vid-external-title">Open video on YouTube</div>
        <div class="vid-external-sub">${escapeHtml(reason || "YouTube blocked embedded playback here, but captions are still available below.")}</div>
        <a class="vid-external-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Watch on YouTube</a>
      </div>
    </div>`;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

async function fetchJsonWithTimeout(url, ms = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchWithAuth(url, { signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function getVideoCaptionLangCandidates(lang) {
  const base = lang || "en";
  const variants = {
    en: ["en", "en-US", "en-GB"],
    zh: ["zh", "zh-CN", "zh-Hans"],
    pt: ["pt", "pt-BR", "pt-PT"],
    es: ["es", "es-419"],
  };
  return [...new Set(variants[base] || [base])];
}

async function fetchVideoCaptionsWithFallback(videoId, lang, targetLang) {
  let lastData = null;
  let lastError = null;
  for (const captionLang of getVideoCaptionLangCandidates(lang)) {
    try {
      const data = await fetchJsonWithTimeout(
        `${API_BASE}/api/video-captions?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(captionLang)}&targetLang=${encodeURIComponent(targetLang)}`,
        22000
      );
      if (data?.captions?.length) return { data, lang: captionLang };
      lastData = data;
    } catch (err) {
      lastError = err;
      if (err.status && err.status !== 503) break;
    }
  }
  if (lastData) return { data: lastData, lang };
  throw lastError || new Error("Captions unavailable");
}

function setVideoCaptionError(message) {
  const text = document.getElementById("vidServiceErrorText");
  if (text) text.textContent = message || "Something went wrong loading captions. Please try again in a moment.";
}

// ── Player lifecycle ────────────────────────────────────

function mountYTPlayer(videoId) {
  const container = document.getElementById("vidPlayerContainer");
  if (!container) return Promise.resolve();

  if (vidFrameMessageHandler) {
    window.removeEventListener("message", vidFrameMessageHandler);
    vidFrameMessageHandler = null;
  }
  vidFrameWindow = null;
  vidProxyState = { state: -1, currentTime: 0, duration: 0 };
  vidPlayer = makeHostedVideoProxy();

  container.innerHTML = "";
  const iframe = document.createElement("iframe");
  iframe.src = `${getHostedPlayerURL()}?videoId=${encodeURIComponent(videoId)}&parentOrigin=${encodeURIComponent(getYouTubeEmbedOrigin())}`;
  iframe.title = "YouTube video player";
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allowFullscreen = true;
  container.appendChild(iframe);
  vidFrameWindow = iframe.contentWindow;

  return new Promise((resolve, reject) => {
    vidFrameMessageHandler = (event) => {
      if (event.origin !== getHostedPlayerOrigin()) return;
      const msg = event.data || {};
      if (msg.source !== "magic-read-video-player") return;
      if (typeof msg.currentTime === "number") vidProxyState.currentTime = msg.currentTime;
      if (typeof msg.duration === "number") vidProxyState.duration = msg.duration;
      if (typeof msg.state === "number") vidProxyState.state = msg.state;
      if (msg.type === "ready") resolve();
      if (msg.type === "time") updateScrubberUI(vidProxyState.currentTime, vidProxyState.duration || 1);
      if (msg.type === "state") onVidStateChange({ data: vidProxyState.state });
      if (msg.type === "error") {
        onVidPlayerError({ data: msg.code });
        reject(new Error(`YouTube player error ${msg.code}`));
      }
    };
    window.addEventListener("message", vidFrameMessageHandler);
  });
}

function onVidPlayerError(event) {
  const code = event?.data;
  console.warn("[Video] YouTube player error:", code);
  if (code === 101 || code === 150 || code === 153) {
    showVideoExternalFallback(currentVideoId, "YouTube blocked embedded playback in the app.");
    showToast("Captions loaded. Open the video on YouTube to watch it.", "info");
  }
}

function onVidStateChange(event) {
  const playing = event.data === 1; // YT.PlayerState.PLAYING
  const useEl = document.getElementById("vidPlayPauseUse");
  if (useEl) useEl.setAttribute("href", playing ? "#sonic-i-pause" : "#sonic-i-play");
  if (playing) startHighlightLoop();
  else          stopHighlightLoop();
}

// ── Caption highlighting ────────────────────────────────

function startHighlightLoop() {
  stopHighlightLoop();
  vidHighlightId = setInterval(() => {
    if (!vidPlayer?.getCurrentTime) return;
    const t   = vidPlayer.getCurrentTime();
    const dur = vidPlayer.getDuration() || 1;
    updateScrubberUI(t, dur);
    highlightCurrentLine(t);
  }, 200);
}

function stopHighlightLoop() {
  clearInterval(vidHighlightId);
  vidHighlightId = null;
}

function updateScrubberUI(t, dur) {
  const scrubber = document.getElementById("vidScrubber");
  if (scrubber && !scrubber._seeking) scrubber.value = (t / dur) * 1000;
  const timeEl = document.getElementById("vidTimeDisplay");
  if (timeEl) timeEl.textContent = `${fmtTime(t)} / ${fmtTime(dur)}`;
}

function highlightCurrentLine(t) {
  const lines = document.querySelectorAll(".vid-line");
  let activeEl = null;
  lines.forEach((el, i) => {
    const cap = vidCaptions[i];
    if (!cap) return;
    const isCurrent = t >= cap.start && t < cap.start + cap.dur;
    const isPast    = t >= cap.start + cap.dur;
    el.classList.toggle("current", isCurrent);
    el.classList.toggle("past",    isPast && !isCurrent);
    if (isCurrent) activeEl = el;
  });
  if (activeEl) {
    // Keep the active line pinned mid-box so the transcript flows upward
    // (bottom → top) while the video plays.
    activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ── Caption rendering ───────────────────────────────────

function buildChineseLineHTML(tokens) {
  return (tokens || []).map(({ word, pinyin: py }) =>
    `<span class="vid-ruby" data-word="${escapeHtml(word)}" data-pinyin="${escapeHtml(py || "")}">` +
    `<small>${escapeHtml(py || "")}</small>` +
    `<span class="vid-zh">${escapeHtml(word)}</span>` +
    `</span>`
  ).join("");
}

function buildPlainLineHTML(text) {
  return text.split(/(\s+)/).map(w =>
    w.trim()
      ? `<span class="vid-word" data-word="${escapeHtml(w)}">${escapeHtml(w)}</span>`
      : escapeHtml(w)
  ).join("");
}

function renderCaptions(captions, lang) {
  const capList = document.getElementById("vidCapList");
  if (!capList) return;
  const isCJK = lang === "zh" || lang === "ja";

  capList.innerHTML = captions.map((cap, i) => {
    // Older cached Japanese captions have no tokens — fall back to plain text.
    const hanHTML = (isCJK && cap.tokens?.length)
      ? `<div class="vid-han">${buildChineseLineHTML(cap.tokens)}</div>`
      : `<div class="vid-text">${buildPlainLineHTML(cap.text)}</div>`;

    return `
      <div class="vid-line" data-cap-index="${i}">
        ${hanHTML}
        ${cap.translation ? `<div class="vid-tr">${escapeHtml(cap.translation)}</div>` : ""}
        <div class="vid-line-acts">
          <button class="vid-replay-btn" type="button" data-cap-index="${i}" aria-label="Replay line">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-play"/></svg>
            ${escapeHtml(getT().listen)}
          </button>
        </div>
      </div>`;
  }).join("");

  function replayCapLine(cap) {
    if (!vidPlayer) return;
    clearTimeout(vidReplayTimer);
    vidPlayer.seekTo(cap.start, true);
    vidPlayer.playVideo();
    vidReplayTimer = setTimeout(() => {
      if (vidPlayer?.getPlayerState() === 1) vidPlayer.pauseVideo();
    }, cap.dur * 1000);
  }

  // Line tap → seek and play; word tap → replay line + popup
  capList.querySelectorAll(".vid-line").forEach((lineEl, i) => {
    const cap = captions[i];
    if (!cap) return;

    // Tap line → seek to start of line and play
    lineEl.addEventListener("click", () => {
      replayCapLine(cap);
    });

    // Replay line button
    lineEl.querySelector(".vid-replay-btn")?.addEventListener("click", e => {
      e.stopPropagation();
      replayCapLine(cap);
    });

    // Chinese ruby tokens — replay line in video + show translate/save popup
    lineEl.querySelectorAll(".vid-ruby").forEach(tokenEl => {
      tokenEl.addEventListener("click", e => {
        e.stopPropagation();
        unlockAudioForMobile();
        const word = tokenEl.dataset.word;
        document.querySelectorAll(".vid-ruby.sel").forEach(el => el.classList.remove("sel"));
        tokenEl.classList.add("sel");
        replayCapLine(cap);
        showVideoWordPopup(tokenEl, word, cap.text, "", true).catch(console.error);
      });
      tokenEl.addEventListener("mouseenter", e => {
        const word = tokenEl.dataset.word;
        showVideoWordPopup(tokenEl, word, cap.text, "", false).catch(console.error);
      });
    });

    // Non-Chinese word spans — replay line in video + show translate/save popup
    lineEl.querySelectorAll(".vid-word").forEach(wordEl => {
      wordEl.addEventListener("click", e => {
        e.stopPropagation();
        unlockAudioForMobile();
        const word = wordEl.dataset.word;
        replayCapLine(cap);
        showVideoWordPopup(wordEl, word, cap.text, "", true).catch(console.error);
      });
      wordEl.addEventListener("mouseenter", e => {
        const word = wordEl.dataset.word;
        showVideoWordPopup(wordEl, word, cap.text, "", false).catch(console.error);
      });
    });
  });
}

// ── Load flow ───────────────────────────────────────────

function renderVidFreeChip() {
  const chip = document.getElementById("vidFreeChip");
  const txt  = document.getElementById("vidFreeChipText");
  if (!chip) return;
  if (!userPlan.trialActive || isPaidProUser()) { chip.hidden = true; return; }
  const remaining = Math.max(0, userPlan.limits.videosPerTrial - userPlan.videosOpened);
  if (txt) txt.textContent = `${remaining} free video${remaining === 1 ? "" : "s"} left`;
  chip.hidden = false;
}

async function checkVideoQuota() {
  if (!document.body.classList.contains("is-logged-in")) return true;
  try {
    const res  = await fetchWithAuth(`${API_BASE}/api/check-video-quota`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      showUpgradePrompt(data.code || "VIDEO_QUOTA_EXCEEDED");
      return false;
    }
    if (typeof data.used === "number") userPlan.videosOpened = data.used;
    renderVidFreeChip();
    return true;
  } catch {
    return true; // fail open on network error
  }
}

async function loadVideoById(videoId) {
  const allowed = await checkVideoQuota();
  if (!allowed) return;
  currentVideoId = videoId;

  const placeholder  = document.getElementById("vidPlayerPlaceholder");
  const transport    = document.getElementById("vidTransport");
  const capArea      = document.getElementById("vidCaptionArea");
  const loadingState = document.getElementById("vidLoadingState");
  const noCapState   = document.getElementById("vidNoCapState");
  const errState     = document.getElementById("vidServiceErrorState");

  // Reset states
  if (placeholder)  placeholder.hidden  = false;
  if (transport)    transport.hidden    = true;
  if (capArea)      capArea.hidden      = true;
  if (loadingState) loadingState.hidden = false;
  if (noCapState)   noCapState.hidden   = true;
  if (errState)     errState.hidden     = true;
  const playerContainer = document.getElementById("vidPlayerContainer");
  if (playerContainer) playerContainer.innerHTML = "";
  setVideoCaptionError("");

  // Same convention as the rest of the app: sourceLang = the language being
  // learned (captions), targetLang = the user's own language (translations).
  // These were swapped before, which asked for captions in the user's native
  // language and "translated" them into the learning language (e.g. tr → tr).
  const lang = sourceLangSelect.value || "zh";
  const targetLang = targetLangSelect.value || "en";
  videoLang = lang;
  videoHelpLang = targetLang;

  try {
    try {
      await withTimeout(mountYTPlayer(videoId), 12000, "Video player timed out");
      if (placeholder) placeholder.hidden = true;
      if (transport) transport.hidden = false;
    } catch (playerErr) {
      console.warn("[Video] player load issue:", playerErr.message);
      showVideoExternalFallback(videoId, "YouTube did not allow embedded playback here.");
    }

    const captionResult = await fetchVideoCaptionsWithFallback(videoId, lang, targetLang);
    const captionData = captionResult.data;
    videoLang = captionResult.lang || lang;

    if (loadingState) loadingState.hidden = true;

    if (captionData.code === "CAPTION_SERVICE_ERROR") {
      setVideoCaptionError(captionData.detail || captionData.error || "The video opened, but captions are temporarily unavailable.");
      if (errState) errState.hidden = false;
      return;
    }

    if (captionData.needsGeneration || !captionData.captions?.length) {
      if (noCapState) noCapState.hidden = false;
      return;
    }

    vidCaptions = captionData.captions;
    renderCaptions(vidCaptions, videoLang);

    if (capArea) capArea.hidden = false;

    // Sync toggles — reading-aid button for Chinese (Pinyin) and Japanese (Romaji)
    const capList = document.getElementById("vidCapList");
    const pinyinBtn = document.getElementById("vidPinyinToggle");
    if (capList) {
      capList.classList.toggle("vid-pinyin-off", !vidPinyinOn);
      capList.classList.toggle("vid-trans-off", !vidTransOn);
    }
    if (pinyinBtn) {
      pinyinBtn.hidden = videoLang !== "zh" && videoLang !== "ja";
      pinyinBtn.textContent = videoLang === "ja" ? getT().romajiPill : getT().pinyinPill;
      pinyinBtn.classList.toggle("on", vidPinyinOn);
    }
    const transBtn = document.getElementById("vidTransToggle");
    if (transBtn) transBtn.classList.toggle("on", vidTransOn);

    // Save progress — fetch real title via YouTube oEmbed (free, no API key)
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`)
      .then(r => r.json())
      .then(d => saveProgress("video", videoId, { seconds: 0 }, d.title || videoId))
      .catch(() => saveProgress("video", videoId, { seconds: 0 }, videoId));

  } catch (err) {
    console.error("[Video] load error:", err.message);
    if (loadingState) loadingState.hidden = true;
    setVideoCaptionError(err.data?.detail || err.data?.error || err.message || "The video opened, but captions could not be loaded.");
    if (errState) errState.hidden = false;
    showToast("Video opened, but captions could not load.", "error");
  }
}

// ── Screen init (called once per visit to the screen) ──

let _vidScreenInited = false;

function initVideoScreen() {
  if (_vidScreenInited) return;
  _vidScreenInited = true;

  const loadBtn  = document.getElementById("vidLoadBtn");
  const urlInput = document.getElementById("vidUrlInput");
  const back5Btn = document.getElementById("vidBack5Btn");
  const ppBtn    = document.getElementById("vidPlayPauseBtn");
  const slowBtn  = document.getElementById("vidSlowBtn");
  const scrubber = document.getElementById("vidScrubber");
  const pinyinBtn = document.getElementById("vidPinyinToggle");
  const tryAgainBtn = document.getElementById("vidTryAnotherBtn");
  const autoGenBtn  = document.getElementById("vidAutoGenBtn");

  function triggerLoad() {
    const id = extractYouTubeId(urlInput?.value || "");
    if (!id) { showToast("Paste a valid YouTube link.", "error"); return; }
    loadVideoById(id);
  }

  loadBtn?.addEventListener("click", triggerLoad);
  urlInput?.addEventListener("keydown", e => { if (e.key === "Enter") triggerLoad(); });

  back5Btn?.addEventListener("click", () => {
    if (!vidPlayer) return;
    clearTimeout(vidReplayTimer);
    vidPlayer.seekTo(Math.max(0, vidPlayer.getCurrentTime() - 5), true);
  });

  ppBtn?.addEventListener("click", () => {
    if (!vidPlayer) return;
    clearTimeout(vidReplayTimer);
    const state = vidPlayer.getPlayerState();
    if (state === 1) vidPlayer.pauseVideo();
    else             vidPlayer.playVideo();
  });

  slowBtn?.addEventListener("click", () => {
    if (!vidPlayer) return;
    vidSlowOn = !vidSlowOn;
    vidPlayer.setPlaybackRate(vidSlowOn ? 0.75 : 1);
    slowBtn.classList.toggle("on", vidSlowOn);
  });

  scrubber?.addEventListener("mousedown",  () => { if (scrubber) scrubber._seeking = true; });
  scrubber?.addEventListener("touchstart", () => { if (scrubber) scrubber._seeking = true; }, { passive: true });
  scrubber?.addEventListener("input", () => {
    if (!vidPlayer) return;
    clearTimeout(vidReplayTimer);
    const dur = vidPlayer.getDuration() || 0;
    vidPlayer.seekTo((Number(scrubber.value) / 1000) * dur, true);
  });
  scrubber?.addEventListener("mouseup",  () => { if (scrubber) scrubber._seeking = false; });
  scrubber?.addEventListener("touchend", () => { if (scrubber) scrubber._seeking = false; });

  pinyinBtn?.addEventListener("click", () => {
    vidPinyinOn = !vidPinyinOn;
    pinyinBtn.classList.toggle("on", vidPinyinOn);
    const capList = document.getElementById("vidCapList");
    capList?.classList.toggle("vid-pinyin-off", !vidPinyinOn);
  });

  document.getElementById("vidTransToggle")?.addEventListener("click", (e) => {
    vidTransOn = !vidTransOn;
    e.currentTarget.classList.toggle("on", vidTransOn);
    const capList = document.getElementById("vidCapList");
    capList?.classList.toggle("vid-trans-off", !vidTransOn);
  });

  tryAgainBtn?.addEventListener("click", () => {
    document.getElementById("vidNoCapState").hidden = true;
    urlInput?.focus();
  });

  document.getElementById("vidRetryBtn")?.addEventListener("click", () => {
    document.getElementById("vidServiceErrorState").hidden = true;
    triggerLoad();
  });

  autoGenBtn?.addEventListener("click", () => {
    showToast("Auto-generation coming soon for Pro users.", "info");
  });
}

function showPrompt(message, placeholder = "") {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-box">
        <p>${escapeHtml(message)}</p>
        <input class="modal-input auth-input" type="text" placeholder="${escapeHtml(placeholder)}" />
        <div class="modal-actions">
          <button class="modal-cancel ghost-btn">Cancel</button>
          <button class="modal-confirm primary-btn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const input = overlay.querySelector(".modal-input");
    input.focus();
    const confirm = () => { const v = input.value.trim(); overlay.remove(); resolve(v || null); };
    overlay.querySelector(".modal-confirm").addEventListener("click", confirm);
    overlay.querySelector(".modal-cancel").addEventListener("click", () => { overlay.remove(); resolve(null); });
    input.addEventListener("keydown", e => { if (e.key === "Enter") confirm(); if (e.key === "Escape") { overlay.remove(); resolve(null); } });
  });
}
