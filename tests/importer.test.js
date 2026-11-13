import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseInput,
  normalizeWord,
  planBatch,
  createItem,
  transition,
  summarize,
  withBackoff,
  BACKOFF_DELAYS_MS,
  backfillNeeds,
  needsBackfill,
  createImporter,
} from "../site/js/importer.js";

class FakeRateLimitError extends Error {
  constructor() {
    super("rate limited");
    this.name = "RateLimitError";
    this.status = 429;
  }
}

describe("parseInput", () => {
  test("one word per line, trimmed, empties dropped, CRLF handled", () => {
    assert.deepEqual(
      parseInput("perro\n  gato  \r\n\n\t\nla casa\n"),
      ["perro", "gato", "la casa"],
    );
  });

  test("empty and null input yield an empty batch", () => {
    assert.deepEqual(parseInput(""), []);
    assert.deepEqual(parseInput("\n\n"), []);
    assert.deepEqual(parseInput(null), []);
  });
});

describe("normalizeWord", () => {
  test("lowercases, trims, collapses inner whitespace", () => {
    assert.equal(normalizeWord("  La   CASA\t"), "la casa");
    assert.equal(normalizeWord("perro"), "perro");
  });
});

describe("planBatch", () => {
  test("marks vocabulary duplicates skipped (normalized compare)", () => {
    const items = planBatch("PERRO\ngato\n la  casa ", ["perro", "La Casa"]);
    assert.deepEqual(
      items.map((i) => [i.word, i.state]),
      [
        ["PERRO", "skipped-duplicate"],
        ["gato", "pending"],
        ["la  casa", "skipped-duplicate"],
      ],
    );
  });

  test("marks repeats within the same input skipped", () => {
    const items = planBatch("gato\nGato\ngato", []);
    assert.deepEqual(
      items.map((i) => i.state),
      ["pending", "skipped-duplicate", "skipped-duplicate"],
    );
  });

  test("keeps the original spelling on the item", () => {
    assert.equal(planBatch("  El Perro ", [])[0].word, "El Perro");
  });
});

describe("transition (state machine)", () => {
  test("walks the full happy path", () => {
    let item = createItem("perro");
    for (const next of ["enriching", "appending", "audio", "audio", "done"]) {
      item = transition(item, next);
    }
    assert.equal(item.state, "done");
  });

  test("failed records the phase it broke in", () => {
    const error = new Error("boom");
    let item = transition(createItem("perro"), "enriching");
    item = transition(item, "failed", { error });
    assert.equal(item.state, "failed");
    assert.equal(item.phase, "enriching");
    assert.equal(item.error, error);
  });

  test("illegal transitions throw", () => {
    assert.throws(() => transition(createItem("x"), "audio"), /illegal/);
    assert.throws(() => transition(createItem("x"), "done"), /illegal/);
    const done = { ...createItem("x"), state: "done" };
    assert.throws(() => transition(done, "enriching"), /illegal/);
    const skipped = transition(createItem("x"), "skipped-duplicate");
    assert.throws(() => transition(skipped, "enriching"), /illegal/);
  });

  test("does not mutate the input item", () => {
    const item = createItem("perro");
    transition(item, "enriching");
    assert.equal(item.state, "pending");
  });
});

describe("summarize", () => {
  test("counts outcomes", () => {
    const states = [
      "done",
      "done",
      "skipped-duplicate",
      "failed",
      "pending",
      "audio",
    ];
    const items = states.map((state) => ({ ...createItem("w"), state }));
    assert.deepEqual(summarize(items), {
      total: 6,
      imported: 2,
      skipped: 1,
      failed: 1,
      inProgress: 2,
    });
  });
});

