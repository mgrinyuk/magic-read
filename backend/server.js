import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { translateText, translateBatch } from "./services/translateService.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import textToSpeech from "@google-cloud/text-to-speech";
import { pinyin } from "pinyin-pro";
import { google } from "googleapis";
import PDFDocument from "pdfkit";
import Papa from "papaparse";
import Stripe from "stripe";
import { isLifetimeOfferEligible } from "./lib/planRules.js";
import { getActivityRpcArgs } from "./lib/activityRules.js";


dotenv.config();

// --- Stripe (billing) config ---
// STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the three plan prices
// (STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL / STRIPE_PRICE_LIFETIME) live in
// .env (and must also be set in the Render dashboard). The webhook secret is
// only used to verify incoming webhook signatures.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/* ============================================================
   STRIPE BILLING — summary of what was added
   ------------------------------------------------------------
   Backend (this file):
     • `stripe` npm dependency + client init (above).
     • POST /api/stripe-webhook   — raw-body Stripe webhook, registered
       BEFORE express.json(); flips profiles.plan between 'pro'/'free'.
     • POST /api/create-checkout-session — auth-gated; takes a priceType
       ('monthly' | 'annual' | 'lifetime') and creates a Stripe Checkout
       session (subscription for monthly/annual, payment for lifetime) and
       stores stripe_customer_id.
   Frontend: "Upgrade to Pro ✨" button opens a 3-plan picker in the profile
     dropdown; plan lookup + checkout redirect in app.js.
   SQL: see the "Stripe setup — run separately" block at the bottom of
     pronunciation-setup.sql (adds profiles.stripe_customer_id).

   WHAT YOU NEED TO DO IN THE STRIPE DASHBOARD:
     1. Create your plan Prices (Dashboard → Products): a recurring monthly
        price, a recurring annual price, and a one-time lifetime price. Copy
        each id into STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL /
        STRIPE_PRICE_LIFETIME (.env locally + Render env vars).
     2. Add STRIPE_SECRET_KEY (Developers → API keys).
     3. Create a webhook endpoint pointing to
        https://magic-read.onrender.com/api/stripe-webhook
        listening for: checkout.session.completed,
        customer.subscription.updated, customer.subscription.deleted.
        Copy its signing secret into STRIPE_WEBHOOK_SECRET.
   ============================================================ */

const supabase = createSupabaseClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Privileged client for server-side reads/writes that must bypass RLS
// (entitlement lookups + usage metering). Falls back to the anon client if
// no service-role key is set, but the pronunciation quota needs the service key.
const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createSupabaseClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : supabase;

// --- Azure Speech (pronunciation assessment) config ---
const AZURE_SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_SPEECH_REGION = process.env.AZURE_SPEECH_REGION;
// --- Free-plan limits (Pro & welcome-week trial users are unlimited) ---
// All overridable via env vars; defaults match the plan definition.
const FREE_DAILY_PRONUNCIATION_LIMIT = Number(process.env.FREE_DAILY_PRONUNCIATION_LIMIT || 20);
const FREE_DAILY_TEXT_LIMIT = Number(process.env.FREE_DAILY_TEXT_LIMIT || 3);
const FREE_MAX_SAVED_TEXTS = Number(process.env.FREE_MAX_SAVED_TEXTS || 5);
const FREE_MAX_DECKS = Number(process.env.FREE_MAX_DECKS || 2);
const FREE_MAX_CARDS = Number(process.env.FREE_MAX_CARDS || 100);
const FREE_VIDEO_TRIAL_LIMIT = Number(process.env.FREE_VIDEO_TRIAL_LIMIT || 3);
const LIFETIME_OFFER_ENABLED = process.env.LIFETIME_OFFER_ENABLED === "true";
const LIFETIME_OFFER_WINDOW_DAYS = Number(process.env.LIFETIME_OFFER_WINDOW_DAYS || 7);

// Centralized plan resolver. Returns the user's *effective* plan, honoring the
// 7-day welcome-week trial: a user is treated as 'pro' if they're a paid pro OR
// still inside their trial window. Use this everywhere instead of reading
// profiles.plan directly.
async function getUserPlan(userId) {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("plan, trial_ends_at")
    .eq("id", userId)
    .maybeSingle();
  if (error) console.error("[Plan] profile lookup error:", error.message);

  const plan = profile?.plan || "free";
  const trialEndsAt = profile?.trial_ends_at || null;
  const trialActive =
    plan !== "pro" && !!trialEndsAt && new Date(trialEndsAt) > new Date();
  const effectivePlan = plan === "pro" || trialActive ? "pro" : "free";
  const lifetimeOfferEligible = isLifetimeOfferEligible({
    enabled: LIFETIME_OFFER_ENABLED,
    plan,
    trialEndsAt,
    windowDays: LIFETIME_OFFER_WINDOW_DAYS
  });
  return { plan, trialEndsAt, trialActive, effectivePlan, lifetimeOfferEligible };
}

// Attaches req.user from a Bearer JWT; silently treats invalid tokens as guests.
async function extractUser(req, _res, next) {
  req.user = null;
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const { data } = await supabase.auth.getUser(auth.slice(7));
      req.user = data?.user ?? null;
    } catch {
      // network hiccup — treat as guest
    }
  }
  next();
}

const RATE_LIMIT_MSG = { error: "Too many requests. Please wait or sign in for more access." };
const skipAuth = (req) => req.user !== null;

// TTS: expensive Google API call — 80/hour for guests.
const ttsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 80,
  skip: skipAuth,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MSG
});

// Translate: moderate cost — 100/hour for guests.
const translateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 100,
  skip: skipAuth,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MSG
});

// Dictionary: cheap local lookup — 600/hour for guests.
const dictionaryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 600,
  skip: skipAuth,
  standardHeaders: true,
  legacyHeaders: false,
  message: RATE_LIMIT_MSG
});

// Baseline protection for all endpoints (300 req / 15 min per IP).
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." }
});

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-secret"] !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// Pronunciation assessment is a paid-cost feature — signed-in users only.
function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "Please sign in to use the pronunciation coach.",
      code: "NO_AUTH"
    });
  }
  next();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const cedictMap = process.env.LOAD_CEDICT === "true" ? loadCedict() : {};

//env
const sheets = google.sheets({
  version: "v4",
  auth: process.env.GOOGLE_SHEETS_API_KEY
});

