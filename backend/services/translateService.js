import dotenv from "dotenv";
import { v2 as translateV2 } from "@google-cloud/translate";

dotenv.config();

const credentials = process.env.GOOGLE_TTS_KEY_JSON
  ? JSON.parse(process.env.GOOGLE_TTS_KEY_JSON)
  : null;

const translateClient = credentials
  ? new translateV2.Translate({
      credentials
    })
  : null;

function mapToGoogleTranslateLang(lang) {
  const map = {
    zh: "zh-CN",
    ru: "ru",
    tr: "tr",
    en: "en",
    de: "de"
  };

  return map[lang] || lang || "en";
}

export async function translateText(text, sourceLang, targetLang) {
  console.log("translateText called:", text, sourceLang, targetLang);

  if (!text) return "";

  if (!translateClient) {
    throw new Error("Google Translate is not configured");
  }

  const source = mapToGoogleTranslateLang(sourceLang);
  const target = mapToGoogleTranslateLang(targetLang);

  const [translation] = await translateClient.translate(text, {
    from: source,
    to: target
  });

  return Array.isArray(translation) ? translation[0] : translation;
}

// Translate an array of strings. Google Translate v2 rejects requests with
// more than 128 text segments, so long transcripts are sent in chunks.
const MAX_SEGMENTS_PER_REQUEST = 100;

export async function translateBatch(texts, sourceLang, targetLang) {
  if (!texts.length) return [];
  if (!translateClient) throw new Error("Google Translate is not configured");
  const source = mapToGoogleTranslateLang(sourceLang);
  const target = mapToGoogleTranslateLang(targetLang);
  const out = [];
  for (let i = 0; i < texts.length; i += MAX_SEGMENTS_PER_REQUEST) {
    const chunk = texts.slice(i, i + MAX_SEGMENTS_PER_REQUEST);
    const [result] = await translateClient.translate(chunk, { from: source, to: target });
    out.push(...(Array.isArray(result) ? result : [result]));
  }
  return out;
}