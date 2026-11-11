// Import screen view logic — issue #37, part of #27.
//
// Pure functions mapping importer.js batch state to what the screens in
// design/word-import.md display: step-1 word counting, step-2 row statuses
// and the progress counter, step-3 report grouping, and the whole-batch
// "generator unreachable" detection. No DOM — the DOM glue lives in
// importscreen.js; these are the unit-testable parts.

import { parseInput, normalizeWord } from "./importer.js";

/**
 * The step-1 word list: parsed input with duplicates within the input
 * collapsed silently (first spelling kept) — the count caption and the
 * Generate button reflect unique words (design/word-import.md step 1).
 * Duplicates against the sheet are NOT dropped here; those become visible
 * "already in list" rows in step 2.
 * @param {string} text raw textarea content
 * @returns {string[]} unique words in input order
 */
export function uniqueWords(text) {
  const seen = new Set();
  const words = [];
  for (const word of parseInput(text)) {
    const normalized = normalizeWord(word);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    words.push(word);
  }
  return words;
}

/** The muted caption under the text area: "12 words". */
export function countCaption(count) {
  return `${count} ${count === 1 ? "word" : "words"}`;
}

/** The primary button label: "Generate 12 words", or "Generate" at 0. */
export function generateLabel(count) {
  if (count === 0) return "Generate";
  return `Generate ${countCaption(count)}`;
}

/** Short muted reason for a failed row, from the phase the word broke in. */
export function failureCaption(item) {
  if (item?.error?.name === "RateLimitError") return "rate limited";
  switch (item?.phase) {
    case "enriching":
      return "generation failed";
    case "appending":
      return "couldn't save";
    case "audio":
      return "audio failed";
    default:
      return "failed";
  }
}

/**
 * Map one batch item (importer.js states) to a step-2 list row
 * (design-system "List row"): ✓ done, ✕ failed (+reason), — skipped
 * (muted, +"already in list"), "generating…" caption while active, and
 * the word itself muted while pending.
 * @param {object} item a batch item, or any {word, state[, phase, error]}
 * @returns {{word: string, glyph: string|null, glyphMuted: boolean,
 *   caption: string|null, pending: boolean}}
 */
export function rowView(item) {
  const view = {
    word: item.word,
    glyph: null,
    glyphMuted: false,
    caption: null,
    pending: false,
  };
  switch (item.state) {
    case "done":
      return { ...view, glyph: "\u2713" };
    case "failed":
      return { ...view, glyph: "\u2715", caption: failureCaption(item) };
    case "skipped-duplicate":
      return { ...view, glyph: "\u2014", glyphMuted: true, caption: "already in list" };
    case "pending":
      return { ...view, pending: true };
    default: // enriching | appending | audio — all read as "generating…"
      return { ...view, caption: "generating\u2026" };
  }
}

/**
 * The step-2 progress component: "3 / 6" counts settled words (done,
 * failed, or skipped) out of the whole batch, matching the mockup.
 * @param {object[]} items batch items
 * @returns {{label: string, percent: number}}
 */
export function progressView(items) {
  const settled = items.filter((i) =>
    ["done", "failed", "skipped-duplicate"].includes(i.state),
  ).length;
  const total = items.length;
  return {
    label: `${settled} / ${total}`,
    percent: total === 0 ? 0 : (settled / total) * 100,
  };
}

/**
 * The step-3 headline and subline: "9 added" + "2 skipped · 1 failed",
 * with empty groups omitted (sub is null when nothing was skipped/failed).
 * @param {{imported: number, skipped: number, failed: number}} counts
 * @returns {{headline: string, sub: string|null}}
 */
export function resultsView({ imported, skipped, failed }) {
  const parts = [];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  return {
    headline: `${imported} added`,
    sub: parts.length > 0 ? parts.join(" \u00b7 ") : null,
  };
}

/** The retry button label: "Retry 1 failed". */
export function retryLabel(failedCount) {
  return `Retry ${failedCount} failed`;
}

/**
 * The step-3 skipped group, collapsed to a single muted line when more
 * than 3 words were skipped (design/word-import.md step 3).
 * @param {string[]} words skipped words
 * @returns {{collapsed: boolean, words: string[], line: string|null}}
 */
export function skippedView(words) {
  if (words.length <= 3) return { collapsed: false, words, line: null };
  return {
    collapsed: true,
    words,
    line: `${words.length} words already in list`,
  };
}

/**
 * Split failed items for a retry run: words that already have a sheet row
 * (they broke generating audio) retry via generateMissingClips; words that
 * never reached the sheet re-run through the full pipeline.
 * @param {object[]} failedItems items with state "failed"
 * @returns {{clipRetries: object[], rerunWords: string[]}}
 */
export function partitionFailed(failedItems) {
  const clipRetries = [];
  const rerunWords = [];
  for (const item of failedItems) {
    if (item.phase === "audio" && item.rowIndex != null) clipRetries.push(item);
    else rerunWords.push(item.word);
  }
  return { clipRetries, rerunWords };
}

/**
 * Whole-batch failure detection (design/word-import.md error states): the
 * generator counts as unreachable when the first word to settle failed
 * while talking to the API (enriching phase, not a response-shape problem)
 * before anything succeeded. A later enriching failure, or one after any
 * success, stays a row-level ✕.
 * @param {object[]} items batch items (any progress snapshot)
 * @returns {boolean}
 */
export function isGeneratorUnreachable(items) {
  const settled = items.filter((i) => ["done", "failed"].includes(i.state));
  if (settled.length === 0) return false;
  if (settled.some((i) => i.state === "done")) return false;
  const first = settled[0];
  return (
    first.phase === "enriching" &&
    first.error?.name !== "EnrichmentParseError"
  );
}