//dictionary
function loadCedict() {
  try {
    const filePath = path.join(__dirname, "data", "dictionaries", "cedict_ts.u8");
    const content = fs.readFileSync(filePath, "utf-8");

    const map = {};

    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) continue;

      // format:
      // traditional simplified [pinyin] /definition 1/definition 2/
      const match = trimmed.match(/^(\S+)\s+(\S+)\s+\[(.+?)\]\s+\/(.+)\/$/);

      if (!match) continue;

      const traditional = match[1];
      const simplified = match[2];
      const pinyinRaw = match[3];
      const definitionsRaw = match[4];

      const definitions = definitionsRaw
        .split("/")
        .map(d => d.trim())
        .filter(Boolean);

      const entry = {
        traditional,
        simplified,
        pinyinNumbered: pinyinRaw,
        definitions
      };

      if (!map[simplified]) {
        map[simplified] = [];
      }

      map[simplified].push(entry);
    }

    console.log(`Loaded CC-CEDICT entries for ${Object.keys(map).length} simplified forms`);
    return map;
  } catch (error) {
    console.error("Could not load CC-CEDICT:", error);
    return {};
  }
}

const GRAMMAR_SHEET_ID = process.env.GRAMMAR_SHEET_ID;
const app = express();
let googleCredentials;
try {
  if (process.env.GOOGLE_TTS_KEY_JSON) {
    googleCredentials = JSON.parse(process.env.GOOGLE_TTS_KEY_JSON);
    console.log("[TTS] Credentials loaded for:", googleCredentials.client_email || "(no client_email)");
  } else {
    console.warn("[TTS] GOOGLE_TTS_KEY_JSON is not set — will fail at runtime");
  }
} catch (err) {
  console.error("[TTS] Failed to parse GOOGLE_TTS_KEY_JSON:", err.message);
}

const ttsClient = new textToSpeech.TextToSpeechClient({
  credentials: googleCredentials
});


app.use(cors());

app.get("/", (_req, res) => {
  res.redirect(302, "https://magicread.app");
});

/* -----------------------------
   STRIPE WEBHOOK
   MUST be registered with the raw body parser and BEFORE the global
   express.json() middleware below — Stripe signature verification needs
   the exact raw request bytes. Uses supabaseAdmin (service role) to flip
   the user's plan based on subscription lifecycle events.
----------------------------- */
async function setPlanByCustomer(customerId, plan) {
  if (!customerId) return;
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ plan })
    .eq("stripe_customer_id", customerId);
  if (error) console.error(`[Stripe] failed to set plan=${plan} for customer ${customerId}:`, error.message);
}

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send("Billing not configured");
  }

  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("[Stripe] webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // Fires for both subscriptions and one-time lifetime payments. Flip to
        // pro. Prefer the customer id; fall back to client_reference_id (the
        // Supabase user id we set when creating the session) — important for
        // the lifetime case (mode === 'payment').
        const session = event.data.object;
        if (session.customer) {
          await setPlanByCustomer(session.customer, "pro");
        } else if (session.client_reference_id) {
          const { error } = await supabaseAdmin
            .from("profiles")
            .update({ plan: "pro" })
            .eq("id", session.client_reference_id);
          if (error) console.error("[Stripe] failed to set pro by user id:", error.message);
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const plan = sub.status === "active" || sub.status === "trialing" ? "pro" : "free";
        // active → pro; canceled / past_due / unpaid / incomplete → free
        await setPlanByCustomer(sub.customer, plan);
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        await setPlanByCustomer(sub.customer, "free");
        break;
      }
      default:
        // ignore other event types
        break;
    }
  } catch (err) {
    console.error("[Stripe] webhook handler error:", err.message);
    // Still 200 so Stripe doesn't retry on our internal bug; we logged it.
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(globalLimiter);

// parsing texts
app.get("/api/game-texts", async (req, res) => {
  try {
    const lang = (req.query.lang || "zh").trim();

    const response = await fetch(process.env.GAME_TEXTS_SHEET_URL);
    const csv = await response.text();

    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true
    });

    const texts = parsed.data
      .filter(row => (row.lang || "").trim() === lang)
      .map(row => ({
        id: row.id,
        title: row.title,
        level: row.level,
        topic: row.topic,
        cardCount: Number(row.sentence_count) || 0
      }));

    res.json({ texts });
  } catch (error) {
    console.error("Game texts load error:", error);
    res.status(500).json({ error: "Could not load sheet" });
  }
});

function drawCharacterGrid(doc, items, fontPath, titleText) {
  // A4 = 595 × 842 pts. Compute layout from actual page dimensions.
  const PAGE_W  = 595;
  const PAGE_H  = 842;
  const boxSize = 32;
  const marginH = 40;         // left & right margin
  const startY  = 70;         // title lives in the 0–70 zone
  const marginB = 40;         // bottom margin

  const cols    = Math.floor((PAGE_W - marginH * 2) / boxSize);   // 16
  const rows    = Math.floor((PAGE_H - startY - marginB) / boxSize); // 22
  const startX  = Math.round((PAGE_W - cols * boxSize) / 2);      // centres grid ≈ 42
  const fontSize = Math.round(22 * (boxSize / 40));               // 18 (scaled from 22)

  const totalPages = Math.max(1, Math.ceil(items.length / rows));

  for (let page = 0; page < totalPages; page++) {
    if (page > 0) doc.addPage();

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#333").text(titleText, startX, 40);

    const pageItems = items.slice(page * rows, page * rows + rows);

    for (let row = 0; row < rows; row++) {
      const item = pageItems[row];

      for (let col = 0; col < cols; col++) {
        const x = startX + col * boxSize;
        const y = startY  + row * boxSize;

        doc.rect(x, y, boxSize, boxSize).stroke("#999");
        doc.moveTo(x + boxSize / 2, y).lineTo(x + boxSize / 2, y + boxSize).stroke("#ccc");
        doc.moveTo(x, y + boxSize / 2).lineTo(x + boxSize, y + boxSize / 2).stroke("#ccc");
        doc.moveTo(x, y).lineTo(x + boxSize, y + boxSize).stroke("#ddd");
        doc.moveTo(x + boxSize, y).lineTo(x, y + boxSize).stroke("#ddd");

        const currentChar = item?.[col];

        if (currentChar) {
          if (fs.existsSync(fontPath)) {
            doc.font(fontPath);
          } else {
            doc.font("Helvetica");
          }

          doc.fontSize(fontSize).fillColor("#333").text(currentChar, x, y + 4, {
            width: boxSize,
            align: "center",
            lineBreak: false
          });
        }
      }
    }
  }
}

