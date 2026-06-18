const ENGLISH_FALLBACK = {
  readModeTitle: "Read and understand any text",
  readModeHint: "Paste an article, story, or lesson to get audio, translation, and reading exercises.",
  startReading: "Start reading",
  speakModeTitle: "Practice pronunciation with your own texts",
  speakModeHint: "Paste homework, dialogue, or exam text and get sentence-by-sentence speaking feedback.",
  startSpeaking: "Start speaking"
};

export function getModeCopy(mode, translations = {}) {
  const t = { ...ENGLISH_FALLBACK, ...translations };
  if (mode === "reading") {
    return {
      title: t.readModeTitle,
      hint: t.readModeHint,
      action: t.startReading
    };
  }

  return {
    title: t.speakModeTitle,
    hint: t.speakModeHint,
    action: t.startSpeaking
  };
}
