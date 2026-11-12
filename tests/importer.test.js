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
  const log = { enriched: [], appended: [], synthesized: [], uploaded: [], audioRefWrites: [], sleeps: [] };
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