app.post("/api/create-writing-sheet", (req, res) => {
  try {
    const { text, sourceLang } = req.body || {};

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const lang = (sourceLang || "zh").trim();

    const filename = `writing-sheet-${lang}.pdf`;
    const doc = new PDFDocument({ size: "A4", margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    if (lang === "ru" || lang === "tr") {
      const words = text
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean);

      const lineStartX = 55;
      const lineEndX = 540;
      const startY = 95;
      const rowHeight = 48;
      const rows = 12;

      const ruFontPath = path.join(__dirname, "fonts", "ClassRoomCursive.ttf");

      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .fillColor("#333")
        .text("Writing practice", 50, 40);

      for (let row = 0; row < rows; row++) {
        const word = words[row] || "";
        const baselineY = startY + row * rowHeight;

        doc.moveTo(lineStartX, baselineY).lineTo(lineEndX, baselineY).stroke("#999");

        if (word) {
          if (fs.existsSync(ruFontPath)) {
            doc.font(ruFontPath);
          } else {
            doc.font("Times-Italic");
          }

          doc
            .fontSize(28)
            .fillColor("#333")
            .text(word, lineStartX + 6, baselineY - 20, {
              width: 180,
              align: "left",
              lineBreak: false
            });
        }
      }
    } else {
      const words = text
        .split(/[\n,，、;；]+/)
        .map(w => w.trim())
        .filter(Boolean);

      const zhFontPath = path.join(__dirname, "fonts", "NotoSansSC-Regular.ttf");
      drawCharacterGrid(doc, words, zhFontPath, "Chinese writing practice");
    }

    doc.end();
  } catch (error) {
    console.error("Writing sheet error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not create writing sheet" });
    }
  }
});

app.use("/worksheets", express.static(path.join(__dirname, "public", "worksheets")));

let grammarCache = {
  zh: { data: null, loadedAt: 0 },
  ru: { data: null, loadedAt: 0 },
  tr: { data: null, loadedAt: 0 },
  de: { data: null, loadedAt: 0 },
  es: { data: null, loadedAt: 0 },
  fr: { data: null, loadedAt: 0 },
  ja: { data: null, loadedAt: 0 }
};

const CACHE_TTL_MS = 5 * 60 * 1000;

function splitIntoSentences(text) {
  const PH = "\x00";
  const protected_text = text
    .replace(/\b(\d+)\. /g, `$1${PH} `)
    .replace(/\b(Mr|Mrs|Ms|Dr|Prof|Jr|Sr|St|vs|etc|e\.g|i\.e|No|Vol|Fig)\./gi, `$1${PH}`);

  return (protected_text.match(/[^.!?。！？]+[.!?。！？]?/g) || [])
    .map(s => s.replace(/\x00/g, ".").trim())
    .filter(Boolean);
}

app.post("/api/split-text", (req, res) => {
  const { text } = req.body || {};

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  res.json({ sentences: splitIntoSentences(text) });
});

function segmentChineseText(text) {
  let words = [];

  try {
    const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
    words = Array.from(segmenter.segment(text))
      .map(item => item.segment)
      .filter(item => item.trim());
  } catch (intlError) {
    console.error("Intl.Segmenter failed:", intlError);
  }

  if (!words.length) {
    words = [...text].filter(char => char.trim());
  }

  return words.map(word => ({
    word,
    pinyin: /[\u4e00-\u9fff]/.test(word)
      ? pinyin(word, { toneType: "symbol", type: "array" }).join(" ")
      : ""
  }));
}

app.post("/api/segment", (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    res.json({ words: segmentChineseText(text) });
  } catch (error) {
    console.error("Segmentation route error:", error);
    res.status(500).json({ error: "Segmentation failed" });
  }
});

app.post("/api/segment-many", (req, res) => {
  const { texts } = req.body;

  if (!Array.isArray(texts)) {
    return res.status(400).json({ error: "texts must be an array" });
  }

  try {
    const results = texts.map(text => ({
      text,
      words: segmentChineseText(text)
    }));

    res.json({ results });
  } catch (error) {
    console.error("Batch segmentation error:", error);
    res.status(500).json({ error: "Batch segmentation failed" });
  }
});


app.post("/api/dictionary", extractUser, dictionaryLimiter, (req, res) => {
  const { word } = req.body;

  if (!word) {
    return res.status(400).json({ error: "Word is required" });
  }

  try {
    const entries = cedictMap[word] || [];

    const result = entries.map(entry => ({
      simplified: entry.simplified,
      traditional: entry.traditional,
      pinyin:
        /[\u4e00-\u9fff]/.test(entry.simplified)
          ? pinyin(entry.simplified, { toneType: "symbol", type: "array" }).join(" ")
          : "",
      definitions: entry.definitions
    }));

    res.json({ entries: result });
  } catch (error) {
    console.error("Dictionary lookup error:", error);
    res.status(500).json({ error: "Dictionary lookup failed" });
  }
});

app.post("/api/pinyin", (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: "Text is required" });
    const result = pinyin(text, { toneType: "symbol", type: "array" }).join(" ");
    res.json({ pinyin: result });
  } catch (error) {
    console.error("Pinyin route error:", error);
    res.status(500).json({ error: "Pinyin conversion failed" });
  }
});

function escapeXml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function buildSSMLWithMarks(text, words) {
  let result = "";
  let pos = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const idx = text.indexOf(word, pos);
    if (idx === -1) continue;
    result += escapeXml(text.slice(pos, idx));
    result += `<mark name="w${i}"/>` + escapeXml(word);
    pos = idx + word.length;
  }
  result += escapeXml(text.slice(pos));
  return `<speak>${result}</speak>`;
}

