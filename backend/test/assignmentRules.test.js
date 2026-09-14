import test from "node:test";
import assert from "node:assert/strict";

import {
  isAssignmentToken,
  speechCheckLimit,
  summarizeStudent,
  validateAssignmentInput,
  validateAttempt
} from "../lib/assignmentRules.js";

const base = {
  text: "Hola. ¿Cómo estás?",
  sentences: ["Hola.", "¿Cómo estás?"],
  sourceLang: "es",
  targetLang: "en"
};

test("assignment tokens must look like generated tokens", () => {
  assert.equal(isAssignmentToken("Q2hlY2tpbmdUb2tlbl8tYQ"), true);
  assert.equal(isAssignmentToken("short"), false);
  assert.equal(isAssignmentToken(null), false);
});

test("a valid assignment gets a default title and exercises on", () => {
  const { value, error } = validateAssignmentInput(base);
  assert.equal(error, undefined);
  assert.equal(value.title, "Hola.");
  assert.equal(value.includeExercises, true);
  assert.equal(value.dueDate, null);
});

test("assignment input is checked", () => {
  assert.ok(validateAssignmentInput({ ...base, text: "" }).error);
  assert.ok(validateAssignmentInput({ ...base, sentences: [] }).error);
  assert.ok(validateAssignmentInput({ ...base, sentences: new Array(201).fill("x") }).error);
  assert.ok(validateAssignmentInput({ ...base, sourceLang: "spanish" }).error);
  assert.ok(validateAssignmentInput({ ...base, dueDate: "next week" }).error);
  assert.equal(validateAssignmentInput({ ...base, dueDate: "2026-10-01", includeExercises: false }).value.includeExercises, false);
});

test("speaking checks are capped per student", () => {
  assert.equal(speechCheckLimit(2), 30);
  assert.equal(speechCheckLimit(20), 100);
  assert.equal(speechCheckLimit(200), 400);
});

test("speaking results average the scored sentences", () => {
  const { value } = validateAttempt({ kind: "speaking", sentenceScores: [80, null, 91.4] }, 3);
  assert.equal(value.score, 86);
  assert.deepEqual(value.sentence_scores, [80, null, 91]);
  assert.ok(validateAttempt({ kind: "speaking", sentenceScores: [80] }, 3).error);
  assert.ok(validateAttempt({ kind: "speaking", sentenceScores: [null, null] }, 2).error);
  assert.ok(validateAttempt({ kind: "speaking", sentenceScores: [120, 50] }, 2).error);
});

test("exercise results are kept within the total", () => {
  const { value } = validateAttempt({ kind: "exercises", total: 4, correct: 6, skipped: 2, mistakes: 3 }, 10);
  assert.deepEqual([value.correct, value.skipped, value.score], [4, 0, 100]);
  assert.ok(validateAttempt({ kind: "exercises", total: "x", correct: 1, skipped: 0, mistakes: 0 }, 10).error);
  assert.ok(validateAttempt({ kind: "quiz" }, 10).error);
});

test("the teacher sees the latest and best attempts per student", () => {
  const summary = summarizeStudent([
    { kind: "speaking", score: 70, sentence_scores: [70], created_at: "2026-09-14T10:00:00Z" },
    { kind: "speaking", score: 90, sentence_scores: [90], created_at: "2026-09-14T09:00:00Z" },
    { kind: "exercises", correct: 3, total: 4, mistakes: 2, created_at: "2026-09-14T08:00:00Z" }
  ]);
  assert.deepEqual(summary.speaking, { latest: 70, best: 90, attempts: 2, sentenceScores: [70] });
  assert.deepEqual(summary.exercises, { correct: 3, total: 4, mistakes: 2, attempts: 1 });
  assert.equal(summary.lastActivityAt, "2026-09-14T10:00:00Z");
  assert.deepEqual(summarizeStudent([]), { speaking: null, exercises: null, lastActivityAt: null });
});
