import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { UI_TEXT } from "./ui-text.js";

const SUPABASE_URL = "https://nudirmexwisvvcmskhtn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8rz-fBIcvrR4qSNuG4j_7w_c_nZ79cU";
const API_BASE = "https://magic-read.onrender.com";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* -----------------------------
   DOM
----------------------------- */

const authScreen = document.getElementById("authScreen");
const authNameGroup = document.getElementById("authNameGroup");
const authMessage = document.getElementById("authMessage");
const mainApp = document.querySelector(".main");
const landingHow = document.querySelector(".landing-how");

const logoutBtn = document.getElementById("logoutBtn");
const guestLoginBtn = document.getElementById("guestLoginBtn");
const signUpBtn = document.getElementById("signUpBtn");

const uiLangSelect = document.getElementById("uiLang");
const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");

const screenMain = document.getElementById("screen-main");
const screenFlashcards = document.getElementById("screen-flashcards");
const screenWriting = document.getElementById("screen-writing");

const createBtn = document.getElementById("createCardsBtn");
const inputText = document.getElementById("inputText");
const container = document.getElementById("cardsContainer");

const readingControlStrip = document.getElementById("readingControlStrip");
const editTextBtn = document.getElementById("editTextBtn");
const replaceTextBtn = document.getElementById("replaceTextBtn");
const globalSlowBtn = document.getElementById("globalSlowBtn");

const fullTextPanel = document.getElementById("fullTextPanel");
const fullTextContent = document.getElementById("fullTextContent");
const fullTextPinyin = document.getElementById("fullTextPinyin");
const fullTextTranslation = document.getElementById("fullTextTranslation");

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

let authMode = "login";

let currentRecognition = null;
let currentAudio = null;
let currentAudioText = "";
let currentAudioRate = 1.0;

let ttsSlowMode = false;
let popupTimeout = null;

let currentText = "";
let currentSentences = [];

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

async function checkAuth() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    document.body.classList.add("is-logged-in");
    document.body.classList.remove("is-logged-out");

    if (authScreen) authScreen.hidden = true;
    if (landingHow) landingHow.hidden = true;
    if (mainApp) mainApp.hidden = false;
    if (logoutBtn) logoutBtn.hidden = false;
  } else {
    document.body.classList.add("is-logged-out");
    document.body.classList.remove("is-logged-in");

    if (authScreen) authScreen.hidden = false;
    if (landingHow) landingHow.hidden = false;
    if (mainApp) mainApp.hidden = true;
    if (logoutBtn) logoutBtn.hidden = true;
  }
}

guestLoginBtn?.addEventListener("click", () => {
  authScreen?.scrollIntoView({ behavior: "smooth" });
});

signUpBtn?.addEventListener("click", async () => {
  const t = getT();

  if (authMode === "login") {
    authMode = "signup";
    if (authNameGroup) authNameGroup.hidden = false;
    signUpBtn.textContent = t.createAccount;
    if (authMessage) authMessage.textContent = t.enterAllFields;
    return;
  }

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

    if (authMessage) authMessage.textContent = t.accountCreated;
  } catch (err) {
    console.error("Signup failed:", err);
    if (authMessage) authMessage.textContent = t.signupFailed;
  } finally {
    signUpBtn.disabled = false;
  }
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
  if (mainApp) mainApp.hidden = true;
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

  if (sourceLangSelect.value === "ru") {
    writingInput.placeholder = "Введите русские слова или фразы";
  } else if (sourceLangSelect.value === "zh") {
    writingInput.placeholder = "请输入汉字";
  } else {
    writingInput.placeholder = "Paste characters or words";
  }
}

sourceLangSelect?.addEventListener("change", () => {
  updateLanguageBasedUI();
  loadTextLibrary();
});

updateLanguageBasedUI();

/* -----------------------------
   MAIN READING FLOW
----------------------------- */

