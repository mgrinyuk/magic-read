# Reader Screen Integration Prompt

You are integrating the new Reader and Speak screens from two handoff mockups (`reader.html` and `speak-spotlight.html`) into the existing Magic Read app (`frontend/index.html`, `frontend/style.css`, `frontend/app.js`).

**Read these files before making any change:**
- `reader.html` — the full Reader handoff (setup → reader → exercises)
- `speak-spotlight.html` — the full Speak handoff (setup → practice → complete)
- `frontend/index.html` — existing app HTML
- `frontend/style.css` — existing app CSS (reader classes start at line ~5241, speak classes at ~5040)
- `frontend/app.js` — existing app JS (reader logic starts at line ~3061)

The app uses `appMode` (`"reading"` or `"pronunciation"`) to decide which flow to launch after the user submits text via `startReadingFromText()`. All classes use the `rd-` (reader) and `sp-` (speak) prefixes, and all icon `<use href="">` references use the `#sonic-i-*` prefix.

---

## What's missing / broken (study the gap before touching code)

1. **No Reader Setup screen** — the handoff has a dedicated `#read-setup` app-screen with Paste / Library / Saved tabs and a card-grid library. The app currently uses `#screen-main` (old composer) as setup.
2. **No Speak Setup screen** — the handoff has a dedicated `#speak-setup` app-screen. The app currently uses `#screen-main` for both modes.
3. **Level badge missing** in `#screen-read-reader` toolbar.
4. **No bottom sheets in reader** — the word-tap sheet and voice-picker sheet are absent from `#screen-read-reader`'s HTML.
5. **Word tap uses the old popup** instead of the new inline word sheet.
6. **Voice pill opens the global voice picker** instead of the new inline voice sheet.
7. **Bookmark only adds `.on`**, never removes it; visually doesn't fully match handoff.
8. **Exercises borrow old DOM panels** (`#readingExercise`, `#wordOrderExercise` from `#screen-main`) instead of the self-contained exercise UI shown in the handoff.
9. **Missing CSS** for the new setup cards, bottom sheets, level badge, and self-contained exercise components.

---

## Step 1 — Add the Reader Setup screen to `index.html`

Insert a new `<section>` **before** `#screen-read-reader`:

```html
<!-- ===================== READER · SETUP ===================== -->
<section id="screen-read-setup" class="app-screen">
  <div class="rd-setup-scroll">
    <div class="rd-setup-eyebrow">Magic Read</div>
    <div class="rd-setup-h1">What would you like<br>to read today?</div>

    <div class="rd-setup-seg" id="rdSetupSeg">
      <button class="rd-setup-seg-btn" data-tab="paste">Paste text</button>
      <button class="rd-setup-seg-btn on" data-tab="library">Library</button>
      <button class="rd-setup-seg-btn" data-tab="saved">Saved</button>
    </div>

    <!-- Paste tab -->
    <div id="rdSetupPasteTab" class="rd-setup-tab" hidden>
      <textarea id="rdSetupInput" class="rd-setup-textarea"
        placeholder="Paste a Chinese text here — an article, a chat, song lyrics or homework. We'll add pinyin, audio and word lookups automatically."></textarea>
      <div class="rd-setup-charcount"><span id="rdSetupCharCount">0</span> / 2000 characters</div>
    </div>

    <!-- Library tab -->
    <div id="rdSetupLibraryTab" class="rd-setup-libgrid rd-setup-tab"></div>

    <!-- Saved tab -->
    <div id="rdSetupSavedTab" class="rd-setup-savedlist rd-setup-tab" hidden></div>
  </div>

  <div class="rd-setup-footer">
    <button class="rd-setup-start-btn" id="rdSetupStartBtn" type="button">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <use href="#sonic-i-book"/>
      </svg>
      <span id="rdSetupStartLabel">Start reading</span>
    </button>
  </div>
</section>
```

**Rules:**
- The `#rdSetupLibraryTab` div will be populated with `.rd-libcard` tiles by JS.
- The `#rdSetupSavedTab` div will be populated with `.rd-savedrow` rows by JS.
- The "Paste text" tab is a textarea, NOT the old `#inputText` composer — it's a separate element.

---

## Step 2 — Add level badge to `#screen-read-reader` toolbar

In `index.html`, inside `#screen-read-reader`'s `.rd-toolbar` div, add the level badge **after** the voice pill:

```html
<span class="rd-lvl" id="rdLevel" hidden>A2</span>
```

---

## Step 3 — Add bottom sheets to `#screen-read-reader`

At the **end** of `#screen-read-reader`, just before the closing `</section>`, add:

```html
<!-- reader bottom sheets -->
<div class="rd-scrim" id="rdScrim"></div>

<div class="rd-sheet" id="rdVoiceSheet">
  <div class="rd-grab"></div>
  <div class="rd-sheet-title">Choose a voice</div>
  <div class="rd-sheet-sub">Pick the narrator for text-to-speech.</div>
  <div id="rdVoiceList" class="rd-voice-list"></div>
</div>

<div class="rd-sheet" id="rdWordSheet">
  <div class="rd-grab"></div>
  <div class="rd-word-header">
    <div class="rd-word-left">
      <div class="rd-word-hz zh" id="rdWordHz"></div>
      <div class="rd-word-py" id="rdWordPy"></div>
    </div>
    <button class="rd-iconbtn" id="rdWordTtsBtn" type="button" aria-label="Listen">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--cyan)"
           stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <use href="#sonic-i-vol"/>
      </svg>
    </button>
    <div style="flex:1"></div>
    <button class="rd-word-save-btn" id="rdWordSaveBtn" type="button"></button>
  </div>
  <div class="rd-word-divider"></div>
  <span class="rd-word-pos" id="rdWordPos"></span>
  <div class="rd-word-en" id="rdWordEn"></div>
</div>
```

---

## Step 4 — Add the Speak Setup screen to `index.html`

Insert a new `<section>` **before** `#screen-speak-practice`:

