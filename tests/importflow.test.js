import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  uniqueWords,
  countCaption,
  generateLabel,
  failureCaption,
  rowView,
  progressView,
  resultsView,
  retryLabel,
  skippedView,
  partitionFailed,
  isGeneratorUnreachable,
} from "../site/js/importflow.js";

describe("uniqueWords (step 1 parsing)", () => {
  test("collapses duplicates within the input, keeping the first spelling", () => {
    assert.deepEqual(
      uniqueWords("Perro\ngato\n perro \nGATO\nla casa"),
      ["Perro", "gato", "la casa"],
    );
  });

  test("keeps duplicates against the sheet (they surface in step 2)", () => {
    // uniqueWords knows nothing about the vocabulary — by design.
    assert.deepEqual(uniqueWords("perro\nperro"), ["perro"]);
  });

  test("empty input yields no words", () => {
    assert.deepEqual(uniqueWords(""), []);
    assert.deepEqual(uniqueWords(" \n\n "), []);
  });
});

describe("step-1 captions", () => {
  test("count caption pluralizes", () => {
    assert.equal(countCaption(0), "0 words");
    assert.equal(countCaption(1), "1 word");
    assert.equal(countCaption(12), "12 words");
  });

  test("generate label includes the count, bare at zero", () => {
    assert.equal(generateLabel(0), "Generate");
    assert.equal(generateLabel(1), "Generate 1 word");
    assert.equal(generateLabel(6), "Generate 6 words");
  });
});

describe("rowView (step-2 list rows)", () => {
  test("maps importer states to the design glyphs", () => {
    assert.deepEqual(rowView({ word: "a", state: "done" }), {
      word: "a", glyph: "\u2713", glyphMuted: false, caption: null, pending: false,
    });
    assert.deepEqual(rowView({ word: "b", state: "skipped-duplicate" }), {
      word: "b", glyph: "\u2014", glyphMuted: true, caption: "already in list", pending: false,
    });
    assert.deepEqual(rowView({ word: "c", state: "pending" }), {
      word: "c", glyph: null, glyphMuted: false, caption: null, pending: true,
    });
  });

  test("all active phases read as generating…", () => {
    for (const state of ["enriching", "appending", "audio"]) {
      assert.equal(rowView({ word: "w", state }).caption, "generating\u2026");
    }
  });

  test("failed rows carry a short phase-specific reason", () => {
    const failed = (phase, error) =>
      rowView({ word: "w", state: "failed", phase, error });
    assert.equal(failed("enriching").caption, "generation failed");
    assert.equal(failed("appending").caption, "couldn't save");
    assert.equal(failed("audio").caption, "audio failed");
    assert.equal(failed(undefined).caption, "failed");
    assert.equal(
      failed("enriching", { name: "RateLimitError" }).caption,
      "rate limited",
    );
    assert.equal(failureCaption({ phase: "audio" }), "audio failed");
  });
});

describe("progressView (step-2 counter)", () => {
  test("counts settled words out of the whole batch", () => {
    const items = [
      { state: "done" },
      { state: "done" },
      { state: "skipped-duplicate" },
      { state: "audio" },
      { state: "pending" },
      { state: "pending" },
    ];
    assert.deepEqual(progressView(items), { label: "3 / 6", percent: 50 });
  });

  test("an empty batch does not divide by zero", () => {
    assert.deepEqual(progressView([]), { label: "0 / 0", percent: 0 });
  });
});

describe("resultsView (step-3 headline)", () => {
  test("joins only the non-empty groups", () => {
    assert.deepEqual(resultsView({ imported: 9, skipped: 2, failed: 1 }), {
      headline: "9 added",
      sub: "2 skipped \u00b7 1 failed",
    });
    assert.deepEqual(resultsView({ imported: 4, skipped: 0, failed: 1 }), {
      headline: "4 added",
      sub: "1 failed",
    });
    assert.deepEqual(resultsView({ imported: 4, skipped: 0, failed: 0 }), {
      headline: "4 added",
      sub: null,
    });
  });

  test("retry label", () => {
    assert.equal(retryLabel(1), "Retry 1 failed");
    assert.equal(retryLabel(3), "Retry 3 failed");
  });
});

describe("skippedView (step-3 skipped group)", () => {
  test("up to 3 skipped words stay as rows", () => {
    const view = skippedView(["a", "b", "c"]);
    assert.equal(view.collapsed, false);
    assert.equal(view.line, null);
  });

  test("more than 3 collapse to a single muted line", () => {
    const view = skippedView(["a", "b", "c", "d"]);
    assert.equal(view.collapsed, true);
    assert.equal(view.line, "4 words already in list");
  });
});

describe("partitionFailed (retry routing)", () => {
  test("audio-phase failures with a row retry clips; the rest re-run", () => {
    const items = [
      { word: "a", state: "failed", phase: "audio", rowIndex: 12 },
      { word: "b", state: "failed", phase: "enriching" },
      { word: "c", state: "failed", phase: "appending" },
      { word: "d", state: "failed", phase: "audio", rowIndex: null },
    ];
    const { clipRetries, rerunWords } = partitionFailed(items);
    assert.deepEqual(clipRetries.map((i) => i.word), ["a"]);
    assert.deepEqual(rerunWords, ["b", "c", "d"]);
  });
});

describe("isGeneratorUnreachable (whole-batch failure)", () => {
  const apiError = { name: "GeminiError" };

  test("first settled word failing at enrichment flags the batch", () => {
    const items = [
      { state: "skipped-duplicate" },
      { state: "failed", phase: "enriching", error: apiError },
      { state: "pending" },
    ];
    assert.equal(isGeneratorUnreachable(items), true);
  });

  test("any success means the generator was reachable", () => {
    const items = [
      { state: "done" },
      { state: "failed", phase: "enriching", error: apiError },
    ];
    assert.equal(isGeneratorUnreachable(items), false);
  });

  test("a later phase failing is a row-level problem, not unreachability", () => {
    assert.equal(
      isGeneratorUnreachable([{ state: "failed", phase: "audio", error: apiError }]),
      false,
    );
    assert.equal(
      isGeneratorUnreachable([{ state: "failed", phase: "appending", error: apiError }]),
      false,
    );
  });

  test("a response-shape problem is not unreachability", () => {
    const items = [
      { state: "failed", phase: "enriching", error: { name: "EnrichmentParseError" } },
    ];
    assert.equal(isGeneratorUnreachable(items), false);
  });

  test("nothing settled yet: no verdict", () => {
    assert.equal(isGeneratorUnreachable([{ state: "enriching" }]), false);
    assert.equal(isGeneratorUnreachable([]), false);
  });
});
