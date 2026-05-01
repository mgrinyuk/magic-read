import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const SUPABASE_URL = "https://nudirmexwisvvcmskhtn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8rz-fBIcvrR4qSNuG4j_7w_c_nZ79cU";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const API_BASE = "https://magic-read.onrender.com";
const authScreen = document.getElementById("authScreen");
const authNameGroup = document.getElementById("authNameGroup");
let authMode = "login";
const mainApp = document.querySelector(".main");
const landingHow = document.querySelector(".landing-how");
const logoutBtn = document.getElementById("logoutBtn");
const authMessage = document.getElementById("authMessage");
const topNav = document.getElementById("topNav");
const headerRight = document.getElementById("headerRight");
const headerLeft = document.getElementById("headerLeft");
const createBtn = document.getElementById("createCardsBtn");
const container = document.getElementById("cardsContainer");
const inputText = document.getElementById("inputText");
const sourceLangSelect = document.getElementById("sourceLang");
const targetLangSelect = document.getElementById("targetLang");


let currentRecognition = null;
let currentUtterance = null;
let currentUtteranceText = "";
let currentUtteranceLang = "";
speechSynthesis.getVoices();
let currentAudio = null;
let currentAudioText = "";
const screenMain = document.getElementById("screen-main");
const screenGame = document.getElementById("screen-game");
const screenFlashcards = document.getElementById("screen-flashcards");

const navButtons = document.querySelectorAll(".nav-btn");
const backButtons = document.querySelectorAll(".back-btn");

let gameTexts = [];
let currentGameText = null;
let currentGameSentences = [];
let currentGameIndex = 0;
let gameUnlockedUntil = 0;
let gameScores = [];
const FLASHCARD_STORAGE_KEY = "magicread_flashcard_decks";
let flashcardDecks = [];
let currentDeckId = null;
let currentFlashcardIndex = 0;
let flashcardFlipped = false;
let ttsSlowMode = false;
let currentAudioRate = 1.0;
let popupTimeout = null;
let customGameText = null;
let customGameSentences = [];

async function checkAuth() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    document.body.classList.add("is-logged-in");
    document.body.classList.remove("is-logged-out");

    authScreen.hidden = true;
    landingHow.hidden = true;
    mainApp.hidden = false;
    logoutBtn.hidden = false;
  } else {
    document.body.classList.add("is-logged-out");
    document.body.classList.remove("is-logged-in");

    authScreen.hidden = false;
    landingHow.hidden = false;
    mainApp.hidden = true;
    logoutBtn.hidden = true;
  }
}

document.getElementById("guestLoginBtn")?.addEventListener("click", () => {
  authScreen.scrollIntoView({ behavior: "smooth" });
});

const signUpBtn = document.getElementById("signUpBtn");

console.log("signUpBtn found:", signUpBtn);

signUpBtn?.addEventListener("click", async () => {
  if (authMode === "login") {
    authMode = "signup";
    authNameGroup.hidden = false;
    signUpBtn.textContent = "Create account";
    authMessage.textContent = "Enter your name, email, and password to create an account.";
    return;
  }

  const name = document.getElementById("authName")?.value.trim();
  const email = document.getElementById("authEmail")?.value.trim();
  const password = document.getElementById("authPassword")?.value.trim();

  if (!name || !email || !password) {
    authMessage.textContent = "Please enter name, email, and password.";
    return;
  }

  signUpBtn.disabled = true;
  authMessage.textContent = "Creating account...";

  try {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name
        }
      }
    });

    console.log("Signup result:", data, error);

    if (error) {
      authMessage.textContent = error.message;
      return;
    }

    authMessage.textContent = "Account created. Please check your email, then log in.";
  } catch (err) {
    console.error("Signup failed:", err);
    authMessage.textContent = "Signup failed. Check console.";
  } finally {
    signUpBtn.disabled = false;
  }
});

document.getElementById("loginBtn")?.addEventListener("click", async () => {
  authMode = "login";
  if (authNameGroup) authNameGroup.hidden = true;

  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value.trim();

  authMessage.textContent = "Logging in...";

  const { error } = await supabase.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    authMessage.textContent = error.message;
    return;
  }

  authMessage.textContent = "";
  await checkAuth();
});

logoutBtn?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  await checkAuth();
});

checkAuth();

const forgotPasswordBox = document.getElementById("forgotPasswordBox");
const recoveryEmailInput = document.getElementById("recoveryEmailInput");
const sendRecoveryEmailBtn = document.getElementById("sendRecoveryEmailBtn");

document.getElementById("forgotPasswordBtn")?.addEventListener("click", () => {
  if (forgotPasswordBox) {
    forgotPasswordBox.hidden = false;
  }

  if (authMessage) {
    authMessage.textContent = "Enter your email and click Restore password.";
  }
});