```html
<!-- ===================== SPEAK · SETUP ===================== -->
<section id="screen-speak-setup" class="app-screen">
  <div class="sp-setup-body">
    <div class="sp-setup-seg">
      <span class="sp-setup-seg-btn on" id="spSetupLibraryBtn">Library</span>
      <span class="sp-setup-seg-btn" id="spSetupMyTextsBtn">My texts</span>
    </div>
    <div class="sp-eyebrow" style="margin-top:28px">Magic Read</div>
    <div class="sp-h1" style="margin-top:8px">Practice pronunciation<br>with your own texts</div>
    <div class="sp-sub" style="margin-top:12px">Paste homework, a dialogue or an exam text. We split it into sentences and coach you one at a time.</div>
    <textarea id="spSetupInput" class="sp-setup-textarea"
      placeholder="Paste a text to start…"></textarea>
    <button class="sp-btn sp-btn-primary sp-setup-start" id="spSetupStartBtn" type="button">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <use href="#sonic-i-mic"/>
      </svg>
      Start speaking
    </button>
    <div class="sp-setup-hint">4 sentences · about 2 minutes</div>
  </div>
</section>
```

---

## Step 5 — Add CSS to `style.css`

Append all of the following **at the end** of `style.css`, after the existing `.rd-*` and `.sp-*` blocks. Do not remove or overwrite anything already there.

