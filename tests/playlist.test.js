import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  GAP_MS,
  DEFAULT_BLOCK_MS,
  eligibleWords,
  shuffle,
  wordSequence,
  buildBlockPlan,
} from "../site/js/playlist.js";

/** Deterministic RNG (mulberry32) so shuffle tests are reproducible. */
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

/** A fully enriched word whose four clip IDs are `<id>-wes` etc. */
function makeWord(id) {
  return {
    word: id,
    audioWordEs: `${id}-wes`,
    audioPhraseEs: `${id}-pes`,
    audioWordEn: `${id}-wen`,
    audioPhraseEn: `${id}-pen`,
  };
}

/** Durations map giving every clip of `words` the same length. */
function uniformDurations(words, ms) {
  const map = new Map();
  for (const w of words) {
    for (const id of [w.audioWordEs, w.audioPhraseEs, w.audioWordEn, w.audioPhraseEn]) {
      map.set(id, ms);
    }
  }
  return map;
}

const AUDIO_FIELD_NAMES = ["audioWordEs", "audioPhraseEs", "audioWordEn", "audioPhraseEn"];

describe("eligibleWords", () => {
  test("keeps only words with all four clip IDs", () => {
    const complete = makeWord("a");
    const missingOne = AUDIO_FIELD_NAMES.map((field) => ({
      ...makeWord(`missing-${field}`),
      [field]: null,
    }));
    const neverEnriched = { word: "plain" };
    const result = eligibleWords([complete, ...missingOne, neverEnriched]);
    assert.deepEqual(result, [complete]);
  });

  test("empty cells (empty string) also exclude a word", () => {
    const word = { ...makeWord("a"), audioPhraseEn: "" };
    assert.deepEqual(eligibleWords([word]), []);
  });

  test("returns a new array and handles the empty pool", () => {
    const words = [makeWord("a")];
    assert.notEqual(eligibleWords(words), words);
    assert.deepEqual(eligibleWords([]), []);
  });
});

