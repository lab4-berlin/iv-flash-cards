// Listen-screen view logic (issue #41, design/listening-mode.md). Pure
// module: maps the player's now-playing payloads and states to what the
// screen shows. The DOM glue lives in listenscreen.js.

/**
 * Texts for the two now-playing slots (#90/#92): the big top slot always
 * shows Spanish — the word during the word half of the sequence, the phrase
 * during the phrase half — and the muted line below shows the matching
 * English translation, hidden (empty) during the recall pauses so the
 * listener gets their recall moment before the confirmation.
 *
 * | Segments               | `big` (Spanish) | `line` (English)   |
 * |------------------------|-----------------|--------------------|
 * | 0 word_es, 1 recall    | word            | "" (hidden)        |
 * | 2 word_en, 3 breather  | word            | word translation   |
 * | 4 phrase_es, 5 recall  | phrase          | "" (hidden)        |
 * | 6 phrase_en, 7 sep.    | phrase          | phrase translation |
 *
 * @param {object|null} word the now-playing word
 * @param {number} segment index 0–7 within the word's fixed 8-segment
 *   sequence (the player's now-playing payload)
 * @returns {{big: string, line: string, phrase: boolean}} `phrase` flags
 *   the phrase half — the screen renders the big slot in its smaller,
 *   wrapping variant.
 */
export function listenTexts(word, segment) {
  const phrase = segment >= 4;
  if (!word) return { big: "", line: "", phrase };
  const line =
    segment === 2 || segment === 3
      ? (word.translation ?? "")
      : segment === 6 || segment === 7
        ? (word.phraseTranslation ?? "")
        : "";
  return { big: (phrase ? word.example : word.word) ?? "", line, phrase };
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