```css
/* ================================================================
   READER · SETUP SCREEN
   ================================================================ */
#screen-read-setup { background: var(--shell, #f4f5f9); }
.rd-setup-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 30px 28px 24px; }
.rd-setup-scroll::-webkit-scrollbar { width: 0; }
.rd-setup-eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .14em; color: var(--primary); text-transform: uppercase; }
.rd-setup-h1 { font-size: 28px; font-weight: 800; line-height: 1.12; letter-spacing: -.01em; margin-top: 8px; }
.rd-setup-seg { display: flex; gap: 6px; background: var(--lav, #ECEAF3); border-radius: 14px; padding: 5px; margin-top: 24px; }
.rd-setup-seg-btn { flex: 1; border: none; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 14px; padding: 10px 0; border-radius: 10px; background: transparent; color: var(--text-soft); }
.rd-setup-seg-btn.on { background: #fff; color: var(--primary); box-shadow: 0 2px 6px rgba(28,18,51,.08); }
.rd-setup-tab { margin-top: 20px; }
.rd-setup-textarea { width: 100%; background: #fff; border: 1.5px solid var(--border); border-radius: 16px; padding: 18px; min-height: 200px; font-family: inherit; font-size: 16px; line-height: 1.6; color: var(--text); resize: none; outline: none; }
.rd-setup-textarea::placeholder { color: var(--text-dim); }
.rd-setup-charcount { text-align: right; margin-top: 8px; font-size: 13px; color: var(--text-dim); }
.rd-setup-libgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rd-libcard { border: 1.5px solid var(--border); background: #fff; border-radius: 16px; overflow: hidden; cursor: pointer; font-family: inherit; text-align: left; padding: 0; transition: border-color .15s; }
.rd-libcard.sel { border: 2px solid var(--primary); box-shadow: 0 10px 24px -14px rgba(229,38,126,.6); }
.rd-libcard:hover { border-color: var(--primary); }
.rd-libthumb { height: 72px; display: grid; place-items: center; }
.rd-libthumb-glyph { font-weight: 900; font-size: 30px; color: #fff; font-family: 'Noto Sans SC', sans-serif; }
.rd-libcard-body { padding: 12px 13px; }
.rd-libcard-title { font-family: 'Noto Sans SC', sans-serif; font-weight: 700; font-size: 16px; }
.rd-libcard-sub { font-size: 12px; color: var(--text-soft); margin-top: 2px; }
.rd-libcard-meta { display: flex; gap: 6px; margin-top: 9px; align-items: center; }
.rd-libcard-level { font-size: 11px; font-weight: 700; color: var(--cyan-ink); background: rgba(10,180,214,.12); padding: 3px 8px; border-radius: 6px; }
.rd-libcard-len { font-size: 11px; color: var(--text-dim); padding: 3px 4px; }
.rd-setup-savedlist { display: flex; flex-direction: column; gap: 10px; }
.rd-savedrow { display: flex; gap: 13px; align-items: center; border: 1.5px solid var(--border); background: #fff; border-radius: 16px; padding: 14px; cursor: pointer; font-family: inherit; width: 100%; text-align: left; }
.rd-savedrow.sel { border: 2px solid var(--primary); }
.rd-savedrow-thumb { width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; flex: none; align-self: flex-start; }
.rd-savedrow-thumb-glyph { font-weight: 900; font-size: 22px; color: #fff; font-family: 'Noto Sans SC', sans-serif; }
.rd-savedrow-body { flex: 1; min-width: 0; }
.rd-savedrow-title { font-family: 'Noto Sans SC', sans-serif; font-weight: 700; font-size: 16px; }
.rd-savedrow-sub { font-size: 12px; color: var(--text-soft); margin: 2px 0 8px; }
.rd-savedrow-bar { height: 6px; border-radius: 99px; background: var(--lav, #ECEAF3); overflow: hidden; }
.rd-savedrow-bar-fill { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, var(--primary), var(--primary-soft)); }
.rd-savedrow-pct { font-size: 13px; font-weight: 700; color: var(--primary); align-self: flex-start; }
.rd-setup-footer { padding: 14px 28px 20px; border-top: 1px solid var(--border); background: var(--shell, #f4f5f9); }
.rd-setup-start-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; height: 58px; border: none; cursor: pointer; font-family: inherit; font-weight: 700; font-size: 17px; border-radius: 16px; color: #fff; background: linear-gradient(95deg, var(--primary), var(--primary-soft)); box-shadow: 0 12px 26px -12px rgba(229,38,126,.7); }
.rd-setup-start-btn:hover { filter: brightness(1.04); }

/* Level badge in toolbar */
.rd-lvl { margin-left: auto; font-size: 12px; font-weight: 700; color: var(--cyan-ink); background: rgba(10,180,214,.12); border: 1px solid rgba(10,180,214,.4); padding: 7px 11px; border-radius: 11px; }

/* ================================================================
   READER · BOTTOM SHEETS
   ================================================================ */
.rd-scrim { position: absolute; inset: 0; background: rgba(28,18,51,.35); z-index: 20; display: none; }
.rd-scrim.open { display: block; animation: rdFadeIn .2s ease; }
.rd-sheet { position: absolute; left: 0; right: 0; bottom: 0; background: #fff; border-radius: 22px 22px 0 0;
            padding: 22px 24px 32px; z-index: 21; display: none;
            box-shadow: 0 -20px 50px -20px rgba(28,18,51,.4); }
.rd-sheet.open { display: block; animation: rdSheetUp .28s cubic-bezier(.2,.85,.3,1); }
.rd-grab { width: 42px; height: 5px; border-radius: 99px; background: var(--border); margin: 0 auto 16px; }
.rd-sheet-title { font-size: 18px; font-weight: 800; }
.rd-sheet-sub { font-size: 13px; color: var(--text-soft); margin: 4px 0 16px; }

/* Voice list rows */
.rd-voice-list { display: flex; flex-direction: column; gap: 8px; }
.rd-vrow { display: flex; align-items: center; gap: 13px; padding: 12px 14px; border-radius: 14px; cursor: pointer; border: 1.5px solid var(--border); background: #fff; }
.rd-vrow.sel { border-color: var(--primary); background: rgba(229,38,126,.05); }
.rd-vava { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; flex: none; color: #fff; font-weight: 700; font-size: 18px; font-family: 'Noto Sans SC', sans-serif; }
.rd-vrow-info { flex: 1; }
.rd-vrow-name { font-weight: 700; font-size: 15px; }
.rd-vrow-tag { font-size: 12px; color: var(--text-soft); }

/* Word sheet */
.rd-word-header { display: flex; align-items: flex-start; gap: 16px; }
.rd-word-left { flex: 1; }
.rd-word-hz { font-size: 40px; font-weight: 700; color: var(--cyan-ink); line-height: 1; }
.rd-word-py { font-size: 15px; color: var(--text-soft); font-weight: 600; margin-top: 6px; }
.rd-word-divider { margin: 16px 0; border-top: 1px solid var(--surface-2, #F1F2F8); }
.rd-word-pos { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-dim); background: var(--surface-2, #F1F2F8); padding: 3px 9px; border-radius: 6px; }
.rd-word-en { font-size: 19px; font-weight: 700; margin-top: 12px; }
.rd-word-save-btn { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: 13px; font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer; border: 1px solid rgba(245,180,0,.5); background: rgba(245,180,0,.14); color: var(--amber-ink, #B98300); }
.rd-word-save-btn.saved { border-color: rgba(22,163,74,.5); background: rgba(22,163,74,.12); color: var(--good); }

@keyframes rdFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes rdSheetUp { from { transform: translateY(110%); } to { transform: translateY(0); } }

/* ================================================================
   READER · SELF-CONTAINED EXERCISES
   ================================================================ */
.rd-excard { background: #fff; border: 1px solid var(--border); border-radius: 20px; padding: 22px; }
.rd-extag { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--primary); background: rgba(229,38,126,.10); padding: 3px 9px; border-radius: 6px; }
.rd-extitle { font-size: 16px; font-weight: 800; margin-left: 8px; }
.rd-exdesc { font-size: 14px; color: var(--text-soft); margin: 10px 0 18px; }
.rd-slots { display: flex; flex-wrap: wrap; gap: 9px; padding: 16px; border: 1.5px dashed var(--border); border-radius: 14px; background: var(--surface-2, #F1F2F8); min-height: 70px; }
.rd-slots.wrong { animation: rdShake .4s ease; }
.rd-slot { height: 44px; padding: 0 16px; border-radius: 11px; border: 1px solid var(--border); background: #fff; color: var(--text); cursor: pointer; font-family: 'Noto Sans SC', sans-serif; font-size: 19px; font-weight: 700; }
.rd-slot.empty { min-width: 56px; border: 1.5px dashed #B9B4C7; background: transparent; cursor: default; }
.rd-bank { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 16px; }
.rd-chip { height: 44px; padding: 0 16px; border-radius: 11px; border: 1px solid var(--border); background: #fff; color: var(--primary); cursor: pointer; font-family: 'Noto Sans SC', sans-serif; font-size: 19px; font-weight: 700; }
.rd-chip.used { opacity: .32; pointer-events: none; }
.rd-exfb { margin-top: 16px; padding: 12px 14px; border-radius: 12px; font-size: 14px; font-weight: 700; }
.rd-exfb.ok { background: rgba(22,163,74,.10); color: var(--good); }
.rd-exfb.no { background: rgba(220,38,38,.08); color: var(--bad); }
.rd-exrow { display: flex; align-items: center; gap: 14px; margin-top: 18px; }
.rd-excheck { flex: 1; height: 50px; border: none; cursor: pointer; font-family: inherit; font-size: 15px; font-weight: 700; border-radius: 16px; display: flex; align-items: center; justify-content: center; gap: 8px; color: #fff; background: linear-gradient(95deg, var(--primary), var(--primary-soft)); box-shadow: 0 12px 26px -12px rgba(229,38,126,.7); }
.rd-excheck:disabled { background: #C9C4D4; box-shadow: none; cursor: default; }
.rd-exskip { background: none; border: none; font-family: inherit; font-size: 14px; font-weight: 600; color: var(--text-soft); cursor: pointer; }
.rd-cloze-sent { background: var(--surface-2, #F1F2F8); border-radius: 14px; padding: 20px 18px; font-size: 24px; font-weight: 500; line-height: 1.7; font-family: 'Noto Sans SC', sans-serif; }
.rd-cloze-hint { font-size: 13px; color: var(--text-dim); margin-top: 8px; }
.rd-opts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
.rd-opt { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 14px 0; border-radius: 14px; cursor: pointer; font-family: inherit; border: 1.5px solid var(--border); background: #fff; color: var(--text); }
.rd-opt .rd-opt-py { font-size: 12px; font-weight: 500; opacity: .7; margin-top: 2px; }
.rd-opt.sel { border-color: var(--primary); background: rgba(229,38,126,.06); color: var(--primary); }
.rd-opt.correct { border-color: var(--good); background: rgba(22,163,74,.10); color: var(--good); }
.rd-opt.wrong { border-color: var(--bad); background: rgba(220,38,38,.07); color: var(--bad); }

@keyframes rdShake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-6px)} 40%,80%{transform:translateX(6px)} }

/* ================================================================
   SPEAK · SETUP SCREEN
   ================================================================ */
.sp-setup-body { flex: 1; display: flex; flex-direction: column; padding: 34px 28px 24px; gap: 0; overflow-y: auto; }
.sp-setup-seg { display: inline-flex; align-self: flex-start; background: var(--surface-2, #ECEAF3); border-radius: 999px; padding: 5px; gap: 0; }
.sp-setup-seg-btn { font-weight: 700; font-size: 15px; padding: 9px 22px; border-radius: 999px; color: var(--text-soft); cursor: pointer; user-select: none; }
.sp-setup-seg-btn.on { background: #fff; color: var(--primary); box-shadow: 0 2px 6px rgba(25,26,51,.08); }
.sp-setup-textarea { width: 100%; background: var(--surface-2, #ECEAF3); border: 2px solid var(--surface-2, #ECEAF3); border-radius: 20px; padding: 20px; min-height: 180px; font-family: inherit; font-size: 16px; line-height: 1.6; color: var(--text); resize: none; outline: none; margin-top: 24px; }
.sp-setup-textarea::placeholder { color: var(--text-dim); }
.sp-setup-start { margin-top: 24px; width: 100%; }
.sp-setup-hint { text-align: center; color: var(--text-dim); font-size: 14px; margin-top: 14px; }
```