async function startReadingFromText(text) {
  const cleanText = text.trim();

  if (!cleanText) {
    alert("Please paste a text first.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/api/split-text`, {
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
      alert("No sentences found. Try adding punctuation: . ! ? 。！？");
      return;
    }

    currentText = cleanText;
    currentSentences = sentences;

    inputText.value = cleanText;

    await renderCards(sentences);
    await showImportedText(cleanText);

    if (fullTextTranslation) fullTextTranslation.textContent = "";
    if (readingControlStrip) readingControlStrip.hidden = false;
    if (textLibraryPanel) textLibraryPanel.hidden = true;
    if (savedTextsPanel) savedTextsPanel.hidden = true;

    fullTextPanel?.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    console.error("Start reading error:", error);
    alert("Could not start reading. Check the Console and Terminal.");
  }
}

createBtn?.addEventListener("click", async () => {
  await startReadingFromText(inputText.value);
});

editTextBtn?.addEventListener("click", () => {
  inputText?.scrollIntoView({ behavior: "smooth", block: "center" });
  inputText?.focus();
});

replaceTextBtn?.addEventListener("click", () => {
  stopAllTTS();
  stopRecognition();

  currentText = "";
  currentSentences = [];

  if (inputText) inputText.value = "";
  if (container) container.innerHTML = "";
  if (fullTextContent) fullTextContent.innerHTML = "";
  if (fullTextPinyin) fullTextPinyin.textContent = "";
  if (fullTextTranslation) fullTextTranslation.textContent = "";
  if (fullTextPanel) fullTextPanel.hidden = true;
  if (readingControlStrip) readingControlStrip.hidden = true;

  inputText?.scrollIntoView({ behavior: "smooth", block: "center" });
  inputText?.focus();
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

  textLibraryList.innerHTML = `<p class="subtle">Loading library...</p>`;

  try {
    const lang = sourceLangSelect.value;
    const res = await fetch(`${API_BASE}/api/game-texts?lang=${lang}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load library");
    }

    const texts = data.texts || [];

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
        await loadLibraryText(item.dataset.id);
      });
    });
  } catch (err) {
    console.error("Library load error:", err);
    textLibraryList.innerHTML = `<p class="subtle">Could not load library.</p>`;
  }
}

async function loadLibraryText(id) {
  try {
    const lang = sourceLangSelect.value;
    const res = await fetch(`${API_BASE}/api/game-texts/${id}?lang=${lang}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || "Failed to load text");
    }

    const fullText = (data.sentences || []).join(" ").trim();

    if (!fullText) {
      alert("This library text is empty.");
      return;
    }

    await startReadingFromText(fullText);
  } catch (err) {
    console.error("Text load error:", err);
    alert("Could not open this text.");
  }
}

/* -----------------------------
   SAVED TEXTS
----------------------------- */

showSavedTextsBtn?.addEventListener("click", async () => {
  if (textLibraryPanel) textLibraryPanel.hidden = true;
  await loadSavedTexts();
});

