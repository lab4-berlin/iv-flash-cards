// Sheet row ⇄ Word object mapping (pure module, no DOM/fetch).
// Column layout (docs/sheet-template.md):
//   A word | B translation | C example | D date_added | E language |
//   F times_shown | G times_right | H times_wrong | I last_reviewed |
//   J interval_days | K due_date | L phrase_translation |
//   M audio_word_es | N audio_phrase_es | O audio_word_en | P audio_phrase_en
// The Sheets API returns rows as arrays of strings; trailing empty cells
// may be omitted entirely. Empty app columns (F:K) mean "new word"; empty
// enrichment cells (L:P) mean "missing — generate on next backfill"
// (ADR-0005), so pre-V2 11-column rows stay valid.

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
    dateAdded: text(row[3]) ?? "",
    language: text(row[4]) ?? "",
    timesShown: count(row[5]),
    timesRight: count(row[6]),
    timesWrong: count(row[7]),
    lastReviewed: text(row[8]),
    intervalDays: count(row[9]),
    dueDate: text(row[10]),
    phraseTranslation: text(row[11]),
    audioWordEs: text(row[12]),
    audioPhraseEs: text(row[13]),
    audioWordEn: text(row[14]),
    audioPhraseEn: text(row[15]),
    rowIndex,
  };
}

/**
 * Map a Word to the 6-element array for the app-owned columns `F:K`.
 * Nulls become empty cells. User-owned columns (A:E) are never written.
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
 * Map a Word to the 5-element array for the enrichment columns `L:P`.
 * Nulls become empty cells, which by ADR-0005 mean "missing — generate
 * on next backfill".
 * @param {ReturnType<typeof rowToWord>} word
 */
export function wordToEnrichmentRow(word) {
  return [
    word.phraseTranslation ?? "",
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
    word.dateAdded,
    word.language,
    ...wordToStatsRow(word),
    ...wordToEnrichmentRow(word),
  ];
}