sendRecoveryEmailBtn?.addEventListener("click", async () => {
  const email = recoveryEmailInput?.value.trim();

  if (!email) {
    if (authMessage) {
      authMessage.textContent = "Please enter your email.";
    }
    return;
  }

  if (authMessage) {
    authMessage.textContent = "Sending password recovery email...";
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}?reset=true`
  });

  if (error) {
    if (authMessage) {
      authMessage.textContent = error.message;
    }
    return;
  }

  if (authMessage) {
    authMessage.textContent = "Password recovery email sent. Please check your inbox.";
  }
});


//reset password
const resetPasswordScreen = document.getElementById("resetPasswordScreen");
const resetPasswordBox = document.getElementById("resetPasswordBox");
const newPasswordInput = document.getElementById("newPasswordInput");
const updatePasswordBtn = document.getElementById("updatePasswordBtn");
const resetPasswordMessage = document.getElementById("resetPasswordMessage");

function showResetPasswordScreen() {
  document.body.classList.add("is-logged-out");
  document.body.classList.remove("is-logged-in");

  authScreen.hidden = true;
  landingHow.hidden = true;
  mainApp.hidden = true;
  logoutBtn.hidden = true;

  if (resetPasswordScreen) {
    resetPasswordScreen.hidden = false;
  }

  if (resetPasswordMessage) {
    resetPasswordMessage.textContent = "Please create a new password.";
  }
}

const isReset =
  window.location.search.includes("reset=true") ||
  window.location.hash.includes("type=recovery");

if (isReset) {
  showResetPasswordScreen();
}

supabase.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    showResetPasswordScreen();
  }
});

updatePasswordBtn?.addEventListener("click", async () => {
  const newPassword = newPasswordInput.value.trim();

  if (newPassword.length < 6) {
    resetPasswordMessage.textContent = "Password should be at least 6 characters.";
    return;
  }

  resetPasswordMessage.textContent = "Saving new password...";

  const { error } = await supabase.auth.updateUser({
    password: newPassword
  });

  if (error) {
    resetPasswordMessage.textContent = error.message;
    return;
  }

  resetPasswordMessage.textContent = "Password updated.";

  if (resetPasswordScreen) {
    resetPasswordScreen.hidden = true;
  }

  window.history.replaceState({}, document.title, window.location.origin);

  await checkAuth();

  showScreen(document.getElementById("screen-main"));

  document.querySelectorAll(".nav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.screen === "reader");
  });
});

// flashcard logic
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

  ensureDefaultDeck();
}

async function autoplayCurrentFlashcardWord() {
  const cards = getCurrentCards();
  if (!cards.length) return;

  const card = cards[currentFlashcardIndex];
  const word = card?.word || "";
  const lang = card?.lang || sourceLangSelect.value;

  if (!word) return;
  stopAllTTS();
  await playGoogleTTS(word, lang);
}

async function saveFlashcardsToStorage() {
  localStorage.setItem(FLASHCARD_STORAGE_KEY, JSON.stringify(flashcardDecks));

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return;

  console.log("Flashcards still saved locally. Supabase sync comes next.");
}

function buildSentencePinyinFromWords(sentenceEl) {
  if (!sentenceEl) return "";
  return Array.from(sentenceEl.querySelectorAll(".word"))
    .map(el => el.dataset.pinyin || "")
    .filter(Boolean)
    .join(" ");
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

function generateDeckId() {
  return `deck-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function getCurrentDeck() {
  return flashcardDecks.find(deck => deck.id === currentDeckId) || null;
}

function getCurrentCards() {
  return getCurrentDeck()?.cards || [];
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

// grammar screen

function renderGrammarList(items) {
  const listEl = document.getElementById("grammarList");
  if (!listEl) return;

  listEl.innerHTML = items.map(item => `
    <div class="grammar-card" data-id="${item.id}">
      <div class="grammar-card-top">
        <span>${item.level}</span>
        <span>${item.category}</span>
      </div>
      <h3>${item.title}</h3>
      <p>${item.shortExplanation}</p>
    </div>
  `).join("");

  listEl.querySelectorAll(".grammar-card").forEach(card => {
    card.addEventListener("click", async () => {
      await openGrammarPage(card.dataset.id);
    });
  });
}

// open grammar page
async function openGrammarPage(id) {
  const listEl = document.getElementById("grammarList");

  try {
    const response = await fetch(
  `${API_BASE}/api/grammar/${id}?lang=${sourceLangSelect.value}`
);
    const data = await response.json();

    const examples = [];

    if (data.ex1_ch) {
      examples.push({ text: data.ex1_ch, translation: data.ex1_py || "" });
    }
    if (data.ex2_ch) {
      examples.push({ text: data.ex2_ch, translation: data.ex2_py || "" });
    }
    if (data.ex3_ch) {
      examples.push({ text: data.ex3_ch, translation: data.ex3_py || "" });
    }

    listEl.innerHTML = `
      <button id="grammarBackBtn">← Back</button>

      <div class="grammar-article-page">
        <h2>${data.title}</h2>
        <p>${data.fullExplanation}</p>

        <h3>Examples</h3>

        ${examples.map(ex => `
          <div class="grammar-example">
            <div>${ex.text}</div>
            <div>${ex.translation}</div>
          </div>
        `).join("")}
      </div>
    `;

    document
      .getElementById("grammarBackBtn")
      .addEventListener("click", loadGrammarScreen);
  } catch (error) {
    console.error(error);
  }
}

// flashcards

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

function deleteCurrentFlashcard() {
  const deck = getCurrentDeck();
  if (!deck || !deck.cards.length) return;

  deck.cards.splice(currentFlashcardIndex, 1);
  saveFlashcardsToStorage();

  if (currentFlashcardIndex >= deck.cards.length) {
    currentFlashcardIndex = Math.max(0, deck.cards.length - 1);
  }

  renderDeckSelector();
  renderFlashcards();

  setTimeout(() => {
  autoplayCurrentFlashcardWord();
}, 250);
}

function clearFlashcards() {
  const deck = getCurrentDeck();
  if (!deck) return;

  deck.cards = [];
  currentFlashcardIndex = 0;
  saveFlashcardsToStorage();
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

function deleteCurrentDeck() {
  if (flashcardDecks.length === 1) {
    alert("You need to keep at least one deck.");
    return;
  }

  const deck = getCurrentDeck();
  if (!deck) return;

  const confirmed = confirm(`Delete deck "${deck.name}"?`);
  if (!confirmed) return;

  flashcardDecks = flashcardDecks.filter(d => d.id !== currentDeckId);
  currentDeckId = flashcardDecks[0]?.id || null;
  currentFlashcardIndex = 0;

  saveFlashcardsToStorage();
  renderDeckSelector();
  renderFlashcards();
}

function renderDeckSelector() {
  const selectEl = document.getElementById("flashcardDeckSelect");
  if (!selectEl) return;

  selectEl.innerHTML = flashcardDecks.map(deck => `
    <option value="${deck.id}">
      ${deck.name} (${deck.cards.length})
    </option>
  `).join("");

  selectEl.value = currentDeckId || "";
}


async function loadGameTexts() {
  try {
    const response = await fetch(`${API_BASE}/api/game-texts?lang=${sourceLangSelect.value}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load game texts");
    }

    gameTexts = data.texts || [];
    renderGameTextList();
  } catch (error) {
    console.error("Game texts load error:", error);
  }
}
function showGameEndScreen() {
  const endScreen = document.getElementById("gameEndScreen");
  const endMessage = document.getElementById("gameEndMessage");
  const endScore = document.getElementById("gameEndScore");

  if (!endScreen || !endMessage || !endScore) return;

  const validScores = gameScores.filter(score => typeof score === "number");
  const averageScore = validScores.length
    ? Math.round(validScores.reduce((sum, score) => sum + score, 0) / validScores.length)
    : 0;

  const completedCount = validScores.length;
  const totalCount = currentGameSentences.length;

  let message = "Nice effort. You finished the practice.";
  if (averageScore >= 90) {
    message = "Excellent pronunciation work!";
  } else if (averageScore >= 75) {
    message = "Great job. You unlocked the whole text.";
  } else if (averageScore >= 50) {
    message = "Good practice. Try again to improve your score.";
  }

  endMessage.textContent = message;
  endScore.textContent = `Average score: ${averageScore}% · Practiced: ${completedCount}/${totalCount}`;

  endScreen.hidden = false;
}

function renderGameTextList() {
  const listEl = document.getElementById("gameTextList");
  if (!listEl) return;

  const importedTextForCurrentLang =
    customGameText && customGameText.lang === sourceLangSelect.value
      ? [customGameText]
      : [];

  const allGameTexts = [
    ...importedTextForCurrentLang,
    ...gameTexts
  ];

  if (!allGameTexts.length) {
    listEl.innerHTML = `
      <div class="flashcard-empty">
        No speaking texts for this language yet.
      </div>
    `;
    currentGameSentences = [];
    renderGameCard();
    return;
  }

  listEl.innerHTML = allGameTexts.map((item, index) => `
    <button class="game-text-item ${index === 0 ? "game-text-item-active" : ""}" data-id="${item.id}">
      <span class="game-text-title">${escapeHtml(item.title)}</span>
      <span class="game-text-meta">${escapeHtml(item.level)} · ${item.cardCount} cards</span>
    </button>
  `).join("");

  listEl.querySelectorAll(".game-text-item").forEach(btn => {
    btn.addEventListener("click", async () => {
      listEl.querySelectorAll(".game-text-item").forEach(el => {
        el.classList.remove("game-text-item-active");
      });

      btn.classList.add("game-text-item-active");
      await startGameText(btn.dataset.id);
      document.getElementById("gameLibraryPanel")?.classList.add("collapsed");

        const toggleBtn = document.getElementById("toggleGameLibraryBtn");
        if (toggleBtn) {
          toggleBtn.textContent = "📚 Choose practice text";
        }
    });
  });

  startGameText(allGameTexts[0].id);
}

async function startGameText(textId) {
  
  if (textId === "custom-pasted-text" && customGameText) {
    currentGameText = customGameText;
    currentGameSentences = customGameText.sentences || [];
    currentGameIndex = 0;
    gameUnlockedUntil = 0;
    gameScores = [];
    renderGameCard();
    return;
  }
  
  try {
    const response = await fetch(
  `${API_BASE}/api/game-texts/${textId}?lang=${sourceLangSelect.value}`
);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load game text");
    }

    currentGameText = data;
    currentGameSentences = data.sentences || [];
    currentGameIndex = 0;
    gameUnlockedUntil = 0;
    gameScores = [];

    renderGameCard();
  } catch (error) {
    console.error("Start game text error:", error);
  }
}

async function renderGameCard() {
  const sentence = currentGameSentences[currentGameIndex] || "";
  const endScreen = document.getElementById("gameEndScreen");
    if (endScreen) {
      endScreen.hidden = true;
    }
  const cardLabel = document.getElementById("gameCardLabel");
  const lastScore = document.getElementById("gameLastScore");
  const progressFill = document.getElementById("gameProgressFill");
  const sentenceEl = document.getElementById("gameSentence");
  const pinyinEl = document.getElementById("gamePinyin");
  const feedbackEl = document.getElementById("gameFeedback");
  const prevBtn = document.getElementById("gamePrevBtn");
  const nextBtn = document.getElementById("gameNextBtn");
  const badgeEl = document.getElementById("gameLangBadge");
if (badgeEl) {
  const labels = {
    zh: "中文",
    ru: "RU",
    tr: "TR",
    en: "EN",
    de: "DE"
  };

  badgeEl.textContent =
    labels[sourceLangSelect.value] ||
    sourceLangSelect.value.toUpperCase();
}

  const gameCardEl = document.querySelector(".game-card");
if (gameCardEl) {
  gameCardEl.classList.remove("slide-out", "slide-in", "slide-in-active");
}

  if (!sentenceEl) return;

  cardLabel.textContent = `Card ${currentGameIndex + 1} of ${currentGameSentences.length}`;
  lastScore.textContent = `Last score: ${gameScores[currentGameIndex] ?? "—"}${gameScores[currentGameIndex] != null ? "%" : ""}`;
  progressFill.style.width = `${((currentGameIndex + 1) / currentGameSentences.length) * 100}%`;

  sentenceEl.textContent = sentence;

  if (sourceLangSelect.value === "zh" && sentence) {
    try {
      const response = await fetch(`${API_BASE}/api/segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sentence })
      });

      const data = await response.json();
      pinyinEl.textContent = (data.words || []).map(w => w.pinyin).filter(Boolean).join(" ");
    } catch {
      pinyinEl.textContent = "";
    }
  } else {
    pinyinEl.textContent = "";
  }

  feedbackEl.className = "game-feedback warning";
  feedbackEl.innerHTML = `<p>Score at least 75% to unlock the next card.</p>`;

  prevBtn.disabled = currentGameIndex === 0;
  nextBtn.disabled = currentGameIndex >= gameUnlockedUntil;
}