describe("withBackoff", () => {
  const sleeps = () => {
    const calls = [];
    return { calls, sleep: async (ms) => calls.push(ms) };
  };

  test("passes a success straight through", async () => {
    const { calls, sleep } = sleeps();
    assert.equal(await withBackoff(async () => 42, sleep), 42);
    assert.deepEqual(calls, []);
  });

  test("backs off 1s/2s/4s/8s on rate limits, then rethrows", async () => {
    const { calls, sleep } = sleeps();
    await assert.rejects(
      withBackoff(async () => {
        throw new FakeRateLimitError();
      }, sleep),
      FakeRateLimitError,
    );
    assert.deepEqual(calls, [1000, 2000, 4000, 8000]);
    assert.deepEqual(BACKOFF_DELAYS_MS, [1000, 2000, 4000, 8000]);
  });

  test("recovers when a retry succeeds mid-ladder", async () => {
    const { calls, sleep } = sleeps();
    let attempts = 0;
    const result = await withBackoff(async () => {
      attempts++;
      if (attempts <= 2) throw new FakeRateLimitError();
      return "ok";
    }, sleep);
    assert.equal(result, "ok");
    assert.deepEqual(calls, [1000, 2000]);
  });

  test("non-rate-limit errors rethrow immediately, no sleeps", async () => {
    const { calls, sleep } = sleeps();
    await assert.rejects(
      withBackoff(async () => {
        throw new Error("boom");
      }, sleep),
      /boom/,
    );
    assert.deepEqual(calls, []);
  });
});

// ---------------------------------------------------------------- glue

function enrichmentFor(word) {
  return {
    translation: `${word}-en`,
    phraseEs: `Frase con ${word}.`,
    phraseEn: `Phrase with ${word}.`,
  };
}

/** Importer with happy-path stub deps; every call is recorded. */
function stubImporter(overrides = {}) {
  const log = {
    enriched: [],
    appended: [],
    synthesized: [],
    uploaded: [],
    audioRefWrites: [],
    phraseWrites: [],
    phraseTranslationWrites: [],
    translated: [],
    sleeps: [],
  };
  let nextRow = 10;
  const importer = createImporter({
    enrich: async (word, vocabulary) => {
      log.enriched.push({ word, vocabulary: [...vocabulary] });
      return enrichmentFor(word);
    },
    appendWord: async (word) => {
      log.appended.push(word);
      return nextRow++;
    },
    writeAudioRefs: async (word) => {
      log.audioRefWrites.push(word);
    },
    synthesize: async (text, language, voice) => {
      log.synthesized.push({ text, language, voice });
      return { fake: "blob", text };
    },
    uploadClip: async (filename, blob) => {
      log.uploaded.push({ filename, blob });
      return `drive-${log.uploaded.length}`;
    },
    writePhrase: async (word) => {
      log.phraseWrites.push({ rowIndex: word.rowIndex, example: word.example });
    },
    writePhraseTranslation: async (word) => {
      log.phraseTranslationWrites.push({
        rowIndex: word.rowIndex,
        phraseTranslation: word.phraseTranslation,
      });
    },
    translatePhrase: async (phrase) => {
      log.translated.push(phrase);
      return `EN: ${phrase}`;
    },
    pickVoice: () => "Puck",
    sleep: async (ms) => log.sleeps.push(ms),
    today: () => "2026-11-11",
    ...overrides,
  });
  return { importer, log };
}

