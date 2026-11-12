import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HEADER_ROW,
  sheetNeedsHeader,
  rowToWord,
  wordToStatsRow,
  wordToAudioRefsRow,
  wordToNewRow,
  firstRowOfRange,
} from "../site/js/model.js";

// Reviewed but not yet audio-enriched row (A:L) — user text incl. the
// phrase translation in D, plus the stats block G:L.
const FULL_ROW = [
  "la manzana",
  "apple",
  "Como una manzana cada mañana.",
  "I eat an apple every morning.",
  "2026-11-01",
  "es",
  "4",
  "3",
  "1",
  "2026-11-08",
  "7",
  "2026-11-15",
];

// Fully enriched 16-column row (A:P).
const ENRICHED_ROW = [
  ...FULL_ROW,
  "drive-word-es",
  "drive-phrase-es",
  "drive-word-en",
  "drive-phrase-en",
];

test("HEADER_ROW matches the #56 A:P column layout in order", () => {
  assert.deepEqual(HEADER_ROW, [
    "word",
    "translation",
    "example",
    "phrase_translation",
    "date_added",
    "language",
    "times_shown",
    "times_right",
    "times_wrong",
    "last_reviewed",
    "interval_days",
    "due_date",
    "audio_word_es",
    "audio_phrase_es",
    "audio_word_en",
    "audio_phrase_en",
  ]);
});

test("sheetNeedsHeader: a blank sheet (no values) needs the header", () => {
  // The Sheets API omits `values` entirely when A1:P1 is empty.
  assert.equal(sheetNeedsHeader(undefined), true);
  assert.equal(sheetNeedsHeader([]), true);
});

test("sheetNeedsHeader: any row-1 content leaves the sheet untouched", () => {
  assert.equal(sheetNeedsHeader([HEADER_ROW]), false);
  assert.equal(sheetNeedsHeader([["word"]]), false);
  assert.equal(sheetNeedsHeader([["something", "else"]]), false);
});

test("rowToWord maps a fully enriched A:P row", () => {
  assert.deepEqual(rowToWord(ENRICHED_ROW, 2), {
    word: "la manzana",
    translation: "apple",
    example: "Como una manzana cada mañana.",
    phraseTranslation: "I eat an apple every morning.",
    dateAdded: "2026-11-01",
    language: "es",
    timesShown: 4,
    timesRight: 3,
    timesWrong: 1,
    lastReviewed: "2026-11-08",
    intervalDays: 7,
    dueDate: "2026-11-15",
    audioWordEs: "drive-word-es",
    audioPhraseEs: "drive-phrase-es",
    audioWordEn: "drive-word-en",
    audioPhraseEn: "drive-phrase-en",
    rowIndex: 2,
  });
});

test("rowToWord: A:L row maps correctly, audio fields null", () => {
  const word = rowToWord(FULL_ROW, 2);
  assert.equal(word.word, "la manzana");
  assert.equal(word.phraseTranslation, "I eat an apple every morning.");
  assert.equal(word.timesShown, 4);
  assert.equal(word.dueDate, "2026-11-15");
  assert.equal(word.audioWordEs, null);
  assert.equal(word.audioPhraseEs, null);
  assert.equal(word.audioWordEn, null);
  assert.equal(word.audioPhraseEn, null);
});

test("rowToWord: missing example and phrase translation become null", () => {
  const row = [...FULL_ROW];
  row[2] = "";
  row[3] = "";
  const word = rowToWord(row, 2);
  assert.equal(word.example, null);
  assert.equal(word.phraseTranslation, null);
});

test("rowToWord: empty stats block means new word (zeros/nulls)", () => {
  // The Sheets API omits trailing empty cells, so a never-reviewed
  // hand-added word arrives as a 6-element row (user text A:F only).
  const word = rowToWord(
    ["correr", "to run", "Me gusta correr.", "", "2026-11-10", "es"],
    4,
  );
  assert.equal(word.phraseTranslation, null);
  assert.equal(word.timesShown, 0);
  assert.equal(word.timesRight, 0);
  assert.equal(word.timesWrong, 0);
  assert.equal(word.lastReviewed, null);
  assert.equal(word.intervalDays, 0);
  assert.equal(word.dueDate, null);
  assert.equal(word.rowIndex, 4);
});