document.getElementById("gamePlayBtn")?.addEventListener("click", async () => {
  const sentence = currentGameSentences[currentGameIndex];
  if (sentence) {
    stopAllTTS();
    await playGoogleTTS(sentence);
  }
});

document.getElementById("gameTranslateBtn")?.addEventListener("click", async () => {
  const sentence = currentGameSentences[currentGameIndex];
  const feedbackEl = document.getElementById("gameFeedback");
  if (!sentence || !feedbackEl) return;

  try {
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
    feedbackEl.className = "game-feedback warning";
    feedbackEl.innerHTML = `<p><strong>Translation:</strong> ${escapeHtml(data.translation || "")}</p>`;
  } catch (error) {
    console.error(error);
  }
});

function recordGameSentence() {
  const feedbackEl = document.getElementById("gameFeedback");
  const sentence = currentGameSentences[currentGameIndex];
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition || !sentence || !feedbackEl) {
    return;
  }

  stopRecognition();
  stopSpeech();

  const recognition = new SpeechRecognition();
  currentRecognition = recognition;

  const lang = mapToSpeechLang(sourceLangSelect.value);
  recognition.lang = lang;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  feedbackEl.className = "game-feedback warning";
  feedbackEl.innerHTML = `<p>Listening...</p>`;

  recognition.onresult = (event) => {
  const transcript = event.results[0][0].transcript || "";
  const result = compareText(sentence, transcript, lang);

  gameScores[currentGameIndex] = result.score;

  if (result.score >= 75) {
    feedbackEl.className = "game-feedback success";

    if (
      currentGameIndex === gameUnlockedUntil &&
      gameUnlockedUntil < currentGameSentences.length - 1
    ) {
      gameUnlockedUntil += 1;
    }

    feedbackEl.innerHTML = `
      <p><strong>Recognized:</strong> ${escapeHtml(transcript)}</p>
      <p><strong>Accuracy:</strong> ${result.score}%</p>
      <p>Great job. The next card is now unlocked.</p>
    `;

    document.getElementById("gameLastScore").textContent = `Last score: ${result.score}%`;
    document.getElementById("gameNextBtn").disabled = false;


    // 🚀 AUTO MOVE + SCROLL
   // ✨ animation + slide
const card = document.querySelector(".game-card");

if (currentGameIndex >= currentGameSentences.length - 1) {
  showGameEndScreen();
  return;
}

if (card) {
  card.classList.remove("slide-in", "slide-in-active");
  card.classList.add("slide-out");

  setTimeout(async () => {
    currentGameIndex += 1;
    await renderGameCard();

    const newCard = document.querySelector(".game-card");

    if (newCard) {
      newCard.classList.add("slide-in");

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          newCard.classList.add("slide-in-active");
        });
      });
    }
  }, 650);
}

  } else {
    feedbackEl.className = "game-feedback warning";
    feedbackEl.innerHTML = `
      <p><strong>Recognized:</strong> ${escapeHtml(transcript)}</p>
      <p><strong>Accuracy:</strong> ${result.score}%</p>
      <p>Try again to unlock the next card.</p>
    `;
  }
};

  recognition.onerror = (event) => {
    feedbackEl.className = "game-feedback warning";
    feedbackEl.innerHTML = `<p>Recognition error: ${escapeHtml(event.error)}</p>`;
  };

  recognition.onend = () => {
    currentRecognition = null;
  };

  recognition.start();
}
document.getElementById("gameRecordBtn")?.addEventListener("click", () => {
  recordGameSentence();
});