describe("run (pipeline glue)", () => {
  test("happy path: enrich → append A:P → 4 clips → write M:P → done", async () => {
    const { importer, log } = stubImporter();
    const { items, summary } = await importer.run("perro", ["gato"]);

    assert.equal(items[0].state, "done");
    assert.equal(items[0].clipsDone, 4);
    assert.deepEqual(summary, { total: 1, imported: 1, skipped: 0, failed: 0, inProgress: 0 });

    // Phase 1: appended row carries the enrichment text, empty audio cells.
    const appended = log.appended[0];
    assert.equal(appended.word, "perro");
    assert.equal(appended.translation, "perro-en");
    assert.equal(appended.example, "Frase con perro.");
    assert.equal(appended.phraseTranslation, "Phrase with perro.");
    assert.equal(appended.dateAdded, "2026-11-11");
    assert.equal(appended.language, "es");
    assert.equal(appended.audioWordEs, null);

    // Phase 2: 4 clips in order, correct text/language, IDs written to M:P.
    assert.deepEqual(
      log.synthesized.map((s) => [s.text, s.language]),
      [
        ["perro", "es"],
        ["Frase con perro.", "es"],
        ["perro-en", "en"],
        ["Phrase with perro.", "en"],
      ],
    );
    assert.deepEqual(
      log.uploaded.map((u) => u.filename),
      [
        "10-perro-word_es.wav",
        "10-perro-phrase_es.wav",
        "10-perro-word_en.wav",
        "10-perro-phrase_en.wav",
      ],
    );
    const written = log.audioRefWrites[0];
    assert.equal(written.rowIndex, 10);
    assert.deepEqual(
      [written.audioWordEs, written.audioPhraseEs, written.audioWordEn, written.audioPhraseEn],
      ["drive-1", "drive-2", "drive-3", "drive-4"],
    );
  });

  test("duplicates are skipped without touching any dependency", async () => {
    const { importer, log } = stubImporter();
    const { items, summary } = await importer.run("gato", ["Gato"]);
    assert.equal(items[0].state, "skipped-duplicate");
    assert.equal(summary.skipped, 1);
    assert.equal(log.enriched.length, 0);
    assert.equal(log.appended.length, 0);
  });

  test("one word failing never aborts the batch (#27)", async () => {
    const boom = new Error("enrich boom");
    const { importer, log } = stubImporter({
      enrich: async (word, vocabulary) => {
        log.enriched.push({ word, vocabulary: [...vocabulary] });
        if (word === "malo") throw boom;
        return enrichmentFor(word);
      },
    });
    const { items, summary } = await importer.run("malo\nbueno", []);
    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "enriching");
    assert.equal(items[0].error, boom);
    assert.equal(items[0].retryable, false);
    assert.equal(items[1].state, "done");
    assert.deepEqual(summary, { total: 2, imported: 1, skipped: 0, failed: 1, inProgress: 0 });
  });

  test("persistent rate limit: full backoff ladder, then failed-retryable, batch continues", async () => {
    const { importer, log } = stubImporter({
      enrich: async (word) => {
        if (word === "limitado") throw new FakeRateLimitError();
        return enrichmentFor(word);
      },
    });
    const { items } = await importer.run("limitado\nlibre", []);
    assert.equal(items[0].state, "failed");
    assert.equal(items[0].retryable, true);
    assert.deepEqual(log.sleeps, [1000, 2000, 4000, 8000]);
    assert.equal(items[1].state, "done");
  });

  test("append failure marks failed(appending); no clips attempted", async () => {
    const { importer, log } = stubImporter({
      appendWord: async () => {
        throw new Error("sheets down");
      },
    });
    const { items } = await importer.run("perro", []);
    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "appending");
    assert.equal(log.synthesized.length, 0);
    assert.equal(log.audioRefWrites.length, 0);
  });

  test("partial clip failure: failed(audio) but successful IDs still written", async () => {
    const { importer, log } = stubImporter({
      synthesize: async (text, language) => {
        if (language === "en") throw new Error("tts boom");
        return { fake: "blob" };
      },
    });
    const { items } = await importer.run("perro", []);
    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "audio");
    assert.equal(items[0].clipsDone, 2); // the two Spanish clips
    const written = log.audioRefWrites[0];
    assert.equal(written.audioWordEs, "drive-1");
    assert.equal(written.audioPhraseEs, "drive-2");
    assert.equal(written.audioWordEn, null); // left empty for retry
    assert.equal(written.audioPhraseEn, null);
  });

  test("persistent audio rate limit: shared ladder, successful clips kept, word failed-retryable", async () => {
    const { importer, log } = stubImporter({
      synthesize: async (text, language) => {
        if (language === "en") throw new FakeRateLimitError();
        return { fake: "blob" };
      },
    });
    const { items } = await importer.run("perro", []);
    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "audio");
    assert.equal(items[0].retryable, true);
    assert.equal(items[0].clipsDone, 2); // the two Spanish clips landed
    // One shared backoff ladder for the whole word (#59), not per clip.
    assert.deepEqual(log.sleeps, [1000, 2000, 4000, 8000]);
    const written = log.audioRefWrites[0];
    assert.equal(written.audioWordEs, "drive-1");
    assert.equal(written.audioPhraseEs, "drive-2");
    assert.equal(written.audioWordEn, null); // left empty for retry
    assert.equal(written.audioPhraseEn, null);
  });

  test("words imported earlier in the batch join later prompts' vocabulary", async () => {
    const { importer, log } = stubImporter();
    await importer.run("perro\ngato", ["casa"]);
    assert.deepEqual(log.enriched[0].vocabulary, ["casa"]);
    assert.deepEqual(log.enriched[1].vocabulary, ["casa", "perro"]);
  });

  test("shouldStop cancels between words: current word finishes, rest stay pending", async () => {
    const { importer, log } = stubImporter();
    let stop = false;
    const { items, summary } = await importer.run(
      "uno\ndos\ntres",
      [],
      (snapshot) => {
        // Cancel while the first word is mid-pipeline — it must complete.
        if (snapshot[0].state === "enriching") stop = true;
      },
      () => stop,
    );
    assert.equal(items[0].state, "done");
    assert.equal(items[1].state, "pending");
    assert.equal(items[2].state, "pending");
    assert.equal(summary.imported, 1);
    assert.equal(summary.inProgress, 2);
    assert.equal(log.enriched.length, 1); // never touched the later words
  });

  test("onProgress sees every state change with fresh snapshots", async () => {
    const { importer } = stubImporter();
    const seen = [];
    await importer.run("perro", [], (items) => seen.push(items[0].state));
    assert.deepEqual(seen, [
      "pending",
      "enriching",
      "appending",
      "audio", // entering phase 2
      "audio", // clips 1..4
      "audio",
      "audio",
      "audio",
      "done",
    ]);
  });
});