---

## Step 6 — Wire up the Reader Setup screen in `app.js`

Add the following block anywhere after the reader state is declared (around line 3064). **Do not remove any existing reader logic** — the setup screen is new, not a replacement.

```js
/* ============================================================
   READER SETUP  (new card-grid setup screen)
   ============================================================ */

// Library data (mirrors the Supabase library list used in #screen-main).
// We reuse the same `libraryCache` and `fetchLibraryTexts()` that already exist.
// Saved texts also reuse the existing `loadSavedTexts()` mechanism.

const rdSetupState = {
  tab: 'library',        // 'paste' | 'library' | 'saved'
  sel: { kind: 'library', id: null, title: '', text: '' },
};

function rdSetupInit() {
  const seg = document.getElementById('rdSetupSeg');
  if (!seg || seg.dataset.rdSetupInited) return;
  seg.dataset.rdSetupInited = '1';

  // Tab switching
  seg.querySelectorAll('.rd-setup-seg-btn').forEach(btn => {
    btn.addEventListener('click', () => rdSetupSetTab(btn.dataset.tab));
  });

  // Char counter on paste tab
  document.getElementById('rdSetupInput')?.addEventListener('input', e => {
    document.getElementById('rdSetupCharCount').textContent = e.target.value.length;
  });

  // Start button
  document.getElementById('rdSetupStartBtn')?.addEventListener('click', rdSetupStart);
}

function rdSetupSetTab(tab) {
  rdSetupState.tab = tab;
  const seg = document.getElementById('rdSetupSeg');
  seg?.querySelectorAll('.rd-setup-seg-btn').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.getElementById('rdSetupPasteTab').hidden  = tab !== 'paste';
  document.getElementById('rdSetupLibraryTab').hidden = tab !== 'library';
  document.getElementById('rdSetupSavedTab').hidden  = tab !== 'saved';

  if (tab === 'library') rdSetupLoadLibrary();
  if (tab === 'saved')   rdSetupLoadSaved();
  rdSetupUpdateStartLabel();
}

function rdSetupUpdateStartLabel() {
  const label = document.getElementById('rdSetupStartLabel');
  if (!label) return;
  if (rdSetupState.tab === 'paste') {
    label.textContent = 'Start reading';
  } else {
    const title = rdSetupState.sel.title;
    label.textContent = title ? `Start reading · ${title}` : 'Start reading';
  }
}

async function rdSetupLoadLibrary() {
  const grid = document.getElementById('rdSetupLibraryTab');
  if (!grid) return;
  grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">Loading…</p>';

  // Reuse the same library fetch as screen-main.
  const lang = sourceLangSelect?.value || 'zh';
  try {
    if (libraryCache[lang]) {
      rdSetupRenderLibrary(libraryCache[lang]);
      return;
    }
    const res = await fetchWithAuth(`${API_BASE}/api/library?lang=${lang}`);
    const data = await res.json();
    const texts = res.ok ? (data.texts || []) : [];
    libraryCache[lang] = texts;
    rdSetupRenderLibrary(texts);
  } catch {
    grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">Could not load library.</p>';
  }
}

function rdSetupRenderLibrary(texts) {
  const grid = document.getElementById('rdSetupLibraryTab');
  if (!grid) return;
  if (!texts.length) { grid.innerHTML = '<p class="rd-loading" style="padding:12px 0">No texts yet.</p>'; return; }

  // Colour palette cycles through 4 brand colours.
  const hues = ['#E5267E', '#0AB4D6', '#F5B400', '#16A34A'];
  grid.innerHTML = texts.map((t, i) => {
    const hue = hues[i % hues.length];
    const glyph = (t.title || '文')[0];
    const sel = rdSetupState.sel.id === t.id && rdSetupState.sel.kind === 'library';
    return `<button class="rd-libcard${sel ? ' sel' : ''}" data-lib-id="${escapeHtml(t.id)}" type="button">
      <div class="rd-libthumb" style="background:linear-gradient(135deg,${hue},rgba(28,18,51,.25))">
        <span class="rd-libthumb-glyph">${escapeHtml(glyph)}</span>
      </div>
      <div class="rd-libcard-body">
        <div class="rd-libcard-title">${escapeHtml(t.title || 'Untitled')}</div>
        <div class="rd-libcard-sub">${escapeHtml(t.subtitle || '')}</div>
        <div class="rd-libcard-meta">
          ${t.level ? `<span class="rd-libcard-level">${escapeHtml(t.level)}</span>` : ''}
          ${t.char_count ? `<span class="rd-libcard-len">${t.char_count} 字</span>` : ''}
        </div>
      </div>
    </button>`;
  }).join('');

  grid.querySelectorAll('.rd-libcard').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.dataset.libId;
      const t = texts.find(x => x.id === id);
      if (!t) return;
      rdSetupState.sel = { kind: 'library', id, title: t.title || '', text: '' };
      rdSetupState._libText = t; // keep reference for loading
      grid.querySelectorAll('.rd-libcard').forEach(c => c.classList.toggle('sel', c.dataset.libId === id));
      rdSetupUpdateStartLabel();
    });
  });

  // Pre-select first if nothing selected.
  if (!rdSetupState.sel.id && texts.length) {
    rdSetupState.sel = { kind: 'library', id: texts[0].id, title: texts[0].title || '', text: '' };
    rdSetupState._libText = texts[0];
    grid.querySelector('.rd-libcard')?.classList.add('sel');
    rdSetupUpdateStartLabel();
  }
}

async function rdSetupLoadSaved() {
  const list = document.getElementById('rdSetupSavedTab');
  if (!list) return;
  list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Loading…</p>';
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) { list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Log in to see saved texts.</p>'; return; }
    const res = await fetchWithAuth(`${API_BASE}/api/saved-texts`);
    const data = await res.json();
    const items = res.ok ? (data.texts || []) : [];
    rdSetupRenderSaved(items);
  } catch {
    list.innerHTML = '<p class="rd-loading" style="padding:12px 0">Could not load saved texts.</p>';
  }
}

function rdSetupRenderSaved(items) {
  const list = document.getElementById('rdSetupSavedTab');
  if (!list) return;
  if (!items.length) { list.innerHTML = '<p class="rd-loading" style="padding:12px 0">No saved texts yet.</p>'; return; }
  list.innerHTML = items.map(t => {
    const glyph = (t.title || '文')[0];
    const pct = t.progress_pct || 0;
    const sel = rdSetupState.sel.id === t.id && rdSetupState.sel.kind === 'saved';
    return `<button class="rd-savedrow${sel ? ' sel' : ''}" data-saved-id="${escapeHtml(t.id)}" type="button">
      <div class="rd-savedrow-thumb" style="background:linear-gradient(135deg,var(--cyan),var(--cyan-ink))">
        <span class="rd-savedrow-thumb-glyph">${escapeHtml(glyph)}</span>
      </div>
      <div class="rd-savedrow-body">
        <div class="rd-savedrow-title">${escapeHtml(t.title || 'Untitled')}</div>
        <div class="rd-savedrow-sub">${escapeHtml(t.subtitle || t.lang || '')}</div>
        <div class="rd-savedrow-bar"><i class="rd-savedrow-bar-fill" style="width:${pct}%"></i></div>
      </div>
      <div class="rd-savedrow-pct">${pct}%</div>
    </button>`;
  }).join('');

  list.querySelectorAll('.rd-savedrow').forEach(row => {
    row.addEventListener('click', () => {
      const id = row.dataset.savedId;
      const t = items.find(x => x.id === id);
      if (!t) return;
      rdSetupState.sel = { kind: 'saved', id, title: t.title || '', text: t.text || '' };
      list.querySelectorAll('.rd-savedrow').forEach(r => r.classList.toggle('sel', r.dataset.savedId === id));
      rdSetupUpdateStartLabel();
    });
  });
}

async function rdSetupStart() {
  const startBtn = document.getElementById('rdSetupStartBtn');
  if (startBtn) { startBtn.disabled = true; startBtn.style.opacity = '.7'; }

  try {
    if (rdSetupState.tab === 'paste') {
      const text = document.getElementById('rdSetupInput')?.value || '';
      if (!text.trim()) { showToast('Paste a text first.', 'error'); return; }
      currentTextId = null;
      currentTextTitle = '';
      // Force reading mode.
      appMode = 'reading';
      await startReadingFromText(text);

    } else if (rdSetupState.tab === 'library') {
      if (!rdSetupState.sel.id) { showToast('Pick a text first.', 'error'); return; }
      const t = rdSetupState._libText;
      if (!t) return;
      currentTextId = `lib_${t.id}`;
      currentTextTitle = t.title || '';
      appMode = 'reading';
      // Load full text from API (same as the existing library flow in screen-main).
      showMagicLoadingOverlay?.();
      const res = await fetchWithAuth(`${API_BASE}/api/library/${t.id}`);
      const data = await res.json();
      if (!res.ok || !data.text) { showToast('Could not load this text.', 'error'); return; }
      // Level badge: store for rdUpdateToolbar.
      rdSetupState._level = data.level || t.level || '';
      await startReadingFromText(data.text);

    } else if (rdSetupState.tab === 'saved') {
      if (!rdSetupState.sel.id || !rdSetupState.sel.text) { showToast('Pick a text first.', 'error'); return; }
      currentTextId = rdSetupState.sel.id;
      currentTextTitle = rdSetupState.sel.title;
      appMode = 'reading';
      rdSetupState._level = '';
      await startReadingFromText(rdSetupState.sel.text);
    }
  } finally {
    if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = ''; }
  }
}
```

