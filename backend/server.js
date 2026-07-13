import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { translateText, translateBatch } from "./services/translateService.js";
import { fetchTranscript } from "./services/captionService.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import textToSpeech from "@google-cloud/text-to-speech";
import { pinyin } from "pinyin-pro";
import { google } from "googleapis";
import PDFDocument from "pdfkit";
import Papa from "papaparse";
import Stripe from "stripe";
import kuromoji from "kuromoji";
import wanakana from "wanakana";
import { isLifetimeOfferEligible } from "./lib/planRules.js";
import { getActivityRpcArgs } from "./lib/activityRules.js";
import {
  TBANK_PLANS,
  createTbankOrderId,
  parseTbankOrderId,
  createTbankToken,
  verifyTbankToken
} from "./lib/tbank.js";


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
const hasSupabaseServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
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
// Abuse caps for third-party-billed APIs (Google TTS / Translate). Generous on
// purpose: normal free-tier app usage stays far below them; they only stop
// direct API calls from burning money on a free account.
const FREE_DAILY_TTS_LIMIT = Number(process.env.FREE_DAILY_TTS_LIMIT || 300);
const FREE_DAILY_TRANSLATE_LIMIT = Number(process.env.FREE_DAILY_TRANSLATE_LIMIT || 300);
const LIFETIME_OFFER_ENABLED = process.env.LIFETIME_OFFER_ENABLED === "true";
const LIFETIME_OFFER_WINDOW_DAYS = Number(process.env.LIFETIME_OFFER_WINDOW_DAYS || 7);
const TBANK_TERMINAL_KEY = process.env.TBANK_TERMINAL_KEY;
const TBANK_PASSWORD = process.env.TBANK_PASSWORD;
const TBANK_API_URL = process.env.TBANK_API_URL || "https://securepay.tinkoff.ru/v2";
const TBANK_NOTIFICATION_URL = process.env.TBANK_NOTIFICATION_URL ||
  "https://magic-read.onrender.com/api/tbank/notification";
const TBANK_RETURN_URL = process.env.TBANK_RETURN_URL || "https://magicread.app";
const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME || "com.magicread.app";
const GOOGLE_PLAY_PRODUCTS = {
  monthly: process.env.GOOGLE_PLAY_PRODUCT_MONTHLY || "magic_read_pro_monthly",
  annual: process.env.GOOGLE_PLAY_PRODUCT_ANNUAL || "magic_read_pro_annual"
};
const GOOGLE_SIGN_IN_WEB_CLIENT_ID = process.env.GOOGLE_SIGN_IN_WEB_CLIENT_ID || "";
const GOOGLE_PLAY_PRODUCT_TO_TIER = Object.fromEntries(
  Object.entries(GOOGLE_PLAY_PRODUCTS).map(([tier, productId]) => [productId, tier])
);
let googlePlayCredentials = null;
try {
  const rawGooglePlayCredentials = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ||
    process.env.GOOGLE_PLAY_KEY_JSON;
  if (rawGooglePlayCredentials) {
    googlePlayCredentials = JSON.parse(rawGooglePlayCredentials);
    console.log("[Google Play] Credentials loaded for:", googlePlayCredentials.client_email || "(no client_email)");
  }
} catch (error) {
  console.error("[Google Play] Failed to parse service account JSON:", error.message);
}

async function isTbankReady() {
  if (!TBANK_TERMINAL_KEY || !TBANK_PASSWORD) return false;
  const { error } = await supabaseAdmin
    .from("tbank_payments")
    .select("payment_id")
    .limit(1);
  return !error;
}

function isGooglePlayReady() {
  return !!googlePlayCredentials && !!GOOGLE_PLAY_PACKAGE_NAME;
}

