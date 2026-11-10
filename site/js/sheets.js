// Google Sheets API v4 adapter (ADR-0001, ADR-0003).
// Reads only `Words!A2:K`; writes only the app-owned columns `F:K` of one
// row at a time. User-owned columns (A:E) are never written.

import { SPREADSHEET_ID } from "./config.js";
import { rowToWord, wordToStatsRow } from "./model.js";

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
 * Read all words from `Words!A2:K`.
 * @param {string} token OAuth access token
 * @returns {Promise<object[]>} Word objects (see model.js), each carrying
 *   the 1-based sheet row it came from as `rowIndex`.
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function loadWords(token) {
  const range = encodeURIComponent(`Words!A${FIRST_DATA_ROW}:K`);
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