app.post("/api/tts", extractUser, ttsLimiter, async (req, res) => {
  try {
    const { text, sourceLang, speakingRate, voiceName, words } = req.body;

    if (!text || !sourceLang) {
      return res.status(400).json({ error: "text and sourceLang are required" });
    }

    const voiceMap = {
      zh: { languageCode: "cmn-CN", name: "cmn-CN-Wavenet-D" },
      en: { languageCode: "en-US", name: "en-US-Wavenet-D" },
      de: { languageCode: "de-DE", name: "de-DE-Wavenet-B" },
      es: { languageCode: "es-ES", name: "es-ES-Wavenet-B" },
      fr: { languageCode: "fr-FR", name: "fr-FR-Wavenet-B" },
      ja: { languageCode: "ja-JP", name: "ja-JP-Wavenet-B" },
      ru: { languageCode: "ru-RU", name: "ru-RU-Wavenet-A" },
      tr: { languageCode: "tr-TR", name: "tr-TR-Wavenet-A" }
    };

    const baseConfig = voiceMap[sourceLang] || voiceMap.en;
    const voiceConfig = voiceName
      ? { languageCode: baseConfig.languageCode, name: voiceName }
      : baseConfig;

    const useMarks = Array.isArray(words) && words.length > 0;
    const input = useMarks
      ? { ssml: buildSSMLWithMarks(text, words) }
      : { text };

    const [response] = await ttsClient.synthesizeSpeech({
      input,
      voice: voiceConfig,
      audioConfig: { audioEncoding: "MP3", speakingRate: speakingRate || 1.0 },
      ...(useMarks && { enableTimePointing: ["SSML_MARK"] })
    });

    if (!response.audioContent) {
      return res.status(500).json({ error: "No audio returned from TTS" });
    }

    res.json({
      audioBase64: response.audioContent.toString("base64"),
      mimeType: "audio/mpeg",
      timepoints: response.timepoints || []
    });
  } catch (error) {
    const code = error.code ?? error.status ?? "unknown";
    const detail = error.message ?? String(error);
    console.error(`[TTS] synthesizeSpeech failed — code: ${code} | message: ${detail}`);
    if (!googleCredentials) {
      console.error("[TTS] No credentials — GOOGLE_TTS_KEY_JSON missing or unparseable");
    }
    res.status(500).json({ error: "TTS generation failed", code, detail });
  }
});


app.post("/api/translate", extractUser, translateLimiter, async (req, res) => {
  try {
    const { sentence, sourceLang, targetLang } = req.body;

    if (!sentence) {
      return res.status(400).json({ error: "Sentence is required" });
    }

    const translation = await translateText(sentence, sourceLang, targetLang);

    res.json({ translation });
  } catch (error) {
    console.error("Translation route error:", error);
    res.status(500).json({ error: "Translation failed" });
  }
});