document.getElementById("gamePrevBtn")?.addEventListener("click", () => {
  if (currentGameIndex > 0) {
    currentGameIndex -= 1;
    renderGameCard();
  }
});

document.getElementById("gameNextBtn")?.addEventListener("click", () => {
  if (
    currentGameIndex < currentGameSentences.length - 1 &&
    currentGameIndex + 1 <= gameUnlockedUntil
  ) {
    currentGameIndex += 1;
    renderGameCard();
  }
});



function showScreen(screen) {
  if (!screen) return;

  document.querySelectorAll(".app-screen").forEach(s => {
    s.classList.remove("active");
  });

  screen.classList.add("active");

  sessionStorage.setItem("activeScreenId", screen.id);
}

window.addEventListener("DOMContentLoaded", () => {
  const savedScreenId = sessionStorage.getItem("activeScreenId") || "screen-main";
  const savedScreen = document.getElementById(savedScreenId);

  showScreen(savedScreen || screenMain);

  document.querySelectorAll(".nav-link").forEach(link => {
    const screenMap = {
      reader: "screen-main",
      speak: "screen-game",
      words: "screen-flashcards",
      grammar: "screen-grammar",
      calligraphy: "screen-writing"
    };

    link.classList.toggle(
      "active",
      screenMap[link.dataset.screen] === savedScreenId
    );
  });
});

const navLinks = document.querySelectorAll(".nav-link");

navLinks.forEach(btn => {
  btn.addEventListener("click", async () => {
    navLinks.forEach(link => link.classList.remove("active"));
    btn.classList.add("active");

    const screen = btn.dataset.screen;

    if (screen === "reader") {
      showScreen(document.getElementById("screen-main"));
    }

    if (screen === "speak") {
      showScreen(document.getElementById("screen-game"));
      await loadGameTexts();
    }

    if (screen === "words") {
      showScreen(document.getElementById("screen-flashcards"));
      renderDeckSelector();
      renderFlashcards();
    }

    if (screen === "grammar") {
      showScreen(document.getElementById("screen-grammar"));
      await loadGrammarScreen();
    }

    if (screen === "calligraphy") {
      showScreen(document.getElementById("screen-writing"));
    }
  });
});

const screenWriting = document.getElementById("screen-writing");
const writingInput = document.getElementById("writingInput");
const createWritingSheetBtn = document.getElementById("createWritingSheetBtn");
const writingResult = document.getElementById("writingResult");

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

    showScreen(screenWriting);

    document.querySelectorAll(".nav-link").forEach(link => {
      link.classList.toggle("active", link.dataset.screen === "calligraphy");
    });

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

createBtn.addEventListener("click", async () => {
  const text = inputText.value.trim();

  if (!text) {
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
        text,
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

    await renderCards(sentences);
    await showImportedText(text);

    document.getElementById("fullTextTranslation").textContent = "";

    document.getElementById("fullTextPanel").scrollIntoView({
      behavior: "smooth"
    });

    customGameSentences = sentences;

    customGameText = {
      id: "custom-pasted-text",
      title: "My pasted text",
      level: "Custom",
      cardCount: customGameSentences.length,
      sentences: customGameSentences,
      lang: sourceLangSelect.value
    };
  } catch (error) {
    console.error("Create cards error:", error);
    alert("Could not create cards. Check the Console and Terminal.");
  }
});

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

async function loadSavedTexts() {
  const panel = document.getElementById("savedTextsPanel");
  const list = document.getElementById("savedTextsList");

  if (!panel || !list) return;

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    alert("Please log in first.");
    return;
  }

  list.innerHTML = "Loading saved texts...";
  panel.hidden = false;

  const { data, error } = await supabase
    .from("saved_texts")
    .select("id, title, text, source_lang, target_lang, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Load saved texts error:", error);
    list.innerHTML = "Could not load saved texts.";
    return;
  }

  if (!data || !data.length) {
    list.innerHTML = `<p class="subtle">No saved texts yet.</p>`;
    return;
  }

  list.innerHTML = data.map(item => `
    <div class="saved-text-item" data-id="${item.id}">
      <div>
        <strong>${escapeHtml(item.title || "Untitled text")}</strong>
        <p>${escapeHtml(item.source_lang || "")} → ${escapeHtml(item.target_lang || "")}</p>
      </div>
      <button class="load-saved-text-btn" data-id="${item.id}">Open</button>
    </div>
  `).join("");

  list.querySelectorAll(".load-saved-text-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const savedText = data.find(item => item.id === btn.dataset.id);
      if (!savedText) return;

      inputText.value = savedText.text || "";

      if (savedText.source_lang) {
        sourceLangSelect.value = savedText.source_lang;
      }

      if (savedText.target_lang) {
        targetLangSelect.value = savedText.target_lang;
      }

      panel.hidden = true;

      await renderSavedTextAsCards(savedText.text);
    });
  });
}

async function renderSavedTextAsCards(text) {
  if (!text) return;

  const res = await fetch(`${API_BASE}/api/split-text`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text,
      sourceLang: sourceLangSelect.value
    })
  });

  const data = await res.json();

  if (!res.ok) {
    alert("Could not open saved text.");
    return;
  }

  const sentences = data.sentences || [];

  await renderCards(sentences);
  await showImportedText(text);

  customGameSentences = sentences;
  customGameText = {
    id: "custom-pasted-text",
    title: "My saved text",
    level: "Saved",
    cardCount: sentences.length,
    sentences,
    lang: sourceLangSelect.value
  };

  document.getElementById("fullTextPanel").scrollIntoView({
    behavior: "smooth"
  });
}

document.getElementById("showSavedTextsBtn")?.addEventListener("click", loadSavedTexts);