**Navigation wiring:** Update the Read tab click handler (look for where `"screen-main"` or `screenMain` is shown when the Read tab is clicked) to instead show `#screen-read-setup` when `appMode === "reading"`. Add this to `rdSetupInit()` call in the app's init block:

```js
// Call rdSetupInit once the DOM is ready (add near bottom of app.js, or in DOMContentLoaded).
rdSetupInit();
```

Also update the tab bar Read button so clicking it calls:
```js
showScreen(document.getElementById('screen-read-setup'));
rdSetupSetTab('library');
rdSetupLoadLibrary();
```

---

## Step 7 — Update `rdUpdateToolbar()` in `app.js`

Find `rdUpdateToolbar()` (around line 3188) and add:

```js
// Level badge
const lvl = document.getElementById('rdLevel');
if (lvl) {
  const level = rdSetupState?._level || '';
  lvl.textContent = level;
  lvl.hidden = !level;
}
// Show the actual selected voice name, not just "Voice ✓"
const voiceName = document.getElementById('rdVoiceName');
if (voiceName) {
  const v = getSelectedVoice(R.lang);
  voiceName.textContent = v ? v.name.split(' · ')[0] : 'Voice';
}
```

---

## Step 8 — Add inline voice sheet logic in `app.js`

Replace the existing `rdVoicePill` click handler with the new sheet-based one. Find and replace the block that calls `openVoicePicker()` on `rdVoicePill` click:

```js
// OLD (remove this):
document.getElementById("rdVoicePill")?.addEventListener("click", () => {
  sourceLangSelect.value = R.lang;
  openVoicePicker();
});

// NEW:
document.getElementById("rdVoicePill")?.addEventListener("click", () => rdOpenSheet('voice'));
```

Add these new functions (anywhere near the reader init block):

