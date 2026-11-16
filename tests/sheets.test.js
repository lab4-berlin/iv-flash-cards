import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  setSpreadsheetId,
  ensureHeader,
  ensureTabs,
  loadWords,
  readWordsFrom,
  SheetsAuthError,
  SheetsError,
  HEADER_ROW,
} from "../site/js/sheets.js";

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

beforeEach(() => setSpreadsheetId("sheet-1"));
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("setSpreadsheetId injection (ADR-0008)", () => {
  test("Sheets calls fail with a clear error before injection", async () => {
    setSpreadsheetId(null);
    const calls = stubFetch();

    await assert.rejects(loadWords("tok"), /setSpreadsheetId/);
    assert.equal(calls.length, 0); // fails before any network call
  });

  test("every call addresses the injected spreadsheet", async () => {
    const calls = stubFetch(json({ values: [] }));

    await loadWords("tok");

    assert.equal(target(calls[0]), "sheet-1/values/Words!A2:P");
    assert.equal(calls[0].options.headers.Authorization, "Bearer tok");
  });

  test("re-injection switches the target spreadsheet", async () => {
    const calls = stubFetch(json({ values: [] }));

    setSpreadsheetId("sheet-2");
    await loadWords("tok");

    assert.equal(target(calls[0]), "sheet-2/values/Words!A2:P");
  });
});

describe("loadWords", () => {
  test("maps rows to Words carrying their 1-based rowIndex", async () => {
    stubFetch(json({ values: [["hola", "hello"], ["adiós", "bye"]] }));

    const words = await loadWords("tok");

    assert.equal(words.length, 2);
    assert.equal(words[0].word, "hola");
    assert.equal(words[0].translation, "hello");
    assert.equal(words[0].rowIndex, 2);
    assert.equal(words[1].rowIndex, 3);
  });

  test("401 surfaces as SheetsAuthError", async () => {
    stubFetch(new Response("", { status: 401 }));

    await assert.rejects(loadWords("expired"), SheetsAuthError);
  });
});

describe("readWordsFrom (migration read path, ADR-0008)", () => {
  test("reads Words!A2:P of the explicit ID, not the injected one", async () => {
    const calls = stubFetch(json({ values: [["hola", "hello"]] }));

    const words = await readWordsFrom("tok", "legacy-sheet");

    assert.equal(target(calls[0]), "legacy-sheet/values/Words!A2:P");
    assert.equal(words[0].word, "hola");
    assert.equal(words[0].rowIndex, 2);
  });

  test("works without any injected ID", async () => {
    setSpreadsheetId(null);
    stubFetch(json({}));

    assert.deepEqual(await readWordsFrom("tok", "legacy-sheet"), []);
  });
});

describe("ensureHeader (issue #56)", () => {
  test("blank sheet gets the header row written", async () => {
    const calls = stubFetch(json({}), json({}));

    await ensureHeader("tok");

    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.method, "PUT");
    assert.equal(target(calls[1]), "sheet-1/values/Words!A1:P1");
    assert.equal(calls[1].url.searchParams.get("valueInputOption"), "RAW");
    assert.deepEqual(JSON.parse(calls[1].options.body).values, [HEADER_ROW]);
  });

  test("any row-1 content is left untouched", async () => {
    const calls = stubFetch(json({ values: [["word"]] }));

    await ensureHeader("tok");

    assert.equal(calls.length, 1);
  });
});

describe("ensureTabs (ADR-0008, supersedes ensureHeader)", () => {
  const settingsOk = () => json({ values: [["key", "value"]] });

  test("both tabs in shape → two reads, no writes", async () => {
    const calls = stubFetch(json({ values: [HEADER_ROW] }), settingsOk());

    await ensureTabs("tok");

    assert.equal(calls.length, 2);
    assert.equal(target(calls[0]), "sheet-1/values/Words!A1:P1");
    assert.equal(target(calls[1]), "sheet-1/values/Settings!A1:B1");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[1].options.method, "GET");
  });

  test("blank Words sheet gets the A1:P1 header (ensureHeader behavior)", async () => {
    const calls = stubFetch(json({}), json({}), settingsOk());

    await ensureTabs("tok");

    assert.equal(calls[1].options.method, "PUT");
    assert.equal(target(calls[1]), "sheet-1/values/Words!A1:P1");
    assert.deepEqual(JSON.parse(calls[1].options.body).values, [HEADER_ROW]);
  });

  test("missing Settings tab (400) → addSheet, then key|value header", async () => {
    const calls = stubFetch(
      json({ values: [HEADER_ROW] }),
      new Response("", { status: 400 }), // values read of a missing tab
      json({}), // batchUpdate addSheet
      json({}), // header write
    );

    await ensureTabs("tok");

    assert.equal(calls.length, 4);
    const batch = calls[2];
    assert.equal(batch.options.method, "POST");
    assert.equal(decodeURIComponent(batch.url.pathname), "/v4/spreadsheets/sheet-1:batchUpdate");
    assert.deepEqual(JSON.parse(batch.options.body).requests, [
      { addSheet: { properties: { title: "Settings" } } },
    ]);
    const header = calls[3];
    assert.equal(header.options.method, "PUT");
    assert.equal(target(header), "sheet-1/values/Settings!A1:B1");
    assert.equal(header.url.searchParams.get("valueInputOption"), "RAW");
    assert.deepEqual(JSON.parse(header.options.body).values, [["key", "value"]]);
  });

  test("Settings tab exists but is blank → only the header is written", async () => {
    const calls = stubFetch(json({ values: [HEADER_ROW] }), json({}), json({}));

    await ensureTabs("tok");

    assert.equal(calls.length, 3);
    assert.equal(calls[2].options.method, "PUT");
    assert.equal(target(calls[2]), "sheet-1/values/Settings!A1:B1");
  });

  test("Settings tab with any row-1 content is left untouched", async () => {
    const calls = stubFetch(
      json({ values: [HEADER_ROW] }),
      json({ values: [["custom"]] }),
    );

    await ensureTabs("tok");

    assert.equal(calls.length, 2);
  });

  test("non-400 Settings failures are not swallowed", async () => {
    stubFetch(json({ values: [HEADER_ROW] }), new Response("", { status: 500 }));

    await assert.rejects(ensureTabs("tok"), (error) => {
      assert.ok(error instanceof SheetsError);
      assert.equal(error.status, 500);
      return true;
    });
  });

  test("401 surfaces as SheetsAuthError, not as a missing tab", async () => {
    stubFetch(json({ values: [HEADER_ROW] }), new Response("", { status: 401 }));

    await assert.rejects(ensureTabs("expired"), SheetsAuthError);
  });
});
