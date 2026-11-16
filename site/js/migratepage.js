// One-time legacy-sheet migration page (ADR-0008 "Legacy adoption", #63/#77).
//
// Drives site/migrate.html (unlinked from the app): the owner signs in,
// pastes the hand-made sheet's URL or ID, and the page copies its
// `Words!A2:P` rows verbatim — in ONE batched `values.update`, preserving
// row order and therefore `rowIndex`, the stats block `G:L`, and the audio
// file IDs `M:P` — into the app-created sheet resolved by discovery
// (ensureSpreadsheet + ensureTabs, exactly the production startup path).
//
// Safety contract (ADR-0008):
//   - The old sheet is ONLY EVER READ (via readWordsFrom and the
//     `spreadsheets` scope — no Drive access to it is needed or taken).
//   - The copy refuses to run when the target already has data rows, so a
//     retry after failure is safe and a double-run cannot duplicate rows.
//
// The pure parts (ID/URL extraction, copy guard) and copyWords (with a
// stubbed fetch) are unit-tested; the DOM wiring below only runs in the
// browser.

import {
  setSpreadsheetId,
  readWordsFrom,
  loadWords,
  valuesRequest,
  ensureTabs,
} from "./sheets.js";
import { ensureSpreadsheet } from "./drive.js";
import { writeLearningLanguage } from "./settings.js";
import { STORAGE_KEY as PENDING_WRITES_KEY } from "./queue.js";
import { wordToNewRow } from "./model.js";

const FIRST_DATA_ROW = 2; // row 1 is the header

/** A migration refusal or bad input — shown to the user verbatim. */
export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationError";
  }
}

// ---------------------------------------------------------------- pure parts

/**
 * Extract a spreadsheet ID from pasted input: either a full Google Sheets
 * URL (`…/spreadsheets/d/<id>/edit…`, `/u/<n>/` paths included) or a bare
 * ID (the long `[A-Za-z0-9_-]` segment itself). Returns null when the
 * input is neither — a short word, another kind of URL, etc.
 * @param {string|null|undefined} input pasted text
 * @returns {string|null} the ID, or null when none can be extracted
 */
export function extractSpreadsheetId(input) {
  const text = (input ?? "").trim();
  if (!text) return null;
  const fromUrl = /\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(text);
  if (fromUrl) return fromUrl[1];
  // Bare ID: one long token of ID characters (real IDs are ~44 chars; the
  // length floor rejects accidental words without rejecting any real ID).
  if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return text;
  return null;
}

/**
 * The copy guard (ADR-0008): the migration may only run into a target with
 * zero data rows. Throws a {@link MigrationError} otherwise.
 * @param {object[]} targetWords the target's current `Words!A2:P` rows
 */
export function guardTargetEmpty(targetWords) {
  if (targetWords.length === 0) return;
  const rows = targetWords.length === 1 ? "1 data row" : `${targetWords.length} data rows`;
  throw new MigrationError(
    `The app's sheet already has ${rows} — refusing to copy. ` +
      "Migration only runs into an empty sheet (so a retry can never duplicate rows).",
  );
}

// ----------------------------------------------------------------- the copy

/**
 * Copy `Words!A2:P` from the source sheet into the app's sheet (the ID
 * injected via setSpreadsheetId): read the source verbatim (readWordsFrom,
 * read-only), check the target is empty ({@link guardTargetEmpty}), then
 * write all rows in ONE batched `values.update` of `A2:P{n}` — row order,
 * stats `G:L`, and audio IDs `M:P` unchanged. The source sheet is never
 * written.
 * @param {string} token OAuth access token
 * @param {string} sourceId the old (hand-made) spreadsheet's ID
 * @returns {Promise<{read: number, written: number}>} row counts
 * @throws {MigrationError} on an empty source or a non-empty target
 */