```js
/* Reader sheet open/close */
function rdOpenSheet(which) {
  document.getElementById('rdScrim')?.classList.add('open');
  document.getElementById('rdVoiceSheet')?.classList.toggle('open', which === 'voice');
  document.getElementById('rdWordSheet')?.classList.toggle('open', which === 'word');
  if (which === 'voice') rdRenderVoiceSheet();
}
function rdCloseSheet() {
  document.getElementById('rdScrim')?.classList.remove('open');
  document.getElementById('rdVoiceSheet')?.classList.remove('open');
  document.getElementById('rdWordSheet')?.classList.remove('open');
  // Clear selected word highlight.
  document.querySelectorAll('#rdHan .rd-word.rd-word-sel').forEach(el => el.classList.remove('rd-word-sel'));
}

document.getElementById('rdScrim')?.addEventListener('click', rdCloseSheet);

/* Voice list rendering */
// VOICES_RD: define the same voice list used elsewhere in the app.
// Each entry: { key: string, initial: string, name: string, tag: string, color: string }
// Pull from whichever VOICES constant already exists in app.js, or define one here.
function rdRenderVoiceSheet() {
  const list = document.getElementById('rdVoiceList');
  if (!list) return;
  const voices = getRdVoices(R.lang);   // implement getRdVoices() below
  const currentKey = getSelectedVoice(R.lang)?.key || '';
  list.innerHTML = voices.map(v => `
    <button class="rd-vrow${v.key === currentKey ? ' sel' : ''}" data-voice-key="${escapeHtml(v.key)}" type="button">
      <div class="rd-vava" style="background:${v.color}">${v.initial}</div>
      <div class="rd-vrow-info">
        <div class="rd-vrow-name">${escapeHtml(v.name)}</div>
        <div class="rd-vrow-tag">${escapeHtml(v.tag)}</div>
      </div>
      ${v.key === currentKey ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg>` : ''}
    </button>`).join('');

  list.querySelectorAll('.rd-vrow').forEach(row => {
    row.addEventListener('click', () => {
      pickVoiceByKey(R.lang, row.dataset.voiceKey);  // use existing voice-pick logic
      rdUpdateToolbar();
      rdCloseSheet();
    });
  });
}

// getRdVoices() — adapt to match whatever voice list structure your app already uses.
// The handoff lists 4 Chinese voices; map them to your real TTS voice keys.
function getRdVoices(lang) {
  // Replace these with your actual voice definitions from the existing voice picker.
  // Example structure only:
  const voiceMap = {
    zh: [
      { key: 'zh-CN-XiaoxiaoNeural', initial: '美', name: 'Xiǎoměi · 小美', tag: 'Female · Mainland · warm', color: '#0AB4D6' },
      { key: 'zh-CN-YunxiNeural',    initial: '轩', name: 'Zǐxuān · 子轩',  tag: 'Male · Mainland · clear', color: '#E5267E' },
      { key: 'zh-TW-HsiaoChenNeural',initial: '婷', name: 'Yǎtíng · 雅婷',  tag: 'Female · Taiwan',         color: '#F5B400' },
      { key: 'zh-CN-YunjianNeural',  initial: '强', name: 'Guóqiáng · 国强', tag: 'Male · slow & articulate',color: '#16A34A' },
    ],
  };
  return voiceMap[lang] || [];
}
```

**Important:** `pickVoiceByKey()` and `getSelectedVoice()` should map to whatever function you already use to set and read the TTS voice. Check the existing voice picker for the correct function names and adapt accordingly.

---

## Step 9 — Wire up inline word sheet in `app.js`

Find `rdRenderPassage()` (around line 3142). The existing word-click handler currently calls the old word popup. Replace or augment the click handler on `.rd-word` elements:

```js
// FIND the existing handler (inside rdRenderPassage, after han.innerHTML is set):
han.querySelectorAll(".rd-word").forEach(el => {
  el.addEventListener("click", (e) => {
    // ... existing logic that opens the OLD popup ...
  });
});

// REPLACE with:
han.querySelectorAll(".rd-word").forEach(el => {
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    const word   = el.dataset.word;
    const pinyin = el.dataset.pinyin || '';
    if (!word) return;

    // Highlight selected word.
    han.querySelectorAll('.rd-word-sel').forEach(w => w.classList.remove('rd-word-sel'));
    el.classList.add('rd-word-sel');

    // Populate word sheet.
    document.getElementById('rdWordHz').textContent  = word;
    document.getElementById('rdWordPy').textContent  = pinyin;
    document.getElementById('rdWordPos').textContent = '';   // fill if you have POS data
    document.getElementById('rdWordEn').textContent  = '';   // fill if you have meaning data

    // TTS button.
    const ttsBtn = document.getElementById('rdWordTtsBtn');
    ttsBtn.onclick = () => playGoogleTTS(word, R.lang, null, null);

    // Save button.
    rdRenderWordSaveBtn(word, pinyin);
    document.getElementById('rdWordSaveBtn').onclick = () => rdToggleWordSave(word, pinyin);

    rdOpenSheet('word');
  });
});
```

Add the word save helpers:

```js
const rdSavedWords = {};   // { [hz]: true } — replace with Supabase in INTEGRATION #4

