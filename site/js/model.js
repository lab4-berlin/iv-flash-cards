// Sheet row ⇄ Word object mapping (pure module, no DOM/fetch).
// Column layout (docs/sheet-template.md, reordered by #56):
//   A word | B translation | C example | D phrase_translation |
//   E date_added | F language | G times_shown | H times_right |
//   I times_wrong | J last_reviewed | K interval_days | L due_date |
//   M audio_word_es | N audio_phrase_es | O audio_word_en | P audio_phrase_en
// The user-text zone is A:F (D is app-backfilled but user-editable); the
// app-owned stats block is G:L; audio Drive-file refs are M:P. The Sheets
// API returns rows as arrays of strings; trailing empty cells may be
// omitted entirely. Empty stats cells (G:L) mean "new word"; empty audio
// cells (M:P) mean "missing — generate on next backfill" (ADR-0005).

/** Header row the app writes to `A1:P1` of a blank sheet (issue #56). */
export const HEADER_ROW = [
  "word",
  "translation",
  "example",
  "phrase_translation",
  "date_added",
  "language",
  "times_shown",
  "times_right",
  "times_wrong",
  "last_reviewed",
  "interval_days",
  "due_date",
  "audio_word_es",
  "audio_phrase_es",
  "audio_word_en",
  "audio_phrase_en",
];

/**
 * Whether the sheet needs its header row written: true only when a read of
 * `A1:P1` came back with no values at all (a completely blank sheet). A
 * sheet with any row-1 content — even a wrong header — is left untouched.
 * @param {string[][]|undefined} values the `values` field of the Sheets
 *   API response for `A1:P1` (absent when the range is empty)
 */
export function sheetNeedsHeader(values) {
  return (values ?? []).length === 0;
}

function text(cell) {
  const value = (cell ?? "").trim();
  return value === "" ? null : value;
}

function count(cell) {
  const value = Number.parseInt(cell ?? "", 10);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Map one sheet row (values of `Words!A{rowIndex}:P{rowIndex}`) to a Word.
 * @param {string[]} row cell values as returned by the Sheets API
 * @param {number} rowIndex 1-based sheet row number the row came from
 */
export function rowToWord(row, rowIndex) {
  return {
    word: text(row[0]) ?? "",
    translation: text(row[1]) ?? "",
    example: text(row[2]),
    phraseTranslation: text(row[3]),
    dateAdded: text(row[4]) ?? "",
    language: text(row[5]) ?? "",
    timesShown: count(row[6]),
    timesRight: count(row[7]),
    timesWrong: count(row[8]),
    lastReviewed: text(row[9]),
    intervalDays: count(row[10]),
    dueDate: text(row[11]),
    audioWordEs: text(row[12]),
    audioPhraseEs: text(row[13]),
    audioWordEn: text(row[14]),
    audioPhraseEn: text(row[15]),
    rowIndex,
  };
}

/**
 * Map a Word to the 6-element array for the app-owned stats block `G:L`.
 * Nulls become empty cells. Grading writes only this block — user text
 * columns (A:F) are never touched (ADR-0003).
 * @param {ReturnType<typeof rowToWord>} word
 */
export function wordToStatsRow(word) {
  return [
    word.timesShown,
    word.timesRight,
    word.timesWrong,
    word.lastReviewed ?? "",
    word.intervalDays,
    word.dueDate ?? "",
  ];
}

/**
 * Map a Word to the 4-element array for the audio-ref columns `M:P`.
 * Nulls become empty cells, which by ADR-0005 mean "missing — generate
 * on next backfill".
 * @param {ReturnType<typeof rowToWord>} word
 */
export function wordToAudioRefsRow(word) {
  return [
    word.audioWordEs ?? "",
    word.audioPhraseEs ?? "",
    word.audioWordEn ?? "",
    word.audioPhraseEn ?? "",
  ];
}

/**
 * First row number of an A1 range like `Words!A12:P12` → 12. The Sheets
 * append response reports where the row landed via such a range; the import
 * pipeline (#36) needs that row index for enrichment writes and clip names.
 * @param {string|null|undefined} a1Range
 * @returns {number|null} the 1-based row, or null when unparseable
 */
export function firstRowOfRange(a1Range) {
  const match = /![A-Z]+(\d+)/.exec(a1Range ?? "");
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Map a Word to the full 16-element `A:P` array for appending a new row
 * (`values.append`). Nulls become empty cells.
 * @param {ReturnType<typeof rowToWord>} word
 */
export function wordToNewRow(word) {
  return [
    word.word,
    word.translation,
    word.example ?? "",
    word.phraseTranslation ?? "",
    word.dateAdded,
    word.language,
    ...wordToStatsRow(word),
    ...wordToAudioRefsRow(word),
  ];
}
