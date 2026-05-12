import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { translateText } from "./services/translateService.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import textToSpeech from "@google-cloud/text-to-speech";
import nodejieba from "nodejieba";
import { pinyin } from "pinyin-pro";
import { google } from "googleapis";
import PDFDocument from "pdfkit";
import Papa from "papaparse";


// optional, but recommended for better word coverage
dotenv.config();

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
const googleCredentials = process.env.GOOGLE_TTS_KEY_JSON
  ? JSON.parse(process.env.GOOGLE_TTS_KEY_JSON)
  : undefined;

const ttsClient = new textToSpeech.TextToSpeechClient({
  credentials: googleCredentials
});


app.use(cors());
app.use(express.json());

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

app.post("/api/create-writing-sheet", (req, res) => {
  try {
    const { text, sourceLang } = req.body || {};

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    const lang = (sourceLang || "zh").trim();

    const outputDir = path.join(__dirname, "public", "worksheets");
    fs.mkdirSync(outputDir, { recursive: true });

    const filename = `writing-sheet-${lang}-${Date.now()}.pdf`;
    const filepath = path.join(outputDir, filename);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

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

      const boxSize = 40;
      const cols = 12;
      const rows = 18;
      const itemsPerPage = rows;

      const startX = 50;
      const startY = 70;

      const zhFontPath = path.join(__dirname, "fonts", "NotoSansSC-Regular.ttf");

      const totalPages = Math.max(1, Math.ceil(words.length / itemsPerPage));

      for (let page = 0; page < totalPages; page++) {
        if (page > 0) doc.addPage();

        doc
          .font("Helvetica-Bold")
          .fontSize(18)
          .fillColor("#333")
          .text("Chinese writing practice", 50, 40);

        const pageWords = words.slice(
          page * itemsPerPage,
          page * itemsPerPage + itemsPerPage
        );

        for (let row = 0; row < rows; row++) {
          const word = pageWords[row];

          for (let col = 0; col < cols; col++) {
            const x = startX + col * boxSize;
            const y = startY + row * boxSize;

            doc.rect(x, y, boxSize, boxSize).stroke("#999");
            doc.moveTo(x + boxSize / 2, y).lineTo(x + boxSize / 2, y + boxSize).stroke("#ccc");
            doc.moveTo(x, y + boxSize / 2).lineTo(x + boxSize, y + boxSize / 2).stroke("#ccc");
            doc.moveTo(x, y).lineTo(x + boxSize, y + boxSize).stroke("#ddd");
            doc.moveTo(x + boxSize, y).lineTo(x, y + boxSize).stroke("#ddd");

            const currentChar = word?.[col];

            if (currentChar) {
              if (fs.existsSync(fontPath)) {
                doc.font(fontPath);
              } else {
                doc.font("Helvetica");
              }

              doc
                .fontSize(22)
                .fillColor("#333")
                .text(currentChar, x, y + 5, {
                  width: boxSize,
                  align: "center",
                  lineBreak: false
                });
            }
          }
        }
      }
    }

    doc.end();

    stream.on("finish", () => {
      res.json({
        fileUrl: `${req.protocol}://${req.get("host")}/worksheets/${filename}`
      });
    });
  } catch (error) {
    console.error("Writing sheet error:", error);
    res.status(500).json({ error: "Could not create writing sheet" });
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


app.post("/api/split-text", (req, res) => {
  const { text } = req.body || {};

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  const sentences =
    text
      .match(/[^.!?。！？]+[.!?。！？]?/g)
      ?.map(s => s.trim())
      .filter(Boolean) || [];

  res.json({ sentences });
});

app.post("/api/segment", (req, res) => {
  const { text } = req.body;

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    let words = [];

    // 1. Best option: nodejieba
    try {
      words = nodejieba.cut(text, true); // true = HMM mode, better for unknown words
    } catch (jiebaError) {
      console.error("nodejieba failed:", jiebaError);
    }

    // 2. If nodejieba fails or gives mostly single characters, use Intl.Segmenter
    const mostlySingleChars =
      words.length > 0 &&
      words.filter(w => /[\u4e00-\u9fff]/.test(w) && w.length === 1).length / words.length > 0.7;

    if (!words.length || mostlySingleChars) {
      try {
        const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

        words = Array.from(segmenter.segment(text))
          .map(item => item.segment)
          .filter(item => item.trim());
      } catch (intlError) {
        console.error("Intl.Segmenter failed:", intlError);
      }
    }

    // 3. Last fallback only
    if (!words.length) {
      words = [...text].filter(char => char.trim());
    }

    const result = words.map(word => ({
      word,
      pinyin: /[\u4e00-\u9fff]/.test(word)
        ? pinyin(word, { toneType: "symbol", type: "array" }).join(" ")
        : ""
    }));

    res.json({ words: result });
  } catch (error) {
    console.error("Segmentation route error:", error);
    res.status(500).json({ error: "Segmentation failed" });
  }
});

app.post("/api/dictionary", (req, res) => {
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

app.post("/api/tts", async (req, res) => {
  try {
    const { text, sourceLang, speakingRate } = req.body;

    if (!text || !sourceLang) {
      return res.status(400).json({ error: "text and sourceLang are required" });
    }

    const voiceMap = {
      zh: {
        languageCode: "cmn-CN",
        name: "cmn-CN-Wavenet-A"
      },
      tr: {
        languageCode: "tr-TR",
        name: "tr-TR-Wavenet-A"
      },
      ru: {
        languageCode: "ru-RU",
        name: "ru-RU-Wavenet-A"
      },
      en: {
        languageCode: "en-US",
        name: "en-US-Wavenet-D"
      },
      de: {
        languageCode: "de-DE",
        name: "de-DE-Wavenet-A"
      },
      es: {
        languageCode: "es-ES",
        name: "es-ES-Wavenet-C"
      },
      fr: {
        languageCode: "fr-FR",
        name: "fr-FR-Wavenet-D"
      },
      ja: {
        languageCode: "ja-JP"
      }
    };

    const voiceConfig = voiceMap[sourceLang] || voiceMap.en;

    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: voiceConfig,
      audioConfig: {
        audioEncoding: "MP3",
        speakingRate: speakingRate || 1.0
      }
    });

    if (!response.audioContent) {
      return res.status(500).json({ error: "No audio returned from TTS" });
    }

    res.json({
      audioBase64: response.audioContent.toString("base64"),
      mimeType: "audio/mpeg"
    });
  } catch (error) {
    console.error("TTS route error:", error);
    res.status(500).json({ error: "TTS generation failed" });
  }
});


app.post("/api/translate", async (req, res) => {
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

      if (sourceLang !== "zh") {
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

app.post("/api/admin/reload-grammar", async (req, res) => {
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

    const sentences = row.text
      .match(/[^.!?。！？]+[.!?。！？]?/g)
      ?.map(s => s.trim())
      .filter(Boolean) || [];

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

    const outputDir = path.join(__dirname, "public", "exports");
    fs.mkdirSync(outputDir, { recursive: true });

    const safeName =
      deckName
        .toLowerCase()
        .replace(/[^a-z0-9\u0400-\u04ff\u4e00-\u9fff]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 50) || "deck";

    const filename = `${safeName}-${Date.now()}.pdf`;
    const filepath = path.join(outputDir, filename);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const boxSize = 40;
    const cols = 12;
    const rows = 18;
    const itemsPerPage = rows;
    const startX = 50;
    const startY = 70;

    const fontPath = path.join(__dirname, "fonts", "NotoSansSC-Regular.ttf");
    const totalPages = Math.max(1, Math.ceil(items.length / itemsPerPage));

    for (let page = 0; page < totalPages; page++) {
      if (page > 0) doc.addPage();

      doc
        .font("Helvetica-Bold")
        .fontSize(18)
        .fillColor("#333")
        .text(`Deck: ${deckName}`, 50, 40);

      const pageItems = items.slice(
        page * itemsPerPage,
        page * itemsPerPage + itemsPerPage
      );

      for (let row = 0; row < rows; row++) {
        const item = pageItems[row];

        for (let col = 0; col < cols; col++) {
          const x = startX + col * boxSize;
          const y = startY + row * boxSize;

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

            doc
              .fontSize(22)
              .fillColor("#333")
              .text(currentChar, x, y + 5, {
                width: boxSize,
                align: "center",
                lineBreak: false
              });
          }
                  }
      }
    }

    doc.end();

    stream.on("finish", () => {
      res.json({
        fileUrl: `${req.protocol}://${req.get("host")}/exports/${filename}`
      });
    });
  } catch (error) {
    console.error("Flashcard deck export error:", error);
    res.status(500).json({ error: "Could not export deck" });
  }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});