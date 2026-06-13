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
// Mic permission persists once granted. Re-opening getUserMedia before every
// check (especially several drill chunks in a row) churns the audio device and
// can make a later capture come back silent. So we warm up once per session.
let micWarmedUp = false;

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
  // 0) Acquire mic permission up-front, while the user gesture is still active.
  //    Safari is strict: if the mic is only requested AFTER the async token
  //    fetch below, it opens the mic but records silence ("didn't hear you").
  //    We release this warm-up stream immediately; the granted permission
  //    persists for the SDK's own capture a moment later.
  if (!micWarmedUp && navigator.mediaDevices?.getUserMedia) {
    let warmup = null;
    try {
      warmup = await navigator.mediaDevices.getUserMedia({ audio: true });
      micWarmedUp = true;
    } catch {
      throw makeErr("Microphone is blocked or unavailable", "MIC_DENIED");
    } finally {
      if (warmup) warmup.getTracks().forEach((tr) => tr.stop());
    }
  }

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
  // Be forgiving about start latency: there's a beat between tapping "Repeat"
  // and the recognizer actually listening (token + SDK init). A longer initial
  // silence window stops short drill clips from returning "no speech" when the
  // user starts a moment late.
  try {
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      "10000"
    );
    speechConfig.setProperty(
      SpeechSDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      "1200"
    );
  } catch {
    /* property names vary across SDK builds; safe to skip */
  }

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

// The per-word accuracy below which a word is treated as "not green" — must
// match the green threshold used in scoreColor / renderAssessment (80).
export const GREEN_THRESHOLD = 80;

// Group the words that didn't get a green light into drillable chunks.
// A word is "bad" if Azure flagged it (Mispronunciation / Omission) or its
// accuracy is below `threshold`. Consecutive bad words are merged into one
// chunk so the learner drills a natural phrase, not stray syllables.
// Insertions (extra words not in the reference text) are skipped — there's
// nothing to model or re-say for them — and they break the current run.
export function collectFailedChunks(result, lang, threshold = GREEN_THRESHOLD) {
  const words = result?.words || [];
  const isCJK = /^(zh|ja)/i.test(String(lang));
  const joiner = isCJK ? "" : " ";
  const chunks = [];
  let current = null;

  const flush = () => {
    if (current && current.length) {
      chunks.push({
        text: current.map((w) => w.word).join(joiner),
        words: current
      });
    }
    current = null;
  };

  for (const w of words) {
    const errorType = w.errorType || "None";
    if (errorType === "Insertion") {
      flush();
      continue;
    }
    const bad = errorType !== "None" || (w.accuracy != null && w.accuracy < threshold);
    if (bad) {
      if (!current) current = [];
      current.push(w);
    } else {
      flush();
    }
  }
  flush();
  return chunks;
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
