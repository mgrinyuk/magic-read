import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { UI_TEXT } from "./ui-text.js?v=20260621.2";
import { getModeCopy } from "./mode-copy.js?v=20260618.2";
import {
  assessPronunciation,
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
      MIC_DENIED: "Microphone is blocked. Please allow mic access in your browser.",
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

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function fetchWithAuth(url, options = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return fetch(url, options);
  return fetch(url, {
    ...options,
    headers: { ...options.headers, Authorization: `Bearer ${token}` }
  });
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

const createBtn = document.getElementById("createCardsBtn");
const inputText = document.getElementById("inputText");
const container = document.getElementById("cardsContainer");

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

let currentAudio = null;       // AudioBufferSourceNode
let audioCtxSuspended = false; // true when audioCtx.suspend() was called (paused)
let currentAudioText = "";
let currentAudioRate = 1.0;
let activePopup = null;
let activeHighlightTimer = null;

let ttsSlowMode = false;
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

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// iOS Safari requires AudioContext to be unlocked on the very first user touch,
// synchronously — before any await. Once running it stays unlocked.
function _unlockAudio() {
  if (audioCtx.state === "suspended") audioCtx.resume();
}
document.addEventListener("touchstart", _unlockAudio, { once: true, passive: true });
document.addEventListener("click", _unlockAudio, { once: true });

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
        const audioBuffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(data.audioBase64));
        const source = audioCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioCtx.destination);
        source.onended = () => { btn.disabled = false; btn.innerHTML = "&#9654;"; };
        source.start(0);
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
let currentFlashcardIndex = 0;
let flashcardFlipped = false;

speechSynthesis.getVoices();

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

// Drives the profile dropdown (upgrade button / Pro badge / trial badge),
// the welcome-week banner, and the soft text counter.
function renderPlanUI() {
  const upgradeBtn = document.getElementById("upgradeBtn");
  const proBadge = document.getElementById("proBadge");
  const trialBadge = document.getElementById("trialBadge");

  const loggedIn = document.body.classList.contains("is-logged-in");
  const paidPro = userPlan.plan === "pro";

  if (!loggedIn) {
    if (upgradeBtn) upgradeBtn.hidden = true;
    if (proBadge) proBadge.hidden = true;
    if (trialBadge) trialBadge.hidden = true;
  } else if (paidPro) {
    if (proBadge) proBadge.hidden = false;
    if (trialBadge) trialBadge.hidden = true;
    if (upgradeBtn) upgradeBtn.hidden = true;
  } else if (userPlan.trialActive) {
    const days = trialDaysLeft();
    if (trialBadge) {
      trialBadge.textContent = `Pro trial · ${days} day${days === 1 ? "" : "s"} left`;
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
    } else if (userPlan.trialActive) {
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
    option.hidden = !userPlan.lifetimeOfferEligible;
  });
}

function renderTbankOptions() {
  document.querySelectorAll("[data-tbank-plan], .tbank-plan-label").forEach(element => {
    element.hidden = !userPlan.tbankAvailable;
  });
}