function updateWritingPlaceholder() {
  if (!writingInput || !sourceLangSelect) return;

  if (sourceLangSelect.value === "ru") {
    writingInput.placeholder = "Введите русские слова или фразы";
  } else if (sourceLangSelect.value === "zh") {
    writingInput.placeholder = "请输入汉字";
  } else if (sourceLangSelect.value === "tr") {
    writingInput.placeholder = "Türkçe kelime veya cümle girin";
  } else {
    writingInput.placeholder = "Paste text here";
  }
}

document.getElementById("gameSkipBtn")?.addEventListener("click", async () => {
  if (!currentGameSentences.length) return;

  gameScores[currentGameIndex] = 0;

  if (currentGameIndex < currentGameSentences.length - 1) {
    currentGameIndex += 1;
    gameUnlockedUntil = Math.max(gameUnlockedUntil, currentGameIndex);
    await renderGameCard();
  } else {
    showGameEndScreen();
  }
});

document.getElementById("gameRestartBtn")?.addEventListener("click", async () => {
  currentGameIndex = 0;
  gameUnlockedUntil = 0;
  gameScores = [];
  await renderGameCard();
});

document.getElementById("gameGoToReaderBtn")?.addEventListener("click", () => {
  showScreen(document.getElementById("screen-main"));

  document.querySelectorAll(".nav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.screen === "reader");
  });
});

document.getElementById("toggleGameLibraryBtn")?.addEventListener("click", () => {
  const panel = document.getElementById("gameLibraryPanel");
  const btn = document.getElementById("toggleGameLibraryBtn");

  if (!panel || !btn) return;

  const isCollapsed = panel.classList.toggle("collapsed");
  btn.textContent = isCollapsed
    ? "📚 Choose practice text"
    : "📚 Hide practice texts";
});

sourceLangSelect.addEventListener("change", async () => {
  updateWritingPlaceholder();

  if (screenGame.classList.contains("active")) {
    await loadGameTexts();
  }
});

updateWritingPlaceholder();

function renderClickableSentence(sentence, lang) {
  if (lang === "zh") {
    return renderChineseSentence(sentence);
  }

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
  container.innerHTML = "";

  const labels = {
    zh: "中文",
    ru: "RU",
    tr: "TR",
    en: "EN",
    de: "DE"
  };

  const badgeText =
    labels[sourceLangSelect.value] ||
    sourceLangSelect.value.toUpperCase();

  for (const [index, sentence] of sentences.entries()) {
    const card = document.createElement("div");
    card.className = "card";

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

      <div class="card-buttons">
        <button class="tts-btn">🔊 Play</button>
        <button class="slow-tts-btn">🐢 Slow: OFF</button>
        <button class="translate-btn">🌐 Translate</button>
        <button class="record-btn">🎤 Record</button>
        <button class="grammar-btn">🧠 Grammar</button>
      </div>

      <div class="translation-box panel-box"></div>
      <div class="grammar-box panel-box"></div>
      <div class="pronunciation-box panel-box"></div>
    `;

    const ttsBtn = card.querySelector(".tts-btn");
    const slowTtsBtn = card.querySelector(".slow-tts-btn");
    const translateBtn = card.querySelector(".translate-btn");
    const recordBtn = card.querySelector(".record-btn");
    const grammarBtn = card.querySelector(".grammar-btn");
    const sentenceEl = card.querySelector(".clickable-sentence");

    slowTtsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      ttsSlowMode = !ttsSlowMode;
      stopAllTTS();
      slowTtsBtn.textContent = ttsSlowMode ? "🐢 Slow: ON" : "🐢 Slow: OFF";
    });

    attachWordListeners(sentenceEl);

    ttsBtn.addEventListener("click", async () => {
      const cleanSentence = await prepareTTSInput(sentence, sourceLangSelect.value);
      stopAllTTS();
      await playGoogleTTS(cleanSentence, sourceLangSelect.value);

      if (currentAudio && currentAudioText === cleanSentence && !currentAudio.paused) {
        ttsBtn.textContent = "⏸ Pause";
      } else {
        ttsBtn.textContent = "🔊 Play";
      }
    });

    sentenceEl.addEventListener("click", async () => {
      const cleanSentence = await prepareTTSInput(sentence, sourceLangSelect.value);
      stopAllTTS();
      await playGoogleTTS(cleanSentence, sourceLangSelect.value);
    });

    

    translateBtn.addEventListener("click", () => {
      translateSentence(sentence, card);
    });

    recordBtn.addEventListener("click", () => {
      record(sentence, card);
    });

    grammarBtn.addEventListener("click", async () => {
      const data = await grammar(sentence, card);

      const sentenceEl = card.querySelector(".sentence");
      highlightGrammarInSentence(sentenceEl, data.items, sourceLangSelect.value);
      

      const grammarItems = card.querySelectorAll(".grammar-item");

      grammarItems.forEach(el => {
        el.addEventListener("click", () => {
          const id = el.dataset.id;
          openGrammarArticle(id, card);
        });
      });
    });

    container.appendChild(card);
  }
}  
async function openGrammarArticle(articleId, card) {
  const resultBox = card.querySelector(".grammar-box");

  if (!resultBox) return;

  resultBox.innerHTML = "Loading explanation...";

  try {
    const response = await fetch(
    `${API_BASE}/api/grammar/${articleId}?lang=${sourceLangSelect.value}`
  );
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load grammar article");
    }

    const examples = [];

    if (data.ex1_ch) {
      examples.push({
        text: data.ex1_ch,
        pinyin: data.ex1_py || ""
      });
    }

    if (data.ex2_ch) {
      examples.push({
        text: data.ex2_ch,
        pinyin: data.ex2_py || ""
      });
    }

    if (data.ex3_ch) {
      examples.push({
        text: data.ex3_ch,
        pinyin: data.ex3_py || ""
      });
    }

    resultBox.innerHTML = `
      <div class="grammar-article">
        <h4>${escapeHtml(data.title || "")}</h4>
        <p>${escapeHtml(data.fullExplanation || "")}</p>

        <div class="examples">
          <strong>Examples:</strong>
          <ul>
            ${examples.map(example => `
              <li>
                <div>${escapeHtml(example.text)}</div>
                ${example.pinyin ? `<div class="example-pinyin">${escapeHtml(example.pinyin)}</div>` : ""}
              </li>
            `).join("")}
          </ul>
        </div>
      </div>
    `;
  } catch (error) {
    console.error("openGrammarArticle error:", error);
    resultBox.innerHTML = "Failed to load grammar explanation.";
  }
}

// read full text

async function showImportedText(text) {
  const panel = document.getElementById("fullTextPanel");
  const contentEl = document.getElementById("fullTextContent");
  const pinyinEl = document.getElementById("fullTextPinyin");

  panel.hidden = false;

  if (sourceLangSelect.value === "zh") {
    const html = await renderChineseSentence(text);
    contentEl.innerHTML = html;
    contentEl.dataset.fullSentence = text;
    attachWordListeners(contentEl);

    try {
      const response = await fetch(`${API_BASE}/api/segment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ text })
      });

      const data = await response.json();
      pinyinEl.textContent = (data.words || [])
        .map(item => item.pinyin || item.word)
        .join(" ");
    } catch (error) {
      console.error("Full text pinyin error:", error);
      pinyinEl.textContent = "";
    }
  } else {
    contentEl.textContent = text;
    pinyinEl.textContent = "";
  }

  document.getElementById("fullTextTranslation").textContent = "";
  pinyinEl.hidden = true;

  const toggleBtn = document.getElementById("toggleFullTextPinyinBtn");
  if (toggleBtn) {
    toggleBtn.textContent = "🔤 Show pinyin";
  }
}