async function loadSavedTexts() {
  if (!savedTextsPanel || !savedTextsList) return;

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    alert("Please log in first.");
    return;
  }

  savedTextsPanel.hidden = !savedTextsPanel.hidden;

  if (savedTextsPanel.hidden) return;

  savedTextsList.innerHTML = "Loading saved texts...";

  const { data, error } = await supabase
    .from("saved_texts")
    .select("id, title, text, source_lang, target_lang, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Load saved texts error:", error);
    savedTextsList.innerHTML = "Could not load saved texts.";
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
      <button class="load-saved-text-btn" data-id="${escapeHtml(item.id)}">Open</button>
    </div>
  `).join("");

  savedTextsList.querySelectorAll(".load-saved-text-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const savedText = data.find(item => item.id === btn.dataset.id);
      if (!savedText) return;

      if (savedText.source_lang) sourceLangSelect.value = savedText.source_lang;
      if (savedText.target_lang) targetLangSelect.value = savedText.target_lang;

      updateLanguageBasedUI();
      await startReadingFromText(savedText.text || "");

      savedTextsPanel.hidden = true;
    });
  });
}

document.getElementById("saveTextBtn")?.addEventListener("click", async () => {
  const text = inputText.value.trim();

  if (!text) {
    alert("Please paste a text first.");
    return;
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    alert("Please log in first.");
    return;
  }

  const title = prompt("Text title:") || "Untitled text";

  const { error } = await supabase.from("saved_texts").insert({
    user_id: user.id,
    title,
    text,
    source_lang: sourceLangSelect.value,
    target_lang: targetLangSelect.value
  });

  if (error) {
    console.error("Save text error:", error);
    alert("Could not save text.");
    return;
  }

  alert("Text saved.");
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
    fullTextContent.dataset.fullSentence = text;
    attachWordListeners(fullTextContent);

    try {
      const response = await fetch(`${API_BASE}/api/segment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text })
      });

      const data = await response.json();
      fullTextPinyin.textContent = (data.words || [])
        .map(item => item.pinyin || item.word)
        .join(" ");
    } catch (error) {
      console.error("Full text pinyin error:", error);
      fullTextPinyin.textContent = "";
    }
  } else {
    fullTextContent.innerHTML = renderClickableSentence(text, sourceLangSelect.value);
    fullTextContent.dataset.fullSentence = text;
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
  if (btn) btn.textContent = isHidden ? "Hide pinyin" : getT().showPinyin;
});

document.getElementById("readFullTextBtn")?.addEventListener("click", async () => {
  if (!fullTextContent) return;

  const text = fullTextContent.dataset.fullSentence || fullTextContent.textContent.trim();
  if (!text) return;

  const cleanText = await prepareTTSInput(text, sourceLangSelect.value);

  stopAllTTS();
  await playGoogleTTS(cleanText, sourceLangSelect.value);
});