function renderWelcomeBanner() {
  const banner = document.getElementById("welcomeWeekBanner");
  if (!banner) return;

  const dismissed = sessionStorage.getItem("welcomeWeekDismissed") === "1";
  if (userPlan.trialActive && !dismissed) {
    const end = userPlan.trialEndsAt ? new Date(userPlan.trialEndsAt) : null;
    const dateStr = end ? end.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
    const textEl = banner.querySelector(".welcome-week-text");
    if (textEl) {
      textEl.textContent =
        `✨ Welcome week — you have Pro access free until ${dateStr}. ` +
        `After that: ${userPlan.limits.textPerDay} texts/day, ${userPlan.limits.pronunciationPerDay} pronunciation checks/day.`;
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
  const msgs = {
    QUOTA_EXCEEDED: {
      title: "You're out of today's free checks",
      sub: `You've used all ${lim.pronunciationPerDay} pronunciation checks for today. Go Pro for unlimited practice — no daily cap.`,
      reassurance: "Your free checks reset tomorrow."
    },
    TEXT_QUOTA_EXCEEDED: {
      title: "That's your free texts for today",
      sub: `You've added ${lim.textPerDay} texts today. Go Pro to add as many as you like.`,
      reassurance: null
    },
    SAVE_TEXT_QUOTA_EXCEEDED: {
      title: "That's your free texts for today",
      sub: `You've saved ${lim.savedTexts} texts (free limit). Go Pro to save as many as you like.`,
      reassurance: null
    },
    DECK_QUOTA_EXCEEDED: {
      title: "You've reached the free limit",
      sub: `Free decks are capped at ${lim.decks}. Go Pro for unlimited decks and cards.`,
      reassurance: null
    },
    CARD_QUOTA_EXCEEDED: {
      title: "You've reached the free limit",
      sub: `Your deck has ${lim.cards} cards (free limit). Go Pro for unlimited cards.`,
      reassurance: null
    },
    VIDEO_QUOTA_EXCEEDED: {
      title: "Videos are a Pro feature",
      sub: `You've used your ${lim.videosPerTrial} trial videos. Go Pro to keep learning from any video.`,
      reassurance: null
    }
  };
  return msgs[code] || { title: "Upgrade to Pro", sub: "Go Pro for unlimited access.", reassurance: null };
}

// Show a dismissible upgrade modal at hard limits. The inline usage meter
// (renderSpeakMeter) stays visible independently — this modal is additive.
function showUpgradePrompt(code) {
  document.querySelectorAll(".upgrade-modal-overlay, .upgrade-inline").forEach(el => el.remove());
  const msg = getUpgradeMessage(code);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay upgrade-modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box upgrade-modal">
      <h3 class="upgrade-modal-title">${escapeHtml(msg.title)}</h3>
      <p class="upgrade-modal-sub">${escapeHtml(msg.sub)}</p>
      <ul class="upgrade-modal-unlocks">
        <li>Unlimited pronunciation checks</li>
        <li>Videos with smart captions</li>
        <li>Calligraphy worksheet export</li>
      </ul>
      <div class="upgrade-modal-plans">
        <button class="upgrade-plan-btn" data-price-type="annual" type="button">
          Annual — $49/yr <span class="upgrade-plan-save">Save 41%</span>
        </button>
        <button class="upgrade-plan-btn upgrade-plan-secondary" data-price-type="monthly" type="button">
          Monthly — $6.99/mo
        </button>
        ${userPlan.tbankAvailable ? `
          <div class="tbank-plan-label">${escapeHtml(getT().tbankPaymentLabel || "Russian card or SBP")}</div>
          <button class="upgrade-plan-btn tbank-upgrade-btn" data-tbank-plan="annual" type="button">
            ${escapeHtml(getT().tbankAnnual || "1 year — 5,000 ₽")}
          </button>
          <button class="upgrade-plan-btn upgrade-plan-secondary tbank-upgrade-btn" data-tbank-plan="monthly" type="button">
            ${escapeHtml(getT().tbankMonthly || "1 month — 600 ₽")}
          </button>
        ` : ""}
      </div>
      <button class="upgrade-modal-cta" data-price-type="annual" type="button">Upgrade to Pro</button>
      ${msg.reassurance ? `<p class="upgrade-modal-reset">${escapeHtml(msg.reassurance)}</p>` : ""}
      <button class="upgrade-modal-dismiss" type="button">Maybe later</button>
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

    // If the user landed on the onboarding screen (because session wasn't known yet),
    // redirect them straight to the home dashboard.
    const activeScreen = document.querySelector(".app-screen.active");
    if (!activeScreen || activeScreen.id === "screen-onboarding") {
      renderHomeScreen();
      showScreen(screenHome);
    }
  } else {
    document.body.classList.add("is-logged-out");
    document.body.classList.remove("is-logged-in");

    if (authScreen) authScreen.hidden = true;
    if (landingHow) landingHow.hidden = false;
    if (mainApp) mainApp.hidden = false;
    if (logoutBtn) logoutBtn.hidden = true;

    userPlan = { ...GUEST_PLAN };
    renderPlanUI();
  }
}

function openAuthFromOverlay(mode = "signup") {
  const overlay = document.getElementById("authOverlay");
  if (overlay) overlay.hidden = true;

  if (authScreen) authScreen.hidden = false;
  document.body.classList.add("auth-active");

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

  authScreen?.scrollIntoView({ behavior: "smooth", block: "center" });
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
        }
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

  if (authMessage) authMessage.textContent = t.loggingIn;

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    if (authMessage) authMessage.textContent = error.message;
    return;
  }

  if (authMessage) authMessage.textContent = "";
  await checkAuth();
});

logoutBtn?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  if (profileDropdown) profileDropdown.hidden = true;
  await checkAuth();
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

