// Class assignments: input validation, speaking caps and the teacher's
// per-student summary.

export const MAX_STUDENTS_PER_ASSIGNMENT = 30;
export const MAX_ASSIGNMENT_SENTENCES = 200;
export const MAX_ASSIGNMENT_TEXT = 20000;

const LANG_RE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

// Tokens are crypto.randomBytes(16) in base64url (22 characters).
export function isAssignmentToken(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(value);
}

// A teacher's new assignment. Returns { value } or { error }.
export function validateAssignmentInput(body) {
  const text = String(body?.text || "").trim();
  const sentences = Array.isArray(body?.sentences)
    ? body.sentences.map(s => String(s || "").trim()).filter(Boolean)
    : [];
  const sourceLang = String(body?.sourceLang || "").trim();
  const targetLang = String(body?.targetLang || "").trim();
  const dueDate = body?.dueDate ? String(body.dueDate) : null;

  if (!text) return { error: "Text is required." };
  if (text.length > MAX_ASSIGNMENT_TEXT) return { error: "This text is too long for an assignment." };
  if (!sentences.length) return { error: "This text has no sentences." };
  if (sentences.length > MAX_ASSIGNMENT_SENTENCES) return { error: "This text is too long for an assignment." };
  if (!LANG_RE.test(sourceLang)) return { error: "Unknown text language." };
  if (targetLang && !LANG_RE.test(targetLang)) return { error: "Unknown translation language." };
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(new Date(`${dueDate}T00:00:00Z`).getTime()))) {
    return { error: "Invalid due date." };
  }

  const title = String(body?.title || "").trim().slice(0, 120) || sentences[0].slice(0, 60);
  return {
    value: {
      title,
      text,
      sentences: sentences.map(s => s.slice(0, 1000)),
      sourceLang,
      targetLang: targetLang || null,
      includeExercises: body?.includeExercises !== false,
      dueDate
    }
  };
}

// Speaking checks one student may use on one assignment: a few tries per
// sentence, so a class can't run up unbounded speech costs.
export function speechCheckLimit(sentenceCount) {
  return Math.min(400, Math.max(30, (Number(sentenceCount) || 0) * 5));
}

const toScore = v => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : undefined;
};
const toCount = (v, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
};

// A student's submitted result. Returns { value } (an assignment_attempts row
// without ids) or { error }.
export function validateAttempt(body, sentenceCount) {
  if (body?.kind === "speaking") {
    const raw = Array.isArray(body.sentenceScores) ? body.sentenceScores : null;
    if (!raw || raw.length !== sentenceCount) return { error: "These scores don't match the assignment." };
    const scores = raw.map(s => (s == null ? null : toScore(s)));
    if (scores.includes(undefined)) return { error: "Invalid score." };
    const counted = scores.filter(s => s != null);
    if (!counted.length) return { error: "No scores to submit." };
    return {
      value: {
        kind: "speaking",
        score: Math.round(counted.reduce((a, b) => a + b, 0) / counted.length),
        sentence_scores: scores,
        correct: null,
        skipped: null,
        total: null,
        mistakes: null
      }
    };
  }

  if (body?.kind === "exercises") {
    const total = toCount(body.total, 50);
    const correctRaw = toCount(body.correct, 50);
    const skippedRaw = toCount(body.skipped, 50);
    const mistakes = toCount(body.mistakes, 1000);
    if ([total, correctRaw, skippedRaw, mistakes].includes(undefined)) return { error: "Invalid exercise result." };
    const correct = Math.min(correctRaw, total);
    const skipped = Math.min(skippedRaw, total - correct);
    return {
      value: {
        kind: "exercises",
        score: total ? Math.round((correct / total) * 100) : null,
        sentence_scores: null,
        correct,
        skipped,
        total,
        mistakes
      }
    };
  }

  return { error: "Unknown result type." };
}

// The teacher's view of one student, from that student's attempts.
export function summarizeStudent(attempts = []) {
  const sorted = [...attempts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const speaking = sorted.filter(a => a.kind === "speaking");
  const exercises = sorted.filter(a => a.kind === "exercises");
  return {
    speaking: speaking.length
      ? {
          latest: speaking[0].score ?? null,
          best: Math.max(...speaking.map(a => a.score ?? 0)),
          attempts: speaking.length,
          sentenceScores: speaking[0].sentence_scores || []
        }
      : null,
    exercises: exercises.length
      ? {
          correct: exercises[0].correct ?? 0,
          total: exercises[0].total ?? 0,
          mistakes: exercises[0].mistakes ?? 0,
          attempts: exercises.length
        }
      : null,
    lastActivityAt: sorted[0]?.created_at || null
  };
}