describe("generateMissingClips", () => {
  test("hand-added row without a phrase: only the word clips, then one write", async () => {
    const { importer, log } = stubImporter();
    const handAdded = {
      word: "mesa",
      translation: "table",
      example: null,
      phraseTranslation: null,
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
      rowIndex: 7,
    };
    const { word, failures } = await importer.generateMissingClips(handAdded);
    assert.deepEqual(failures, []);
    assert.deepEqual(
      log.synthesized.map((s) => [s.text, s.language]),
      [
        ["mesa", "es"],
        ["table", "en"],
      ],
    );
    assert.equal(word.audioWordEs, "drive-1");
    assert.equal(word.audioWordEn, "drive-2");
    assert.equal(word.audioPhraseEs, null);
    assert.equal(log.audioRefWrites.length, 1);
    assert.equal(handAdded.audioWordEs, null); // input not mutated
  });

  test("existing clips are never regenerated; nothing missing means no write", async () => {
    const { importer, log } = stubImporter();
    const complete = {
      word: "mesa",
      translation: "table",
      example: "La mesa es grande.",
      phraseTranslation: "The table is big.",
      audioWordEs: "id1",
      audioPhraseEs: "id2",
      audioWordEn: "id3",
      audioPhraseEn: "id4",
      rowIndex: 7,
    };
    const { failures } = await importer.generateMissingClips(complete);
    assert.deepEqual(failures, []);
    assert.equal(log.synthesized.length, 0);
    assert.equal(log.audioRefWrites.length, 0);
  });

  test("a failed clip is reported and its cell left empty; the rest proceed", async () => {
    const boom = new Error("tts boom");
    const { importer, log } = stubImporter({
      synthesize: async (text) => {
        if (text === "mesa") throw boom;
        return { fake: "blob" };
      },
    });
    const partial = {
      word: "mesa",
      translation: "table",
      example: "La mesa es grande.",
      phraseTranslation: "The table is big.",
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
      rowIndex: 7,
    };
    const { word, failures } = await importer.generateMissingClips(partial);
    assert.deepEqual(
      failures.map((f) => [f.kind, f.error]),
      [["word_es", boom]],
    );
    assert.equal(word.audioWordEs, null);
    assert.equal(word.audioPhraseEs, "drive-1");
    assert.equal(log.audioRefWrites.length, 1);
  });

  test("all 4 syntheses start before any upload (parallel within the word, #59)", async () => {
    const events = [];
    const { importer } = stubImporter({
      synthesize: async (text, language) => {
        events.push(`synth:${language}:${text}`);
        return { fake: "blob" };
      },
      uploadClip: async (filename) => {
        events.push(`upload:${filename}`);
        return `drive-${events.length}`;
      },
    });
    const { failures } = await importer.generateMissingClips({
      word: "mesa",
      translation: "table",
      example: "La mesa es grande.",
      phraseTranslation: "The table is big.",
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
      rowIndex: 7,
    });
    assert.deepEqual(failures, []);
    const firstUpload = events.findIndex((e) => e.startsWith("upload:"));
    // A sequential pipeline would interleave synth/upload per clip; the
    // parallel one initiates all 4 syntheses before any upload starts.
    assert.equal(firstUpload, 4);
    assert.equal(events.length, 8);
  });

  test("rate-limited synthesis: backoff, then only the missing clip is retried", async () => {
    let phraseEsCalls = 0;
    const { importer, log } = stubImporter({
      synthesize: async (text, language) => {
        log.synthesized.push({ text, language });
        if (text === "La mesa es grande.") {
          phraseEsCalls++;
          if (phraseEsCalls === 1) throw new FakeRateLimitError();
        }
        return { fake: "blob", text, language };
      },
    });
    const { word, failures } = await importer.generateMissingClips({
      word: "mesa",
      translation: "table",
      example: "La mesa es grande.",
      phraseTranslation: "The table is big.",
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
      rowIndex: 7,
    });
    assert.deepEqual(failures, []);
    assert.deepEqual(log.sleeps, [1000]);
    // Pass 1 synthesized all 4; pass 2 retried only the rate-limited clip.
    assert.equal(log.synthesized.length, 5);
    assert.deepEqual(
      log.synthesized.slice(4).map((s) => s.text),
      ["La mesa es grande."],
    );
    // The 3 already-uploaded clips were not uploaded again.
    assert.equal(log.uploaded.length, 4);
    assert.equal(word.audioWordEs, "drive-1");
    assert.equal(word.audioWordEn, "drive-2");
    assert.equal(word.audioPhraseEn, "drive-3");
    assert.equal(word.audioPhraseEs, "drive-4"); // landed on the retry pass
    assert.equal(log.audioRefWrites.length, 1); // still a single M:P write
  });

  test("rate-limited upload: backoff, then only that clip is redone", async () => {
    let uploadCalls = 0;
    let rateLimitedOnce = false;
    const { importer, log } = stubImporter({
      uploadClip: async (filename) => {
        uploadCalls++;
        if (filename === "7-mesa-word_en.wav" && !rateLimitedOnce) {
          rateLimitedOnce = true;
          throw new FakeRateLimitError();
        }
        return `drive-${uploadCalls}`;
      },
    });
    const { word, failures } = await importer.generateMissingClips({
      word: "mesa",
      translation: "table",
      example: null,
      phraseTranslation: null,
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
      rowIndex: 7,
    });
    assert.deepEqual(failures, []);
    assert.deepEqual(log.sleeps, [1000]);
    // Pass 1: both word clips synthesized and uploaded (word_en upload rate
    // limited); pass 2: only word_en synthesized and uploaded again.
    assert.deepEqual(
      log.synthesized.map((s) => s.text),
      ["mesa", "table", "table"],
    );
    assert.equal(uploadCalls, 3);
    assert.equal(word.audioWordEs, "drive-1");
    assert.equal(word.audioWordEn, "drive-3");
  });

  test("rate-limited synthesis backs off before succeeding", async () => {
    let calls = 0;
    const { importer, log } = stubImporter({
      synthesize: async () => {
        calls++;
        if (calls === 1) throw new FakeRateLimitError();
        return { fake: "blob" };
      },
    });
    const { failures } = await importer.generateMissingClips({
      word: "mesa",
      translation: null,
      example: null,
      phraseTranslation: null,
      audioWordEs: null,
      rowIndex: 7,
    });
    assert.deepEqual(failures, []);
    assert.deepEqual(log.sleeps, [1000]);
  });
});