describe("shuffle", () => {
  test("returns a permutation without mutating the input", () => {
    const words = ["a", "b", "c", "d", "e"].map(makeWord);
    const result = shuffle(words, seededRandom(1));
    assert.deepEqual(
      words.map((w) => w.word),
      ["a", "b", "c", "d", "e"]
    );
    assert.deepEqual(
      result.map((w) => w.word).sort(),
      ["a", "b", "c", "d", "e"]
    );
  });

  test("is deterministic for a given seed", () => {
    const words = ["a", "b", "c", "d", "e"].map(makeWord);
    const first = shuffle(words, seededRandom(42)).map((w) => w.word);
    const second = shuffle(words, seededRandom(42)).map((w) => w.word);
    assert.deepEqual(first, second);
  });

  test("fairness basics: every permutation of 3 items shows up, roughly evenly", () => {
    const random = seededRandom(7);
    const counts = new Map();
    const runs = 1200;
    for (let i = 0; i < runs; i++) {
      const key = shuffle(["a", "b", "c"], random).join("");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    assert.equal(counts.size, 6, "all 6 permutations occur");
    const expected = runs / 6;
    for (const [key, count] of counts) {
      assert.ok(
        Math.abs(count - expected) < expected * 0.25,
        `permutation ${key} occurred ${count} times, expected ~${expected}`
      );
    }
  });
});

describe("wordSequence", () => {
  test("matches the fixed #29 flow: es word · gap · es phrase · gap · en word · en phrase", () => {
    assert.deepEqual(wordSequence(makeWord("a")), [
      { type: "clip", fileId: "a-wes" },
      { type: "gap", ms: GAP_MS },
      { type: "clip", fileId: "a-pes" },
      { type: "gap", ms: GAP_MS },
      { type: "clip", fileId: "a-wen" },
      { type: "clip", fileId: "a-pen" },
    ]);
  });

  test("the gap is 2 seconds", () => {
    assert.equal(GAP_MS, 2000);
  });
});

describe("buildBlockPlan", () => {
  // Each word: 4 clips of 1000 ms + two 2000 ms gaps = 8000 ms.
  const WORD_MS = 8000;

  test("takes whole words until the target is reached; boundaries on word boundaries", () => {
    const words = ["a", "b", "c", "d", "e"].map(makeWord);
    const durations = uniformDurations(words, 1000);
    // Target 20s: a (8s) + b (16s) still short of 20s, c crosses it.
    const plan = buildBlockPlan(words, 20000, durations);
    assert.deepEqual(
      plan.cues.map((cue) => cue.word.word),
      ["a", "b", "c"]
    );
    assert.equal(plan.totalMs, 3 * WORD_MS);
    assert.equal(plan.segments.length, 3 * 6, "no word is split across blocks");
    assert.deepEqual(
      plan.segments.slice(-2).map((s) => s.fileId),
      ["c-wen", "c-pen"],
      "block ends exactly at the last word's final clip"
    );
    assert.deepEqual(
      plan.remaining.map((w) => w.word),
      ["d", "e"]
    );
  });

  test("cue offsets point at each word's start", () => {
    const words = ["a", "b", "c"].map(makeWord);
    const durations = uniformDurations(words, 1000);
    const plan = buildBlockPlan(words, 30000, durations);
    assert.deepEqual(
      plan.cues.map((cue) => cue.startMs),
      [0, WORD_MS, 2 * WORD_MS]
    );
  });

  test("cue offsets track varying clip durations", () => {
    const [a, b] = ["a", "b"].map(makeWord);
    const durations = new Map([
      ["a-wes", 700],
      ["a-pes", 2500],
      ["a-wen", 600],
      ["a-pen", 3200],
      ["b-wes", 500],
      ["b-pes", 1500],
      ["b-wen", 400],
      ["b-pen", 2000],
    ]);
    const aMs = 700 + 2500 + 600 + 3200 + 2 * GAP_MS;
    const bMs = 500 + 1500 + 400 + 2000 + 2 * GAP_MS;
    const plan = buildBlockPlan([a, b], 60000, durations);
    assert.deepEqual(
      plan.cues.map((cue) => cue.startMs),
      [0, aMs]
    );
    assert.equal(plan.totalMs, aMs + bMs);
  });

  test("a queue shorter than the target yields a short final block", () => {
    const words = [makeWord("a")];
    const plan = buildBlockPlan(words, DEFAULT_BLOCK_MS, uniformDurations(words, 1000));
    assert.equal(plan.cues.length, 1);
    assert.equal(plan.totalMs, WORD_MS);
    assert.deepEqual(plan.remaining, []);
  });

  test("empty queue yields an empty plan", () => {
    assert.deepEqual(buildBlockPlan([], DEFAULT_BLOCK_MS, new Map()), {
      segments: [],
      cues: [],
      totalMs: 0,
      remaining: [],
    });
  });

  test("does not mutate the queue", () => {
    const words = ["a", "b"].map(makeWord);
    buildBlockPlan(words, 1, uniformDurations(words, 1000));
    assert.equal(words.length, 2);
  });

  test("defaults to a ~10-minute target", () => {
    assert.equal(DEFAULT_BLOCK_MS, 600000);
    const words = Array.from({ length: 100 }, (_, i) => makeWord(`w${i}`));
    const durations = uniformDurations(words, 1000);
    const plan = buildBlockPlan(words, undefined, durations);
    // 8s per word ⇒ 75 words reach exactly 600s.
    assert.equal(plan.cues.length, 75);
    assert.equal(plan.totalMs, 600000);
  });

  test("throws when a clip duration is missing", () => {
    assert.throws(
      () => buildBlockPlan([makeWord("a")], 1000, new Map()),
      /missing clip duration/
    );
  });
});

describe("no repeat until the pool has cycled", () => {
  test("blocks built off one shuffled queue cover every word exactly once", () => {
    const pool = Array.from({ length: 23 }, (_, i) => makeWord(`w${i}`));
    const durations = uniformDurations(pool, 1000);
    let queue = shuffle(pool, seededRandom(99));
    const played = [];
    while (queue.length > 0) {
      const plan = buildBlockPlan(queue, 40000, durations);
      played.push(...plan.cues.map((cue) => cue.word.word));
      queue = plan.remaining;
    }
    assert.equal(played.length, pool.length);
    assert.deepEqual(new Set(played).size, pool.length, "no word repeats within a cycle");
  });

  test("the next cycle reshuffles into a (typically) different order", () => {
    const pool = Array.from({ length: 10 }, (_, i) => makeWord(`w${i}`));
    const random = seededRandom(5);
    const firstCycle = shuffle(pool, random).map((w) => w.word);
    const secondCycle = shuffle(pool, random).map((w) => w.word);
    assert.notDeepEqual(firstCycle, secondCycle);
    assert.deepEqual([...firstCycle].sort(), [...secondCycle].sort());
  });
});
