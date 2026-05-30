import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { UI_TEXT } from "./ui-text.js";

const SUPABASE_URL = "https://nudirmexwisvvcmskhtn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8rz-fBIcvrR4qSNuG4j_7w_c_nZ79cU";
const API_BASE = "https://magic-read.onrender.com";

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

const screenMain = document.getElementById("screen-main");
const screenFlashcards = document.getElementById("screen-flashcards");
const screenWriting = document.getElementById("screen-writing");

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
let freeTrialUsed = false;
let authMode = "login";

let currentRecognition = null;
let currentAudio = null;       // AudioBufferSourceNode
let audioCtxSuspended = false; // true when audioCtx.suspend() was called (paused)
let currentAudioText = "";
let currentAudioRate = 1.0;
let activePopup = null;
let activeHighlightTimer = null;

let ttsSlowMode = false;
let popupTimeout = null;
let guestPracticeCount = 0;
const FREE_TRIAL_LISTENS = 3;

let currentText = "";
let currentSentences = [];
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

const savedUiLang = localStorage.getItem("magicread_ui_lang") || "en";

if (uiLangSelect) {
  uiLangSelect.value = savedUiLang;
  uiLangSelect.addEventListener("change", () => {
    applyLocalization(uiLangSelect.value);
  });
}

applyLocalization(savedUiLang);

/* -----------------------------
   AUTH
----------------------------- */
document.getElementById("closeAuthOverlayBtn")?.addEventListener("click", () => {
  document.getElementById("authOverlay")?.setAttribute("hidden", "");
  document.body.style.overflow = "";
  freeTrialUsed = true;
});

async function checkAuth() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    document.body.classList.add("is-logged-in");
    document.body.classList.remove("is-logged-out");

    if (authScreen) authScreen.hidden = true;
    if (landingHow) landingHow.hidden = false;
    if (mainApp) mainApp.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  } else {
    document.body.classList.add("is-logged-out");
    document.body.classList.remove("is-logged-in");

    if (authScreen) authScreen.hidden = true;
    if (landingHow) landingHow.hidden = false;
    if (mainApp) mainApp.hidden = false;
    if (logoutBtn) logoutBtn.hidden = true;
  }
}

