import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { readSettings, writeLearningLanguage } from "../site/js/settings.js";
import { setSpreadsheetId, SheetsAuthError, SheetsError } from "../site/js/sheets.js";

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

describe("readSettings", () => {
  test("maps Settings!A2:B rows to a plain object", async () => {
    const calls = stubFetch(
      json({ values: [["learning_language", "es"], ["new_words_per_day", "10"]] }),
    );

    const settings = await readSettings("tok");

    assert.deepEqual(settings, { learning_language: "es", new_words_per_day: "10" });
    assert.equal(target(calls[0]), "sheet-1/values/Settings!A2:B");
    assert.equal(calls[0].options.headers.Authorization, "Bearer tok");
  });

  test("trims cells and skips rows with a blank key", async () => {
    stubFetch(json({ values: [[" learning_language ", " es "], [""], ["   ", "x"]] }));

    assert.deepEqual(await readSettings("tok"), { learning_language: "es" });
  });

  test("an empty tab (no data rows) → {}", async () => {
    stubFetch(json({}));

    assert.deepEqual(await readSettings("tok"), {});
  });

  test("a missing Settings tab (400) → {}, not an error", async () => {
    stubFetch(new Response("", { status: 400 }));

    assert.deepEqual(await readSettings("tok"), {});
  });

  test("other failures still surface as SheetsError", async () => {
    stubFetch(new Response("", { status: 500 }));

    await assert.rejects(readSettings("tok"), (error) => {
      assert.ok(error instanceof SheetsError);
      assert.equal(error.status, 500);
      return true;
    });
  });

  test("401 surfaces as SheetsAuthError (never swallowed as missing tab)", async () => {
    stubFetch(new Response("", { status: 401 }));

    await assert.rejects(readSettings("expired"), SheetsAuthError);
  });
});

describe("writeLearningLanguage (upsert)", () => {
  test("existing key → the row is overwritten in place", async () => {
    const calls = stubFetch(
      json({ values: [["theme", "dark"], ["learning_language", "es"]] }),
      json({}),
    );

    await writeLearningLanguage("tok", "fr");

    assert.equal(calls.length, 2);
    const write = calls[1];
    assert.equal(write.options.method, "PUT");
    assert.equal(target(write), "sheet-1/values/Settings!A3:B3"); // 2nd data row
    assert.equal(write.url.searchParams.get("valueInputOption"), "RAW");
    assert.deepEqual(JSON.parse(write.options.body).values, [
      ["learning_language", "fr"],
    ]);
  });

  test("missing key → a new row is appended with INSERT_ROWS", async () => {
    const calls = stubFetch(json({ values: [["theme", "dark"]] }), json({}));

    await writeLearningLanguage("tok", "de");

    const write = calls[1];
    assert.equal(write.options.method, "POST");
    assert.equal(target(write), "sheet-1/values/Settings!A2:B:append");
    assert.equal(write.url.searchParams.get("insertDataOption"), "INSERT_ROWS");
    assert.equal(write.url.searchParams.get("valueInputOption"), "RAW");
    assert.deepEqual(JSON.parse(write.options.body).values, [
      ["learning_language", "de"],
    ]);
  });

  test("empty tab → the first data row is appended", async () => {
    const calls = stubFetch(json({}), json({}));

    await writeLearningLanguage("tok", "es");

    assert.equal(calls[1].options.method, "POST");
    assert.equal(target(calls[1]), "sheet-1/values/Settings!A2:B:append");
  });
});
