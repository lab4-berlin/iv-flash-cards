// Listen-screen view logic (issue #41, design/listening-mode.md). Pure
// module: maps the player's now-playing payloads and states to what the
// screen shows. The DOM glue lives in listenscreen.js.

/**
 * Text for the muted now-playing line under the big word: the clip being
 * spoken right now. Empty during the Spanish word clip (the word is already
 * huge on screen) and during the silence gaps (clip = null), per the design.
 *
 * @param {object|null} word the now-playing word
 * @param {string|null} clip a player SEGMENT_KINDS value, null during gaps
 */
export function nowPlayingLine(word, clip) {
  if (!word || !clip) return "";
  if (clip === "phrase_es") return word.example ?? "";
  if (clip === "word_en") return word.translation ?? "";
  if (clip === "phrase_en") return word.phraseTranslation ?? "";
  return ""; // word_es
}

/** The muted top-right cycle counter: "12 / 87". */
export function counterText(np) {
  return `${np.position} / ${np.cycleSize}`;
}

/**
 * What the screen shows for a player state (design states table).
 *
 * - `screen`: which of the three layouts is visible. "player" keeps the
 *   word/line/controls; "empty"/"error" swap in a message instead.
 * - `glyph`: big-control icon — "pause" (two bars) only while playing;
 *   everything else shows the play triangle.
 * - `playDisabled`: loading disables the big control (hairline-inv fill).
 * - `loadingLine`: "loading…" replaces the now-playing line.
 * - `pausedCaption`: muted "paused" caption above the controls.
 *
 * @param {string} state a player.js state
 */
export function screenView(state) {
  return {
    screen: state === "empty" ? "empty" : state === "error" ? "error" : "player",
    glyph: state === "playing" ? "pause" : "play",
    playDisabled: state === "loading",
    loadingLine: state === "loading",
    pausedCaption: state === "paused",
  };
}