export async function copyWords(token, sourceId) {
  const source = await readWordsFrom(token, sourceId);
  if (source.length === 0) {
    throw new MigrationError(
      "The old sheet has no data rows (Words!A2:P is empty) — check the URL or ID.",
    );
  }
  guardTargetEmpty(await loadWords(token));

  const values = source.map(wordToNewRow);
  const lastRow = FIRST_DATA_ROW - 1 + values.length;
  const range = encodeURIComponent(`Words!A${FIRST_DATA_ROW}:P${lastRow}`);
  await valuesRequest(token, "PUT", `${range}?valueInputOption=RAW`, { values });
  return { read: source.length, written: values.length };
}

// ------------------------------------------------------------- page wiring

async function initMigratePage() {
  // Loaded here, not at the top: config.js is gitignored (it exists only in
  // a configured checkout/deploy), and unit tests import this module's pure
  // exports in Node, where neither config nor a DOM exists.
  const config = await import("./config.js");
  const auth = await import("./auth.js");

  const $ = (id) => document.getElementById(id);
  const els = {
    signin: $("mig-signin"),
    signinHint: $("mig-signin-hint"),
    signinBtn: $("mig-signin-btn"),
    form: $("mig-form"),
    source: $("mig-source"),
    error: $("mig-error"),
    run: $("mig-run"),
    running: $("mig-running"),
    status: $("mig-status"),
    done: $("mig-done"),
    report: $("mig-report"),
  };

  function show(section) {
    for (const el of [els.signin, els.form, els.running, els.done]) {
      el.hidden = el !== section;
    }
  }

  function showFormError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
    show(els.form);
  }

  function status(text) {
    els.status.textContent = text;
    show(els.running);
  }

  async function run() {
    els.error.hidden = true;
    const sourceId = extractSpreadsheetId(els.source.value);
    if (!sourceId) {
      showFormError("That doesn't look like a Google Sheets URL or spreadsheet ID.");
      return;
    }
    try {
      status("Finding the app's sheet\u2026");
      const token = auth.getToken() ?? (await auth.requestToken({ silent: true }));
      // The production startup path (ADR-0008): discover — or create — the
      // app's sheet, then make sure both tabs are in shape. Idempotent.
      setSpreadsheetId(await ensureSpreadsheet(token));
      await ensureTabs(token);

      status("Copying words\u2026");
      const { read, written } = await copyWords(token, sourceId);

      status("Writing settings\u2026");
      await writeLearningLanguage(token, "es");
      // Pending stats writes queued against the old sheet's row indices
      // must not replay into the new sheet.
      globalThis.localStorage?.removeItem(PENDING_WRITES_KEY);

      els.report.textContent =
        `${read} rows read from the old sheet \u00b7 ${written} rows written. ` +
        "The old sheet was not modified; it stays in Drive as a backup.";
      show(els.done);
    } catch (error) {
      showFormError(
        error instanceof MigrationError
          ? error.message
          : `Migration failed before any damage could occur: ${error.message}. The old sheet was not modified. Fix the problem and try again.`,
      );
    }
  }

  async function start() {
    try {
      await auth.init(config.CLIENT_ID);
    } catch {
      els.signinHint.textContent = "Couldn't load Google sign-in — check your connection and reload.";
      show(els.signin);
      return;
    }
    if (!auth.getToken()) {
      try {
        await auth.requestToken({ silent: true });
      } catch {
        show(els.signin);
        return;
      }
    }
    show(els.form);
  }

  els.signinBtn.addEventListener("click", async () => {
    try {
      await auth.requestToken(); // interactive popup — needs the user gesture
      show(els.form);
    } catch {
      els.signinHint.textContent = "Sign-in failed — try again.";
    }
  });
  els.run.addEventListener("click", () => void run());

  void start();
}

// Node (unit tests) imports the pure parts; only a real page has the DOM.
if (typeof document !== "undefined" && document.getElementById("mig-run")) {
  void initMigratePage();
}