document.getElementById("toggleFullTextPinyinBtn")?.addEventListener("click", () => {
  const pinyinEl = document.getElementById("fullTextPinyin");
  const btn = document.getElementById("toggleFullTextPinyinBtn");

  const isHidden = pinyinEl.hidden;
  pinyinEl.hidden = !isHidden;
  btn.textContent = isHidden ? "🔤 Hide pinyin" : "🔤 Show pinyin";
});


const screenGrammar = document.getElementById("screen-grammar");

async function loadGrammarScreen() {
  try {
    const response = await fetch(
  `${API_BASE}/api/grammar-list?lang=${sourceLangSelect.value}`
);  
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load grammar list");
    }

    renderGrammarList(data.items || []);
  } catch (error) {
    console.error("Grammar screen load error:", error);
  }
}

const grammarLensInput = document.getElementById("grammarLensInput");
const grammarLensAnalyzeBtn = document.getElementById("grammarLensAnalyzeBtn");
const grammarLensResult = document.getElementById("grammarLensResult");
const grammarSidePanel = document.getElementById("grammarSidePanel");

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getGrammarRanges(text, items, lang) {
  const ranges = [];
  const lowerText = text.toLowerCase();

  items.forEach(item => {
    const rawMarker = item.matchedText || "";
    const marker = rawMarker.toLowerCase().trim();
    if (!marker) return;

    if (lang === "zh") {
      let index = lowerText.indexOf(marker);
      while (index !== -1) {
        ranges.push({
          start: index,
          end: index + marker.length,
          item
        });
        index = lowerText.indexOf(marker, index + marker.length);
      }
      return;
    }

    const wordRegex = /[\p{L}\p{M}]+/gu;
    let match;

    if (marker.startsWith("-") && marker.endsWith("-")) {
      const infix = marker.slice(1, -1);

      while ((match = wordRegex.exec(lowerText)) !== null) {
        const word = match[0];
        const localIndex = word.indexOf(infix);

        if (localIndex !== -1) {
          ranges.push({
            start: match.index + localIndex,
            end: match.index + localIndex + infix.length,
            item
          });
        }
      }

      return;
    }

    if (marker.startsWith("-")) {
      const suffix = marker.slice(1);

      while ((match = wordRegex.exec(lowerText)) !== null) {
        const word = match[0];

        if (word.endsWith(suffix)) {
          ranges.push({
            start: match.index + word.length - suffix.length,
            end: match.index + word.length,
            item
          });
        }
      }

      return;
    }

    const regex = new RegExp(`(^|\\s|[.,!?;:«»"'()\\-])(${escapeRegExp(marker)})($|\\s|[.,!?;:«»"'()\\-])`, "giu");

    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0];
      const markerPart = match[2];
      const start = match.index + fullMatch.indexOf(markerPart);

      ranges.push({
        start,
        end: start + markerPart.length,
        item
      });
    }
  });

  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const cleanRanges = [];
  let lastEnd = -1;

  ranges.forEach(range => {
    if (range.start >= lastEnd) {
      cleanRanges.push(range);
      lastEnd = range.end;
    }
  });

  return cleanRanges;
}

function renderGrammarLensText(text, items) {
  if (!grammarLensResult) return;

  const lang = sourceLangSelect.value;
  const ranges = getGrammarRanges(text, items, lang);

  if (!ranges.length) {
    grammarLensResult.innerHTML = `<p class="subtle">No grammar markers found yet.</p>`;
    return;
  }

  let html = "";
  let cursor = 0;

  ranges.forEach(range => {
    html += escapeHtml(text.slice(cursor, range.start));

    const markerText = text.slice(range.start, range.end);
    const item = range.item;

    html += `
      <span 
        class="grammar-token"
        data-article-id="${escapeHtml(item.articleId)}"
        data-short="${escapeHtml(item.shortExplanation || "")}"
        data-title="${escapeHtml(item.label || "")}"
      >${escapeHtml(markerText)}</span>
    `;

    cursor = range.end;
  });

  html += escapeHtml(text.slice(cursor));
  grammarLensResult.innerHTML = html;

  attachGrammarLensTokenListeners();
}

function attachGrammarLensTokenListeners() {
  const tokens = document.querySelectorAll(".grammar-token");

  tokens.forEach(token => {
    token.addEventListener("mouseenter", showGrammarTooltip);
    token.addEventListener("mousemove", moveGrammarTooltip);
    token.addEventListener("mouseleave", hideGrammarTooltip);

    token.addEventListener("click", async () => {
      const id = token.dataset.articleId;

      document.querySelectorAll(".grammar-token").forEach(el => {
        el.classList.remove("selected-token");
      });

      document.querySelectorAll(`.grammar-token[data-article-id="${id}"]`).forEach(el => {
        el.classList.add("selected-token");
      });

      grammarLensResult.classList.add("focus-mode");

      await openGrammarLensArticle(id);
    });
  });
}

function showGrammarTooltip(event) {
  hideGrammarTooltip();

  const tooltip = document.createElement("div");
  tooltip.className = "grammar-tooltip";

  const title = event.target.dataset.title || "";
  const short = event.target.dataset.short || "";

  tooltip.innerHTML = `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(short)}`;
  document.body.appendChild(tooltip);

  moveGrammarTooltip(event);
}

function moveGrammarTooltip(event) {
  const tooltip = document.querySelector(".grammar-tooltip");
  if (!tooltip) return;

  tooltip.style.left = `${event.pageX + 12}px`;
  tooltip.style.top = `${event.pageY + 12}px`;
}

function hideGrammarTooltip() {
  document.querySelectorAll(".grammar-tooltip").forEach(el => el.remove());
}