function getGooglePlayPublisher() {
  const auth = new google.auth.GoogleAuth({
    credentials: googlePlayCredentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"]
  });
  return google.androidpublisher({ version: "v3", auth });
}

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

  const { data: paidAccess } = await supabaseAdmin
    .from("profiles")
    .select("plan_ends_at, plan_provider")
    .eq("id", userId)
    .maybeSingle();

  const storedPlan = profile?.plan || "free";
  const planEndsAt = paidAccess?.plan_ends_at || null;
  const planProvider = paidAccess?.plan_provider || null;
  const lifetimeProvider = planProvider === "lifetime" || planProvider === "forever";
  const paidPlanActive = storedPlan === "pro" &&
    (lifetimeProvider || !planEndsAt || new Date(planEndsAt) > new Date());
  const plan = paidPlanActive ? "pro" : "free";
  const trialEndsAt = profile?.trial_ends_at || null;
  const trialActive =
    !paidPlanActive && !!trialEndsAt && new Date(trialEndsAt) > new Date();
  const effectivePlan = paidPlanActive || trialActive ? "pro" : "free";
  const lifetimeOfferEligible = isLifetimeOfferEligible({
    enabled: LIFETIME_OFFER_ENABLED,
    plan,
    trialEndsAt,
    windowDays: LIFETIME_OFFER_WINDOW_DAYS
  });
  return {
    plan,
    planEndsAt,
    planProvider,
    isPaidPro: paidPlanActive,
    isLifetimePro: paidPlanActive && (lifetimeProvider || (planProvider === "stripe" && !planEndsAt)),
    trialEndsAt,
    trialActive,
    effectivePlan,
    lifetimeOfferEligible
  };
}

