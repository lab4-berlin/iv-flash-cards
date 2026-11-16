import { test } from "node:test";
import assert from "node:assert/strict";

import { listenTexts, counterText, screenView } from "../site/js/listenflow.js";

const word = {
  word: "la ventana",
  translation: "the window",
  example: "Abre la ventana, por favor.",
  phraseTranslation: "Open the window, please.",
};

// ------------------------------------- the two now-playing slots (#90/#92)

test("word half (segments 0–3): the word on top, translation during 2–3 only", () => {
  // 0 word_es and 1 recall pause: recall moment — translation hidden.
  assert.deepEqual(listenTexts(word, 0), { big: "la ventana", line: "", phrase: false });
  assert.deepEqual(listenTexts(word, 1), { big: "la ventana", line: "", phrase: false });
  // 2 word_en and 3 breather: the confirmation stays readable.
  assert.deepEqual(listenTexts(word, 2), {
    big: "la ventana",
    line: "the window",
    phrase: false,
  });
  assert.deepEqual(listenTexts(word, 3), {
    big: "la ventana",
    line: "the window",
    phrase: false,
  });
});

test("phrase half (segments 4–7): the phrase on top, translation during 6–7 only", () => {
  // 4 phrase_es and 5 recall pause: Spanish phrase big, translation hidden.
  assert.deepEqual(listenTexts(word, 4), {
    big: "Abre la ventana, por favor.",
    line: "",
    phrase: true,
  });
  assert.deepEqual(listenTexts(word, 5), {
    big: "Abre la ventana, por favor.",
    line: "",
    phrase: true,
  });
  // 6 phrase_en and 7 separator: phrase translation below.
  assert.deepEqual(listenTexts(word, 6), {
    big: "Abre la ventana, por favor.",
    line: "Open the window, please.",
    phrase: true,
  });
  assert.deepEqual(listenTexts(word, 7), {
    big: "Abre la ventana, por favor.",
    line: "Open the window, please.",
    phrase: true,
  });
});

test("missing word or missing text fields yield empty strings, no crashes", () => {
  assert.deepEqual(listenTexts(null, 0), { big: "", line: "", phrase: false });
  assert.deepEqual(listenTexts(null, 4), { big: "", line: "", phrase: true });
  assert.equal(listenTexts({ ...word, word: null }, 0).big, "");
  assert.equal(listenTexts({ ...word, translation: null }, 2).line, "");
  assert.equal(listenTexts({ ...word, example: null }, 4).big, "");
  assert.equal(listenTexts({ ...word, phraseTranslation: null }, 6).line, "");
});

// --------------------------------------------------------- cycle counter

test("counter shows the position within the current cycle", () => {
  assert.equal(counterText({ position: 12, cycleSize: 87 }), "12 / 87");
  assert.equal(counterText({ position: 1, cycleSize: 1 }), "1 / 1");
});

// ------------------------------------------------- per-state screen view

test("playing: pause glyph, controls enabled, no captions", () => {
  assert.deepEqual(screenView("playing"), {
    screen: "player",
    glyph: "pause",
    playDisabled: false,
    loadingLine: false,
    pausedCaption: false,
  });
});

test("paused: play glyph plus the muted paused caption", () => {
  assert.deepEqual(screenView("paused"), {
    screen: "player",
    glyph: "play",
    playDisabled: false,
    loadingLine: false,
    pausedCaption: true,
  });
});

test("loading: play control disabled, loading line shown", () => {
  assert.deepEqual(screenView("loading"), {
    screen: "player",
    glyph: "play",
    playDisabled: true,
    loadingLine: true,
    pausedCaption: false,
  });
});

test("empty and error swap the player layout for a message", () => {
  assert.equal(screenView("empty").screen, "empty");
  assert.equal(screenView("error").screen, "error");
  assert.equal(screenView("idle").screen, "player");
});
