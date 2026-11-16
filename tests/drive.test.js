import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  clipFilename,
  ensureFolder,
  resetFolderCache,
  ensureSpreadsheet,
  resetSpreadsheetCache,
  DriveAuthError,
  DriveError,
  FOLDER_NAME,
  SPREADSHEET_NAME,
} from "../site/js/drive.js";

test("clipFilename follows {rowIndex}-{word}-{kind}.wav", () => {
  assert.equal(clipFilename(7, "manzana", "word_es"), "7-manzana-word_es.wav");
});

test("clipFilename sanitizes spaces, case, and accented words", () => {
  assert.equal(
    clipFilename(12, "la Mañana", "phrase_es"),
    "12-la-mañana-phrase_es.wav",
  );
  assert.equal(clipFilename(3, "¿qué tal?", "word_en"), "3-qué-tal-word_en.wav");
});

test("DriveAuthError is a DriveError with status 401", () => {
  const err = new DriveAuthError("reconnect");
  assert.ok(err instanceof DriveError);
  assert.equal(err.status, 401);
  assert.equal(err.name, "DriveAuthError");
});

describe("ensureFolder (ADR-0007 discovery)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => resetFolderCache());
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetFolderCache();
  });

  /** Stub fetch with a queue of responses; records every call. */
  function stubFetch(...responses) {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: new URL(url), options });
      return responses.shift();
    };
    return calls;
  }

  const json = (payload) =>
    new Response(JSON.stringify(payload), { status: 200 });

  test("discovers folders without name matching, oldest first", async () => {
    const calls = stubFetch(
      json({
        files: [
          { id: "oldest-folder", createdTime: "2026-01-01T00:00:00Z" },
          { id: "newer-folder", createdTime: "2026-06-01T00:00:00Z" },
        ],
      }),
    );

    const id = await ensureFolder("tok");

    assert.equal(id, "oldest-folder");
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(
      url.searchParams.get("q"),
      "mimeType='application/vnd.google-apps.folder' and trashed=false",
    );
    assert.equal(url.searchParams.get("orderBy"), "createdTime");
    assert.equal(url.searchParams.get("fields"), "files(id,createdTime)");
    assert.equal(options.headers.Authorization, "Bearer tok");
  });

  test("no folders → creates the named folder at Drive root", async () => {
    const calls = stubFetch(json({ files: [] }), json({ id: "fresh-folder" }));

    const id = await ensureFolder("tok");

    assert.equal(id, "fresh-folder");
    assert.equal(calls.length, 2);
    const { options } = calls[1];
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.name, FOLDER_NAME);
    assert.equal(body.mimeType, "application/vnd.google-apps.folder");
    assert.equal(body.parents, undefined); // root, no parent
  });

  test("caches the ID in memory: one discovery per session", async () => {
    const calls = stubFetch(json({ files: [{ id: "f1" }] }));

    assert.equal(await ensureFolder("tok"), "f1");
    assert.equal(await ensureFolder("tok"), "f1");
    assert.equal(calls.length, 1);
  });

  test("401 from discovery surfaces as DriveAuthError", async () => {
    stubFetch(new Response("", { status: 401 }));

    await assert.rejects(ensureFolder("expired"), DriveAuthError);
  });
});

describe("ensureSpreadsheet (ADR-0008 discovery)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => resetSpreadsheetCache());
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetSpreadsheetCache();
  });

  /** Stub fetch with a queue of responses; records every call. */
  function stubFetch(...responses) {
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url: new URL(url), options });
      return responses.shift();
    };
    return calls;
  }

  const json = (payload) =>
    new Response(JSON.stringify(payload), { status: 200 });

  test("discovers spreadsheets without name matching, oldest first", async () => {
    const calls = stubFetch(
      json({
        files: [
          { id: "oldest-sheet", createdTime: "2026-01-01T00:00:00Z" },
          { id: "newer-sheet", createdTime: "2026-06-01T00:00:00Z" },
        ],
      }),
    );

    const id = await ensureSpreadsheet("tok");

    assert.equal(id, "oldest-sheet");
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.equal(
      url.searchParams.get("q"),
      "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    );
    assert.equal(url.searchParams.get("orderBy"), "createdTime");
    assert.equal(url.searchParams.get("fields"), "files(id,createdTime)");
    assert.equal(options.headers.Authorization, "Bearer tok");
  });

  test("none → creates the named sheet, renames the default tab to Words", async () => {
    const calls = stubFetch(
      json({ files: [] }),
      json({ id: "fresh-sheet" }),
      json({}), // the rename batchUpdate
    );

    const id = await ensureSpreadsheet("tok");

    assert.equal(id, "fresh-sheet");
    assert.equal(calls.length, 3);

    const create = calls[1];
    assert.equal(create.options.method, "POST");
    assert.equal(create.url.origin + create.url.pathname, "https://www.googleapis.com/drive/v3/files");
    const body = JSON.parse(create.options.body);
    assert.equal(body.name, SPREADSHEET_NAME);
    assert.equal(body.mimeType, "application/vnd.google-apps.spreadsheet");

    const rename = calls[2];
    assert.equal(rename.options.method, "POST");
    assert.equal(
      rename.url.href,
      "https://sheets.googleapis.com/v4/spreadsheets/fresh-sheet:batchUpdate",
    );
    assert.deepEqual(JSON.parse(rename.options.body).requests, [
      {
        updateSheetProperties: {
          properties: { sheetId: 0, title: "Words" },
          fields: "title",
        },
      },
    ]);
  });

  test("caches the ID in memory: one discovery per session", async () => {
    const calls = stubFetch(json({ files: [{ id: "s1" }] }));

    assert.equal(await ensureSpreadsheet("tok"), "s1");
    assert.equal(await ensureSpreadsheet("tok"), "s1");
    assert.equal(calls.length, 1);
  });

  test("resetSpreadsheetCache forces a fresh discovery", async () => {
    const calls = stubFetch(json({ files: [{ id: "s1" }] }), json({ files: [{ id: "s2" }] }));

    assert.equal(await ensureSpreadsheet("tok"), "s1");
    resetSpreadsheetCache();
    assert.equal(await ensureSpreadsheet("tok"), "s2");
    assert.equal(calls.length, 2);
  });

  test("401 from discovery surfaces as DriveAuthError", async () => {
    stubFetch(new Response("", { status: 401 }));

    await assert.rejects(ensureSpreadsheet("expired"), DriveAuthError);
  });
});
