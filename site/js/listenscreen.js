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

import { listenTexts, counterText, screenView } from "./listenflow.js";
import { getKey } from "./apikey.js";
import { openKeySetup } from "./keysetup.js";
import { listenEmptyVariant } from "./keysetupflow.js";

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
    nokey: $("listen-nokey"),
    setupKey: $("listen-setup-key"),
    error: $("listen-error"),
    errorRetry: $("listen-retry"),
  };

  let open = false;

  function render(state) {
    const view = screenView(state);
    // Empty with no key (issue #64, design/key-setup.md): invite into the
    // key setup instead of the dead-end import CTA. Playback of stored
    // clips needs no key, so this only ever replaces the *empty* state.
    const emptyVariant = listenEmptyVariant(getKey() != null);
    els.body.hidden = view.screen !== "player";
    els.controls.hidden = view.screen !== "player";
    els.empty.hidden = view.screen !== "empty" || emptyVariant !== "import";
    els.nokey.hidden = view.screen !== "empty" || emptyVariant !== "no-key";
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
    // Spanish on top (word, then phrase), matching translation below
    // (#90/#92); .is-phrase is the big slot's smaller wrapping variant
    // (plain .phrase is taken by the review card's styles).
    const texts = listenTexts(np.word, np.segment);
    els.word.textContent = texts.big;
    els.word.classList.toggle("is-phrase", texts.phrase);
    els.line.textContent = texts.line;
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

  // Into the guided key setup (issue #64). The guide overlays this screen
  // (in the normal palette, by design), so Listen's global shortcuts are
  // handed off while it is open — Space/Esc belong to the paste field.
  // On return a re-render picks the right empty variant: with a key saved
  // the invitation yields to the regular import CTA, no reload.
  els.setupKey.addEventListener("click", () => {
    document.removeEventListener("keydown", onKey);
    openKeySetup({
      onDone: () => {
        document.addEventListener("keydown", onKey);
        render(player.state());
      },
    });
  });

  return {
    open() {
      open = true;
      els.word.textContent = "";
      els.word.classList.remove("is-phrase");
      els.line.textContent = "";
      els.counter.textContent = "";
      document.addEventListener("keydown", onKey);
      void player.start(getWords());
    },
  };
}