// Server-side cap for third-party-billed APIs. Pro/trial users are unlimited;
// free users get a per-day cap per kind ("tts" | "translate"). Returns true if
// the request may proceed; otherwise it has already sent the 429. Fails open on
// storage errors so a missing table can't take the feature down for everyone.
async function enforceFreeApiCap(req, res, kind, limit) {
  try {
    const userId = req.user.id;
    const { effectivePlan } = await getUserPlan(userId);
    if (effectivePlan === "pro") return true;

    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const { data: row, error } = await supabaseAdmin
      .from("api_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("day", day)
      .eq("kind", kind)
      .maybeSingle();
    if (error) {
      console.error(`[ApiCap] ${kind} lookup error:`, error.message);
      return true;
    }

    const used = row?.count || 0;
    if (used >= limit) {
      res.status(429).json({
        error: "You've reached today's free limit. Upgrade to Pro for unlimited use.",
        code: `${kind.toUpperCase()}_QUOTA_EXCEEDED`,
        used,
        limit
      });
      return false;
    }

    const { error: incErr } = await supabaseAdmin
      .from("api_usage")
      .upsert({ user_id: userId, day, kind, count: used + 1 }, { onConflict: "user_id,day,kind" });
    if (incErr) console.error(`[ApiCap] ${kind} increment error:`, incErr.message);
    return true;
  } catch (e) {
    console.error(`[ApiCap] ${kind} error:`, e.message);
    return true;
  }
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

// App APIs are for signed-in users only.
function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: "Please sign in to continue.",
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

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.get("/api/auth/google-config", (_req, res) => {
  res.json({
    webClientId: GOOGLE_SIGN_IN_WEB_CLIENT_ID
  });
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
  let { error } = await supabaseAdmin
    .from("profiles")
    .update({ plan, plan_ends_at: null, plan_provider: plan === "pro" ? "stripe" : null })
    .eq("stripe_customer_id", customerId);
  if (error?.message?.includes("plan_ends_at") || error?.message?.includes("plan_provider")) {
    ({ error } = await supabaseAdmin.from("profiles").update({ plan }).eq("stripe_customer_id", customerId));
  }
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
          let { error } = await supabaseAdmin
            .from("profiles")
            .update({ plan: "pro", plan_ends_at: null, plan_provider: "stripe" })
            .eq("id", session.client_reference_id);
          if (error?.message?.includes("plan_ends_at") || error?.message?.includes("plan_provider")) {
            ({ error } = await supabaseAdmin.from("profiles").update({ plan: "pro" }).eq("id", session.client_reference_id));
          }
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
app.use(express.urlencoded({ extended: false }));
app.use(globalLimiter);

app.post("/api/delete-account", extractUser, requireUser, async (req, res) => {
  if (!hasSupabaseServiceRole) {
    return res.status(503).json({
      error: "Account deletion is not configured on this server."
    });
  }

  try {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(req.user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (error) {
    console.error("[Account] Delete account error:", error.message);
    res.status(500).json({
      error: "Could not delete account. Please contact support@magicread.app."
    });
  }
});

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

app.post("/api/create-writing-sheet", extractUser, requireUser, (req, res) => {
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

app.post("/api/split-text", extractUser, requireUser, (req, res) => {
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

// --- Japanese segmentation (kuromoji morphological analyzer + romaji readings) ---
// kuromoji's in-memory dictionary costs ~300MB RSS — it OOMs a 512MB instance
// alongside CC-CEDICT. Opt in with JA_TOKENIZER=kuromoji only when the server
// has at least 1GB of memory. Without it, Japanese still segments into words
// via Intl.Segmenter; romaji is then limited to kana-only words.
let kuromojiTokenizer = null;
if (process.env.JA_TOKENIZER === "kuromoji") {
  kuromoji
    .builder({ dicPath: path.join(__dirname, "node_modules", "kuromoji", "dict") })
    .build((err, tokenizer) => {
      if (err) {
        console.error("[JA] kuromoji failed to load — falling back to Intl.Segmenter:", err.message);
        return;
      }
      kuromojiTokenizer = tokenizer;
      console.log("[JA] kuromoji tokenizer ready");
    });
} else {
  console.log("[JA] kuromoji disabled (set JA_TOKENIZER=kuromoji to enable full romaji) — using Intl.Segmenter");
}

const JA_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff]/;

function segmentJapaneseText(text) {
  if (kuromojiTokenizer) {
    return kuromojiTokenizer
      .tokenize(text)
      .filter(t => t.surface_form.trim())
      .map(t => {
        // Particles は/へ/を are pronounced wa/e/o.
        const particle = t.pos === "助詞" && { "は": "wa", "へ": "e", "を": "o" }[t.surface_form];
        const reading = t.reading && t.reading !== "*" ? t.reading : t.surface_form;
        return {
          word: t.surface_form,
          pinyin: particle || (JA_SCRIPT.test(t.surface_form) ? wanakana.toRomaji(reading) : "")
        };
      });
  }

  // Fallback while the tokenizer dictionary is still loading.
  let words = [];
  try {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    words = Array.from(segmenter.segment(text))
      .map(item => item.segment)
      .filter(item => item.trim());
  } catch (intlError) {
    console.error("Intl.Segmenter (ja) failed:", intlError);
  }
  if (!words.length) words = [...text].filter(char => char.trim());

  return words.map(word => ({
    word,
    // Kana-only words can be romanized without a dictionary; kanji need kuromoji.
    pinyin: /^[\u3040-\u30ff]+$/.test(word) ? wanakana.toRomaji(word) : ""
  }));
}

// Kana is a reliable Japanese marker; Han characters alone mean Chinese.
function detectSegmentLang(text, requested) {
  if (requested === "ja" || requested === "zh") return requested;
  return /[\u3040-\u30ff]/.test(text) ? "ja" : "zh";
}

function segmentText(text, lang) {
  return detectSegmentLang(text, lang) === "ja"
    ? segmentJapaneseText(text)
    : segmentChineseText(text);
}

app.post("/api/segment", extractUser, requireUser, (req, res) => {
  const { text, lang } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    res.json({ words: segmentText(text, lang) });
  } catch (error) {
    console.error("Segmentation route error:", error);
    res.status(500).json({ error: "Segmentation failed" });
  }
});

app.post("/api/segment-many", extractUser, requireUser, (req, res) => {
  const { texts, lang } = req.body;

  if (!Array.isArray(texts)) {
    return res.status(400).json({ error: "texts must be an array" });
  }

  try {
    const results = texts.map(text => ({
      text,
      words: segmentText(text, lang)
    }));

    res.json({ results });
  } catch (error) {
    console.error("Batch segmentation error:", error);
    res.status(500).json({ error: "Batch segmentation failed" });
  }
});


app.post("/api/dictionary", extractUser, requireUser, (req, res) => {
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

app.post("/api/pinyin", extractUser, requireUser, (req, res) => {
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

app.post("/api/tts", extractUser, requireUser, async (req, res) => {
  try {
    const { text, sourceLang, speakingRate, voiceName, words } = req.body;

    if (!text || !sourceLang) {
      return res.status(400).json({ error: "text and sourceLang are required" });
    }

    // Google TTS is billed — cap free accounts server-side.
    if (!(await enforceFreeApiCap(req, res, "tts", FREE_DAILY_TTS_LIMIT))) return;

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


app.post("/api/translate", extractUser, requireUser, async (req, res) => {
  try {
    const { sentence, sourceLang, targetLang } = req.body;

    if (!sentence) {
      return res.status(400).json({ error: "Sentence is required" });
    }

    // Google Translate is billed — cap free accounts server-side.
    if (!(await enforceFreeApiCap(req, res, "translate", FREE_DAILY_TRANSLATE_LIMIT))) return;

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
   SUBSCRIPTION STATUS / UPGRADE / CANCEL
   In-app management so users see their tier + dates and can upgrade
   (monthly -> annual) or cancel without leaving the app. Stripe is the source
   of truth for tier/dates; T-Bank Pro is one-time/time-limited (no renewal).
----------------------------- */

// Return the user's most relevant Stripe subscription, or null. Prefers an
// active/trialing/past_due sub; otherwise the most recent one.
async function getActiveStripeSubscription(customerId) {
  if (!stripe || !customerId) return null;
  const { data: subs } = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10
  });
  if (!subs || !subs.length) return null;
  const live = subs.find((s) => ["active", "trialing", "past_due"].includes(s.status));
  return live || subs[0];
}

// Map a subscription's price id to our tier label.
function stripeTierFromSub(sub) {
  const priceId = sub?.items?.data?.[0]?.price?.id;
  if (priceId && priceId === process.env.STRIPE_PRICE_ANNUAL) return "annual";
  if (priceId && priceId === process.env.STRIPE_PRICE_MONTHLY) return "monthly";
  return null;
}

const toISO = (unixSeconds) =>
  unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;

app.get("/api/subscription-status", extractUser, requireUser, async (req, res) => {
  try {
    const userId = req.user.id;
    const { plan, planEndsAt, planProvider, trialActive, isLifetimePro } = await getUserPlan(userId);
    const active = plan === "pro" || trialActive;

    const base = {
      active,
      provider: planProvider,
      tier: isLifetimePro ? "lifetime" : null,
      purchasedAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      canUpgradeToAnnual: false,
      cancelable: false
    };

    if (plan !== "pro") {
      // Free or trial-only: nothing to manage.
      return res.json(base);
    }

    if (planProvider === "stripe") {
      const { data: profile } = await supabaseAdmin
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();
      const sub = await getActiveStripeSubscription(profile?.stripe_customer_id);
      if (sub) {
        const tier = stripeTierFromSub(sub);
        return res.json({
          ...base,
          tier,
          purchasedAt: toISO(sub.start_date || sub.created),
          currentPeriodEnd: toISO(sub.current_period_end),
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          canUpgradeToAnnual: tier === "monthly" && !sub.cancel_at_period_end,
          cancelable: !sub.cancel_at_period_end
        });
      }
      // Pro via Stripe but no subscription = one-time lifetime purchase.
      return res.json({ ...base, tier: "lifetime" });
    }

    if (planProvider === "tbank") {
      const { data: payment } = await supabaseAdmin
        .from("tbank_payments")
        .select("plan_code, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const tier = payment?.plan_code || null;
      return res.json({
        ...base,
        tier,
        purchasedAt: payment?.created_at || null,
        currentPeriodEnd: planEndsAt,
        canUpgradeToAnnual: tier !== "annual"
      });
    }

    if (planProvider === "google_play") {
      const { data: purchase } = await supabaseAdmin
        .from("google_play_purchases")
        .select("tier, created_at, expires_at, subscription_state")
        .eq("user_id", userId)
        .order("expires_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return res.json({
        ...base,
        provider: "google_play",
        tier: purchase?.tier || null,
        purchasedAt: purchase?.created_at || null,
        currentPeriodEnd: purchase?.expires_at || planEndsAt,
        cancelable: false
      });
    }

    // Pro with no provider = directly granted (comp/manual). Treat it as lifetime access.
    return res.json({ ...base, tier: isLifetimePro ? "lifetime" : null });
  } catch (error) {
    console.error("[Stripe] subscription-status error:", error.message);
    res.status(500).json({ error: "Could not load subscription status." });
  }
});

app.post("/api/upgrade-to-annual", extractUser, requireUser, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Billing is not configured.", code: "NOT_CONFIGURED" });
    if (!process.env.STRIPE_PRICE_ANNUAL) {
      return res.status(503).json({ error: "Annual plan is not configured.", code: "NOT_CONFIGURED" });
    }
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", req.user.id)
      .maybeSingle();
    const sub = await getActiveStripeSubscription(profile?.stripe_customer_id);
    if (!sub) return res.status(404).json({ error: "No active Stripe subscription to upgrade.", code: "NO_SUBSCRIPTION" });
    if (stripeTierFromSub(sub) === "annual") {
      return res.status(400).json({ error: "You're already on the annual plan.", code: "ALREADY_ANNUAL" });
    }
    const itemId = sub.items.data[0].id;
    await stripe.subscriptions.update(sub.id, {
      items: [{ id: itemId, price: process.env.STRIPE_PRICE_ANNUAL }],
      proration_behavior: "create_prorations"
    });
    res.json({ ok: true });
  } catch (error) {
    console.error("[Stripe] upgrade-to-annual error:", error.message);
    res.status(500).json({ error: "Could not upgrade your plan." });
  }
});

app.post("/api/cancel-subscription", extractUser, requireUser, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Billing is not configured.", code: "NOT_CONFIGURED" });
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", req.user.id)
      .maybeSingle();
    const sub = await getActiveStripeSubscription(profile?.stripe_customer_id);
    if (!sub) return res.status(404).json({ error: "No active Stripe subscription to cancel.", code: "NO_SUBSCRIPTION" });
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
    res.json({ ok: true, endsAt: toISO(updated.current_period_end) });
  } catch (error) {
    console.error("[Stripe] cancel-subscription error:", error.message);
    res.status(500).json({ error: "Could not cancel your subscription." });
  }
});

app.post("/api/resume-subscription", extractUser, requireUser, async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: "Billing is not configured.", code: "NOT_CONFIGURED" });
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", req.user.id)
      .maybeSingle();
    const sub = await getActiveStripeSubscription(profile?.stripe_customer_id);
    if (!sub) return res.status(404).json({ error: "No subscription to resume.", code: "NO_SUBSCRIPTION" });
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: false });
    res.json({ ok: true, renewsAt: toISO(updated.current_period_end) });
  } catch (error) {
    console.error("[Stripe] resume-subscription error:", error.message);
    res.status(500).json({ error: "Could not resume your subscription." });
  }
});

/* -----------------------------
   GOOGLE PLAY BILLING
   Android app purchases are verified server-side against Google Play, then
   mapped onto the same profiles.plan / plan_provider / plan_ends_at entitlement
   that Stripe and T-Bank already use.
----------------------------- */
app.post("/api/google-play/verify-purchase", extractUser, requireUser, async (req, res) => {
  try {
    if (!isGooglePlayReady()) {
      return res.status(503).json({
        error: "Google Play Billing is not configured.",
        code: "NOT_CONFIGURED"
      });
    }

    const { productId, purchaseToken, packageName, orderId } = req.body || {};
    const tier = GOOGLE_PLAY_PRODUCT_TO_TIER[productId];
    if (!tier || !purchaseToken) {
      return res.status(400).json({
        error: "Invalid Google Play purchase.",
        code: "INVALID_PURCHASE"
      });
    }

    const expectedPackage = GOOGLE_PLAY_PACKAGE_NAME;
    if (packageName && packageName !== expectedPackage) {
      return res.status(400).json({
        error: "Purchase package does not match this app.",
        code: "PACKAGE_MISMATCH"
      });
    }

    const androidpublisher = getGooglePlayPublisher();
    const { data: sub } = await androidpublisher.purchases.subscriptionsv2.get({
      packageName: expectedPackage,
      token: purchaseToken
    });

    const lineItem = (sub.lineItems || []).find((item) => item.productId === productId) ||
      sub.lineItems?.[0];
    const expiryTime = lineItem?.expiryTime || null;
    const subscriptionState = sub.subscriptionState || "";
    const activeStates = new Set([
      "SUBSCRIPTION_STATE_ACTIVE",
      "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"
    ]);
    const active = activeStates.has(subscriptionState) &&
      !!expiryTime &&
      new Date(expiryTime) > new Date();

    if (!active) {
      return res.status(402).json({
        error: "Google Play subscription is not active.",
        code: "SUBSCRIPTION_INACTIVE",
        subscriptionState
      });
    }

    const userId = req.user.id;
    const purchaseRow = {
      purchase_token: purchaseToken,
      user_id: userId,
      product_id: productId,
      order_id: orderId || sub.latestOrderId || null,
      package_name: expectedPackage,
      tier,
      subscription_state: subscriptionState,
      expires_at: expiryTime,
      raw: sub
    };

    const { error: purchaseError } = await supabaseAdmin
      .from("google_play_purchases")
      .upsert(purchaseRow, { onConflict: "purchase_token" });
    if (purchaseError) {
      console.error("[Google Play] purchase upsert error:", purchaseError.message);
    }

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({
        plan: "pro",
        plan_provider: "google_play",
        plan_ends_at: expiryTime
      })
      .eq("id", userId);
    if (profileError) throw profileError;

    res.json({
      ok: true,
      provider: "google_play",
      tier,
      currentPeriodEnd: expiryTime
    });
  } catch (error) {
    console.error("[Google Play] verify-purchase error:", error.message);
    res.status(500).json({ error: "Could not verify Google Play purchase." });
  }
});

/* -----------------------------
   T-BANK: RUSSIAN CARDS + SBP
   Creates a hosted payment and grants time-limited Pro access only after a
   signed CONFIRMED notification. Amounts are in kopecks.
----------------------------- */
app.post("/api/tbank/create-payment", extractUser, requireUser, async (req, res) => {
  try {
    if (!(await isTbankReady())) {
      return res.status(503).json({
        error: "T-Bank payments are not ready. Complete the Supabase migration first.",
        code: "NOT_CONFIGURED"
      });
    }

    const { plan: planName } = req.body || {};
    const plan = TBANK_PLANS[planName];
    if (!plan) {
      return res.status(400).json({ error: "Invalid T-Bank plan.", code: "INVALID_PLAN" });
    }

    const orderId = createTbankOrderId(req.user.id, planName);
    const payload = {
      TerminalKey: TBANK_TERMINAL_KEY,
      Amount: plan.amount,
      OrderId: orderId,
      Description: plan.description,
      CustomerKey: req.user.id,
      PayType: "O",
      Language: "ru",
      NotificationURL: TBANK_NOTIFICATION_URL,
      SuccessURL: `${TBANK_RETURN_URL}/?tbank=success`,
      FailURL: `${TBANK_RETURN_URL}/?tbank=failed`,
      DATA: { Email: req.user.email || "" }
    };
    payload.Token = createTbankToken(payload, TBANK_PASSWORD);

    const response = await fetch(`${TBANK_API_URL}/Init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();

    if (!response.ok || data.Success !== true || !data.PaymentURL) {
      console.error("[T-Bank] Init failed:", data.ErrorCode, data.Message, data.Details);
      return res.status(502).json({
        error: data.Message || data.Details || "Could not start T-Bank payment.",
        code: "TBANK_INIT_FAILED"
      });
    }

    res.json({ url: data.PaymentURL, paymentId: data.PaymentId, orderId });
  } catch (error) {
    console.error("[T-Bank] create-payment error:", error.message);
    res.status(502).json({ error: "Could not start T-Bank payment." });
  }
});

app.post("/api/tbank/notification", async (req, res) => {
  const payload = req.body || {};

  if (!TBANK_TERMINAL_KEY || !TBANK_PASSWORD) {
    return res.status(503).send("T-Bank is not configured");
  }
  if (String(payload.TerminalKey || "") !== TBANK_TERMINAL_KEY ||
      !verifyTbankToken(payload, TBANK_PASSWORD)) {
    console.warn("[T-Bank] Rejected notification with invalid token.");
    return res.status(403).send("INVALID TOKEN");
  }

  if (String(payload.Status || "").toUpperCase() !== "CONFIRMED") {
    return res.type("text/plain").send("OK");
  }

  const order = parseTbankOrderId(payload.OrderId);
  const amount = Number(payload.Amount);
  if (!order || amount !== order.plan.amount || !payload.PaymentId) {
    console.warn("[T-Bank] Rejected notification with invalid order or amount.");
    return res.status(400).send("INVALID ORDER");
  }

  const { error } = await supabaseAdmin.rpc("apply_tbank_payment", {
    p_user_id: order.userId,
    p_payment_id: String(payload.PaymentId),
    p_order_id: String(payload.OrderId),
    p_plan_code: order.planName,
    p_amount: amount
  });
  if (error) {
    console.error("[T-Bank] apply payment error:", error.message);
    return res.status(500).send("RETRY");
  }

  return res.type("text/plain").send("OK");
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
    const {
      plan,
      planEndsAt,
      planProvider,
      isPaidPro,
      isLifetimePro,
      trialEndsAt,
      trialActive,
      effectivePlan,
      lifetimeOfferEligible
    } = await getUserPlan(userId);
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    const [textRes, pronRes, statsRes, videoRes] = await Promise.all([
      supabaseAdmin.from("text_processing_usage").select("count").eq("user_id", userId).eq("day", day).maybeSingle(),
      supabaseAdmin.from("pronunciation_usage").select("count").eq("user_id", userId).eq("day", day).maybeSingle(),
      supabaseAdmin.from("user_stats").select("words_read,words_spoken,words_practiced,current_streak").eq("user_id", userId).maybeSingle(),
      supabaseAdmin.from("video_usage").select("opens").eq("user_id", userId).maybeSingle()
    ]);

    const stats = statsRes.data || {};
    const tbankAvailable = await isTbankReady();
    res.json({
      plan,
      effectivePlan,
      planEndsAt,
      planProvider,
      isPaidPro,
      isLifetimePro,
      trialEndsAt,
      trialActive,
      lifetimeOfferEligible,
      tbankAvailable,
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
   Fetches captions via Supadata (existing tracks only — AI generation disabled),
   enriches with pinyin (Chinese) + translation, caches in public.video_captions.
   Auth required; returns { captions, source, cached }, { needsGeneration: true },
   or { error, code: "CAPTION_SERVICE_ERROR" } on provider outage.
----------------------------- */

// Translate caption lines and add reading aids (zh pinyin / ja romaji tokens).
// Used both for fresh transcripts and to heal cached rows that were stored
// while translation was failing.
async function enrichCaptionLines(rawLines, actualLang, targetLang) {
  const isZh = actualLang === "zh" || actualLang.startsWith("zh-");
  const isJa = actualLang === "ja" || actualLang.startsWith("ja-");

  let translations = rawLines.map(() => "");
  // Same-language "translation" (e.g. tr → tr after a transcript-language
  // fallback) is a paid no-op — skip it and leave translations empty.
  const sameLang = String(actualLang).slice(0, 2).toLowerCase() === String(targetLang).slice(0, 2).toLowerCase();
  if (!sameLang) {
    try {
      // Chunked translation of long transcripts takes several requests — allow 25s.
      translations = await Promise.race([
        translateBatch(rawLines.map(l => l.text), actualLang, targetLang),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Caption translation timed out")), 25000))
      ]);
    } catch (err) {
      console.error("[Captions] translation error:", err.message);
    }
  }

  return rawLines.map((line, i) => {
    const out = {
      start:       line.start,
      dur:         line.dur,
      text:        line.text,
      translation: translations[i] ?? ""
    };
    if (isZh) {
      out.pinyin = line.pinyin || pinyin(line.text, { toneType: "symbol", type: "array" }).join(" ");
      out.tokens = line.tokens?.length ? line.tokens : segmentChineseText(line.text);
    } else if (isJa) {
      out.tokens = line.tokens?.length ? line.tokens : segmentJapaneseText(line.text);
      out.pinyin = line.pinyin || out.tokens.map(t => t.pinyin).filter(Boolean).join(" ");
    }
    return out;
  });
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

  // Entitlement backstop — the app calls /api/check-video-quota first (which
  // increments the trial counter), but captions burn Supadata credits, so the
  // route itself must also refuse non-entitled accounts. `>` not `>=`: the
  // quota check has already counted this open for trial users.
  try {
    const { plan, trialActive } = await getUserPlan(req.user.id);
    if (plan !== "pro") {
      if (!trialActive) {
        return res.status(403).json({ error: "Videos are a Pro feature.", code: "VIDEO_QUOTA_EXCEEDED" });
      }
      const { data: usageRow } = await supabaseAdmin
        .from("video_usage")
        .select("opens")
        .eq("user_id", req.user.id)
        .maybeSingle();
      if ((usageRow?.opens || 0) > FREE_VIDEO_TRIAL_LIMIT) {
        return res.status(403).json({ error: "You've used your trial videos. Go Pro to keep learning from any video.", code: "VIDEO_QUOTA_EXCEEDED" });
      }
    }
  } catch (entitlementErr) {
    console.error("[Captions] entitlement check error:", entitlementErr.message);
  }

  try {
    // 1. Positive + negative cache lookups in parallel (both bypass RLS via service-role client).
    //    Positive: exact (video_id, lang) row with enriched captions.
    //    Negative: sentinel row (lang "__none__") written when a video yields no usable captions
    //              anywhere; checked_at stored inside captions JSON for a TTL-based expiry.
    const NEG_LANG   = "__none__";
    const NEG_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    const [{ data: cached }, { data: sentinel }] = await Promise.all([
      supabaseAdmin.from("video_captions").select("captions, source").eq("video_id", videoId).eq("lang", lang).maybeSingle(),
      supabaseAdmin.from("video_captions").select("captions").eq("video_id", videoId).eq("lang", NEG_LANG).maybeSingle()
    ]);

    if (cached) {
      const caps = Array.isArray(cached.captions) ? cached.captions : [];
      // Stale rows: no translations at all, or "translations" identical to the
      // source text (cached back when the target language was wrong).
      const missingTranslations =
        caps.length > 0 && caps.every(c => !c.translation || c.translation === c.text);
      if (!missingTranslations) {
        return res.json({ captions: cached.captions, source: cached.source, cached: true });
      }
      // Heal stale rows cached while translation was broken (e.g. the >128
      // segment limit) — re-enrich from the cached lines, no Supadata credit.
      const healed = await enrichCaptionLines(caps, lang, targetLang);
      supabaseAdmin
        .from("video_captions")
        .upsert({ video_id: videoId, lang, source: cached.source, captions: healed })
        .then(({ error }) => { if (error) console.error("[Captions] heal write:", error.message); });
      return res.json({ captions: healed, source: cached.source, cached: true });
    }

    if (sentinel?.captions?.no_captions) {
      const ageMs = Date.now() - new Date(sentinel.captions.checked_at).getTime();
      if (ageMs < NEG_TTL_MS) {
        return res.json({ needsGeneration: true });
      }
      // Sentinel expired — fall through to Supadata so a video that gained captions can recover
    }

    // 2. Fetch existing captions from Supadata (AI generation disabled via mode=native).
    //    Try the user's learning language first; if unavailable, fall back to the video's default.
    let transcript;
    try {
      transcript = await fetchTranscript(videoId, lang, 12000);
      if (!transcript) transcript = await fetchTranscript(videoId, null, 12000);
    } catch (err) {
      console.error("[Captions] provider error:", err.message);
      return res.status(503).json({
        error: "Captions are temporarily unavailable. Please try again later.",
        code: "CAPTION_SERVICE_ERROR",
        detail: err.message   // temporary — remove once root cause confirmed
      });
    }

    if (!transcript) {
      // Write negative cache sentinel so this video doesn't keep burning Supadata credits.
      // Expires after NEG_TTL_MS — if captions are added later the sentinel will be overwritten.
      supabaseAdmin
        .from("video_captions")
        .upsert({
          video_id: videoId,
          lang:     NEG_LANG,
          source:   "no_captions",
          captions: { no_captions: true, checked_at: new Date().toISOString() }
        })
        .then(({ error }) => { if (error) console.error("[Captions] negative cache write:", error.message); });
      return res.json({ needsGeneration: true });
    }

    const { lines: rawLines, language: actualLang } = transcript;

    // 3. Enrich: batch-translate all lines; add pinyin + tokens for Chinese,
    //    romaji + tokens for Japanese
    const enriched = await enrichCaptionLines(rawLines, actualLang, targetLang);

    // 4. Cache under the actual language returned by the provider (fire-and-forget).
    //    Also cache under the requested lang when we fell back, so repeated requests for the
    //    same video+requestedLang hit the cache instead of burning another Supadata credit.
    supabaseAdmin
      .from("video_captions")
      .upsert({ video_id: videoId, lang: actualLang, source: "supadata", captions: enriched })
      .then(({ error }) => { if (error) console.error("[Captions] cache write:", error.message); });

    if (actualLang !== lang) {
      supabaseAdmin
        .from("video_captions")
        .upsert({ video_id: videoId, lang, source: "supadata", captions: enriched })
        .then(({ error }) => { if (error) console.error("[Captions] cache write:", error.message); });
    }

    return res.json({ captions: enriched, source: "supadata", cached: false });

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

app.get("/video-player.html", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "frontend", "video-player.html"));
});

app.post("/api/export-flashcard-deck", extractUser, requireUser, (req, res) => {
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
