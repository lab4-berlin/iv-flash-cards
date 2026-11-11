// Google Sheets API v4 adapter (ADR-0001, ADR-0003, ADR-0005).
// Reads `Words!A2:P`. Writes are scoped per concern: grading writes only
// the app-owned stats columns `F:K` of one row; enrichment writes only
// `L:P` of one row; import appends whole `A:P` rows at the bottom.
// User-owned columns (A:E) of existing rows are never written.

import { SPREADSHEET_ID } from "./config.js";
import {
  rowToWord,
  wordToStatsRow,
  wordToEnrichmentRow,
  wordToNewRow,
} from "./model.js";

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
 * Write one word's stats to the app-owned columns `F{row}:K{row}`.
 * @param {string} token OAuth access token
 * @param {object} word a Word object with a valid `rowIndex`
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writeStats(token, word) {
  const row = word.rowIndex;
  const range = encodeURIComponent(`Words!F${row}:K${row}`);
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
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function appendWords(token, words) {
  const range = encodeURIComponent(`Words!A${FIRST_DATA_ROW}:P`);
  await request(
    token,
    "POST",
    `${range}:append?insertDataOption=INSERT_ROWS&valueInputOption=RAW`,
    { values: words.map(wordToNewRow) },
  );
}

/**
 * Write one word's enrichment fields to the columns `L{row}:P{row}`.
 * Grading writes stay in `F:K` (see writeStats) — the ranges never overlap.
 * @param {string} token OAuth access token
 * @param {object} word a Word object with a valid `rowIndex`
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writeEnrichment(token, word) {
  const row = word.rowIndex;
  const range = encodeURIComponent(`Words!L${row}:P${row}`);
  await request(token, "PUT", `${range}?valueInputOption=RAW`, {
    values: [wordToEnrichmentRow(word)],
  });
}