function openAuthFromOverlay(mode = "signup") {
  const overlay = document.getElementById("authOverlay");
  if (overlay) overlay.hidden = true;

  if (authScreen) authScreen.hidden = false;

  authMode = mode;

  if (mode === "signup") {
    if (authNameGroup) authNameGroup.hidden = false;

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

checkAuth();

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

function showScreen(screen) {
  if (!screen) return;

  document.querySelectorAll(".app-screen").forEach(s => {
    s.classList.remove("active");
  });

  screen.classList.add("active");
  sessionStorage.setItem("activeScreenId", screen.id);
}

profileMenuBtn?.addEventListener("click", () => {
  if (profileDropdown) profileDropdown.hidden = !profileDropdown.hidden;
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".profile-menu") && profileDropdown) {
    profileDropdown.hidden = true;
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

  const backToReaderBtn = document.getElementById("backToReaderBtn");
  const backToReaderBtnWriting = document.getElementById("backToReaderBtnWriting");

  backToReaderBtn?.addEventListener("click", () => {
    showScreen(screenMain);
  });
  backToReaderBtnWriting?.addEventListener("click", () => {
  showScreen(screenMain);
});

  document.querySelector(".brand")?.addEventListener("click", (e) => {
    e.preventDefault();
    stopAllTTS();
    stopRecognition();
    showScreen(screenMain);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

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

    if (sourceLangSelect.value === "zh") {
      await preloadChineseSegments([cleanText, ...sentences]);
    }

    inputText.value = cleanText;
    if (startComposerArea) startComposerArea.hidden = true;

    await showImportedText(cleanText);
    await renderCards(sentences);

    if (fullTextTranslation) fullTextTranslation.textContent = "";
      if (textLibraryPanel) textLibraryPanel.hidden = true;
    if (savedTextsPanel) savedTextsPanel.hidden = true;

    fullTextPanel?.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    console.error("Start reading error:", error);
    showToast("Could not start reading.", "error");
  } finally {
    hideMagicLoadingOverlay();
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.textContent = getT().start || "Start";
    }
  }
}

createBtn?.addEventListener("click", async () => {
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
  if (textLibraryPanel) textLibraryPanel.hidden = true;

  if (!savedTextsPanel.hidden) {
    savedTextsPanel.hidden = true;
    return;
  }

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
  if (toggleBtn) toggleBtn.textContent = getT().showPinyin;
}

document.getElementById("toggleFullTextPinyinBtn")?.addEventListener("click", () => {
  if (!fullTextPinyin) return;

  const btn = document.getElementById("toggleFullTextPinyinBtn");
  const isHidden = fullTextPinyin.hidden;

  fullTextPinyin.hidden = !isHidden;
  if (btn) btn.textContent = isHidden ? getT().hidePinyin : getT().showPinyin;
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
  const label = ttsSlowMode ? t.slowOn : t.slowOff;

  document.getElementById("globalSlowBtn")?.replaceChildren(document.createTextNode(label));
  document.getElementById("flashcardSlowBtn")?.replaceChildren(document.createTextNode(label));
}

function toggleSlowMode() {
  ttsSlowMode = !ttsSlowMode;
  stopAllTTS();
  updateSlowLabels();
}

globalSlowBtn?.addEventListener("click", toggleSlowMode);
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


async function maybeShowAuthOverlay() {
  const { data } = await supabase.auth.getSession();

  if (data.session) return;
  if (authPromptShown) return;

  const overlay = document.getElementById("authOverlay");

  if (overlay) {
    overlay.hidden = false;
  }

  authPromptShown = true;
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
            <h3>Sentence ${index + 1}</h3>
            <span class="card-badge">${badgeText}</span>
          </div>

          <p class="sentence clickable-sentence" data-full-sentence="${escapeHtml(sentence)}">${sentenceHtml}</p>
          <div class="sentence-pinyin-box panel-box" hidden></div>

          <div class="card-action-row">
            <button class="tts-btn card-primary-btn">${escapeHtml(t.listen)}</button>
            <button class="record-btn card-primary-btn" hidden>${escapeHtml(t.yourTurn)}</button>

            <div class="card-more">
              <button class="more-btn" type="button" aria-label="More">⋯</button>
              <div class="more-menu" hidden>
                ${sourceLangSelect.value === "zh"
                  ? `<button class="sentence-pinyin-btn" type="button">Show pinyin</button>`
                  : ""}
                <button class="translate-btn" type="button">${escapeHtml(t.showTranslation)}</button>
                <button class="grammar-btn" type="button">${escapeHtml(t.grammar)}</button>
              </div>
            </div>
          </div>

          <div class="translation-box panel-box"></div>
          <div class="grammar-box panel-box"></div>
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
    const grammarBtn = card.querySelector(".grammar-btn");
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

      const { data } = await supabase.auth.getSession();

      if (!data.session && freeTrialUsed) {
        document.getElementById("authOverlay")?.removeAttribute("hidden");
        document.body.style.overflow = "hidden";
        return;
      }
      guestPracticeCount += 1;

      if (guestPracticeCount >= FREE_TRIAL_LISTENS) {
        await maybeShowAuthOverlay();
      }

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
      record(sentence, card, recordBtn);
    });

    grammarBtn?.addEventListener("click", async () => {
      if (moreMenu) moreMenu.hidden = true;

      const data = await grammar(sentence, card);
      highlightGrammarInSentence(card.querySelector(".sentence"), data.items, sourceLangSelect.value);

      card.querySelectorAll(".grammar-item").forEach(el => {
        el.addEventListener("click", () => {
          openGrammarArticle(el.dataset.id, card);
        });
      });
    });
  });
  
}

/* -----------------------------
   TRANSLATION / GRAMMAR
----------------------------- */

