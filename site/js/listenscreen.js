// Listen screen controller — issue #41 (design/listening-mode.md).
//
// Owns the #state-listen section: the only inverted screen. app.js shows
// the section and calls `open()`, which starts the injected player (#40)
// over the current vocabulary; the player decides eligibility, order and
// looping (ADR-0006). Leaving always goes through `deps.onExit` /
// `deps.onImport` — this module never touches other screens.
//
// Driver-safety per the design: the two fixed controls never move, and the
// whole screen outside any button is a play/pause target. Listening writes
// no stats (ADR-0006) — nothing here touches the scheduler or the queue.

import { nowPlayingLine, counterText, screenView } from "./listenflow.js";

const $ = (id) => document.getElementById(id);

/**
 * Wire up the listen screen once.
 *
 * @param {object} deps
 * @param {ReturnType<import("./player.js").createPlayer>} deps.player
 * @param {() => object[]} deps.getWords current vocabulary; the player
 *   filters it to fully-enriched words itself
 * @param {() => void} deps.onExit leave the screen (app decides where)
 * @param {() => void} deps.onImport open the import screen (empty state)
 * @returns {{open: () => void}}
 */
export function initListenScreen({ player, getWords, onExit, onImport }) {
  const els = {
    screen: $("state-listen"),
    close: $("listen-close"),
    counter: $("listen-counter"),
    body: $("listen-body"),
    word: $("listen-word"),
    line: $("listen-line"),
    pausedCap: $("listen-paused"),
    controls: $("listen-controls"),
    playPause: $("listen-play"),
    glyphPlay: $("listen-glyph-play"),
    glyphPause: $("listen-glyph-pause"),
    next: $("listen-next"),
    empty: $("listen-empty"),
    emptyImport: $("listen-import"),
    error: $("listen-error"),
    errorRetry: $("listen-retry"),
  };

  let open = false;

  function render(state) {
    const view = screenView(state);
    els.body.hidden = view.screen !== "player";
    els.controls.hidden = view.screen !== "player";
    els.empty.hidden = view.screen !== "empty";
    els.error.hidden = view.screen !== "error";
    // toggleAttribute, not .hidden: the glyphs are SVG elements, which
    // have no `hidden` property — only the attribute works.
    els.glyphPause.toggleAttribute("hidden", view.glyph !== "pause");
    els.glyphPlay.toggleAttribute("hidden", view.glyph !== "play");
    els.playPause.disabled = view.playDisabled;
    els.pausedCap.hidden = !view.pausedCaption;
    if (view.loadingLine) els.line.textContent = "loading\u2026";
  }

  player.onStateChange((state) => {
    if (open) render(state);
  });

  player.onNowPlaying((np) => {
    if (!open) return;
    els.word.textContent = np.word.word;
    els.line.textContent = nowPlayingLine(np.word, np.clip);
    els.counter.textContent = counterText(np);
  });

  /** Pause/resume from the current state; no-op while loading/empty/error. */
  function toggle() {
    const state = player.state();
    if (state === "playing") player.pause();
    else if (state === "paused") void player.resume();
  }

  function leave(after) {
    open = false;
    document.removeEventListener("keydown", onKey);
    player.stop();
    after();
  }

  // Keyboard (web, per the design): Space = play/pause, → = next, Esc =
  // close. Bound only while the screen is open.
  function onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === " ") {
      event.preventDefault(); // don't scroll
      toggle();
    } else if (event.key === "ArrowRight") {
      void player.skipWord();
    } else if (event.key === "Escape") {
      leave(onExit);
    }
  }

  // The entire screen outside the buttons is a glove-friendly play/pause
  // target (design: recoverable without looking).
  els.screen.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    toggle();
  });

  els.playPause.addEventListener("click", () => toggle());
  els.next.addEventListener("click", () => void player.skipWord());
  els.close.addEventListener("click", () => leave(onExit));
  els.emptyImport.addEventListener("click", () => leave(onImport));
  els.errorRetry.addEventListener("click", () => void player.start(getWords()));

  return {
    open() {
      open = true;
      els.word.textContent = "";
      els.line.textContent = "";
      els.counter.textContent = "";
      document.addEventListener("keydown", onKey);
      void player.start(getWords());
    },
  };
}
