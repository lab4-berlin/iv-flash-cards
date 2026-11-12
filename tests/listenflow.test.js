import { test } from "node:test";
import assert from "node:assert/strict";

import { nowPlayingLine, counterText, screenView } from "../site/js/listenflow.js";

const word = {
  word: "la ventana",
  translation: "the window",
  example: "Abre la ventana, por favor.",
  phraseTranslation: "Open the window, please.",
};

// ------------------------------------------------------- now-playing line

test("line is empty during the Spanish word clip and the gaps", () => {
  assert.equal(nowPlayingLine(word, "word_es"), "");
  assert.equal(nowPlayingLine(word, null), "");
});

test("line shows the clip being spoken: phrase, then the translations", () => {
  assert.equal(nowPlayingLine(word, "phrase_es"), "Abre la ventana, por favor.");
  assert.equal(nowPlayingLine(word, "word_en"), "the window");
  assert.equal(nowPlayingLine(word, "phrase_en"), "Open the window, please.");
});

test("line tolerates a missing word or missing text fields", () => {
  assert.equal(nowPlayingLine(null, "phrase_es"), "");
  assert.equal(nowPlayingLine({ ...word, example: null }, "phrase_es"), "");
  assert.equal(nowPlayingLine({ ...word, phraseTranslation: null }, "phrase_en"), "");
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