async function translateSentence(sentence, card) {
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

async function grammar(sentence, card) {
  const resultBox = card.querySelector(".grammar-box");

  try {
    resultBox.innerHTML = "Checking grammar...";

    const response = await fetchWithAuth(`${API_BASE}/api/grammar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sentence,
        sourceLang: sourceLangSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Grammar analysis failed");
    }

    if (!data.items || !data.items.length) {
      resultBox.innerHTML = "No grammar notes found for this sentence yet.";
      return data;
    }

    resultBox.innerHTML = `
      <div class="grammar-panel">
        <h4>Grammar</h4>
        <ul class="grammar-list">
          ${data.items.map(item => `
            <li class="grammar-item" data-id="${escapeHtml(item.articleId)}">
              <div class="grammar-top">
                <span class="grammar-label">${escapeHtml(item.label)}</span>
                ${item.matchedText ? `<span class="grammar-match">${escapeHtml(item.matchedText)}</span>` : ""}
              </div>
              <p class="grammar-expl">${escapeHtml(item.shortExplanation || "")}</p>
            </li>
          `).join("")}
        </ul>
      </div>
    `;

    return data;
  } catch (error) {
    console.error("Grammar error:", error);
    resultBox.innerHTML = getT().grammarFailed;
    return { items: [] };
  }
}

async function openGrammarArticle(articleId, card) {
  const resultBox = card.querySelector(".grammar-box");
  if (!resultBox) return;

  resultBox.innerHTML = "Loading explanation...";

  try {
    const response = await fetchWithAuth(`${API_BASE}/api/grammar/${articleId}?lang=${sourceLangSelect.value}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load grammar article");
    }

    const examples = [];

    if (data.ex1_ch) examples.push({ text: data.ex1_ch, translation: data.ex1_py || "" });
    if (data.ex2_ch) examples.push({ text: data.ex2_ch, translation: data.ex2_py || "" });
    if (data.ex3_ch) examples.push({ text: data.ex3_ch, translation: data.ex3_py || "" });

    resultBox.innerHTML = `
      <div class="grammar-article">
        <h4>${escapeHtml(data.title || "")}</h4>
        <p>${escapeHtml(data.fullExplanation || "")}</p>

        ${examples.length ? `
          <div class="examples">
            <strong>Examples</strong>
            <ul>
              ${examples.map(example => `
                <li>
                  <div>${escapeHtml(example.text)}</div>
                  ${example.translation ? `<div class="example-pinyin">${escapeHtml(example.translation)}</div>` : ""}
                </li>
              `).join("")}
            </ul>
          </div>
        ` : ""}
      </div>
    `;
  } catch (error) {
    console.error("openGrammarArticle error:", error);
    resultBox.innerHTML = "Failed to load grammar explanation.";
  }
}

function highlightGrammarInSentence(sentenceEl, items, lang) {
  if (!sentenceEl || !items) return;

  const wordEls = sentenceEl.querySelectorAll(".word");

  wordEls.forEach(el => {
    el.classList.remove("grammar-highlight");
  });

  items.forEach(item => {
    if (!item.matchedText) return;

    const target = normalizeText(item.matchedText, lang);

    wordEls.forEach(el => {
      const wordText = normalizeText(el.dataset.word || el.textContent, lang);

      if (lang === "zh") {
        if (target.includes(wordText)) el.classList.add("grammar-highlight");
      } else if (lang === "ru" || lang === "tr") {
        if (target.startsWith("-") && target.endsWith("-")) {
          const infix = target.slice(1, -1);
          if (wordText.includes(infix)) el.classList.add("grammar-highlight");
        } else if (target.startsWith("-")) {
          const suffix = target.slice(1);
          if (wordText.endsWith(suffix)) el.classList.add("grammar-highlight");
        } else if (wordText === target) {
          el.classList.add("grammar-highlight");
        }
      } else if (wordText === target) {
        el.classList.add("grammar-highlight");
      }
    });
  });
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

  showWordPopup(wordEl, word, sentenceText, sentencePinyin, false).catch(console.error);
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
    ${pinyin ? `<div class="popup-pinyin">${escapeHtml(pinyin)}</div>` : ""}
    <div>${escapeHtml(translation)}</div>
    ${allowSave ? renderPopupDeckSelect() : ""}
    ${allowSave ? `<button class="popup-save-btn">${escapeHtml(getT().save || "Save")}</button>` : ""}
  `;

    if (allowSave) {
      attachSaveButton(
        popup.querySelector(".popup-save-btn"),
        translation,
        pinyin
      );
    }
  }

  let result = { translation: "", pinyin: pinyinText };

  try {
    const dictResponse = await fetchWithAuth(`${API_BASE}/api/dictionary`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ word })
    });

    const dictData = await dictResponse.json();

    if (dictResponse.ok && dictData.entries && dictData.entries.length > 0) {
      const firstEntry = dictData.entries[0];
      result = {
        translation: firstEntry.definitions.slice(0, 3).join("; "),
        pinyin: firstEntry.pinyin || pinyinText
      };
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

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Translation failed");
      result = { translation: data.translation || "", pinyin: pinyinText };
    }
  } catch (err) {
    console.error("Word popup error:", err);
    result = { translation: "Lookup failed", pinyin: pinyinText };
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
    console.error("Google TTS failed, falling back to browser TTS:", error);
    currentAudio = null;
    currentAudioText = "";
    currentAudioRate = 1.0;
    audioCtxSuspended = false;
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

function record(sentence, card, recordBtn = null) {
  const resultBox = card.querySelector(".pronunciation-box");
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  const t = getT();

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
    maybeShowAuthOverlay();
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
        lang
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
      lang: card.lang
    }))
  }));

  await ensureDefaultDeck();
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
  const sentenceEl = document.getElementById("flashcardSentence");
  const sentencePinyinEl = document.getElementById("flashcardSentencePinyin");
  const translationEl = document.getElementById("flashcardTranslation");
  const contextBlockEl = document.querySelector(".flashcard-context-block");

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
  counterEl.textContent = `${deck?.name || t.deck} · ${t.card} ${currentFlashcardIndex + 1} ${t.of} ${cards.length}`;
  wordEl.textContent = card.word || "";
  wordPinyinEl.textContent = card.pinyin || "";
  if (wordBackEl) wordBackEl.textContent = card.word || "";
  sentenceEl.textContent = card.sentence || "";
  sentenceEl.dataset.fullSentence = card.sentence || "";
  sentencePinyinEl.textContent = card.sentencePinyin || "";
  translationEl.textContent = card.translation || "";
  if (contextBlockEl) contextBlockEl.hidden = !card.sentence;

  flashcardFlipped = false;
  cardEl.classList.remove("is-flipped");
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

  currentFlashcardIndex = (currentFlashcardIndex + 1) % cards.length;
  renderFlashcards();
}

function goToPrevFlashcard() {
  const cards = getCurrentCards();
  if (!cards.length) return;

  currentFlashcardIndex = (currentFlashcardIndex - 1 + cards.length) % cards.length;
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
        const transRes = await fetchWithAuth(`${API_BASE}/api/translate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentence: word, sourceLang: lang, targetLang })
        });
        const transData = await transRes.json();
        if (!transRes.ok) throw new Error(transData.error || "Translation failed");
        const translation = transData.translation || "";

        let pinyin = "";
        if (isZh) {
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
document.getElementById("flashcardClearBtn")?.addEventListener("click", clearFlashcards);
document.getElementById("flashcardNewDeckBtn")?.addEventListener("click", createDeck);
document.getElementById("flashcardDeleteDeckBtn")?.addEventListener("click", deleteCurrentDeck);
document.getElementById("flashcardImportBtn")?.addEventListener("click", importWords);
document.getElementById("flashcardExportBtn")?.addEventListener("click", exportCurrentDeck);

document.getElementById("flashcardDeckSelect")?.addEventListener("change", (e) => {
  currentDeckId = e.target.value;
  currentFlashcardIndex = 0;
  renderFlashcards();
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

document.getElementById("flashcardPlaySentenceBtn")?.addEventListener("click", async (e) => {
  unlockAudioForMobile();
  e.stopPropagation();

  const cards = getCurrentCards();
  if (!cards.length) return;

  const card = cards[currentFlashcardIndex];
  const sentence = card?.sentence || "";
  const lang = card?.lang;

  const cleanSentence = await prepareTTSInput(sentence, lang);

  if (cleanSentence) {
    stopAllTTS();
    await playGoogleTTS(cleanSentence, lang);
  }
});

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
  showScreen(screenMain);
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