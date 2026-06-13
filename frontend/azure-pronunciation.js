/* =============================================================
   Azure pronunciation assessment (browser SDK)

   Flow: fetch a short-lived token from our backend (the metering
   gate) -> stream mic audio straight to Azure -> return scores.
   The Azure key never touches the browser.

   Exposes:
     assessPronunciation(referenceText, lang, { tokenUrl, fetchWithAuth })
       -> resolves { transcript, accuracy, fluency, completeness,
                     pronunciation, prosody, words: [{word, accuracy, errorType}] }
       -> rejects with err.code in:
            NO_AUTH | NOT_CONFIGURED | QUOTA_EXCEEDED | TOKEN_FAILED
            SDK_LOAD_FAILED | NO_SPEECH | MIC_DENIED | CANCELED | SDK_ERROR
     renderAssessment(result, lang) -> HTML string for the result box
   ============================================================= */

const SPEECH_SDK_URL =
  "https://cdn.jsdelivr.net/npm/microsoft-cognitiveservices-speech-sdk@1.40.0/distrib/browser/microsoft.cognitiveservices.speech.sdk.bundle-min.js";

let sdkPromise = null;

function loadSpeechSDK() {
  if (typeof window !== "undefined" && window.SpeechSDK) {
    return Promise.resolve(window.SpeechSDK);
  }
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SPEECH_SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.SpeechSDK) resolve(window.SpeechSDK);
      else reject(makeErr("Speech SDK loaded but global missing", "SDK_LOAD_FAILED"));
    };
    script.onerror = () => {
      sdkPromise = null; // allow retry
      reject(makeErr("Failed to load Speech SDK", "SDK_LOAD_FAILED"));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

function makeErr(message, code, info) {
  const e = new Error(message);
  e.code = code;
  if (info) e.info = info;
  return e;
}

function extractWords(detailJson) {
  try {
    const words = detailJson?.NBest?.[0]?.Words || [];
    return words.map((w) => ({
      word: w.Word,
      accuracy: w.PronunciationAssessment?.AccuracyScore ?? null,
      errorType: w.PronunciationAssessment?.ErrorType ?? "None"
    }));
  } catch {
    return [];
  }
}

export async function assessPronunciation(referenceText, lang, { tokenUrl, fetchWithAuth }) {
  // 1) Token — this is the quota gate. Non-200 carries a typed code.
  const res = await fetchWithAuth(tokenUrl, { method: "POST" });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const code =
      data.code ||
      (res.status === 401 ? "NO_AUTH" : res.status === 429 ? "QUOTA_EXCEEDED" : "TOKEN_FAILED");
    throw makeErr(data.error || "Could not get speech token", code, data);
  }
  const { token, region } = data;

  // 2) SDK + assessment config
  const SpeechSDK = await loadSpeechSDK();

  const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = lang;

  const audioConfig = SpeechSDK.AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);

  const paConfig = new SpeechSDK.PronunciationAssessmentConfig(
    referenceText,
    SpeechSDK.PronunciationAssessmentGradingSystem.HundredMark,
    SpeechSDK.PronunciationAssessmentGranularity.Phoneme,
    true // enableMiscue: detect omissions/insertions
  );
  // Prosody (intonation/rhythm) is only supported for en-* locales.
  if (String(lang).toLowerCase().startsWith("en")) {
    paConfig.enableProsodyAssessment = true;
  }
  paConfig.applyTo(recognizer);

  // 3) One-shot recognition
  return new Promise((resolve, reject) => {
    recognizer.recognizeOnceAsync(
      (result) => {
        try {
          if (result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
            const pa = SpeechSDK.PronunciationAssessmentResult.fromResult(result);
            let detail = {};
            try {
              detail = JSON.parse(
                result.properties.getProperty(
                  SpeechSDK.PropertyId.SpeechServiceResponse_JsonResult
                )
              );
            } catch {
              /* keep empty */
            }
            resolve({
              transcript: result.text || "",
              accuracy: pa.accuracyScore,
              fluency: pa.fluencyScore,
              completeness: pa.completenessScore,
              pronunciation: pa.pronunciationScore,
              prosody: pa.prosodyScore ?? null,
              words: extractWords(detail)
            });
          } else if (result.reason === SpeechSDK.ResultReason.NoMatch) {
            reject(makeErr("No speech recognized", "NO_SPEECH"));
          } else if (result.reason === SpeechSDK.ResultReason.Canceled) {
            const c = SpeechSDK.CancellationDetails.fromResult(result);
            const denied = /denied|permission/i.test(c.errorDetails || "");
            reject(
              makeErr(c.errorDetails || "Recognition canceled", denied ? "MIC_DENIED" : "CANCELED")
            );
          } else {
            reject(makeErr("Recognition failed", "SDK_ERROR"));
          }
        } catch (e) {
          reject(makeErr(e.message || "Assessment parse error", "SDK_ERROR"));
        } finally {
          recognizer.close();
        }
      },
      (err) => {
        try {
          recognizer.close();
        } catch {
          /* ignore */
        }
        reject(makeErr(String(err) || "SDK error", "SDK_ERROR"));
      }
    );
  });
}

// Color a 0–100 score.
function scoreColor(score) {
  if (score == null) return "#888";
  if (score >= 80) return "#1a8a3a";
  if (score >= 60) return "#c8860a";
  return "#c0392b";
}

// Build the result HTML for the .pronunciation-box / flashcard result element.
export function renderAssessment(result, lang) {
  const overall = Math.round(result.pronunciation ?? result.accuracy ?? 0);
  const isEn = String(lang).toLowerCase().startsWith("en");

  const wordsHtml = (result.words || [])
    .map((w) => {
      const bad = w.errorType && w.errorType !== "None";
      const color = bad ? "#c0392b" : scoreColor(w.accuracy);
      const title = `${w.errorType !== "None" ? w.errorType + " · " : ""}${
        w.accuracy != null ? Math.round(w.accuracy) + "%" : ""
      }`;
      return `<span class="pa-word" style="color:${color}" title="${title}">${escapeHtml(
        w.word
      )}</span>`;
    })
    .join(" ");

  const metrics = [
    ["Accuracy", result.accuracy],
    ["Fluency", result.fluency],
    ["Completeness", result.completeness],
    isEn ? ["Prosody", result.prosody] : null
  ].filter(Boolean);

  const metricsHtml = metrics
    .map(
      ([label, val]) =>
        `<span class="pa-metric">${label}: <strong style="color:${scoreColor(
          val
        )}">${val == null ? "–" : Math.round(val)}</strong></span>`
    )
    .join(" · ");

  return `
    <div class="pa-result">
      <p class="pa-overall">Pronunciation: <strong style="color:${scoreColor(
        overall
      )}">${overall}%</strong></p>
      ${wordsHtml ? `<p class="pa-words">${wordsHtml}</p>` : ""}
      <p class="pa-metrics">${metricsHtml}</p>
      ${result.transcript ? `<p class="pa-heard">Heard: ${escapeHtml(result.transcript)}</p>` : ""}
    </div>
  `;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
