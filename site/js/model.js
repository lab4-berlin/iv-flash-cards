// Sheet row ⇄ Word object mapping (pure module, no DOM/fetch).
// Column layout (docs/sheet-template.md):
//   A word | B translation | C example | D date_added | E language |
//   F times_shown | G times_right | H times_wrong | I last_reviewed |
//   J interval_days | K due_date
// The Sheets API returns rows as arrays of strings; trailing empty cells
// may be omitted entirely. Empty app columns (F:K) mean "new word".

function text(cell) {
  const value = (cell ?? "").trim();
  return value === "" ? null : value;
}

function count(cell) {
  const value = Number.parseInt(cell ?? "", 10);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Map one sheet row (values of `Words!A{rowIndex}:K{rowIndex}`) to a Word.
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
