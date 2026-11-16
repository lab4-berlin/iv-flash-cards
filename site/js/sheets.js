// Google Sheets API v4 adapter (ADR-0001, ADR-0003, ADR-0005, ADR-0008).
// Reads `Words!A2:P`. Writes are scoped per concern: grading writes only
// the app-owned stats block `G:L` of one row; audio-ref writes only `M:P`
// of one row; the enrichment backfill (#28/#72) writes the single cells
// `C{row}` and `D{row}`; import appends whole `A:P` rows at the bottom.
// Grading never writes user text columns. On a completely blank sheet, `ensureHeader`
// writes the header row to `A1:P1` once at startup (issue #56).
//
// The spreadsheet ID is injected once at startup via `setSpreadsheetId`
// (ADR-0008) — this module no longer imports it from config.js. Every
// function below operates on the injected ID, except `readWordsFrom`,
// which reads from an explicitly given spreadsheet (the migration's read
// path, ADR-0008).

import {
  HEADER_ROW,
  sheetNeedsHeader,
  rowToWord,
  wordToStatsRow,
  wordToAudioRefsRow,
  wordToNewRow,
  firstRowOfRange,
} from "./model.js";

export { HEADER_ROW };

const API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const FIRST_DATA_ROW = 2; // row 1 is the header

/** Any non-OK Sheets API response. `status` is the HTTP status code. */
export class SheetsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "SheetsError";
    this.status = status;
  }
}

/** A 401 — the access token is missing/expired; re-auth is needed. */
export class SheetsAuthError extends SheetsError {
  constructor(message) {
    super(message, 401);
    this.name = "SheetsAuthError";
  }
}

let spreadsheetId = null;

/**
 * Inject the spreadsheet ID every other function here operates on. Called
 * once at startup, before any Sheets call (ADR-0008): today app.js passes
 * the config ID; the onboarding flow will pass the discovered one.
 * @param {string} id the spreadsheet's Drive file ID
 */
export function setSpreadsheetId(id) {
  spreadsheetId = id;
}

function requireSpreadsheetId() {
  if (!spreadsheetId) {
    throw new Error(
      "sheets.js: spreadsheet ID not set — call setSpreadsheetId() at startup before any Sheets call",
    );
  }
  return spreadsheetId;
}

async function sheetsFetch(token, url, method, body, what) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    throw new SheetsAuthError(`Sheets API: unauthorized (${what})`);
  }
  if (!response.ok) {
    throw new SheetsError(`Sheets API: ${response.status} (${what})`, response.status);
  }
  return response.json();
}

function requestOn(id, token, method, rangeAndQuery, body) {
  return sheetsFetch(
    token,
    `${API_BASE}/${id}/values/${rangeAndQuery}`,
    method,
    body,
    `${method} ${rangeAndQuery}`,
  );
}

function request(token, method, rangeAndQuery, body) {
  return requestOn(requireSpreadsheetId(), token, method, rangeAndQuery, body);
}

// Shared transport for sibling Sheets-backed modules (settings.js) — same
// injected ID and error classes. Not part of the app-facing API.
export { request as valuesRequest };