document.getElementById("translateFullTextBtn")?.addEventListener("click", async () => {
  if (!fullTextContent || !fullTextTranslation) return;

  const text = fullTextContent.dataset.fullSentence || fullTextContent.textContent.trim();
  if (!text) return;

  try {
    fullTextTranslation.textContent = "Translating...";

    const response = await fetch(`${API_BASE}/api/translate`, {
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
document.getElementById("fullTextSlowBtn")?.addEventListener("click", toggleSlowMode);
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
  const response = await fetch(`${API_BASE}/api/segment`, {
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

  return data.words.map(item => {
    const word = item.word;
    const py = item.pinyin || "";

    if (/[，。！？；：、“”‘’（）,.!?;:]/.test(word)) {
      return `<span class="punctuation">${escapeHtml(word)}</span>`;
    }

    return `<span class="word" data-word="${escapeHtml(word)}" data-pinyin="${escapeHtml(py)}">${escapeHtml(word)}</span>`;
  }).join("");
}

async function renderCards(sentences) {
  if (!container) return;

  container.innerHTML = "";

  const labels = {
    zh: "中文",
    ru: "RU",
    tr: "TR",
    en: "EN",
    de: "DE"
  };

  const t = getT();
  const badgeText =
    labels[sourceLangSelect.value] ||
    sourceLangSelect.value.toUpperCase();

  for (const [index, sentence] of sentences.entries()) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.cardIndex = String(index);

    const sentenceHtml =
      sourceLangSelect.value === "zh"
        ? await renderChineseSentence(sentence)
        : renderClickableSentence(sentence, sourceLangSelect.value);

    card.innerHTML = `
      <div class="card-head">
        <h3>Sentence ${index + 1}</h3>
        <span class="card-badge">${badgeText}</span>
      </div>

      <p class="sentence clickable-sentence">${sentenceHtml}</p>

      <div class="card-action-row">
        <button class="tts-btn card-primary-btn">${escapeHtml(t.listen)}</button>
        <button class="record-btn card-primary-btn" hidden>${escapeHtml(t.yourTurn)}</button>

        <div class="card-more">
          <button class="more-btn" type="button" aria-label="More">⋯</button>
          <div class="more-menu" hidden>
            <button class="translate-btn" type="button">${escapeHtml(t.showTranslation)}</button>
            <button class="grammar-btn" type="button">${escapeHtml(t.grammar)}</button>
          </div>
        </div>
      </div>

      <div class="translation-box panel-box"></div>
      <div class="grammar-box panel-box"></div>
      <div class="pronunciation-box panel-box"></div>
    `;

    const ttsBtn = card.querySelector(".tts-btn");
    const recordBtn = card.querySelector(".record-btn");
    const translateBtn = card.querySelector(".translate-btn");
    const grammarBtn = card.querySelector(".grammar-btn");
    const moreBtn = card.querySelector(".more-btn");
    const moreMenu = card.querySelector(".more-menu");
    const sentenceEl = card.querySelector(".clickable-sentence");

    attachWordListeners(sentenceEl);

    moreBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (moreMenu) moreMenu.hidden = !moreMenu.hidden;
    });

    ttsBtn?.addEventListener("click", async () => {
      const cleanSentence = await prepareTTSInput(sentence, sourceLangSelect.value);

      stopAllTTS();
      ttsBtn.textContent = t.listening;

      try {
        await playGoogleTTS(cleanSentence, sourceLangSelect.value);
      } finally {
        ttsBtn.textContent = t.listen;
        if (recordBtn) {
          recordBtn.hidden = false;
          recordBtn.textContent = t.yourTurn;
        }
      }
    });

    sentenceEl?.addEventListener("click", async () => {
      const cleanSentence = await prepareTTSInput(sentence, sourceLangSelect.value);
      stopAllTTS();
      await playGoogleTTS(cleanSentence, sourceLangSelect.value);

      if (recordBtn) {
        recordBtn.hidden = false;
        recordBtn.textContent = t.yourTurn;
      }
    });

    translateBtn?.addEventListener("click", () => {
      if (moreMenu) moreMenu.hidden = true;
      translateSentence(sentence, card);
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

    container.appendChild(card);
  }
}

/* -----------------------------
   TRANSLATION / GRAMMAR
----------------------------- */

async function translateSentence(sentence, card) {
  const translationBox = card.querySelector(".translation-box");

  try {
    translationBox.textContent = "Translating...";

    const response = await fetch(`${API_BASE}/api/translate`, {
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

    const response = await fetch(`${API_BASE}/api/grammar`, {
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
    resultBox.innerHTML = "Grammar failed.";
    return { items: [] };
  }
}

async function openGrammarArticle(articleId, card) {
  const resultBox = card.querySelector(".grammar-box");
  if (!resultBox) return;

  resultBox.innerHTML = "Loading explanation...";

  try {
    const response = await fetch(`${API_BASE}/api/grammar/${articleId}?lang=${sourceLangSelect.value}`);
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

    wordEl.addEventListener("click", (event) => {
      event.stopPropagation();

      const word = wordEl.dataset.word;
      if (!word) return;

      stopAllTTS();
      playGoogleTTS(word);
      showWordPopup(wordEl, word, sentenceText, sentencePinyin).catch(console.error);
    });

    wordEl.dataset.listenerAttached = "true";
  });
}

function removeExistingPopup() {
  document.querySelectorAll(".word-popup").forEach(el => el.remove());

  if (popupTimeout) {
    clearTimeout(popupTimeout);
    popupTimeout = null;
  }
}

async function showWordPopup(wordEl, word, sentence = "", sentencePinyin = "") {
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
      const saved = await addFlashcard({
        word,
        pinyin: py || pinyinText || "",
        sentence,
        sentencePinyin,
        translation: translationText || "",
        lang: sourceLangSelect.value
      });

      saveBtn.textContent = saved ? getT().saved : "Already saved";
    });
  }

  try {
    const dictResponse = await fetch(`${API_BASE}/api/dictionary`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ word })
    });

    const dictData = await dictResponse.json();

    if (dictResponse.ok && dictData.entries && dictData.entries.length > 0) {
      const firstEntry = dictData.entries[0];
      const definitions = firstEntry.definitions.slice(0, 3).join("; ");
      const py = firstEntry.pinyin || pinyinText;

      popup.innerHTML = `
        <strong>${escapeHtml(word)}</strong><br/>
        ${py ? `<div class="popup-pinyin">${escapeHtml(py)}</div>` : ""}
        <div>${escapeHtml(definitions)}</div>
        <button class="popup-save-btn">${escapeHtml(getT().save)}</button>
      `;

      attachSaveButton(popup.querySelector(".popup-save-btn"), definitions, py);
      return;
    }

    const response = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sentence: word,
        sourceLang: sourceLangSelect.value,
        targetLang: targetLangSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Translation failed");
    }

    const translation = data.translation || "";

    popup.innerHTML = `
      <strong>${escapeHtml(word)}</strong><br/>
      ${pinyinText ? `<div class="popup-pinyin">${escapeHtml(pinyinText)}</div>` : ""}
      <div>${escapeHtml(translation)}</div>
      <button class="popup-save-btn">${escapeHtml(getT().save)}</button>
    `;

    attachSaveButton(popup.querySelector(".popup-save-btn"), translation, pinyinText);
  } catch (err) {
    popup.innerHTML = `
      <strong>${escapeHtml(word)}</strong><br/>
      ${pinyinText ? `<div class="popup-pinyin">${escapeHtml(pinyinText)}</div>` : ""}
      <div>Lookup failed</div>
      <button class="popup-save-btn">${escapeHtml(getT().save)}</button>
    `;

    attachSaveButton(popup.querySelector(".popup-save-btn"), "Lookup failed", pinyinText);
  }

  popupTimeout = setTimeout(() => {
    popup.remove();
    popupTimeout = null;
  }, 4000);
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
    de: "de-DE"
  };

  return map[lang] || "en-US";
}