checkAuth().then(() => {
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

document.getElementById("forgotPasswordBtn")?.addEventListener("click", () => {
  const t = getT();

  if (forgotPasswordBox) forgotPasswordBox.hidden = false;
  if (authMessage) authMessage.textContent = t.enterEmailInstruction;
});

sendRecoveryEmailBtn?.addEventListener("click", async () => {
  const t = getT();
  const email = recoveryEmailInput?.value.trim();

  if (!email) {
    if (authMessage) authMessage.textContent = t.enterEmailError;
    return;
  }

  if (authMessage) authMessage.textContent = t.sendingRecovery;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?reset=true`
  });

  if (error) {
    if (authMessage) authMessage.textContent = error.message;
    return;
  }

  if (authMessage) authMessage.textContent = t.recoverySent;
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
  "screen-home":       "home",
  "screen-flashcards": "cards",
  "screen-video":      "video",
  "screen-writing":    null,
  "screen-onboarding": null,
  "screen-account":    null,
};

function showScreen(screen) {
  if (!screen) return;

  document.querySelectorAll(".app-screen").forEach(s => {
    s.classList.remove("active");
  });

  screen.classList.add("active");
  sessionStorage.setItem("activeScreenId", screen.id);
  document.body.classList.toggle("product-active", screen.id !== "screen-onboarding");

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

  window.scrollTo({ top: 0, behavior: "auto" });
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
      const paidPro = userPlan.plan === "pro";
      if (paidPro) {
        const paidUntil = userPlan.planEndsAt
          ? new Date(userPlan.planEndsAt).toLocaleDateString()
          : null;
        pillEl.textContent = paidUntil ? `Pro · ${paidUntil}` : "Pro";
      } else if (userPlan.trialActive) {
        const days = trialDaysLeft();
        pillEl.textContent = `Pro trial · ${days} day${days === 1 ? "" : "s"} left`;
      } else {
        pillEl.textContent = "Free plan";
      }
    }

    if (upgradeRow) {
      const isPro = userPlan.plan === "pro" && !userPlan.trialActive;
      upgradeRow.hidden = isPro;
    }

    const langLabel = document.getElementById("acctAppLangLabel");
    if (langLabel) {
      const uiLangEl = document.getElementById("uiLang");
      const langNames = { en: "English", ru: "Русский", zh: "中文", tr: "Türkçe", de: "Deutsch", es: "Español", fr: "Français", ja: "日本語" };
      langLabel.textContent = langNames[uiLangEl?.value] || "English";
    }
  });
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
  const activityLabels = { reading: "Continue reading", speaking: "Continue speaking", flashcards: "Continue cards", video: "Continue video" };
  if (resumeLabel) resumeLabel.textContent = activityLabels[data.activity] || "Continue";
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

    if (nameEl)   nameEl.textContent   = `Hello, ${name}`;
    if (avatarEl) avatarEl.textContent = initial;

    if (badgeEl) {
      const paidPro = userPlan.plan === "pro";
      if (paidPro && !userPlan.trialActive) {
        badgeEl.textContent = "Pro";
        badgeEl.dataset.variant = "pro";
      } else if (userPlan.trialActive) {
        const days = trialDaysLeft();
        badgeEl.textContent = `Pro trial · ${days} day${days === 1 ? "" : "s"} left`;
        badgeEl.dataset.variant = "trial";
      } else {
        badgeEl.textContent = "Free plan";
        delete badgeEl.dataset.variant;
      }
      badgeEl.hidden = false;
    }
  });

  // Streak
  const streak = userPlan.currentStreak || 0;
  const streakN = document.getElementById("homeStreakN");
  if (streakN) streakN.textContent = `${streak}-day streak`;

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

  updateHomeCardsBadge();

  loadRecentProgress();
  loadVideoHistory();
}

document.getElementById("acctUpgradeRow")?.addEventListener("click", () => {
  const picker = document.getElementById("acctPlanPicker");
  if (picker) picker.hidden = !picker.hidden;
});

document.getElementById("acctManageSubBtn")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/create-billing-portal-session`, {
      method: "POST"
    });
    const data = await response.json();
    if (!response.ok || !data?.url) {
      showToast(data?.error || "Could not open subscription settings.", "error");
      return;
    }
    window.location.href = data.url;
  } catch {
    showToast("Could not open subscription settings.", "error");
  } finally {
    button.disabled = false;
  }
});

document.getElementById("acctPersonalDataBtn")?.addEventListener("click", () => {
  showToast("Personal data settings coming soon.", "info");
});

document.getElementById("acctSavedWordsBtn")?.addEventListener("click", () => {
  showScreen(screenFlashcards);
  renderDeckSelector();
  renderFlashcards();
});

document.getElementById("acctAppLanguageBtn")?.addEventListener("click", () => {
  showToast("App language switch coming soon.", "info");
});

document.getElementById("acctAboutBtn")?.addEventListener("click", () => {
  showToast("Magic Read — Phase 1.", "info");
});

document.getElementById("acctHelpBtn")?.addEventListener("click", () => {
  showToast("Email us at help@magicread.app for support.", "info");
});

document.getElementById("acctLogoutBtn")?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  showScreen(screenMain);
  await checkAuth();
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
    if (target === "speak" || target === "read") {
      await activateReaderMode(target === "read" ? "reading" : "pronunciation");
      showScreen(screenMain);
    } else if (target === "cards") {
      showScreen(screenFlashcards);
      renderDeckSelector();
      renderFlashcards();
    } else if (target === "write") {
      showScreen(screenWriting);
    } else if (target === "video") {
      showScreen(screenVideo);
      initVideoScreen();
    }
  });
});