/**
 * Make sure the sheet has its header row: read `Words!A1:P1` and, when the
 * sheet has no values at all (brand-new/blank), write {@link HEADER_ROW}.
 * A sheet with any row-1 content is left untouched. Called once at app
 * startup, before the first loadWords (issue #56). Superseded by
 * {@link ensureTabs}, which the V3 startup flow will call instead.
 * @param {string} token OAuth access token
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function ensureHeader(token) {
  const range = encodeURIComponent("Words!A1:P1");
  const data = await request(token, "GET", range);
  if (!sheetNeedsHeader(data.values)) return;
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [HEADER_ROW],
  });
}

/**
 * Idempotently make sure the spreadsheet has both app tabs in shape
 * (supersedes {@link ensureHeader}, ADR-0008):
 *
 * 1. the `Words` header `A1:P1` (exactly the ensureHeader behavior), and
 * 2. a `Settings` worksheet with the header `key | value` in `A1:B1` —
 *    added via a `batchUpdate` `addSheet` when the tab is missing (a
 *    values read of a missing tab is a 400).
 *
 * Every step is check-then-write, so a retry after a mid-setup failure
 * completes the missing steps instead of duplicating anything — the
 * onboarding "Setup failed → Retry" contract.
 * @param {string} token OAuth access token
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function ensureTabs(token) {
  await ensureHeader(token);

  const range = encodeURIComponent("Settings!A1:B1");
  let data;
  try {
    data = await request(token, "GET", range);
  } catch (error) {
    if (!(error instanceof SheetsError) || error.status !== 400) throw error;
    // 400 = no Settings worksheet yet — add it, then write the header.
    await sheetsFetch(
      token,
      `${API_BASE}/${requireSpreadsheetId()}:batchUpdate`,
      "POST",
      { requests: [{ addSheet: { properties: { title: "Settings" } } }] },
      "addSheet Settings",
    );
    data = {};
  }
  if (!sheetNeedsHeader(data.values)) return;
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [["key", "value"]],
  });
}

/**
 * Read all words from `Words!A2:P`.
 * @param {string} token OAuth access token
 * @returns {Promise<object[]>} Word objects (see model.js), each carrying
 *   the 1-based sheet row it came from as `rowIndex`.
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function loadWords(token) {
  const range = encodeURIComponent(`Words!A${FIRST_DATA_ROW}:P`);
  const data = await request(token, "GET", range);
  const rows = data.values ?? [];
  return rows.map((row, i) => rowToWord(row, FIRST_DATA_ROW + i));
}

/**
 * Read all words from `Words!A2:P` of an *explicitly given* spreadsheet —
 * the same row mapping as {@link loadWords}, but against an ID passed by
 * the caller instead of the injected one. This is the legacy-adoption
 * migration's read path (ADR-0008): the `spreadsheets` scope reads any
 * sheet by ID the user owns, so the hand-made sheet needs no Drive access.
 * @param {string} token OAuth access token
 * @param {string} spreadsheetId the source spreadsheet's ID
 * @returns {Promise<object[]>} Word objects with `rowIndex`, as loadWords
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function readWordsFrom(token, spreadsheetId) {
  const range = encodeURIComponent(`Words!A${FIRST_DATA_ROW}:P`);
  const data = await requestOn(spreadsheetId, token, "GET", range);
  const rows = data.values ?? [];
  return rows.map((row, i) => rowToWord(row, FIRST_DATA_ROW + i));
}

/**
 * Write one word's stats to the app-owned stats block `G{row}:L{row}`.
 * Grading writes only this range — never user text columns (ADR-0003).
 * @param {string} token OAuth access token
 * @param {object} word a Word object with a valid `rowIndex`
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writeStats(token, word) {
  const row = word.rowIndex;
  const range = encodeURIComponent(`Words!G${row}:L${row}`);
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [wordToStatsRow(word)],
  });
}

/**
 * Append new words as whole `A:P` rows at the bottom of the sheet via
 * `values.append` with `INSERT_ROWS`, which never shifts existing row
 * indices (ADR-0005).
 * @param {string} token OAuth access token
 * @param {object[]} words Word objects (see model.js)
 * @returns {Promise<number|null>} 1-based sheet row of the first appended
 *   word (from the API's `updatedRange`) — the import pipeline (#36) needs
 *   it for enrichment writes and clip filenames
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function appendWords(token, words) {
  const range = encodeURIComponent(`Words!A${FIRST_DATA_ROW}:P`);
  const data = await request(
    token,
    "POST",
    `${range}:append?insertDataOption=INSERT_ROWS&valueInputOption=RAW`,
    { values: words.map(wordToNewRow) },
  );
  return firstRowOfRange(data.updates?.updatedRange);
}

/**
 * Write one word's audio Drive-file refs to the columns `M{row}:P{row}`.
 * Grading writes stay in `G:L` (see writeStats) — the ranges never overlap.
 * @param {string} token OAuth access token
 * @param {object} word a Word object with a valid `rowIndex`
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writeAudioRefs(token, word) {
  const row = word.rowIndex;
  const range = encodeURIComponent(`Words!M${row}:P${row}`);
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [wordToAudioRefsRow(word)],
  });
}

/**
 * Write one word's example phrase to the single cell `C{row}` — used by
 * the enrichment backfill (#28/#72) for rows added by hand without a
 * phrase. Sits in the user-text zone; the backfill only ever calls this
 * when the cell is empty, so user text is never overwritten.
 * @param {string} token OAuth access token
 * @param {object} word a Word object with a valid `rowIndex`
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writePhrase(token, word) {
  const row = word.rowIndex;
  const range = encodeURIComponent(`Words!C${row}`);
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [[word.example ?? ""]],
  });
}

/**
 * Write one word's phrase translation to the single cell `D{row}` — used
 * by the enrichment backfill (#28) for rows added by hand. Sits in the
 * user-text zone, so nothing else ever writes it.
 * @param {string} token OAuth access token
 * @param {object} word a Word object with a valid `rowIndex`
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writePhraseTranslation(token, word) {
  const row = word.rowIndex;
  const range = encodeURIComponent(`Words!D${row}`);
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [[word.phraseTranslation ?? ""]],
  });
}