test("rowToWord: explicit empty strings in the stats block also mean new word", () => {
  const word = rowToWord(
    ["el perro", "dog", "", "", "2026-11-05", "es", "", "", "", "", "", ""],
    3,
  );
  assert.equal(word.example, null);
  assert.equal(word.timesShown, 0);
  assert.equal(word.lastReviewed, null);
  assert.equal(word.intervalDays, 0);
  assert.equal(word.dueDate, null);
});

test("wordToStatsRow produces the 6 G:L cells in order", () => {
  const word = rowToWord(FULL_ROW, 2);
  assert.deepEqual(wordToStatsRow(word), [4, 3, 1, "2026-11-08", 7, "2026-11-15"]);
});

test("wordToStatsRow: nulls become empty cells", () => {
  const word = rowToWord(["correr", "to run", "", "", "2026-11-10", "es"], 4);
  assert.deepEqual(wordToStatsRow(word), [0, 0, 0, "", 0, ""]);
});

test("round-trip: stats written then re-read map to the same word", () => {
  const original = rowToWord(FULL_ROW, 2);
  const statsRow = wordToStatsRow(original);
  // Simulate what the sheet would return after the write: user text (A:F)
  // unchanged, stats block (G:L) replaced by what we wrote (as strings).
  const rereadRow = [...FULL_ROW.slice(0, 6), ...statsRow.map(String)];
  assert.deepEqual(rowToWord(rereadRow, 2), original);
});

test("wordToAudioRefsRow produces the 4 M:P cells in order", () => {
  const word = rowToWord(ENRICHED_ROW, 2);
  assert.deepEqual(wordToAudioRefsRow(word), [
    "drive-word-es",
    "drive-phrase-es",
    "drive-word-en",
    "drive-phrase-en",
  ]);
});

test("wordToAudioRefsRow: nulls become empty cells (regenerate convention)", () => {
  const word = rowToWord(FULL_ROW, 2);
  assert.deepEqual(wordToAudioRefsRow(word), ["", "", "", ""]);
});

test("wordToNewRow produces the 16 A:P cells in order", () => {
  const word = rowToWord(ENRICHED_ROW, 2);
  assert.deepEqual(wordToNewRow(word), [
    "la manzana",
    "apple",
    "Como una manzana cada mañana.",
    "I eat an apple every morning.",
    "2026-11-01",
    "es",
    4,
    3,
    1,
    "2026-11-08",
    7,
    "2026-11-15",
    "drive-word-es",
    "drive-phrase-es",
    "drive-word-en",
    "drive-phrase-en",
  ]);
});

test("round-trip: A:P row written then re-read maps to the same word", () => {
  const original = rowToWord(ENRICHED_ROW, 7);
  const rereadRow = wordToNewRow(original).map(String);
  assert.deepEqual(rowToWord(rereadRow, 7), original);
});

test("round-trip: new word with only user text set survives append and re-read", () => {
  const original = rowToWord(["correr", "to run", "", "", "2026-11-10", "es"], 9);
  const rereadRow = wordToNewRow(original).map(String);
  assert.deepEqual(rowToWord(rereadRow, 9), original);
});

test("firstRowOfRange parses the append response's updatedRange", () => {
  assert.equal(firstRowOfRange("Words!A12:P12"), 12);
  assert.equal(firstRowOfRange("'My Words'!AB3:AC4"), 3);
  assert.equal(firstRowOfRange("Words!A2"), 2);
});

test("firstRowOfRange is null on unparseable input", () => {
  assert.equal(firstRowOfRange(null), null);
  assert.equal(firstRowOfRange(undefined), null);
  assert.equal(firstRowOfRange(""), null);
  assert.equal(firstRowOfRange("Words"), null);
});
