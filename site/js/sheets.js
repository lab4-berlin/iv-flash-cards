// Google Sheets API v4 adapter (ADR-0001, ADR-0003, ADR-0005).
// Reads `Words!A2:P`. Writes are scoped per concern: grading writes only
// the app-owned stats block `G:L` of one row; audio-ref writes only `M:P`
// of one row; the phrase-translation backfill (#28) writes the single cell
// `D{row}`; import appends whole `A:P` rows at the bottom. Grading never
// writes user text columns. On a completely blank sheet, `ensureHeader`
// writes the header row to `A1:P1` once at startup (issue #56).

import { SPREADSHEET_ID } from "./config.js";
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

async function request(token, method, rangeAndQuery, body) {
  const url = `${API_BASE}/${SPREADSHEET_ID}/values/${rangeAndQuery}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 401) {
    throw new SheetsAuthError(`Sheets API: unauthorized (${method} ${rangeAndQuery})`);
  }
  if (!response.ok) {
    throw new SheetsError(
      `Sheets API: ${response.status} (${method} ${rangeAndQuery})`,
      response.status,
    );
  }
  return response.json();
}

/**
 * Make sure the sheet has its header row: read `Words!A1:P1` and, when the
 * sheet has no values at all (brand-new/blank), write {@link HEADER_ROW}.
 * A sheet with any row-1 content is left untouched. Called once at app
 * startup, before the first loadWords (issue #56).
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