document.getElementById("homeResume")?.addEventListener("click", async () => {
  if (!_resumeProgress) { showScreen(screenMain); return; }
  const { activity, item_id, position } = _resumeProgress;

  if (activity === "video") {
    showScreen(screenVideo);
    initVideoScreen();
    loadVideoById(item_id);
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
    if (sentenceIdx > 0) {
      const cards = container?.querySelectorAll(".card");
      const target = cards?.[sentenceIdx];
      if (target) setTimeout(() => target.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
    }
    showScreen(screenMain);
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
    } else if (t === "read" || t === "speak") {
      await activateReaderMode(t === "read" ? "reading" : "pronunciation");
      showScreen(screenMain);
    } else if (t === "cards") {
      showScreen(screenFlashcards);
      renderDeckSelector();
      renderFlashcards();
    } else if (t === "video") {
      showScreen(screenVideo);
      initVideoScreen();
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
    showOnboardingStepA();
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

  if (currentText && currentSentences.length) {
    if (appMode === "reading") {
      await showImportedText(currentText);
      await buildClozeExercise(currentSentences);
    } else if (!container?.querySelector(".card")) {
      await renderCards(currentSentences);
    }
  }

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

// On reload, stay on the screen the user was last viewing instead of jumping home.
function restoreActiveScreen() {
  const savedId = sessionStorage.getItem("activeScreenId");
  const target = savedId ? document.getElementById(savedId) : null;

  if (!target || savedId === "screen-onboarding") {
    if (sessionStorage.getItem("onboardingStep") === "trial") {
      showOnboardingStepTrial();
    } else {
      showOnboardingStepA();
    }
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

document.getElementById("onboardingContinueBtn")?.addEventListener("click", () => {
  syncOnboardingToMain();
  showOnboardingStepTrial();
});

document.getElementById("onboardingStartBtn")?.addEventListener("click", () => {
  if (document.body.classList.contains("is-logged-in")) {
    renderHomeScreen();
    showScreen(screenHome);
    return;
  }
  openAuthFromOverlay("signup");
});

document.getElementById("heroCtaBtn")?.addEventListener("click", () => {
  openAuthFromOverlay("signup");
});

document.getElementById("googleAuthBtn")?.addEventListener("click", async () => {
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin }
  });
});

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

  if (appMode === "reading") {
    if (cardsSection) cardsSection.hidden = true;
    if (fullTextPanel) fullTextPanel.hidden = !hasText;
    if (readingExercise) readingExercise.hidden = !hasText;
    if (wordOrderExercise) wordOrderExercise.hidden = true;
  } else {
    if (cardsSection) cardsSection.hidden = false;
    if (readingExercise) readingExercise.hidden = true;
    if (fullTextPanel) fullTextPanel.hidden = true;
    if (wordOrderExercise) wordOrderExercise.hidden = !hasText;
  }
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

    if (appMode === "reading") {
      // Read the whole text, then practise with a fill-the-gap exercise.
      await showImportedText(cleanText);
      await buildClozeExercise(sentences);
    } else {
      // Pronunciation: jump straight to sentence-by-sentence practice cards.
      await renderCards(sentences);
    }
    applyMode();
    trackGuest("fullTextsGenerated");

    if (fullTextTranslation) fullTextTranslation.textContent = "";
      if (textLibraryPanel) textLibraryPanel.hidden = true;
    if (savedTextsPanel) savedTextsPanel.hidden = true;

    const scrollTarget = appMode === "reading" ? fullTextPanel : document.getElementById("cardsSection");
    scrollTarget?.scrollIntoView({ behavior: "smooth" });
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
  window.speechSynthesis.cancel();
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
  const label = t.slow || "Slow";

  ["globalSlowBtn", "flashcardSlowBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const lbl = el.querySelector(".toggle-label");
    if (lbl) lbl.textContent = label;
    el.classList.toggle("is-active", ttsSlowMode);
    el.setAttribute("aria-pressed", ttsSlowMode ? "true" : "false");
  });
}

function toggleSlowMode() {
  ttsSlowMode = !ttsSlowMode;
  stopAllTTS();
  updateSlowLabels();
}

globalSlowBtn?.addEventListener("click", toggleSlowMode);

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
        currentAudioRate === (ttsSlowMode ? 0.85 : 1.0);

      if (isSameAudio && !audioCtxSuspended) {
        audioCtx.suspend();
        audioCtxSuspended = true;
        ttsBtn.textContent = t.listen;
        return;
      }

      if (isSameAudio && audioCtxSuspended) {
        audioCtx.resume();
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

function buildWordOrderExercise(sentences) {
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
          .map(item => item.word)
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

function unlockAudioForMobile() {
  try {
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    const buffer = audioCtx.createBuffer(1, 1, 22050);
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start(0);
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
  const units = Array.from(container.querySelectorAll(".word, .hanzi-char"));
  if (!units.length) return;
  units.forEach(u => u.classList.remove("word-speaking"));
  let pos = 0;
  for (const unit of units) {
    const len = (unit.textContent || "").length;
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

  let words = Array.from(container.querySelectorAll(".word")).filter(el => el.textContent.trim());

  if (!words.length) {
    words = Array.from(container.querySelectorAll(".hanzi-char")).filter(el => el.textContent.trim());
  }

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
  const effectiveRate = ttsSlowMode ? 0.85 : 1.0;

  // Toggle pause/resume for same audio
  if (currentAudio && currentAudioText === text && currentAudioRate === effectiveRate) {
    if (audioCtxSuspended) {
      audioCtx.resume();
      audioCtxSuspended = false;
    } else {
      audioCtx.suspend();
      audioCtxSuspended = true;
    }
    return;
  }

  // Stop any current audio
  clearWordHighlights();
  if (currentAudio) {
    currentAudio.onended = null;
    try { currentAudio.stop(); } catch (_) {}
    currentAudio = null;
  }
  if (audioCtxSuspended) { audioCtx.resume(); audioCtxSuspended = false; }
  currentAudioText = "";
  currentAudioRate = 1.0;

  speechSynthesis.cancel();

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

      if (response.status === 429) throw new Error("RATE_LIMIT");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "TTS failed");

      const audioBuffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(data.audioBase64));

      if (ttsCache.size >= 50) ttsCache.delete(ttsCache.keys().next().value);
      cached = { audioBuffer };
      ttsCache.set(cacheKey, cached);
    }

    const { audioBuffer } = cached;
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = 1.0;
    source.connect(audioCtx.destination);

    currentAudio = source;
    currentAudioText = text;
    currentAudioRate = effectiveRate;
    audioCtxSuspended = false;

    if (sentenceEl) {
      const isCJK = ["zh", "ja"].includes(effectiveLang);
      const durationMs = isCJK ? null : audioBuffer.duration * 1000;
      highlightWordsSequentially(sentenceEl, durationMs);
    }

    source.onended = () => {
      clearWordHighlights();
      if (currentAudio === source) {
        currentAudio = null;
        currentAudioText = "";
        currentAudioRate = 1.0;
        audioCtxSuspended = false;
      }
      if (typeof onEnd === "function") onEnd();
    };

    source.start(0);
  } catch (error) {
    currentAudio = null;
    currentAudioText = "";
    currentAudioRate = 1.0;
    audioCtxSuspended = false;
    if (error.message === "RATE_LIMIT") {
      showToast("Too many requests. Please wait a moment.", "error");
      return;
    }
    console.error("Google TTS failed, falling back to browser TTS:", error);
    playBrowserTTS(text, effectiveLang, sentenceEl, onEnd);
  }
}

function playBrowserTTS(text, langOverride = null, sentenceEl = null, onEnd = null, onError = null) {
  if (!text) return;

  unlockAudioForMobile();
  clearWordHighlights();

  const lang = mapToSpeechLang(langOverride || sourceLangSelect.value);
  const rate = ttsSlowMode ? 0.85 : 1.0;

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
    setTimeout(() => window.speechSynthesis.speak(utterance), 0);
  }
}

