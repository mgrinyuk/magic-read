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