// ------------------------------------------------------------ backfill (#72)

/** A sheet Word with sensible complete-row defaults. */
function makeWord(overrides = {}) {
  return {
    word: "mesa",
    translation: "table",
    example: "La mesa es grande.",
    phraseTranslation: "The table is big.",
    audioWordEs: "id1",
    audioPhraseEs: "id2",
    audioWordEn: "id3",
    audioPhraseEn: "id4",
    rowIndex: 2,
    ...overrides,
  };
}

describe("backfillNeeds (fill decisions)", () => {
  test("a complete row needs nothing", () => {
    assert.deepEqual(backfillNeeds(makeWord()), {
      phrase: false,
      phraseTranslation: false,
      clips: [],
    });
    assert.equal(needsBackfill(makeWord()), false);
  });

  test("a bare hand-added row needs phrase, translation and all 4 clips", () => {
    const word = makeWord({
      example: null,
      phraseTranslation: null,
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
    });
    assert.deepEqual(backfillNeeds(word), {
      phrase: true,
      phraseTranslation: true,
      clips: ["word_es", "phrase_es", "word_en", "phrase_en"],
    });
    assert.equal(needsBackfill(word), true);
  });

  test("an existing phrase is kept; only its translation is planned", () => {
    const word = makeWord({ phraseTranslation: null, audioPhraseEn: null });
    assert.deepEqual(backfillNeeds(word), {
      phrase: false,
      phraseTranslation: true,
      clips: ["phrase_en"],
    });
  });

  test("an existing phrase translation is kept when only the phrase is missing", () => {
    const word = makeWord({ example: null, audioPhraseEs: null });
    assert.deepEqual(backfillNeeds(word), {
      phrase: true,
      phraseTranslation: false,
      clips: ["phrase_es"],
    });
  });

  test("a cleared audio cell is planned again (regeneration, ADR-0005)", () => {
    const word = makeWord({ audioPhraseEs: null });
    assert.deepEqual(backfillNeeds(word), {
      phrase: false,
      phraseTranslation: false,
      clips: ["phrase_es"],
    });
    assert.equal(needsBackfill(word), true);
  });

  test("a clip without source text is not planned (B is never backfilled)", () => {
    // No translation → no word_en clip; the phrase clips are still planned
    // because their texts exist or are generated this run.
    const word = makeWord({ translation: null, audioWordEn: null });
    assert.deepEqual(backfillNeeds(word), {
      phrase: false,
      phraseTranslation: false,
      clips: [],
    });
    assert.equal(needsBackfill(word), false);
  });
});

