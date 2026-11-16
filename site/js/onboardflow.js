// Onboarding flow decisions — issue #76 (design/onboarding.md). Pure: no
// DOM, no network, no storage. onboardscreen.js renders what this module
// decides; app.js provides the inputs (sheet discovery, settings, key).
//
// The "onboarding is done" signal is: sheet exists AND `learning_language`
// is set (ADR-0008). Everything below follows from the spec's resume-rules
// table.

/**
 * Which screen comes next, given what the session knows.
 *
 * `sheetExisted` is a session constant: whether discovery found the sheet
 * when this visit started (`false` = the app created it this visit). The
 * resume rules key on it:
 *
 * - no sheet → `"settingUp"` (find-or-create runs; it is idempotent, so a
 *   visit interrupted mid-creation never duplicates the sheet);
 * - sheet exists but no `learning_language` → `"language"` directly — no
 *   "Setting up" flash;
 * - `learning_language` set on a *previous* visit (`sheetExisted` true) →
 *   `"home"`, never the key offer: a returning user sees zero onboarding
 *   screens. They meet the key invitation on Import/Listen instead
 *   (design/key-setup.md);
 * - `learning_language` saved *this* visit (`sheetExisted` false, the true
 *   first run) → `"keyOffer"` when no key is stored on the device,
 *   `"home"` when one is.
 *
 * @param {object} state
 * @param {boolean} state.sheetExisted discovery found the sheet at the
 *   start of this visit
 * @param {string|null} state.learningLanguage the `Settings` tab's
 *   `learning_language` (a languages.js code), or null when unset
 * @param {boolean} state.hasKey a Gemini key is stored on this device
 * @returns {"settingUp"|"language"|"keyOffer"|"home"}
 */
export function nextStep({ sheetExisted, learningLanguage, hasKey }) {
  if (learningLanguage) {
    return sheetExisted || hasKey ? "home" : "keyOffer";
  }
  return sheetExisted ? "language" : "settingUp";
}

/**
 * Keyboard selection on the language picker (spec: ↑/↓ move selection).
 * With nothing selected, ↓ starts at the top and ↑ at the bottom; with a
 * selection, the ends clamp — no wrap-around.
 *
 * @param {number|null} current selected index, or null when none yet
 * @param {-1|1} delta ↑ = -1, ↓ = +1
 * @param {number} count number of options
 * @returns {number|null} the new selected index
 */
export function moveSelection(current, delta, count) {
  if (count <= 0) return null;
  if (current === null) return delta > 0 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + delta));
}

/**
 * The muted caption under Continue (spec/mockup): nothing before a
 * selection, the stored-in-your-sheet line once one exists, "Saving…"
 * while the write runs.
 *
 * @param {{ selected: boolean, saving: boolean }} state
 * @returns {string} the caption text, "" = hidden
 */
export function languageCaption({ selected, saving }) {
  if (saving) return "Saving\u2026";
  if (selected) {
    return "Stored in your sheet, so it follows you on every device.";
  }
  return "";
}

/**
 * Continue commits the selection (selection alone never advances — a
 * mis-tap must not be final). Disabled until a language is selected, and
 * while the write runs.
 *
 * @param {{ selected: boolean, saving: boolean }} state
 * @returns {boolean}
 */
export function continueDisabled({ selected, saving }) {
  return !selected || saving;
}