/* -----------------------------
   STRIPE CHECKOUT
   Auth-gated. Ensures the user has a Stripe customer (stored on their
   profile), then creates a Checkout session for the requested plan.
   Body: { priceType: 'monthly' | 'annual' | 'lifetime' }.
   Monthly/annual are subscriptions; lifetime is a one-time payment.
   Returns { url } for the browser to redirect to.
----------------------------- */
app.post("/api/create-checkout-session", extractUser, requireUser, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Billing is not configured.", code: "NOT_CONFIGURED" });
    }

    // Map the requested plan to its Stripe price + checkout mode.
    const PRICE_MAP = {
      monthly:  { price: process.env.STRIPE_PRICE_MONTHLY,  mode: "subscription" },
      annual:   { price: process.env.STRIPE_PRICE_ANNUAL,   mode: "subscription" },
      lifetime: { price: process.env.STRIPE_PRICE_LIFETIME, mode: "payment" }
    };

    const { priceType } = req.body || {};
    const selected = PRICE_MAP[priceType];
    if (!selected) {
      return res.status(400).json({ error: "Invalid or missing priceType.", code: "INVALID_PRICE_TYPE" });
    }
    if (!selected.price) {
      return res.status(503).json({ error: "Billing is not configured.", code: "NOT_CONFIGURED" });
    }

    const userId = req.user.id;
    const email = req.user.email;

    if (priceType === "lifetime") {
      const { lifetimeOfferEligible } = await getUserPlan(userId);
      if (!lifetimeOfferEligible) {
        return res.status(403).json({
          error: "The lifetime offer is not available for this account.",
          code: "LIFETIME_OFFER_UNAVAILABLE"
        });
      }
    }

    // Reuse the user's Stripe customer if we already have one; otherwise create
    // it and persist the id on the profile.
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr) console.error("[Stripe] profile lookup error:", profileErr.message);

    let customerId = profile?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: userId }
      });
      customerId = customer.id;
      const { error: updErr } = await supabaseAdmin
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", userId);
      if (updErr) console.error("[Stripe] failed to store customer id:", updErr.message);
    }

    // Send the user back to the frontend they came from (fall back to prod).
    const origin = req.headers.origin || "https://magic-read.onrender.com";

    const session = await stripe.checkout.sessions.create({
      mode: selected.mode,
      customer: customerId,
      client_reference_id: userId,
      line_items: [{ price: selected.price, quantity: 1 }],
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancel`
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("[Stripe] create-checkout-session error:", error.message);
    res.status(500).json({ error: "Could not start checkout." });
  }
});

app.post("/api/create-billing-portal-session", extractUser, requireUser, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: "Billing is not configured.", code: "NOT_CONFIGURED" });
    }

    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", req.user.id)
      .maybeSingle();

    if (profileErr) {
      console.error("[Stripe] portal profile lookup error:", profileErr.message);
      return res.status(500).json({ error: "Could not open subscription settings." });
    }
    if (!profile?.stripe_customer_id) {
      return res.status(404).json({
        error: "No paid subscription is connected to this account yet.",
        code: "NO_BILLING_CUSTOMER"
      });
    }

    const origin = req.headers.origin || "https://magic-read.onrender.com";
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: origin
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error("[Stripe] create-billing-portal-session error:", error.message);
    res.status(500).json({ error: "Could not open subscription settings." });
  }
});


/* -----------------------------
   PLAN & QUOTAS
   All quota endpoints use getUserPlan() so welcome-week trial users get
   pro-level (unlimited) access. Guests never reach these (requireUser).
----------------------------- */

// Read-only snapshot the frontend uses to render limits/counters in one call.
app.get("/api/my-plan", extractUser, requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan, trialEndsAt, trialActive, effectivePlan, lifetimeOfferEligible } = await getUserPlan(userId);
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    const [textRes, pronRes, statsRes, videoRes] = await Promise.all([
      supabaseAdmin.from("text_processing_usage").select("count").eq("user_id", userId).eq("day", day).maybeSingle(),
      supabaseAdmin.from("pronunciation_usage").select("count").eq("user_id", userId).eq("day", day).maybeSingle(),
      supabaseAdmin.from("user_stats").select("words_read,words_spoken,words_practiced,current_streak").eq("user_id", userId).maybeSingle(),
      supabaseAdmin.from("video_usage").select("opens").eq("user_id", userId).maybeSingle()
    ]);

    const stats = statsRes.data || {};
    res.json({
      plan,
      effectivePlan,
      trialEndsAt,
      trialActive,
      lifetimeOfferEligible,
      textUsedToday: textRes.data?.count || 0,
      pronouncedToday: pronRes.data?.count || 0,
      videosOpened: videoRes.data?.opens || 0,
      wordsRead: stats.words_read || 0,
      wordsSpoken: stats.words_spoken || 0,
      wordsPracticed: stats.words_practiced || 0,
      currentStreak: stats.current_streak || 0,
      limits: {
        textPerDay: FREE_DAILY_TEXT_LIMIT,
        pronunciationPerDay: FREE_DAILY_PRONUNCIATION_LIMIT,
        savedTexts: FREE_MAX_SAVED_TEXTS,
        decks: FREE_MAX_DECKS,
        cards: FREE_MAX_CARDS,
        videosPerTrial: FREE_VIDEO_TRIAL_LIMIT
      }
    });
  } catch (error) {
    console.error("[Plan] my-plan error:", error.message);
    res.status(500).json({ error: "Could not load plan." });
  }
});

let recordActivityRpcMode = "typed";

// Records activity counters (words read/spoken/practiced) and updates the
// daily streak. Fire-and-forget from the frontend — always returns 200 so
// a stats failure never blocks the user.
app.post("/api/record-activity", extractUser, requireUser, async (req, res) => {
  const { type, count } = req.body || {};
  const validTypes = ["words_read", "words_spoken", "words_practiced"];
  if (!validTypes.includes(type) || !Number.isInteger(count) || count < 1) {
    return res.status(400).json({ error: "Invalid type or count." });
  }
  try {
    const userId = req.user.id;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const activity = { userId, type, count, today };
    let { error } = await supabaseAdmin.rpc(
      "record_activity",
      getActivityRpcArgs(recordActivityRpcMode, activity)
    );

    if (error && recordActivityRpcMode === "typed" &&
        (error.code === "PGRST202" || error.message?.includes("Could not find the function"))) {
      const fallback = await supabaseAdmin.rpc(
        "record_activity",
        getActivityRpcArgs("legacy", activity)
      );
      error = fallback.error;
      if (!error) {
        recordActivityRpcMode = "legacy";
        console.log("[Stats] Using legacy record_activity RPC signature.");
      }
    }

    if (error) console.error("[Stats] record_activity error:", error.message);
  } catch (err) {
    console.error("[Stats] record-activity exception:", err.message);
  }
  res.json({ ok: true });
});

/* -----------------------------
   VIDEO CAPTIONS
   Fetches captions from YouTube (human or auto), enriches them with
   pinyin (Chinese) + translation, caches in public.video_captions.
   Auth required; returns { captions, source, cached } or { needsGeneration: true }.
----------------------------- */

// Walk the raw HTML string to extract a balanced JSON object that starts
// after `marker`, without a regex that can't match nested braces.
function extractJsonObject(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf("{", idx);
  if (start === -1) return null;

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc)        { esc = false; continue; }
    if (c === "\\" && inStr) { esc = true;  continue; }
    if (c === '"')  { inStr = !inStr; continue; }
    if (inStr)      continue;
    if (c === "{")  depth++;
    else if (c === "}") {
      if (--depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Normalize YouTube language codes to our internal codes (zh-Hans → zh, en-US → en).
function normYtLang(code) {
  if (!code) return "";
  if (code.startsWith("zh")) return "zh";
  return code.split("-")[0];
}

app.get("/api/video-captions", extractUser, requireUser, async (req, res) => {
  const { videoId, lang, targetLang = "en" } = req.query;

  if (!videoId || !lang) {
    return res.status(400).json({ error: "videoId and lang are required" });
  }
  // YouTube video IDs are exactly 11 chars from [A-Za-z0-9_-]
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid videoId" });
  }

  try {
    // 1. Cache hit — service-role client bypasses RLS
    const { data: cached } = await supabaseAdmin
      .from("video_captions")
      .select("captions, source")
      .eq("video_id", videoId)
      .eq("lang", lang)
      .maybeSingle();

    if (cached) {
      return res.json({ captions: cached.captions, source: cached.source, cached: true });
    }

    // 2. Fetch the YouTube watch page to discover caption track URLs
    const ytHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9"
    };

    const watchRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, { headers: ytHeaders });
    if (!watchRes.ok) {
      return res.status(502).json({ error: "Could not reach YouTube." });
    }
    const html = await watchRes.text();

    // Try both marker spellings (YouTube has varied this over time)
    const playerResponse =
      extractJsonObject(html, "var ytInitialPlayerResponse =") ||
      extractJsonObject(html, "ytInitialPlayerResponse=");

    if (!playerResponse) {
      return res.json({ needsGeneration: true });
    }

    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const targetCode = normYtLang(lang);

    // Prefer human-made track; fall back to ASR (auto-generated)
    const human = tracks.find(t => normYtLang(t.languageCode) === targetCode && t.kind !== "asr");
    const auto  = tracks.find(t => normYtLang(t.languageCode) === targetCode);
    const track = human ?? auto;

    if (!track) {
      return res.json({ needsGeneration: true });
    }

    const source = track.kind === "asr" ? "youtube_auto" : "youtube";

    // 3. Download caption track as JSON3 (YouTube's structured caption format)
    const captionRes = await fetch(`${track.baseUrl}&fmt=json3`, { headers: ytHeaders });
    if (!captionRes.ok) {
      return res.json({ needsGeneration: true });
    }
    const captionJson = await captionRes.json();

    const rawLines = (captionJson.events ?? [])
      .filter(e => e.segs && e.tStartMs !== undefined)
      .map(e => ({
        start: e.tStartMs / 1000,
        dur:   (e.dDurationMs ?? 3000) / 1000,
        text:  e.segs.map(s => s.utf8 ?? "").join("").replace(/\n/g, " ").trim()
      }))
      .filter(l => l.text);

    if (!rawLines.length) {
      return res.json({ needsGeneration: true });
    }

    // 4. Enrich: batch-translate all lines in one API call; add pinyin for Chinese
    const isZh = targetCode === "zh";
    const srcLang = normYtLang(lang) || lang;

    let translations = rawLines.map(() => "");
    try {
      translations = await translateBatch(rawLines.map(l => l.text), srcLang, targetLang);
    } catch (err) {
      console.error("[Captions] translation error:", err.message);
    }

    const enriched = rawLines.map((line, i) => {
      const out = {
        start:       line.start,
        dur:         line.dur,
        text:        line.text,
        translation: translations[i] ?? ""
      };
      if (isZh) {
        out.pinyin = pinyin(line.text, { toneType: "symbol", type: "array" }).join(" ");
        out.tokens = segmentChineseText(line.text); // [{ word, pinyin }] for tappable words
      }
      return out;
    });

    // 5. Write to cache (fire-and-forget — user already has the response)
    supabaseAdmin
      .from("video_captions")
      .upsert({ video_id: videoId, lang, source, captions: enriched })
      .then(({ error }) => { if (error) console.error("[Captions] cache write:", error.message); });

    return res.json({ captions: enriched, source, cached: false });

  } catch (err) {
    console.error("[Captions] error:", err.message);
    res.status(500).json({ error: "Could not fetch captions." });
  }
});

// Metered: increments the per-day text counter for free users.
app.post("/api/check-text-quota", extractUser, requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { effectivePlan } = await getUserPlan(userId);
    if (effectivePlan === "pro") return res.json({ allowed: true });

    const day = new Date().toISOString().slice(0, 10);
    const { data: usageRow, error: usageErr } = await supabaseAdmin
      .from("text_processing_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("day", day)
      .maybeSingle();
    if (usageErr) console.error("[Quota] text usage lookup error:", usageErr.message);

    const used = usageRow?.count || 0;
    if (used >= FREE_DAILY_TEXT_LIMIT) {
      return res.status(429).json({
        error: `You've used your ${FREE_DAILY_TEXT_LIMIT} free texts today. Upgrade to Pro for unlimited.`,
        code: "TEXT_QUOTA_EXCEEDED",
        used,
        limit: FREE_DAILY_TEXT_LIMIT
      });
    }

    const { error: incErr } = await supabaseAdmin.rpc("increment_text_usage", {
      p_user_id: userId,
      p_day: day
    });
    if (incErr) console.error("[Quota] text usage increment error:", incErr.message);

    res.json({ allowed: true, used: used + 1, limit: FREE_DAILY_TEXT_LIMIT });
  } catch (error) {
    console.error("[Quota] text quota error:", error.message);
    res.status(500).json({ error: "Quota check failed." });
  }
});