describe("backfill (pipeline glue)", () => {
  test("complete rows are left out; no dependency is touched for them", async () => {
    const { importer, log } = stubImporter();
    const { items, summary } = await importer.backfill([makeWord()]);
    assert.deepEqual(items, []);
    assert.deepEqual(summary, { total: 0, imported: 0, skipped: 0, failed: 0, inProgress: 0 });
    assert.equal(log.enriched.length, 0);
    assert.equal(log.synthesized.length, 0);
    assert.equal(log.phraseWrites.length, 0);
  });

  test("bare hand-added row: enrich → write C and D → 4 clips → write M:P → done", async () => {
    const { importer, log } = stubImporter();
    const bare = makeWord({
      word: "silla",
      translation: "chair",
      example: null,
      phraseTranslation: null,
      audioWordEs: null,
      audioPhraseEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
      rowIndex: 5,
    });
    const { items, summary } = await importer.backfill([bare, makeWord()]);

    assert.equal(items.length, 1); // the complete row is not an item
    assert.equal(items[0].state, "done");
    assert.equal(items[0].rowIndex, 5);
    assert.equal(items[0].clipsDone, 4);
    assert.deepEqual(summary, { total: 1, imported: 1, skipped: 0, failed: 0, inProgress: 0 });

    // The prompt saw the whole vocabulary, including complete rows.
    assert.deepEqual(log.enriched, [{ word: "silla", vocabulary: ["silla", "mesa"] }]);
    // Generated phrase → C, its translation → D (single-cell writes).
    assert.deepEqual(log.phraseWrites, [{ rowIndex: 5, example: "Frase con silla." }]);
    assert.deepEqual(log.phraseTranslationWrites, [
      { rowIndex: 5, phraseTranslation: "Phrase with silla." },
    ]);
    assert.equal(log.translated.length, 0); // no separate translate call

    // All 4 clips, from the filled texts, named by the existing row.
    assert.deepEqual(
      log.synthesized.map((s) => [s.text, s.language]),
      [
        ["silla", "es"],
        ["Frase con silla.", "es"],
        ["chair", "en"],
        ["Phrase with silla.", "en"],
      ],
    );
    assert.deepEqual(
      log.uploaded.map((u) => u.filename),
      [
        "5-silla-word_es.wav",
        "5-silla-phrase_es.wav",
        "5-silla-word_en.wav",
        "5-silla-phrase_en.wav",
      ],
    );
    assert.equal(log.audioRefWrites.length, 1);
    assert.equal(bare.example, null); // input Word not mutated
  });

  test("existing phrase, missing D: translates that phrase — never regenerates C", async () => {
    const { importer, log } = stubImporter();
    const word = makeWord({ phraseTranslation: null, audioPhraseEn: null });
    const { items } = await importer.backfill([word]);

    assert.equal(items[0].state, "done");
    assert.equal(log.enriched.length, 0);
    assert.equal(log.phraseWrites.length, 0); // C untouched
    assert.deepEqual(log.translated, ["La mesa es grande."]);
    assert.deepEqual(log.phraseTranslationWrites, [
      { rowIndex: 2, phraseTranslation: "EN: La mesa es grande." },
    ]);
    // Only the missing phrase_en clip, from the fresh translation.
    assert.deepEqual(
      log.synthesized.map((s) => [s.text, s.language]),
      [["EN: La mesa es grande.", "en"]],
    );
  });

  test("missing phrase but existing D: generates C, keeps the user's D", async () => {
    const { importer, log } = stubImporter();
    const word = makeWord({ example: null, audioPhraseEs: null });
    const { items } = await importer.backfill([word]);

    assert.equal(items[0].state, "done");
    assert.equal(log.enriched.length, 1);
    assert.deepEqual(log.phraseWrites, [{ rowIndex: 2, example: "Frase con mesa." }]);
    assert.equal(log.phraseTranslationWrites.length, 0); // D never overwritten
    assert.equal(log.translated.length, 0);
  });

  test("clips-only row: no text calls, just the missing clips", async () => {
    const { importer, log } = stubImporter();
    const word = makeWord({ audioWordEs: null, audioPhraseEn: null });
    const { items } = await importer.backfill([word]);

    assert.equal(items[0].state, "done");
    assert.equal(items[0].clipsDone, 2);
    assert.equal(log.enriched.length, 0);
    assert.equal(log.translated.length, 0);
    assert.equal(log.phraseWrites.length, 0);
    assert.equal(log.phraseTranslationWrites.length, 0);
    assert.deepEqual(
      log.synthesized.map((s) => [s.text, s.language]),
      [
        ["mesa", "es"],
        ["The table is big.", "en"],
      ],
    );
  });

  test("one row failing never aborts the batch; the phase is recorded", async () => {
    const boom = new Error("enrich boom");
    const { importer, log } = stubImporter({
      enrich: async () => {
        throw boom;
      },
    });
    const broken = makeWord({ word: "rota", example: null, rowIndex: 3 });
    const clipsOnly = makeWord({ word: "casi", audioWordEs: null, rowIndex: 4 });
    const { items, summary } = await importer.backfill([broken, clipsOnly]);

    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "enriching");
    assert.equal(items[0].error, boom);
    assert.equal(items[0].retryable, false);
    assert.equal(items[0].rowIndex, 3); // retry can find the row again
    assert.equal(items[1].state, "done");
    assert.deepEqual(summary, { total: 2, imported: 1, skipped: 0, failed: 1, inProgress: 0 });
    assert.equal(log.phraseWrites.length, 0); // nothing written for the failure
  });

  test("a clip failure marks failed(audio); successful IDs still written", async () => {
    const { importer, log } = stubImporter({
      synthesize: async (text, language) => {
        if (language === "en") throw new Error("tts boom");
        return { fake: "blob" };
      },
    });
    const word = makeWord({
      audioWordEs: null,
      audioWordEn: null,
      audioPhraseEn: null,
    });
    const { items } = await importer.backfill([word]);

    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "audio");
    assert.equal(items[0].rowIndex, 2);
    const written = log.audioRefWrites[0];
    assert.equal(written.audioWordEs, "drive-1");
    assert.equal(written.audioWordEn, null); // left empty for the next run
  });

  test("persistent rate limit on translate: full ladder, then failed-retryable", async () => {
    const { importer, log } = stubImporter({
      translatePhrase: async () => {
        throw new FakeRateLimitError();
      },
    });
    const word = makeWord({ phraseTranslation: null, audioPhraseEn: null });
    const { items } = await importer.backfill([word]);

    assert.equal(items[0].state, "failed");
    assert.equal(items[0].phase, "enriching");
    assert.equal(items[0].retryable, true);
    assert.deepEqual(log.sleeps, [1000, 2000, 4000, 8000]);
    assert.equal(log.phraseTranslationWrites.length, 0);
  });

  test("shouldStop cancels between rows: current row finishes, rest stay pending", async () => {
    const { importer, log } = stubImporter();
    let stop = false;
    const rows = [
      makeWord({ word: "uno", audioWordEs: null, rowIndex: 2 }),
      makeWord({ word: "dos", audioWordEs: null, rowIndex: 3 }),
    ];
    const { items, summary } = await importer.backfill(
      rows,
      (snapshot) => {
        if (snapshot[0].state === "audio") stop = true;
      },
      () => stop,
    );
    assert.equal(items[0].state, "done");
    assert.equal(items[1].state, "pending");
    assert.equal(summary.inProgress, 1);
    assert.equal(log.synthesized.length, 1); // never touched the second row
  });

  test("onProgress sees every state change with fresh snapshots", async () => {
    const { importer } = stubImporter();
    const seen = [];
    const word = makeWord({ phraseTranslation: null, audioPhraseEn: null });
    await importer.backfill([word], (items) => seen.push(items[0].state));
    assert.deepEqual(seen, [
      "pending",
      "enriching",
      "audio", // entering phase 2
      "audio", // the one missing clip
      "done",
    ]);
  });
});
