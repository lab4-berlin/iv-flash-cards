import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  extractSpreadsheetId,
  guardTargetEmpty,
  copyWords,
  MigrationError,
} from "../site/js/migratepage.js";
import { setSpreadsheetId } from "../site/js/sheets.js";

// ------------------------------------------------- ID/URL extraction (pure)

describe("extractSpreadsheetId", () => {
  const ID = "1AbC-dEfGhIjKlMnOpQrStUvWxYz0123456789abcdef";

  test("extracts the ID from a full edit URL", () => {
    assert.equal(
      extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`),
      ID,
    );
  });

  test("extracts the ID from a share URL with query params", () => {
    assert.equal(
      extractSpreadsheetId(`https://docs.google.com/spreadsheets/d/${ID}/edit?usp=sharing`),
      ID,
    );
  });

  test("handles multi-account /u/<n>/ URLs", () => {
    assert.equal(
      extractSpreadsheetId(`https://docs.google.com/spreadsheets/u/1/d/${ID}/edit`),
      ID,
    );
  });

  test("accepts a bare ID, with surrounding whitespace", () => {
    assert.equal(extractSpreadsheetId(`  ${ID}\n`), ID);
  });

  test("rejects empty/null/garbage input", () => {
    assert.equal(extractSpreadsheetId(""), null);
    assert.equal(extractSpreadsheetId(null), null);
    assert.equal(extractSpreadsheetId(undefined), null);
    assert.equal(extractSpreadsheetId("my words"), null);
    assert.equal(extractSpreadsheetId("short-token"), null); // too short for an ID
    assert.equal(extractSpreadsheetId("https://docs.google.com/document/d/abc/edit"), null);
  });
});

// ------------------------------------------------------- copy guard (pure)

describe("guardTargetEmpty (ADR-0008 retry safety)", () => {
  test("an empty target passes", () => {
    guardTargetEmpty([]); // does not throw
  });

  test("any data row refuses with a MigrationError naming the count", () => {
    assert.throws(() => guardTargetEmpty([{ word: "hola" }]), (error) => {
      assert.ok(error instanceof MigrationError);
      assert.match(error.message, /1 data row\b/);
      assert.match(error.message, /refusing/i);
      return true;
    });
    assert.throws(
      () => guardTargetEmpty([{ word: "hola" }, { word: "adiós" }]),
      /2 data rows/,
    );
  });
});

// ------------------------------------------- the copy, with injected fetch

const realFetch = globalThis.fetch;

/** Stub fetch with a queue of responses; records every call. */
function stubFetch(...responses) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    return responses.shift();
  };
  return calls;
}

const json = (payload) => new Response(JSON.stringify(payload), { status: 200 });

/** The values-API range a call addressed, decoded: "<id>/values/<range>". */
const target = (call) =>
  decodeURIComponent(call.url.pathname).replace("/v4/spreadsheets/", "");

// Two full 16-column source rows: user text A:F, stats G:L, audio IDs M:P.
const ROW_HOLA = [
  "hola", "hello", "Hola, ¿qué tal?", "Hi, how are you?",
  "2026-01-05", "es", "7", "5", "2", "2026-11-01", "14", "2026-11-15",
  "drive-we1", "drive-pe1", "drive-wn1", "drive-pn1",
];
const ROW_ADIOS = [
  "adiós", "bye", "Adiós, hasta mañana.", "Bye, see you tomorrow.",
  "2026-01-06", "es", "3", "1", "2", "2026-10-20", "1", "2026-10-21",
  "drive-we2", "drive-pe2", "drive-wn2", "drive-pn2",
];

// What the verbatim roundtrip writes: same cells, counts as numbers (RAW).
const WRITTEN_HOLA = [
  "hola", "hello", "Hola, ¿qué tal?", "Hi, how are you?",
  "2026-01-05", "es", 7, 5, 2, "2026-11-01", 14, "2026-11-15",
  "drive-we1", "drive-pe1", "drive-wn1", "drive-pn1",
];
const WRITTEN_ADIOS = [
  "adiós", "bye", "Adiós, hasta mañana.", "Bye, see you tomorrow.",
  "2026-01-06", "es", 3, 1, 2, "2026-10-20", 1, "2026-10-21",
  "drive-we2", "drive-pe2", "drive-wn2", "drive-pn2",
];

describe("copyWords (ADR-0008 legacy adoption)", () => {
  beforeEach(() => setSpreadsheetId("target-1"));
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("copies all rows verbatim and in order, in ONE batched write", async () => {
    const calls = stubFetch(
      json({ values: [ROW_HOLA, ROW_ADIOS] }), // source read
      json({}), // target read: empty
      json({}), // the one values.update
    );

    const result = await copyWords("tok", "old-sheet");

    assert.deepEqual(result, { read: 2, written: 2 });
    assert.equal(calls.length, 3);

    // Read source, read target, write target — nothing else.
    assert.equal(target(calls[0]), "old-sheet/values/Words!A2:P");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(target(calls[1]), "target-1/values/Words!A2:P");
    assert.equal(calls[1].options.method, "GET");

    const write = calls[2];
    assert.equal(write.options.method, "PUT");
    assert.equal(target(write), "target-1/values/Words!A2:P3"); // A2:P{n}
    assert.equal(write.url.searchParams.get("valueInputOption"), "RAW");
    assert.deepEqual(JSON.parse(write.options.body).values, [
      WRITTEN_HOLA, // row order preserved → rowIndex, G:L, M:P unchanged
      WRITTEN_ADIOS,
    ]);
  });

  test("the old sheet is never written: every non-GET call targets the app's sheet", async () => {
    const calls = stubFetch(
      json({ values: [ROW_HOLA] }),
      json({}),
      json({}),
    );

    await copyWords("tok", "old-sheet");

    for (const call of calls) {
      if ((call.options.method ?? "GET") === "GET") continue;
      assert.ok(target(call).startsWith("target-1/"), `writes only the target: ${target(call)}`);
    }
  });

  test("refuses when the target has data rows — and never reaches the write", async () => {
    const calls = stubFetch(
      json({ values: [ROW_HOLA] }), // source read
      json({ values: [["existing", "row"]] }), // target read: NOT empty
    );

    await assert.rejects(copyWords("tok", "old-sheet"), MigrationError);
    assert.equal(calls.length, 2); // both reads, no write anywhere
    assert.ok(calls.every((c) => (c.options.method ?? "GET") === "GET"));
  });

  test("refuses an empty source (wrong-ID safety) before touching the target", async () => {
    const calls = stubFetch(json({})); // source read: no values

    await assert.rejects(copyWords("tok", "old-sheet"), /no data rows/);
    assert.equal(calls.length, 1); // only the source read happened
  });

  test("sparse source rows (trailing cells omitted) still write full A:P rows", async () => {
    const calls = stubFetch(
      json({ values: [["hola", "hello"]] }), // a hand-added minimal row
      json({}),
      json({}),
    );

    await copyWords("tok", "old-sheet");

    assert.deepEqual(JSON.parse(calls[2].options.body).values, [
      ["hola", "hello", "", "", "", "", 0, 0, 0, "", 0, "", "", "", "", ""],
    ]);
  });
});