async function prepareTTSInput(text, lang) {
  if (!text) return "";

  if (lang === "zh") {
    try {
      const response = await fetch(`${API_BASE}/api/segment`, {
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

async function playGoogleTTS(text, langOverride = null) {
  if (!text) return;

  const effectiveLang = langOverride || sourceLangSelect.value;
  const effectiveRate = ttsSlowMode ? 0.75 : 1.0;

  if (
    currentAudio &&
    currentAudioText === text &&
    currentAudioRate === effectiveRate
  ) {
    if (currentAudio.paused) {
      await currentAudio.play();
    } else {
      currentAudio.pause();
    }

    return;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
    currentAudioText = "";
    currentAudioRate = 1.0;
  }

  speechSynthesis.cancel();

  try {
    const response = await fetch(`${API_BASE}/api/tts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        sourceLang: effectiveLang,
        speakingRate: effectiveRate
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "TTS failed");
    }

    const audio = new Audio(`data:${data.mimeType};base64,${data.audioBase64}`);
    currentAudio = audio;
    currentAudioText = text;
    currentAudioRate = effectiveRate;

    audio.onended = () => {
      currentAudio = null;
      currentAudioText = "";
      currentAudioRate = 1.0;
    };

    await audio.play();
  } catch (error) {
    console.error("Google TTS failed, falling back to browser TTS:", error);
    currentAudio = null;
    currentAudioText = "";
    currentAudioRate = 1.0;
    playBrowserTTS(text);
  }
}

function playBrowserTTS(text) {
  if (!text) return;

  const lang = mapToSpeechLang(sourceLangSelect.value);

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = ttsSlowMode ? 0.75 : 0.9;

  speechSynthesis.speak(utterance);
}

function stopAllTTS() {
  speechSynthesis.cancel();

  if (currentAudio) {
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio = null;
    currentAudioText = "";
  }
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
  let cleaned = text
    .toLowerCase()
    .replace(/[.,!?;:«»"'()\[\]{}…。，！？、]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (lang.startsWith("zh")) {
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
    if (event.error === "aborted") {
      return;
    }

    resultBox.innerHTML = `Recognition error: ${escapeHtml(event.error)}`;
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
  const sentenceEl = document.getElementById("flashcardSentence");
  const sentencePinyinEl = document.getElementById("flashcardSentencePinyin");
  const translationEl = document.getElementById("flashcardTranslation");

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

  counterEl.textContent = `${deck?.name || "Deck"} · Card ${currentFlashcardIndex + 1} of ${cards.length}`;
  wordEl.textContent = card.word || "";
  wordPinyinEl.textContent = card.pinyin || "";
  sentenceEl.textContent = card.sentence || "";
  sentenceEl.dataset.fullSentence = card.sentence || "";
  sentencePinyinEl.textContent = card.sentencePinyin || "";
  translationEl.textContent = card.translation || "";

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
  deck.cards.splice(currentFlashcardIndex, 1);

  if (card?.id) {
    await supabase.from("flashcards").delete().eq("id", card.id);
  }

  if (currentFlashcardIndex >= deck.cards.length) {
    currentFlashcardIndex = Math.max(0, deck.cards.length - 1);
  }

  renderDeckSelector();
  renderFlashcards();
}

async function clearFlashcards() {
  const deck = getCurrentDeck();
  if (!deck) return;

  const confirmed = confirm(`Clear all cards in "${deck.name}"?`);
  if (!confirmed) return;

  await supabase.from("flashcards").delete().eq("deck_id", deck.id);

  deck.cards = [];
  currentFlashcardIndex = 0;

  renderDeckSelector();
  renderFlashcards();
}

async function createDeck() {
  const name = prompt("Deck name:");
  if (!name || !name.trim()) return;

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
    alert("Could not create deck.");
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
    alert("You need to keep at least one deck.");
    return;
  }

  const deck = getCurrentDeck();
  if (!deck) return;

  const confirmed = confirm(`Delete deck "${deck.name}"?`);
  if (!confirmed) return;

  await supabase.from("flashcard_decks").delete().eq("id", deck.id);

  flashcardDecks = flashcardDecks.filter(d => d.id !== currentDeckId);
  currentDeckId = flashcardDecks[0]?.id || null;
  currentFlashcardIndex = 0;

  renderDeckSelector();
  renderFlashcards();
}

async function exportCurrentDeck() {
  const deck = getCurrentDeck();

  if (!deck) {
    alert("No deck selected.");
    return;
  }

  if (!deck.cards || !deck.cards.length) {
    alert("This deck is empty.");
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
    const response = await fetch(`${API_BASE}/api/export-flashcard-deck`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        deckName: deck.name,
        words
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Export failed");
    }

    if (exportResult) {
      exportResult.innerHTML = "";

      const link = document.createElement("a");
      link.href = data.fileUrl;
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
      alert("Could not export printable deck.");
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
document.getElementById("flashcardExportBtn")?.addEventListener("click", exportCurrentDeck);

document.getElementById("flashcardDeckSelect")?.addEventListener("change", (e) => {
  currentDeckId = e.target.value;
  currentFlashcardIndex = 0;
  renderFlashcards();
});

document.getElementById("flashcardPlayWordBtn")?.addEventListener("click", async (e) => {
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
    const response = await fetch(`${API_BASE}/api/create-writing-sheet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        sourceLang: sourceLangSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to create writing sheet");
    }

    writingResult.innerHTML = "";

    const link = document.createElement("a");
    link.href = data.fileUrl;
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