// Lifetime video open counter. Trial users get FREE_VIDEO_TRIAL_LIMIT total opens;
// paid Pro users are unlimited; free users with an expired trial are blocked entirely.
app.post("/api/check-video-quota", extractUser, requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan, trialActive } = await getUserPlan(userId);

    // Paid Pro — always allowed.
    if (plan === "pro") return res.json({ allowed: true });

    // Trial expired (free user, no active trial) — Videos are Pro-only.
    if (!trialActive) {
      return res.status(429).json({
        error: "Videos are a Pro feature.",
        code: "VIDEO_QUOTA_EXCEEDED",
        used: null,
        limit: FREE_VIDEO_TRIAL_LIMIT
      });
    }

    // Active trial — check lifetime counter.
    const { data: usageRow, error: usageErr } = await supabaseAdmin
      .from("video_usage")
      .select("opens")
      .eq("user_id", userId)
      .maybeSingle();
    if (usageErr) console.error("[VideoQuota] lookup error:", usageErr.message);

    const used = usageRow?.opens || 0;
    if (used >= FREE_VIDEO_TRIAL_LIMIT) {
      return res.status(429).json({
        error: `You've used your ${FREE_VIDEO_TRIAL_LIMIT} trial videos. Go Pro to keep learning from any video.`,
        code: "VIDEO_QUOTA_EXCEEDED",
        used,
        limit: FREE_VIDEO_TRIAL_LIMIT
      });
    }

    // Increment counter.
    const { error: incErr } = await supabaseAdmin
      .from("video_usage")
      .upsert({ user_id: userId, opens: used + 1 }, { onConflict: "user_id" });
    if (incErr) console.error("[VideoQuota] increment error:", incErr.message);

    res.json({ allowed: true, used: used + 1, limit: FREE_VIDEO_TRIAL_LIMIT });
  } catch (error) {
    console.error("[VideoQuota] error:", error.message);
    res.status(500).json({ error: "Quota check failed." });
  }
});

// Checked before inserting into saved_texts. Does not mutate anything.
app.post("/api/check-save-text-quota", extractUser, requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { effectivePlan } = await getUserPlan(userId);
    if (effectivePlan === "pro") return res.json({ allowed: true });

    const { count, error } = await supabaseAdmin
      .from("saved_texts")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (error) console.error("[Quota] saved_texts count error:", error.message);

    const used = count || 0;
    if (used >= FREE_MAX_SAVED_TEXTS) {
      return res.status(429).json({
        error: `You've saved ${FREE_MAX_SAVED_TEXTS} texts (free limit). Upgrade to Pro to save unlimited texts.`,
        code: "SAVE_TEXT_QUOTA_EXCEEDED",
        used,
        limit: FREE_MAX_SAVED_TEXTS
      });
    }
    res.json({ allowed: true, used, limit: FREE_MAX_SAVED_TEXTS });
  } catch (error) {
    console.error("[Quota] save-text quota error:", error.message);
    res.status(500).json({ error: "Quota check failed." });
  }
});