function stopAllTTS() {
  clearWordHighlights();
  speechSynthesis.cancel();
  if (currentAudio) {
    currentAudio.onended = null;
    try { currentAudio.stop(); } catch (_) {}
    currentAudio = null;
  }
  if (audioCtxSuspended) { audioCtx.resume(); audioCtxSuspended = false; }
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

async function startFlashcardSpeakingPractice() {
  if (drillActive) return; // a drill is already running for this card
  const cards = getCurrentCards();
  const card = cards[currentFlashcardIndex];
  if (!card) return;

  const cardLang = card.lang || sourceLangSelect.value;
  const isChinese = cardLang === "zh";
  const expected = card.word || "";
  const speechLang = mapToSpeechLang(cardLang);
  const resultEl = document.getElementById("flashcardSpeakingResult");

  // Azure pronunciation assessment (signed-in users, when enabled).
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
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Listening…"; }

  recognition.onresult = async (event) => {
    const transcript = event.results[0][0].transcript || "";

    let result;

    if (isChinese) {
      if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Scoring…"; }
      try {
        const transcriptPinyin = await getPinyinForText(transcript);
        const expectedNorm = normalizePinyin(card.pinyin || expected);
        const actualNorm   = normalizePinyin(transcriptPinyin);

        const score = (actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm))
          ? 100
          : compareByEditDistance(expectedNorm, actualNorm);

        result = { score, message: score >= FLASHCARD_PASS_SCORE ? "Great" : "Try again" };

        if (result.score >= FLASHCARD_PASS_SCORE) {
          flashcardSpeakingUnlocked = true;
          if (resultEl) {
            resultEl.hidden = false;
            resultEl.innerHTML =
              `<strong>✓ ${escapeHtml(result.message)}!</strong>` +
              `<p>You said: ${escapeHtml(transcript)}</p>` +
              `<p>Pronunciation: ${escapeHtml(transcriptPinyin)}</p>` +
              `<p>Expected: ${escapeHtml(card.pinyin || expected)}</p>` +
              `<p>Score: ${result.score}%</p>`;
          }
        } else {
          flashcardSpeakingUnlocked = false;
          if (resultEl) {
            resultEl.hidden = false;
            resultEl.innerHTML =
              `<strong>Try again</strong>` +
              `<p>You said: ${escapeHtml(transcript)}</p>` +
              `<p>Pronunciation: ${escapeHtml(transcriptPinyin)}</p>` +
              `<p>Expected: ${escapeHtml(card.pinyin || expected)}</p>` +
              `<p>Score: ${result.score}%</p>`;
          }
        }
      } catch {
        // Pinyin conversion failed — fall back to character comparison
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
  };

  recognition.onerror = () => {
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = "Could not hear you. Please try again."; }
    currentFlashcardRecognition = null;
  };

  recognition.onend = () => {
    currentFlashcardRecognition = null;
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
    "not-allowed": "Microphone is blocked. Please allow microphone access in your browser.",
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
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    flashcardDecks = [];
    currentDeckId = null;
    return;
  }

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
        lang,
        srs_ease,
        srs_interval,
        srs_due,
        srs_reps,
        srs_lapses,
        srs_last_reviewed
      )
    `)
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  if (deckError) {
    console.error("Load decks error:", deckError);
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
      lang: card.lang,
      srs_ease: card.srs_ease,
      srs_interval: card.srs_interval,
      srs_due: card.srs_due,
      srs_reps: card.srs_reps,
      srs_lapses: card.srs_lapses,
      srs_last_reviewed: card.srs_last_reviewed
    }))
  }));

  await ensureDefaultDeck();
  updateHomeCardsBadge();
}

async function ensureDefaultDeck() {
  if (!flashcardDecks.length) {
    const {
      data: { user }
    } = await supabase.auth.getUser();

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

function isDueCard(card) {
  if (!card.srs_due) return true; // never reviewed → always due
  return card.srs_due <= new Date().toISOString().slice(0, 10);
}

function getDueCount() {
  return flashcardDecks.reduce(
    (sum, deck) => sum + deck.cards.filter(isDueCard).length,
    0
  );
}

function updateHomeCardsBadge() {
  const badge = document.getElementById("homeCardsDue");
  if (!badge) return;
  const due = getDueCount();
  if (due > 0) {
    badge.textContent = `${due} due`;
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

function getCurrentCards() {
  const cards = getCurrentDeck()?.cards || [];
  const due    = cards.filter(isDueCard);
  const future = cards.filter(c => !isDueCard(c));
  return [...due, ...future];
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
    lang: data.lang,
    srs_ease: null,
    srs_interval: null,
    srs_due: null,
    srs_reps: 0,
    srs_lapses: 0,
    srs_last_reviewed: null
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
  const srsReviewEl = document.getElementById("flashcardSrsReview");

  if (!emptyEl || !deckEl || !cardEl) return;

  if (!cards.length) {
    emptyEl.hidden = false;
    deckEl.hidden = true;
    return;
  }

  if (currentFlashcardIndex >= cards.length) {
    currentFlashcardIndex = cards.length - 1;
  }

  const card = cards[currentFlashcardIndex];

  emptyEl.hidden = true;
  deckEl.hidden = false;

  const t = getT();
  const dueNow = cards.filter(isDueCard).length;
  const dueLabel = dueNow > 0 ? ` · ${dueNow} due` : "";
  counterEl.textContent = `${deck?.name || t.deck}${dueLabel} · ${t.card} ${currentFlashcardIndex + 1} ${t.of} ${cards.length}`;
  wordEl.textContent = card.word || "";
  wordPinyinEl.textContent = card.pinyin || "";
  if (wordBackEl) wordBackEl.textContent = card.word || "";
  if (translationEl) translationEl.textContent = cleanTranslation(card.translation);

  // Update SRS button labels to show the projected interval for this specific card.
  const fmtDays = d => d === 1 ? "1 day" : `${d} days`;
  const setSmall = (id, text) => { const s = document.getElementById(id)?.querySelector("small"); if (s) s.textContent = text; };
  setSmall("srsAgainBtn", fmtDays(computeNextSRS(card, "again").srs_interval));
  setSmall("srsGoodBtn",  fmtDays(computeNextSRS(card, "good").srs_interval));
  setSmall("srsEasyBtn",  fmtDays(computeNextSRS(card, "easy").srs_interval));

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
    if (srsReviewEl) srsReviewEl.hidden = true;

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
    if (srsReviewEl)   srsReviewEl.hidden = false;
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
  if (!getCurrentCards().length) { showToast("No cards in deck.", "error"); return; }
  flashcardSpeakingMode = "easy";
  flashcardSpeakingUnlocked = false;
  stopFlashcardRecognition();
  const resultEl = document.getElementById("flashcardSpeakingResult");
  if (resultEl) { resultEl.hidden = true; resultEl.innerHTML = ""; }
  renderFlashcards();
});

document.getElementById("flashcardSpeakHardBtn")?.addEventListener("click", () => {
  if (!getCurrentCards().length) { showToast("No cards in deck.", "error"); return; }
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

// SM-2 simplified: computes the next SRS state from the current card state + rating.
function computeNextSRS(card, rating) {
  const ease     = card.srs_ease     ?? 2.5;
  const interval = card.srs_interval ?? 0;
  const reps     = card.srs_reps     ?? 0;
  const lapses   = card.srs_lapses   ?? 0;

  let newEase = ease, newInterval, newReps, newLapses;

  if (rating === "again") {
    newLapses   = lapses + 1;
    newReps     = 0;
    newInterval = 1;
    newEase     = Math.max(1.3, ease - 0.2);
  } else if (rating === "good") {
    newLapses   = lapses;
    newReps     = reps + 1;
    newInterval = newReps === 1 ? 2 : newReps === 2 ? 6 : Math.round(interval * ease);
    newEase     = ease;
  } else { // easy
    newLapses   = lapses;
    newReps     = reps + 1;
    newInterval = newReps === 1 ? 6 : newReps === 2 ? 15 : Math.round(interval * ease * 1.3);
    newEase     = Math.min(2.5, ease + 0.15);
  }

  const due = new Date();
  due.setDate(due.getDate() + newInterval);
  const today = new Date().toISOString().slice(0, 10);

  return {
    srs_ease:          Math.round(newEase * 100) / 100,
    srs_interval:      newInterval,
    srs_due:           due.toISOString().slice(0, 10),
    srs_reps:          newReps,
    srs_lapses:        newLapses,
    srs_last_reviewed: today
  };
}

async function scheduleCard(rating) {
  recordActivity("words_practiced", 1);

  const sorted = getCurrentCards();
  const card = sorted[currentFlashcardIndex];
  if (!card) { goToNextFlashcard(); return; }

  const next = computeNextSRS(card, rating);

  // Optimistically update in-memory card (deck.cards holds the originals).
  const deck = getCurrentDeck();
  if (deck) {
    const orig = deck.cards.find(c => c.id === card.id);
    if (orig) Object.assign(orig, next);
  }

  // Persist to Supabase — fire and forget (failure doesn't block navigation).
  supabase.from("flashcards").update({
    srs_ease:          next.srs_ease,
    srs_interval:      next.srs_interval,
    srs_due:           next.srs_due,
    srs_reps:          next.srs_reps,
    srs_lapses:        next.srs_lapses,
    srs_last_reviewed: next.srs_last_reviewed
  }).eq("id", card.id).then(({ error }) => {
    if (error) console.error("[SRS] update error:", error.message);
  });

  goToNextFlashcard();
  updateHomeCardsBadge();
  const _sdeck = getCurrentDeck();
  if (_sdeck) saveProgress("flashcards", _sdeck.id, { card: currentFlashcardIndex }, _sdeck.name);
}

document.getElementById("srsAgainBtn")?.addEventListener("click", () => scheduleCard("again"));
document.getElementById("srsGoodBtn")?.addEventListener("click",  () => scheduleCard("good"));
document.getElementById("srsEasyBtn")?.addEventListener("click",  () => scheduleCard("easy"));

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
  restoreActiveScreen();
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
let vidSlowOn      = false;
let vidPinyinOn    = true;
let vidHighlightId = null;   // setInterval handle for line highlighting
let vidReplayTimer = null;   // setTimeout handle for auto-pause after replay

// ── YouTube IFrame API ──────────────────────────────────

let _ytApiReady = false;
const _ytApiCallbacks = [];

window.onYouTubeIframeAPIReady = () => {
  _ytApiReady = true;
  _ytApiCallbacks.forEach(cb => cb());
  _ytApiCallbacks.length = 0;
};

function whenYTReady(cb) {
  if (_ytApiReady) { cb(); return; }
  _ytApiCallbacks.push(cb);
  if (!document.getElementById("yt-api-script")) {
    const s = document.createElement("script");
    s.id = "yt-api-script";
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  }
}

function extractYouTubeId(input) {
  const s = (input || "").trim();
  const re = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const m = s.match(re) || s.match(/^([a-zA-Z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, "0")}`;
}