async function openGrammarLensArticle(articleId) {
  if (!grammarSidePanel) return;

  grammarSidePanel.innerHTML = `<p class="subtle">Loading explanation...</p>`;

  try {
    const response = await fetch(
  `${API_BASE}/api/grammar/${articleId}?lang=${sourceLangSelect.value}`
);

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Failed to load grammar article");
    }

    const examples = [];

    if (data.ex1_ch) examples.push({ text: data.ex1_ch, translation: data.ex1_py || "" });
    if (data.ex2_ch) examples.push({ text: data.ex2_ch, translation: data.ex2_py || "" });
    if (data.ex3_ch) examples.push({ text: data.ex3_ch, translation: data.ex3_py || "" });

    grammarSidePanel.innerHTML = `
      <h3>${escapeHtml(data.title || "")}</h3>
      <p>${escapeHtml(data.fullExplanation || "")}</p>

      <h4>Examples</h4>
      <ul>
        ${examples.map(ex => `
          <li>
            <div>${escapeHtml(ex.text)}</div>
            <div class="example-pinyin">${escapeHtml(ex.translation)}</div>
          </li>
        `).join("")}
      </ul>
    `;
  } catch (error) {
    console.error("Grammar Lens article error:", error);
    grammarSidePanel.innerHTML = `<p>Could not load explanation.</p>`;
  }
}

async function analyzeGrammarLensText() {
  const text = grammarLensInput?.value.trim();

  if (!text) {
    grammarLensResult.innerHTML = `<p class="subtle">Paste a text first.</p>`;
    return;
  }

  grammarLensResult.innerHTML = `<p class="subtle">Analyzing grammar...</p>`;

  try {
    const response = await fetch(`${API_BASE}/api/grammar`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        sentence: text,
        sourceLang: sourceLangSelect.value
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Grammar analysis failed");
    }

    renderGrammarLensText(text, data.items || []);
  } catch (error) {
    console.error("Grammar Lens error:", error);
    grammarLensResult.innerHTML = `<p>Grammar analysis failed.</p>`;
  }
}

grammarLensAnalyzeBtn?.addEventListener("click", analyzeGrammarLensText);

  //highlight grammar
function highlightGrammarInSentence(sentenceEl, items, lang) {
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
        if (target.includes(wordText)) {
          el.classList.add("grammar-highlight");
        }
      } else if (lang === "ru" || lang === "tr") {
        if (target.startsWith("-") && target.endsWith("-")) {
          const infix = target.slice(1, -1);
          if (wordText.includes(infix)) {
            el.classList.add("grammar-highlight");
          }
        } else if (target.startsWith("-")) {
          const suffix = target.slice(1);
          if (wordText.endsWith(suffix)) {
            el.classList.add("grammar-highlight");
          }
        } else {
          if (wordText === target) {
            el.classList.add("grammar-highlight");
          }
        }
      } else {
        if (wordText === target) {
          el.classList.add("grammar-highlight");
        }
      }
    });
  });
}

function removeExistingPopup() {
  document.querySelectorAll(".word-popup").forEach(el => el.remove());

  if (popupTimeout) {
    clearTimeout(popupTimeout);
    popupTimeout = null;
  }
}

//pop-up word-translation
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

  try {
    // 1. Try dictionary first
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
        <button class="popup-save-btn">＋ Save</button>
      `;
      const saveBtn = popup.querySelector(".popup-save-btn");
    saveBtn?.addEventListener("click", async () => {
      const translationText =
        popup.querySelector("div:last-of-type")?.textContent?.trim() || "";

      const saved = await addFlashcard({
        word,
        pinyin: py || pinyinText || "",
        sentence,
        sentencePinyin,
        translation: translationText,
        lang: sourceLangSelect.value
      });

     saveBtn.textContent = saved ? "✓ Saved" : "Already saved";
    });
      return;
    }

    // 2. Fallback to translator
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

    popup.innerHTML = `
      <strong>${escapeHtml(word)}</strong><br/>
      ${pinyinText ? `<div class="popup-pinyin">${escapeHtml(pinyinText)}</div>` : ""}
      <div>${escapeHtml(data.translation || "")}</div>
      <button class="popup-save-btn">＋ Save</button>
    `;
    const saveBtn = popup.querySelector(".popup-save-btn");
    saveBtn?.addEventListener("click", async () => {
      const translationText =
        popup.querySelector("div:last-of-type")?.textContent?.trim() || "";

      const saved = await addFlashcard({
        word,
        pinyin: pinyinText || "",
        sentence,
        sentencePinyin,
        translation: translationText,
        lang: sourceLangSelect.value
      });

      saveBtn.textContent = saved ? "✓ Saved" : "Already saved";
      });
  } catch (err) {
    popup.innerHTML = `
      <strong>${escapeHtml(word)}</strong><br/>
      ${pinyinText ? `<div class="popup-pinyin">${escapeHtml(pinyinText)}</div>` : ""}
      <div>Lookup failed</div>
      <button class="popup-save-btn">＋ Save</button>
    `;

    const saveBtn = popup.querySelector(".popup-save-btn");
    saveBtn?.addEventListener("click", async () => {
      const translationText =
        popup.querySelector("div:last-of-type")?.textContent?.trim() || "";

     const saved = await addFlashcard({
      word,
      pinyin: pinyinText || "",
      sentence,
      sentencePinyin,
      translation: "Lookup failed",
      lang: sourceLangSelect.value
    });

      saveBtn.textContent = saved ? "✓ Saved" : "Already saved";
    });
  }
  

  popupTimeout = setTimeout(() => {
      popup.remove();
      popupTimeout = null;
    }, 4000);
  }
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

    translationBox.textContent = data.translation;
  } catch (error) {
    console.error("Translation error:", error);
    translationBox.textContent = "Translation failed.";
  }
}

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
    playTTS(text);
  }
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

function stopSpeech() {
  speechSynthesis.cancel();
  currentUtterance = null;
  currentUtteranceText = "";
  currentUtteranceLang = "";
}

function stopRecognition() {
  if (currentRecognition) {
    currentRecognition.abort();
    currentRecognition = null;
  }
}

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
    if (actualWords[index] === word) {
      matches += 1;
    }
  });

  return Math.round((matches / expectedWords.length) * 100);
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) {
    matrix[i][0] = i;
  }

  for (let j = 0; j < cols; j++) {
    matrix[0][j] = j;
  }

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

  const score = Math.round((1 - distance / maxLength) * 100);
  return Math.max(0, score);
}

function compareText(expected, actual, lang) {
  const normalizedExpected = normalizeText(expected, lang);
  const normalizedActual = normalizeText(actual, lang);

  if (!normalizedExpected) {
    return { score: 0, message: "No target text found." };
  }

  let score = 0;

  if (lang.startsWith("zh")) {
    score = compareByEditDistance(normalizedExpected, normalizedActual);
  } else {
    score = compareByWords(normalizedExpected, normalizedActual);
  }

  let message = "Try again. Speak more slowly and clearly.";
  if (score === 100) {
    message = "Excellent! The sentence was recognized correctly.";
  } else if (score >= 70) {
    message = "Good job. Most of the sentence was recognized.";
  } else if (score >= 40) {
    message = "Almost there. Some words were recognized.";
  }

  return { score, message };
}

function record(sentence, card) {
  const resultBox = card.querySelector(".pronunciation-box");
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  console.log("Record button clicked");
  console.log("SpeechRecognition available:", !!SpeechRecognition);
  console.log("User agent:", navigator.userAgent);

  if (!SpeechRecognition) {
    resultBox.innerHTML = "Speech recognition is not supported in this browser.";
    return;
  }

  stopRecognition();
  stopSpeech();

  const recognition = new SpeechRecognition();
  currentRecognition = recognition;

  const lang = mapToSpeechLang(sourceLangSelect.value);
  recognition.lang = lang;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;

  console.log("Recognition object created");
  console.log("Recognition lang:", lang);

  resultBox.innerHTML = "Listening...";

  recognition.onstart = () => {
    console.log("recognition.onstart fired");
    resultBox.innerHTML = "Listening... (started)";
  };

  recognition.onaudiostart = () => {
    console.log("recognition.onaudiostart fired");
  };

  recognition.onsoundstart = () => {
    console.log("recognition.onsoundstart fired");
  };

  recognition.onspeechstart = () => {
    console.log("recognition.onspeechstart fired");
  };

  recognition.onresult = (event) => {
    console.log("recognition.onresult fired", event);

    const transcript = event.results[0][0].transcript || "";
    const result = compareText(sentence, transcript, lang);

    resultBox.innerHTML = `
      <p><strong>Recognized:</strong> ${escapeHtml(transcript)}</p>
      <p><strong>Accuracy:</strong> ${result.score}%</p>
      <p>${escapeHtml(result.message)}</p>
    `;
  };

  recognition.onerror = (event) => {
    console.log("recognition.onerror fired:", event.error);
    resultBox.innerHTML = `Recognition error: ${escapeHtml(event.error)}`;
  };

  recognition.onend = () => {
    console.log("recognition.onend fired");
    currentRecognition = null;
  };

  try {
    console.log("Calling recognition.start()");
    recognition.start();
    
  } catch (err) {
    console.log("recognition.start() threw:", err);
    resultBox.innerHTML = "Could not start recognition.";
  }
}


function playTTS(text) {
  if (!text) return;

  const lang = mapToSpeechLang(sourceLangSelect.value);

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.9;

  speechSynthesis.speak(utterance);
}

async function grammar(sentence, card) {
  const resultBox = card.querySelector(".grammar-box");

  try {
    resultBox.innerHTML = "Analyzing grammar...";

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
        <h4>Grammar in this sentence</h4>
        <ul class="grammar-list">
          ${data.items.map(item => `
            <li class="grammar-item" data-id="${item.articleId}">
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
    resultBox.innerHTML = "Grammar analysis failed.";
    return { items: [] };
  }
}

