import { test } from "node:test";
import assert from "node:assert/strict";

import { clipFilename, DriveAuthError, DriveError } from "../site/js/drive.js";

test("clipFilename follows {rowIndex}-{word}-{kind}.wav", () => {
  assert.equal(clipFilename(7, "manzana", "word_es"), "7-manzana-word_es.wav");
});

test("clipFilename sanitizes spaces, case, and accented words", () => {
  assert.equal(
    clipFilename(12, "la Mañana", "phrase_es"),
    "12-la-mañana-phrase_es.wav",
  );
  assert.equal(clipFilename(3, "¿qué tal?", "word_en"), "3-qué-tal-word_en.wav");
});

test("DriveAuthError is a DriveError with status 401", () => {
  const err = new DriveAuthError("reconnect");
  assert.ok(err instanceof DriveError);
  assert.equal(err.status, 401);
  assert.equal(err.name, "DriveAuthError");
});
