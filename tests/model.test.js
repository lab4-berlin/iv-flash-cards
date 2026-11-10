import { test } from "node:test";
import assert from "node:assert/strict";

import { rowToWord, wordToStatsRow } from "../site/js/model.js";

const FULL_ROW = [
  "la manzana",
  "apple",
  "Como una manzana cada mañana.",
  "2026-11-01",
  "es",
  "4",
  "3",
  "1",
  "2026-11-08",
  "7",
  "2026-11-15",
];

test("rowToWord maps a fully populated row", () => {
  assert.deepEqual(rowToWord(FULL_ROW, 2), {
    word: "la manzana",
    translation: "apple",
    example: "Como una manzana cada mañana.",
    dateAdded: "2026-11-01",
    language: "es",
    timesShown: 4,
    timesRight: 3,
    timesWrong: 1,
    lastReviewed: "2026-11-08",
    intervalDays: 7,
    dueDate: "2026-11-15",
    rowIndex: 2,
  });
});

test("rowToWord: missing example becomes null", () => {
  const row = [...FULL_ROW];
  row[2] = "";
  assert.equal(rowToWord(row, 2).example, null);
});

test("rowToWord: empty app columns mean new word (zeros/nulls)", () => {
  // The Sheets API omits trailing empty cells, so a never-reviewed word
  // arrives as a 5-element row (A:E only).
  const word = rowToWord(["correr", "to run", "Me gusta correr.", "2026-11-10", "es"], 4);
  assert.equal(word.timesShown, 0);
  assert.equal(word.timesRight, 0);
  assert.equal(word.timesWrong, 0);
  assert.equal(word.lastReviewed, null);
  assert.equal(word.intervalDays, 0);
  assert.equal(word.dueDate, null);
  assert.equal(word.rowIndex, 4);
});

test("rowToWord: explicit empty strings in app columns also mean new word", () => {
  const word = rowToWord(["el perro", "dog", "", "2026-11-05", "es", "", "", "", "", "", ""], 3);
  assert.equal(word.example, null);
  assert.equal(word.timesShown, 0);
  assert.equal(word.lastReviewed, null);
  assert.equal(word.intervalDays, 0);
  assert.equal(word.dueDate, null);
});

test("wordToStatsRow produces the 6 F:K cells in order", () => {
  const word = rowToWord(FULL_ROW, 2);
  assert.deepEqual(wordToStatsRow(word), [4, 3, 1, "2026-11-08", 7, "2026-11-15"]);
});

test("wordToStatsRow: nulls become empty cells", () => {
  const word = rowToWord(["correr", "to run", "", "2026-11-10", "es"], 4);
  assert.deepEqual(wordToStatsRow(word), [0, 0, 0, "", 0, ""]);
});

test("round-trip: stats written then re-read map to the same word", () => {
  const original = rowToWord(FULL_ROW, 2);
  const statsRow = wordToStatsRow(original);
  // Simulate what the sheet would return after the write: user columns
  // unchanged, app columns replaced by what we wrote (as strings).
  const rereadRow = [...FULL_ROW.slice(0, 5), ...statsRow.map(String)];
  assert.deepEqual(rowToWord(rereadRow, 2), original);
});