// ── Player lifecycle ────────────────────────────────────

function mountYTPlayer(videoId) {
  const container = document.getElementById("vidPlayerContainer");
  if (!container) return Promise.resolve();

  // Wipe old iframe
  container.innerHTML = "";
  const div = document.createElement("div");
  container.appendChild(div);

  return new Promise(resolve => {
    whenYTReady(() => {
      vidPlayer = new YT.Player(div, {
        videoId,
        playerVars: { controls: 0, rel: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady:       () => resolve(),
          onStateChange: onVidStateChange
        }
      });
    });
  });
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
    activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
  const isZh = lang === "zh";

  capList.innerHTML = captions.map((cap, i) => {
    const hanHTML = isZh
      ? `<div class="vid-han">${buildChineseLineHTML(cap.tokens)}</div>`
      : `<div class="vid-text">${buildPlainLineHTML(cap.text)}</div>`;

    return `
      <div class="vid-line" data-cap-index="${i}">
        ${hanHTML}
        ${cap.translation ? `<div class="vid-tr">${escapeHtml(cap.translation)}</div>` : ""}
        <div class="vid-line-acts">
          <button class="vid-replay-btn" type="button" data-cap-index="${i}" aria-label="Replay line">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-play"/></svg>
            Listen
          </button>
          <button class="vid-speak-btn" type="button" data-cap-index="${i}" aria-label="Speak this line">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-mic"/></svg>
            Speak this line
          </button>
        </div>
        <div class="vid-result-box" hidden></div>
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

    // Speak this line — full Azure pronunciation scoring, same flow as the reader
    lineEl.querySelector(".vid-speak-btn")?.addEventListener("click", async e => {
      e.stopPropagation();
      unlockAudioForMobile();
      stopAllTTS();

      const speakBtn  = lineEl.querySelector(".vid-speak-btn");
      const resultBox = lineEl.querySelector(".vid-result-box");
      const speechLang = mapToSpeechLang(videoLang);

      // Pause playback while the user speaks so mic doesn't pick up the video
      const wasPlaying = vidPlayer?.getPlayerState() === 1;
      if (wasPlaying) vidPlayer.pauseVideo();

      await tryAzurePronunciation(cap.text, speechLang, resultBox, speakBtn, getT());
      recordActivity("words_spoken", (cap.text.match(/\S+/g) || [cap.text]).length);

      if (wasPlaying) vidPlayer.playVideo();
    });

    // Chinese ruby tokens — replay line in video + show translate/save popup
    lineEl.querySelectorAll(".vid-ruby").forEach(tokenEl => {
      tokenEl.addEventListener("click", e => {
        e.stopPropagation();
        unlockAudioForMobile();
        const word = tokenEl.dataset.word;
        document.querySelectorAll(".vid-ruby.sel").forEach(el => el.classList.remove("sel"));
        tokenEl.classList.add("sel");
        sourceLangSelect.value = videoLang;
        replayCapLine(cap);
        showWordPopup(tokenEl, word, cap.text, "", true).catch(console.error);
      });
    });

    // Non-Chinese word spans — replay line in video + show translate/save popup
    lineEl.querySelectorAll(".vid-word").forEach(wordEl => {
      wordEl.addEventListener("click", e => {
        e.stopPropagation();
        unlockAudioForMobile();
        const word = wordEl.dataset.word;
        sourceLangSelect.value = videoLang;
        replayCapLine(cap);
        showWordPopup(wordEl, word, cap.text, "", true).catch(console.error);
      });
    });
  });
}

// ── Load flow ───────────────────────────────────────────

function renderVidFreeChip() {
  const chip = document.getElementById("vidFreeChip");
  const txt  = document.getElementById("vidFreeChipText");
  if (!chip) return;
  if (!userPlan.trialActive || userPlan.plan === "pro") { chip.hidden = true; return; }
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

  const lang      = sourceLangSelect.value || "zh";
  const targetLang = targetLangSelect.value || "en";
  videoLang = lang;

  try {
    // Start player mount and caption fetch in parallel
    const [, captionData] = await Promise.all([
      mountYTPlayer(videoId),
      fetchWithAuth(
        `${API_BASE}/api/video-captions?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}&targetLang=${encodeURIComponent(targetLang)}`
      ).then(r => r.json())
    ]);

    if (loadingState) loadingState.hidden = true;
    if (placeholder)  placeholder.hidden  = true;
    if (transport)    transport.hidden    = false;

    if (captionData.code === "CAPTION_SERVICE_ERROR") {
      if (errState) errState.hidden = false;
      return;
    }

    if (captionData.needsGeneration || !captionData.captions?.length) {
      if (noCapState) noCapState.hidden = false;
      return;
    }

    vidCaptions = captionData.captions;
    renderCaptions(vidCaptions, lang);

    if (capArea) capArea.hidden = false;

    // Sync pinyin toggle state
    const capList = document.getElementById("vidCapList");
    const pinyinBtn = document.getElementById("vidPinyinToggle");
    if (capList) capList.classList.toggle("vid-pinyin-off", !vidPinyinOn);
    if (pinyinBtn) pinyinBtn.classList.toggle("on", vidPinyinOn);

    // Save progress — fetch real title via YouTube oEmbed (free, no API key)
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`)
      .then(r => r.json())
      .then(d => saveProgress("video", videoId, { seconds: 0 }, d.title || videoId))
      .catch(() => saveProgress("video", videoId, { seconds: 0 }, videoId));

  } catch (err) {
    console.error("[Video] load error:", err.message);
    if (loadingState) loadingState.hidden = true;
    if (errState)     errState.hidden     = false;
    showToast("Could not load video. Check your connection.", "error");
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