loadFlashcardsFromStorage().then(() => {
  renderDeckSelector();
  renderFlashcards();
});
//attach cardlisteners
document.getElementById("flashcardCard")?.addEventListener("click", flipFlashcard);
document.getElementById("flashcardNextBtn")?.addEventListener("click", goToNextFlashcard);
document.getElementById("flashcardPrevBtn")?.addEventListener("click", goToPrevFlashcard);
document.getElementById("flashcardDeleteBtn")?.addEventListener("click", deleteCurrentFlashcard);
document.getElementById("flashcardClearBtn")?.addEventListener("click", clearFlashcards);

const speedBtn = document.getElementById("ttsSpeedToggle");

speedBtn?.addEventListener("click", () => {
  ttsSlowMode = !ttsSlowMode;
  stopAllTTS();
  speedBtn.textContent = ttsSlowMode ? "🐢 Slow ON" : "⚡ Normal";
});

document.getElementById("readFullTextBtn")?.addEventListener("click", async () => {
  const contentEl = document.getElementById("fullTextContent");
  if (!contentEl) return;

  const text = contentEl.dataset.fullSentence || contentEl.textContent.trim();
  if (!text) return;

  const cleanText = await prepareTTSInput(text, sourceLangSelect.value);
  stopAllTTS();
  await playGoogleTTS(cleanText, sourceLangSelect.value);
});

document.getElementById("fullTextSlowBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  ttsSlowMode = !ttsSlowMode;
  stopAllTTS();

  document.getElementById("fullTextSlowBtn").textContent =
    ttsSlowMode ? "🐢 Slow: ON" : "🐢 Slow: OFF";
});

document.getElementById("translateFullTextBtn")?.addEventListener("click", async () => {
  const contentEl = document.getElementById("fullTextContent");
  const translationEl = document.getElementById("fullTextTranslation");

  if (!contentEl || !translationEl) return;

  const text = contentEl.dataset.fullSentence || contentEl.textContent.trim();
  if (!text) return;

  try {
    translationEl.textContent = "Translating...";

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

    translationEl.textContent = data.translation || "";
  } catch (error) {
    console.error("Full text translation error:", error);
    translationEl.textContent = "Translation failed.";
  }
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

document.getElementById("flashcardSlowBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  ttsSlowMode = !ttsSlowMode;
  stopAllTTS();
  document.getElementById("flashcardSlowBtn").textContent =
    ttsSlowMode ? "🐢 Slow: ON" : "🐢 Slow: OFF";
});

document.getElementById("flashcardDeckSelect")?.addEventListener("change", (e) => {
  currentDeckId = e.target.value;
  currentFlashcardIndex = 0;
  renderFlashcards();
});

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

  if (exportResult) {
    exportResult.textContent = "Creating printable deck...";
  }

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

document.getElementById("flashcardNewDeckBtn")?.addEventListener("click", createDeck);
document.getElementById("flashcardDeleteDeckBtn")?.addEventListener("click", deleteCurrentDeck);
document.getElementById("flashcardExportBtn")?.addEventListener("click", exportCurrentDeck);

document.getElementById("checkFullTextGrammarBtn")?.addEventListener("click", async () => {
  const contentEl = document.getElementById("fullTextContent");
  const text =
    contentEl?.dataset.fullSentence ||
    contentEl?.textContent.trim() ||
    inputText.value.trim();

  if (!text) {
    alert("Please create or paste a text first.");
    return;
  }

  showScreen(document.getElementById("screen-grammar"));

  document.querySelectorAll(".nav-link").forEach(link => {
    link.classList.toggle("active", link.dataset.screen === "grammar");
  });

  if (grammarLensInput) {
    grammarLensInput.value = text;
  }

  await loadGrammarScreen();
  await analyzeGrammarLensText();
});

//attach wordlisteners
function attachWordListeners(sentenceEl) {
  const wordEls = sentenceEl.querySelectorAll(".word");
  const sentenceText =
  sentenceEl.dataset.fullSentence || sentenceEl.textContent.trim();
  const sentencePinyin = buildSentencePinyinFromWords(sentenceEl);

  wordEls.forEach(wordEl => {
    if (wordEl.dataset.listenerAttached === "true") {
      return;
    }

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



function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}