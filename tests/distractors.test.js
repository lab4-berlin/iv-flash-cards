import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  canAsk,
  choicesAvailable,
  pick,
  buildQuestion,
} from "../site/js/distractors.js";

/** Deterministic RNG (mulberry32) so sampling tests are reproducible. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWord(word, translation, language = "es") {
  return { word, translation, language };
}

/** es vocabulary with 6 distinct translations. */
function vocabulary() {
  return [
    makeWord("la mesa", "table"),
    makeWord("la ventana", "window"),
    makeWord("el bolígrafo", "pen"),
    makeWord("correr", "to run"),
    makeWord("el perro", "dog"),
    makeWord("el gato", "cat"),
  ];
}

describe("pick", () => {
  test("returns 3 distinct translations, never the correct answer", () => {
    const words = vocabulary();
    const correct = words[1]; // window
    for (let seed = 0; seed < 20; seed++) {
      const result = pick(words, correct, seededRandom(seed));
      assert.equal(result.length, 3);
      assert.equal(new Set(result).size, 3, "no duplicate distractors");
      assert.ok(!result.includes("window"), "never the correct answer");
      for (const t of result) {
        assert.ok(
          words.some((w) => w.translation === t),
          `${t} comes from the vocabulary`
        );
      }
    }
  });

  test("is deterministic for a given seed", () => {
    const words = vocabulary();
    assert.deepEqual(
      pick(words, words[0], seededRandom(7)),
      pick(words, words[0], seededRandom(7))
    );
  });

  test("samples uniformly: every candidate appears over many runs", () => {
    const words = vocabulary();
    const random = seededRandom(3);
    const counts = new Map();
    const runs = 1000;
    for (let i = 0; i < runs; i++) {
      for (const t of pick(words, words[0], random)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    assert.equal(counts.size, 5, "all 5 candidates get sampled");
    const expected = (runs * 3) / 5; // 3 slots over 5 candidates
    for (const [t, count] of counts) {
      assert.ok(
        Math.abs(count - expected) < expected * 0.15,
        `${t} drawn ${count} times, expected ~${expected}`
      );
    }
  });

  test("excludes words of another language", () => {
    const words = [
      makeWord("la mesa", "table"),
      makeWord("der Tisch", "desk", "de"),
      makeWord("das Fenster", "casement", "de"),
      makeWord("la ventana", "window"),
      makeWord("el bolígrafo", "pen"),
      makeWord("correr", "to run"),
    ];
    const result = pick(words, words[0], seededRandom(1));
    assert.deepEqual([...result].sort(), ["pen", "to run", "window"]);
  });

  test("excludes translations equal to the correct answer and duplicates of each other", () => {
    const words = [
      makeWord("la mesa", "table"),
      makeWord("el escritorio", "table"), // same text as the answer — excluded
      makeWord("la ventana", "window"),
      makeWord("el cristal", "window"), // duplicate translation — counted once
      makeWord("el bolígrafo", "pen"),
      makeWord("correr", "to run"),
    ];
    const result = pick(words, words[0], seededRandom(1));
    assert.deepEqual([...result].sort(), ["pen", "to run", "window"]);
  });

  test("returns null with fewer than 3 valid distractors", () => {
    const words = vocabulary().slice(0, 3); // 2 candidates for any word
    assert.equal(pick(words, words[0], seededRandom(1)), null);
  });

  test("returns null when the asked word has no translation", () => {
    const words = [makeWord("la mesa", ""), ...vocabulary().slice(1)];
    assert.equal(pick(words, words[0], seededRandom(1)), null);
  });

  test("words with empty translations are not candidates", () => {
    const words = [
      makeWord("la mesa", "table"),
      makeWord("x", ""),
      makeWord("y", ""),
      makeWord("z", ""),
      makeWord("la ventana", "window"),
    ];
    assert.equal(pick(words, words[0], seededRandom(1)), null);
  });

  test("does not mutate the vocabulary", () => {
    const words = vocabulary();
    const before = words.map((w) => w.translation);
    pick(words, words[2], seededRandom(5));
    assert.deepEqual(
      words.map((w) => w.translation),
      before
    );
  });
});

describe("buildQuestion", () => {
  test("4 options: the correct answer at correctIndex + the 3 distractors", () => {
    const words = vocabulary();
    for (let seed = 0; seed < 20; seed++) {
      const q = buildQuestion(words, words[1], seededRandom(seed));
      assert.equal(q.options.length, 4);
      assert.equal(q.options[q.correctIndex], "window");
      assert.equal(new Set(q.options).size, 4);
    }
  });

  test("the correct answer lands on every position across seeds", () => {
    const words = vocabulary();
    const positions = new Set();
    for (let seed = 0; seed < 50; seed++) {
      positions.add(buildQuestion(words, words[0], seededRandom(seed)).correctIndex);
    }
    assert.deepEqual([...positions].sort(), [0, 1, 2, 3]);
  });

  test("returns null when no question can be built", () => {
    const words = vocabulary().slice(0, 3);
    assert.equal(buildQuestion(words, words[0], seededRandom(1)), null);
  });
});

describe("canAsk / choicesAvailable", () => {
  test("available with 4 same-language words with distinct translations", () => {
    const words = vocabulary().slice(0, 4);
    assert.equal(choicesAvailable(words), true);
    for (const word of words) assert.equal(canAsk(words, word), true);
  });

  test("unavailable below 4 words (the issue's rule)", () => {
    const words = vocabulary().slice(0, 3);
    assert.equal(choicesAvailable(words), false);
    assert.equal(choicesAvailable([]), false);
  });

  test("duplicate translations don't count toward the minimum", () => {
    const words = [
      makeWord("la mesa", "table"),
      makeWord("la ventana", "window"),
      makeWord("el cristal", "window"),
      makeWord("el bolígrafo", "pen"),
    ];
    // "la mesa" sees only window + pen as distinct distractors.
    assert.equal(canAsk(words, words[0]), false);
    assert.equal(choicesAvailable(words), false);
  });

  test("unavailable when any word can't be asked (mixed languages)", () => {
    const words = [
      ...vocabulary(), // 6 askable es words
      makeWord("der Hund", "hound", "de"), // no de distractors at all
    ];
    assert.equal(canAsk(words, words[0]), true);
    assert.equal(canAsk(words, words[6]), false);
    assert.equal(choicesAvailable(words), false);
  });

  test("a word with an empty translation makes the mode unavailable", () => {
    const words = [...vocabulary(), makeWord("roto", "")];
    assert.equal(choicesAvailable(words), false);
  });
});