function rdRenderWordSaveBtn(hz) {
  const btn = document.getElementById('rdWordSaveBtn');
  if (!btn) return;
  const saved = !!rdSavedWords[hz];
  btn.className = 'rd-word-save-btn' + (saved ? ' saved' : '');
  btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <use href="#${saved ? 'sonic-i-check' : 'sonic-i-plus'}"/></svg> ${saved ? 'Saved to cards' : 'Save to cards'}`;
}

function rdToggleWordSave(hz, py) {
  // INTEGRATION #4: replace with Supabase flashcards insert/delete.
  if (rdSavedWords[hz]) delete rdSavedWords[hz];
  else rdSavedWords[hz] = true;
  rdRenderWordSaveBtn(hz);
}
```

**Also add CSS class `.rd-word-sel` for the selected word highlight:**

```css
/* Add to style.css with the other .rd-word rules */
.rd-word.rd-word-sel .rd-hz { color: var(--cyan-ink); background: rgba(10,180,214,.18); }
```

---

## Step 10 — Fix bookmark toggle in `app.js`

Find the `rdBookmarkBtn` click handler (around line 3285). Replace:

```js
// OLD:
document.getElementById("rdBookmarkBtn")?.addEventListener("click", () => {
  document.getElementById("saveTextBtn")?.click();
  document.getElementById("rdBookmarkBtn")?.classList.add("on");
});

// NEW:
document.getElementById("rdBookmarkBtn")?.addEventListener("click", async () => {
  const btn = document.getElementById("rdBookmarkBtn");
  const isNowSaved = !btn?.classList.contains("on");
  // INTEGRATION #5: replace with Supabase saved_texts insert/delete.
  if (isNowSaved) {
    btn?.classList.add("on");
    showToast("Text saved to your library", "success");
    // Call existing save mechanism:
    document.getElementById("saveTextBtn")?.click();
  } else {
    btn?.classList.remove("on");
    showToast("Removed from library", "info");
  }
});
```

---

## Step 11 — Replace borrowed exercises with self-contained UI in `app.js`

The biggest change. Find `rdRenderExercise()` (around line 3345). The functions `rdRenderExMenu()` and `rdRenderExDone()` are fine — keep them. Replace the borrowed-panels logic in `rdRenderExercise()` and add new exercise renderers.

**Replace the `if (rdExState.view === 'order')` / `if (rdExState.view === 'choice')` branches:**

```js
// REMOVE the old borrowed-panel approach entirely. Remove rdParkExercisePanels() calls.
// REMOVE rdParkExercisePanels() function.

// In rdRenderExercise(), replace the order/choice branches with:
if (rdExState.view === 'order')  { rdRenderExOrder(body);  return; }
if (rdExState.view === 'choice') { rdRenderExCloze(body);  return; }
```

**Add the self-contained word-order exercise:**

```js
/* ---- Word-order exercise (self-contained, matches handoff Type 1) ---- */
const rdEx1 = { slots: [], target: [], bank: [], fb: null };

function rdEx1Init() {
  // Generate from the active text: pick a short sentence and shuffle its words.
  // INTEGRATION #7: replace this with server-generated target/bank from the text.
  const sent = R.sentences.find(s => s.text && s.text.length >= 6 && s.text.length <= 20);
  if (!sent) { rdEx1.target = []; rdEx1.bank = []; return; }
  const chars = [...sent.text].filter(c => !/[，。！？、\s]/.test(c));
  rdEx1.target = chars;
  rdEx1.slots  = new Array(chars.length).fill(null);
  rdEx1.bank   = chars.map((c, i) => ({ id: i, t: c })).sort(() => Math.random() - .5);
  rdEx1.fb     = null;
}

function rdRenderExOrder(body) {
  if (!rdEx1.target.length) rdEx1Init();
  if (!rdEx1.target.length) { body.innerHTML = '<p class="rd-loading">Not enough text for this exercise.</p>'; return; }

  const slots = rdEx1.slots.map((id, pos) =>
    id == null
      ? `<span class="rd-slot empty" data-slot="${pos}"></span>`
      : `<button class="rd-slot" data-slot="${pos}" type="button">${rdEx1.bank.find(b => b.id === id)?.t || ''}</button>`
  ).join('');
  const bank = rdEx1.bank.map(b =>
    `<button class="rd-chip${rdEx1.slots.includes(b.id) ? ' used' : ''}" data-bank-id="${b.id}" type="button">${b.t}</button>`
  ).join('');
  const fb = rdEx1.fb
    ? `<div class="rd-exfb ${rdEx1.fb === 'correct' ? 'ok' : 'no'}">${rdEx1.fb === 'correct' ? '太好了！Correct order.' : 'Not quite — tap a tile to send it back.'}</div>`
    : '';

  body.innerHTML = `
    <div class="rd-excard">
      <div style="display:flex;align-items:center;gap:9px">
        <span class="rd-extag">Exercise 1</span><span class="rd-extitle">Put the words in order</span>
      </div>
      <p class="rd-exdesc">Rebuild the scrambled sentence.</p>
      <div class="rd-slots${rdEx1.fb === 'wrong' ? ' wrong' : ''}" id="rdEx1Slots">${slots}</div>
      <div class="rd-bank">${bank}</div>
      ${fb}
      <div class="rd-exrow">
        <button class="rd-excheck" id="rdEx1Check" type="button">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg> Check
        </button>
        <button class="rd-exskip" type="button" id="rdEx1Skip">Skip</button>
      </div>
    </div>`;

  // Slot tap → return to bank.
  body.querySelectorAll('.rd-slot:not(.empty)').forEach(sl => {
    sl.addEventListener('click', () => {
      const pos = Number(sl.dataset.slot);
      rdEx1.slots[pos] = null; rdEx1.fb = null; rdRenderExOrder(body);
    });
  });
  // Bank tap → fill next empty slot.
  body.querySelectorAll('.rd-chip').forEach(ch => {
    ch.addEventListener('click', () => {
      const id = Number(ch.dataset.bankId);
      const i = rdEx1.slots.indexOf(null);
      if (i < 0 || rdEx1.slots.includes(id)) return;
      rdEx1.slots[i] = id; rdEx1.fb = null; rdRenderExOrder(body);
    });
  });
  document.getElementById('rdEx1Check')?.addEventListener('click', () => {
    const placed = rdEx1.slots.map(id => id == null ? null : rdEx1.bank.find(b => b.id === id)?.t);
    const ok = JSON.stringify(placed) === JSON.stringify(rdEx1.target);
    rdEx1.fb = ok ? 'correct' : 'wrong';
    rdRenderExOrder(body);
    if (ok) setTimeout(() => { rdExState.done.order = true; rdExState.view = rdExState.done.choice ? 'done' : 'menu'; rdRenderExercise(); }, 900);
  });
  document.getElementById('rdEx1Skip')?.addEventListener('click', () => { rdExState.view = 'menu'; rdRenderExercise(); });
}

/* ---- Cloze exercise (self-contained, matches handoff Type 2) ---- */
const rdEx2 = { sent: '', blank: '', opts: [], answer: 0, choice: null, fb: null };

function rdEx2Init() {
  // INTEGRATION #7: replace with server-generated cloze from the active text.
  // Fallback: pick a sentence with ≥4 words and blank the last content word.
  const s = R.sentences.find(s => s.text && s.text.length >= 8);
  if (!s) { rdEx2.sent = ''; return; }
  const chars = [...s.text].filter(c => !/[，。！？、\s]/.test(c));
  if (chars.length < 4) { rdEx2.sent = ''; return; }
  const answerChar = chars[chars.length - 1];
  rdEx2.blank  = answerChar;
  rdEx2.sent   = s.text.replace(new RegExp(answerChar + '(?=[^\\u4e00-\\u9fff]*$)'), '___');
  rdEx2.answer = 0;
  rdEx2.choice = null;
  rdEx2.fb     = null;
  // Dummy distractors — INTEGRATION #7 should provide real options from the text vocabulary.
  const distractors = chars.slice(0, 3).filter(c => c !== answerChar);
  rdEx2.opts = [{ t: answerChar, py: '' }, ...distractors.slice(0,3).map(t => ({ t, py: '' }))].sort(() => Math.random() - .5);
  rdEx2.answer = rdEx2.opts.findIndex(o => o.t === answerChar);
}

function rdRenderExCloze(body) {
  if (!rdEx2.sent) rdEx2Init();
  if (!rdEx2.sent) { body.innerHTML = '<p class="rd-loading">Not enough text for this exercise.</p>'; return; }

  const blankCol = rdEx2.fb === 'correct' ? 'var(--good)' : rdEx2.fb === 'wrong' ? 'var(--bad)' : 'var(--primary)';
  const blankTxt = rdEx2.choice == null ? '＿＿' : rdEx2.opts[rdEx2.choice].t;
  const blankHtml = `<span style="display:inline-block;min-width:56px;text-align:center;border-bottom:3px solid ${blankCol};color:${rdEx2.choice == null ? '#B9B4C7' : blankCol};font-weight:700;margin:0 2px;padding:0 4px">${blankTxt}</span>`;
  const sentDisplay = rdEx2.sent.replace('___', blankHtml);

  const opts = rdEx2.opts.map((op, i) => {
    let cls = 'rd-opt';
    if (rdEx2.fb && i === rdEx2.answer) cls += ' correct';
    else if (rdEx2.fb === 'wrong' && rdEx2.choice === i) cls += ' wrong';
    else if (rdEx2.choice === i) cls += ' sel';
    return `<button class="${cls}" data-opt="${i}" type="button">
      <span class="zh" style="font-size:22px;font-weight:700">${escapeHtml(op.t)}</span>
      ${op.py ? `<span class="rd-opt-py">${escapeHtml(op.py)}</span>` : ''}
    </button>`;
  }).join('');

  const fb = rdEx2.fb
    ? `<div class="rd-exfb ${rdEx2.fb === 'correct' ? 'ok' : 'no'}">${rdEx2.fb === 'correct' ? '对了！' : 'Not quite — try again.'}</div>`
    : '';

  body.innerHTML = `
    <div class="rd-excard">
      <div style="display:flex;align-items:center;gap:9px">
        <span class="rd-extag">Exercise 2</span><span class="rd-extitle">Choose the missing word</span>
      </div>
      <p class="rd-exdesc">Which word completes the sentence?</p>
      <div class="rd-cloze-sent zh">${sentDisplay}</div>
      <div class="rd-opts">${opts}</div>
      ${fb}
      <div class="rd-exrow">
        <button class="rd-excheck" id="rdEx2Check" type="button" ${rdEx2.choice == null && !rdEx2.fb ? 'disabled' : ''}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#sonic-i-check"/></svg>
          ${rdEx2.fb === 'correct' ? 'Correct ✓' : 'Check'}
        </button>
        <button class="rd-exskip" type="button" id="rdEx2Skip">Skip</button>
      </div>
    </div>`;

  body.querySelectorAll('.rd-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      if (rdEx2.fb === 'correct') return;
      rdEx2.choice = Number(btn.dataset.opt); rdEx2.fb = null; rdRenderExCloze(body);
    });
  });
  document.getElementById('rdEx2Check')?.addEventListener('click', () => {
    if (rdEx2.choice == null) return;
    const ok = rdEx2.choice === rdEx2.answer;
    rdEx2.fb = ok ? 'correct' : 'wrong';
    rdRenderExCloze(body);
    if (ok) setTimeout(() => { rdExState.done.choice = true; rdExState.view = rdExState.done.order ? 'done' : 'menu'; rdRenderExercise(); }, 900);
  });
  document.getElementById('rdEx2Skip')?.addEventListener('click', () => { rdExState.view = 'menu'; rdRenderExercise(); });
}
```

**Also reset `rdEx1` and `rdEx2` when a new text is loaded**, by adding to `startReader()`:

```js
function startReader(text, sentences) {
  // ... existing body ...
  // ADD at the top:
  rdEx1.slots = []; rdEx1.target = []; rdEx1.bank = []; rdEx1.fb = null;
  rdEx2.sent  = ''; rdEx2.choice = null; rdEx2.fb = null;
  rdExState.done = { order: false, choice: false };
  rdExState.view = 'menu';
  // ... rest of existing body ...
}
```

---

## Step 12 — Wire up the Speak Setup screen in `app.js`

The Speak tab should now navigate to `#screen-speak-setup` instead of `#screen-main`. Find where the Speak tab click navigates to `screenMain` (look for `appMode = "pronunciation"`) and change it to:

```js
// When switching to Speak mode, show the new setup screen.
showScreen(document.getElementById('screen-speak-setup'));
```

Wire the start button:

```js
document.getElementById('spSetupStartBtn')?.addEventListener('click', async () => {
  const text = document.getElementById('spSetupInput')?.value || '';
  if (!text.trim()) { showToast('Paste a text first.', 'error'); return; }
  currentTextId = null;
  currentTextTitle = '';
  appMode = 'pronunciation';
  await startReadingFromText(text);
});
```

The back button in `#screen-speak-practice` (already wired as `spBackBtn`) should return to `#screen-speak-setup`, not `#screen-main`:

```js
// Find spBackBtn handler and update its showScreen target:
showScreen(document.getElementById('screen-speak-setup'));
```

---

## Step 13 — Delete demo-only stubs

The handoff HTML files contain dev-only artifacts. **Do not copy these into the app:**
- The `<div class="devbar">` jump-bar at the top of each mockup.
- The `fakeScore()` function in `speak-spotlight.html`.
- The `renderTabbar()` function in both mockups (the app already has its own tab bar).
- Any `/* INTEGRATION ... */` comment stubs — these mark where real logic (TTS, Supabase) should already exist in your app.

---

## Verification checklist

After completing all steps, manually verify:

- [ ] Read tab → shows new card-grid setup screen (not old textarea composer)
- [ ] Library cards render with thumbnail, title, level badge; selecting one highlights it; "Start reading · [title]" label updates
- [ ] Paste tab → textarea works; "Start reading" submits text
- [ ] Saved tab → shows saved texts with progress bars
- [ ] Tapping "Start reading" loads the reader screen; level badge shows the text's level
- [ ] Pinyin pill toggles ruby annotations on/off
- [ ] Translate pill lazy-loads paragraph translations
- [ ] Voice pill opens the inline voice sheet (not a modal); picking a voice updates the pill label and closes the sheet
- [ ] Tapping any word opens the word sheet with hanzi, pinyin, POS, English; TTS button plays the word; Save button toggles saved state
- [ ] Bookmark button toggles on/off correctly
- [ ] "Practice what you read" → Exercise menu with two cards
- [ ] Word-order exercise: bank chips slot in order; wrong answer shakes; correct → auto-advances
- [ ] Cloze exercise: four options; wrong shows red; correct → auto-advances
- [ ] Completing both exercises → celebration screen
- [ ] Speak tab → shows speak setup screen with textarea; "Start speaking" launches the existing spotlight flow
- [ ] No JS console errors on any of the above paths