// Checked before creating a deck (intent: 'new-deck') or adding a card
// (intent: 'add-card'). With no intent it checks both. Does not mutate.
app.post("/api/check-deck-quota", extractUser, requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { effectivePlan } = await getUserPlan(userId);
    if (effectivePlan === "pro") return res.json({ allowed: true });

    const intent = req.body?.intent; // 'new-deck' | 'add-card' | undefined

    const { count: deckCount, error: deckErr } = await supabaseAdmin
      .from("flashcard_decks")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    if (deckErr) console.error("[Quota] decks count error:", deckErr.message);

    if (intent !== "add-card" && (deckCount || 0) >= FREE_MAX_DECKS) {
      return res.status(429).json({
        error: `You have ${FREE_MAX_DECKS} decks (free limit). Upgrade to Pro for unlimited decks.`,
        code: "DECK_QUOTA_EXCEEDED",
        used: deckCount || 0,
        limit: FREE_MAX_DECKS
      });
    }

    if (intent !== "new-deck") {
      const { count: cardCount, error: cardErr } = await supabaseAdmin
        .from("flashcards")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      if (cardErr) console.error("[Quota] cards count error:", cardErr.message);

      if ((cardCount || 0) >= FREE_MAX_CARDS) {
        return res.status(429).json({
          error: `You've reached ${FREE_MAX_CARDS} cards (free limit). Upgrade to Pro for unlimited cards.`,
          code: "CARD_QUOTA_EXCEEDED",
          used: cardCount || 0,
          limit: FREE_MAX_CARDS
        });
      }
    }

    res.json({
      allowed: true,
      decks: deckCount || 0,
      deckLimit: FREE_MAX_DECKS,
      cardLimit: FREE_MAX_CARDS
    });
  } catch (error) {
    console.error("[Quota] deck quota error:", error.message);
    res.status(500).json({ error: "Quota check failed." });
  }
});


/* -----------------------------
   PRONUNCIATION ASSESSMENT (Azure)
   Mints a short-lived Azure token. This endpoint is the metering point:
   one token = one pronunciation check. Free signed-in users are quota-limited
   here; pro users are unlimited. The Azure key never reaches the browser.
----------------------------- */
app.post("/api/speech-token", extractUser, requireUser, async (req, res) => {
  try {
    if (!AZURE_SPEECH_KEY || !AZURE_SPEECH_REGION) {
      return res.status(503).json({
        error: "Pronunciation service is not configured.",
        code: "NOT_CONFIGURED"
      });
    }

    const userId = req.user.id;

    // Entitlement via the centralized resolver: paid pro OR active trial → pro.
    const { effectivePlan } = await getUserPlan(userId);
    const isPro = effectivePlan === "pro";

    // Quota: free users are capped per UTC day. Metered at token issuance.
    if (!isPro) {
      const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

      const { data: usageRow, error: usageErr } = await supabaseAdmin
        .from("pronunciation_usage")
        .select("count")
        .eq("user_id", userId)
        .eq("day", day)
        .maybeSingle();

      if (usageErr) console.error("[Speech] usage lookup error:", usageErr.message);

      const used = usageRow?.count || 0;
      if (used >= FREE_DAILY_PRONUNCIATION_LIMIT) {
        return res.status(429).json({
          error: "You've used today's free pronunciation checks. Upgrade for unlimited.",
          code: "QUOTA_EXCEEDED",
          used,
          limit: FREE_DAILY_PRONUNCIATION_LIMIT
        });
      }

      // Atomic increment (Postgres function). Counts this check.
      const { error: incErr } = await supabaseAdmin.rpc("increment_pronunciation_usage", {
        p_user_id: userId,
        p_day: day
      });
      if (incErr) console.error("[Speech] usage increment error:", incErr.message);
    }

    // Mint a short-lived (~10 min) Azure authorization token.
    const tokenResponse = await fetch(
      `https://${AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": AZURE_SPEECH_KEY,
          "Content-Length": "0"
        }
      }
    );

    if (!tokenResponse.ok) {
      const detail = await tokenResponse.text().catch(() => "");
      console.error("[Speech] issueToken failed:", tokenResponse.status, detail);
      return res.status(502).json({ error: "Could not get speech token.", code: "TOKEN_FAILED" });
    }

    const token = await tokenResponse.text();
    res.json({
      token,
      region: AZURE_SPEECH_REGION,
      plan: isPro ? "pro" : "free"
    });
  } catch (error) {
    console.error("[Speech] token route error:", error);
    res.status(500).json({ error: "Speech token error." });
  }
});


async function analyzeGrammar(sentence, sourceLang) {
  const items = [];

  if (!["zh", "ru", "tr", "de", "es", "fr", "ja"].includes(sourceLang)) {
    return items;
  }

  const library = await getGrammarLibrary(sourceLang);
  const sentenceText = sentence.trim();
  const normalizedSentence = sentenceText.toLowerCase();

  for (const articleId in library) {
    const entry = library[articleId];
    const markers = Array.isArray(entry.markers) ? entry.markers : [];

    let matched = false;
    let matchedText = "";

    for (const rawMarker of markers) {
      const marker = String(rawMarker || "").trim().toLowerCase();
      if (!marker) continue;

      if (sourceLang === "zh") {
        if (normalizedSentence.includes(marker)) {
          matched = true;
          matchedText = rawMarker;
          break;
        }
        continue;
      }

      const words = normalizedSentence
        .replace(/[.,!?;:«»"'()]/g, " ")
        .split(/\s+/)
        .filter(Boolean);

      if (marker.startsWith("-") && marker.endsWith("-")) {
        const infix = marker.slice(1, -1);
        const hasInfix = words.some(word => word.includes(infix));

        if (hasInfix) {
          matched = true;
          matchedText = rawMarker;
          break;
        }
      } else if (marker.startsWith("-")) {
        const suffix = marker.slice(1);
        const hasSuffix = words.some(word => word.endsWith(suffix));

        if (hasSuffix) {
          matched = true;
          matchedText = rawMarker;
          break;
        }
      } else {
        const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(
          `(^|\\s|[.,!?;:«»"'()-])${escaped}($|\\s|[.,!?;:«»"'()-])`,
          "i"
        );

        if (regex.test(sentenceText)) {
          matched = true;
          matchedText = rawMarker;
          break;
        }
      }
    }

    if (matched) {
      items.push({
        label: entry.title || matchedText,
        matchedText,
        articleId: entry.id,
        shortExplanation: entry.shortExplanation || ""
      });
    }
  }

  return items;
}

app.post("/api/grammar", async (req, res) => {
  try {
    const { sentence, sourceLang } = req.body;

    if (!sentence || !sourceLang) {
      return res.status(400).json({ error: "Sentence and sourceLang are required." });
    }

    const items = await analyzeGrammar(sentence, sourceLang);
    res.json({ items });
  } catch (error) {
    console.error("Grammar analysis route error:", error);
    res.status(500).json({ error: "Grammar analysis failed." });
  }
});

app.post("/api/admin/reload-grammar", requireAdmin, async (req, res) => {
  try {
    grammarCache.zh = {
      data: await loadGrammarFromSheet("GrammarZH"),
      loadedAt: Date.now()
    };

    grammarCache.ru = {
      data: await loadGrammarFromSheet("GrammarRu"),
      loadedAt: Date.now()
    };

    grammarCache.tr = {
      data: await loadGrammarFromSheet("GrammarTR"),
      loadedAt: Date.now()
    };

    grammarCache.de = {
      data: await loadGrammarFromSheet("GrammarDe"),
      loadedAt: Date.now()
    };

    grammarCache.es = {
      data: await loadGrammarFromSheet("GrammarEs"),
      loadedAt: Date.now()
    };

    grammarCache.fr = {
      data: await loadGrammarFromSheet("GrammarFr"),
      loadedAt: Date.now()
    };

    grammarCache.ja = {
      data: await loadGrammarFromSheet("GrammarJa"),
      loadedAt: Date.now()
    };

    res.json({ ok: true, message: "Grammar cache reloaded" });
  } catch (error) {
    console.error("Reload error:", error);
    res.status(500).json({ error: "Reload failed" });
  }
});

app.get("/api/grammar/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const lang = (req.query.lang || "zh").trim();

    const library = await getGrammarLibrary(lang);
    const article = library[id] || null;

    if (!article) {
      return res.status(404).json({ error: "Article not found" });
    }

    res.json(article);
  } catch (error) {
    console.error("Grammar lookup error:", error);
    res.status(500).json({ error: "Failed to load grammar article" });
  }
});

