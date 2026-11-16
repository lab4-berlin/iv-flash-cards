// Per-user settings in the `Settings` worksheet (ADR-0008): key–value
// layout, `A` = key, `B` = value, header row `key | value`. Settings live
// in the sheet — not localStorage — so they follow the user across
// devices. First key: `learning_language` (codes per languages.js), which
// doubles as the onboarding "done" signal.
//
// Shares the spreadsheet-ID injection and error classes of sheets.js:
// `setSpreadsheetId` must have been called before anything here runs.

import { valuesRequest, SheetsError } from "./sheets.js";

const FIRST_DATA_ROW = 2; // row 1 is the `key | value` header
const DATA_RANGE = `Settings!A${FIRST_DATA_ROW}:B`;

const key = (row) => (row[0] ?? "").trim();

/**
 * Read all settings rows (`Settings!A2:B`) into a plain object, e.g.
 * `{ learning_language: "es" }`. Rows with a blank key are skipped. A
 * missing `Settings` tab (a values read of it is a 400) means "no settings
 * yet" and yields `{}` — not an error — so callers can probe the
 * onboarding state before `ensureTabs` ever ran.
 * @param {string} token OAuth access token
 * @returns {Promise<Record<string, string>>}
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function readSettings(token) {
  let data;
  try {
    data = await valuesRequest(token, "GET", encodeURIComponent(DATA_RANGE));
  } catch (error) {
    if (error instanceof SheetsError && error.status === 400) return {};
    throw error;
  }
  const settings = {};
  for (const row of data.values ?? []) {
    if (key(row)) settings[key(row)] = (row[1] ?? "").trim();
  }
  return settings;
}

/**
 * Upsert the `learning_language` row: overwrite the value in place when
 * the key already exists, otherwise append a new row at the bottom (via
 * `values.append` with `INSERT_ROWS`, like appendWords). Safe to re-run —
 * a retry can never produce a duplicate key.
 * @param {string} token OAuth access token
 * @param {string} code a language code per languages.js, e.g. "es"
 * @throws {SheetsAuthError} on 401, {SheetsError} on other API failures
 */
export async function writeLearningLanguage(token, code) {
  const data = await valuesRequest(token, "GET", encodeURIComponent(DATA_RANGE));
  const values = [["learning_language", code]];
  const index = (data.values ?? []).findIndex((row) => key(row) === "learning_language");
  if (index === -1) {
    await valuesRequest(
      token,
      "POST",
      `${encodeURIComponent(DATA_RANGE)}:append?insertDataOption=INSERT_ROWS&valueInputOption=RAW`,
      { values },
    );
    return;
  }
  const row = FIRST_DATA_ROW + index;
  await valuesRequest(
    token,
    "PUT",
    `${encodeURIComponent(`Settings!A${row}:B${row}`)}?valueInputOption=RAW`,
    { values },
  );
}