app.get("/api/game-texts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const lang = (req.query.lang || "zh").trim();

    const response = await fetch(process.env.GAME_TEXTS_SHEET_URL);
    const csv = await response.text();

    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true
    });

    const row = parsed.data.find(
      item => item.id === id && (item.lang || "").trim() === lang
    );

    if (!row) {
      return res.status(404).json({ error: "Game text not found" });
    }

    const sentences = splitIntoSentences(row.text);

    res.json({
      id: row.id,
      title: row.title,
      level: row.level,
      topic: row.topic,
      sentences
    });
  } catch (error) {
    console.error("Game text lesson load error:", error);
    res.status(500).json({ error: "Could not load sheet lesson" });
  }
});

async function loadGrammarFromSheet(sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GRAMMAR_SHEET_ID,
      range: `${sheetName}!A1:M`
    });

    const rows = response.data.values || [];

    if (!rows.length) {
      return {};
    }

    const headers = rows[0];
    const dataRows = rows.slice(1);

    const library = {};

    for (const row of dataRows) {
      const item = {};

      headers.forEach((header, index) => {
        item[header] = row[index] || "";
      });

      if (!item.id) continue;

      const markers = (item.markers || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);

      library[item.id] = {
        id: item.id,
        title: item.title || "",
        level: item.level || "",
        category: item.category || "",
        shortExplanation: item.shortExplanation || "",
        fullExplanation: item.fullExplanation || "",
        markers,
        ex1_ch: item.ex1_ch || "",
        ex1_py: item.ex1_py || "",
        ex2_ch: item.ex2_ch || "",
        ex2_py: item.ex2_py || "",
        ex3_ch: item.ex3_ch || "",
        ex3_py: item.ex3_py || ""
      };
    }

    return library;
  } catch (error) {
    console.error(`Could not load grammar sheet ${sheetName}:`, error);
    return {};
  }
}

//grammar from DB
async function getGrammarLibrary(lang) {
  const now = Date.now();

  if (
    grammarCache[lang] &&
    grammarCache[lang].data &&
    now - grammarCache[lang].loadedAt < CACHE_TTL_MS
  ) {
    return grammarCache[lang].data;
  }

  let sheetName = "";

  if (lang === "zh") {
    sheetName = "GrammarZH";
  } else if (lang === "ru") {
    sheetName = "GrammarRu";
  } else if (lang === "tr") {
    sheetName = "GrammarTR";
  } else if (lang === "de") {
    sheetName = "GrammarDe";
  } else if (lang === "es") {
    sheetName = "GrammarEs";
  } else if (lang === "fr") {
    sheetName = "GrammarFr";
  } else if (lang === "ja") {
    sheetName = "GrammarJa";
  }else {
    return {};
  }

  const library = await loadGrammarFromSheet(sheetName);

  grammarCache[lang] = {
    data: library,
    loadedAt: now
  };

  return library;
}

app.get("/api/grammar-list", async (req, res) => {
  try {
    const lang = (req.query.lang || "zh").trim();
    const library = await getGrammarLibrary(lang);

    const items = Object.values(library).map(item => ({
      id: item.id,
      title: item.title,
      level: item.level,
      category: item.category,
      shortExplanation: item.shortExplanation
    }));

    res.json({ items });
  } catch (error) {
    console.error("Grammar list error:", error);
    res.status(500).json({ error: "Failed to load grammar list" });
  }
});

app.use("/exports", express.static(path.join(__dirname, "public", "exports")));

app.post("/api/export-flashcard-deck", (req, res) => {
  try {
    const { deckName, words } = req.body || {};

    if (!deckName || !Array.isArray(words)) {
      return res.status(400).json({ error: "deckName and words are required" });
    }

    const items = words
      .map(w => String(w).trim())
      .filter(Boolean);

    if (!items.length) {
      return res.status(400).json({ error: "No characters to export" });
    }

    const safeName =
      deckName
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04ff\u4e00-\u9fff]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "deck";

    const filename = `${safeName}.pdf`;
    const doc = new PDFDocument({ size: "A4", margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    const fontPath = path.join(__dirname, "fonts", "NotoSansSC-Regular.ttf");
    drawCharacterGrid(doc, items, fontPath, `Deck: ${deckName}`);

    doc.end();
  } catch (error) {
    console.error("Flashcard deck export error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Could not export deck" });
    }
  }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
