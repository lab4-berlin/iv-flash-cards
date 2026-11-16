// Onboarding screen controller — issue #76 (design/onboarding.md).
//
// DOM glue over the four first-run states (Setting up, Language, AI key
// offer, Setup failed); every decision lives in onboardflow.js. app.js
// orchestrates — it resolves the sheet, saves the language, and routes
// between steps — so this module only renders states and reports taps:
//
//   - `onContinue(code)` — Continue tapped with a selected language;
//     app.js runs the write (driving `setSaving`) and routes on success.
//   - `onDone()` — the key-offer step is over (key set up or skipped);
//     app.js lands on Home.
//
// "Set up the free key" opens #64's guide via openKeySetup({ onDone }) in
// its onboarding context: finishing *or closing* the guide counts — either
// way the user lands on Home. Nothing of the key UI lives here.
//
// The language list comes from languages.js — no hardcoded names.

import { SUPPORTED } from "./languages.js";
import { openKeySetup } from "./keysetup.js";
import {
  moveSelection,
  languageCaption,
  continueDisabled,
} from "./onboardflow.js";

const $ = (id) => document.getElementById(id);

/**
 * Wire the onboarding sections once.
 *
 * @param {object} deps
 * @param {(id: string) => void} deps.showScreen app.js's state switcher —
 *   shows one stage section and hides the rest
 * @param {(code: string) => void} deps.onContinue Continue tapped;
 *   receives the selected languages.js code
 * @param {() => void} deps.onDone key offer finished or skipped → Home
 * @returns {{ showSettingUp, showLanguage, setSaving, showKeyOffer,
 *   showError }}
 */
export function initOnboardScreen({ showScreen, onContinue, onDone }) {
  const els = {
    language: $("state-onboard-language"),
    menu: $("ob-menu"),
    continue: $("ob-continue"),
    caption: $("ob-caption"),
    setupKey: $("ob-setup-key"),
    skipKey: $("ob-skip-key"),
    retry: $("ob-retry"),
  };

  let selected = null; // index into SUPPORTED, or null before any tap
  let saving = false; // the learning_language write is running
  let retry = null; // showError's "re-run the failed step" callback

  // The six option buttons, inserted before Continue (mockup order).
  const optionButtons = SUPPORTED.map((language, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn outline";
    button.textContent = language.name;
    button.addEventListener("click", () => select(index));
    els.menu.insertBefore(button, els.continue);
    return button;
  });

  function render() {
    for (const [i, button] of optionButtons.entries()) {
      button.classList.toggle("solid", i === selected);
      button.classList.toggle("outline", i !== selected);
      button.disabled = saving; // inert while the write runs
    }
    const disabled = continueDisabled({ selected: selected !== null, saving });
    els.continue.disabled = disabled;
    els.continue.classList.toggle("disabled", disabled);
    els.continue.classList.toggle("solid", !disabled);
    const caption = languageCaption({ selected: selected !== null, saving });
    els.caption.textContent = caption;
    els.caption.hidden = caption === "";
  }

  /** Tap selects (solid ink); tapping another option moves the selection. */
  function select(index) {
    if (saving) return;
    selected = index;
    render();
  }

  function commit() {
    if (continueDisabled({ selected: selected !== null, saving })) return;
    onContinue(SUPPORTED[selected].code);
  }

  els.continue.addEventListener("click", commit);

  // Keyboard (spec): ↑/↓ move the selection, Enter = Continue.
  document.addEventListener("keydown", (event) => {
    if (els.language.hidden || saving) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault(); // don't scroll
      selected = moveSelection(
        selected,
        event.key === "ArrowDown" ? 1 : -1,
        SUPPORTED.length,
      );
      render();
    } else if (event.key === "Enter") {
      // A focused button activates natively — don't double-fire.
      if (document.activeElement?.closest("button, a")) return;
      commit();
    }
  });

  // Key offer: the guide in its onboarding context (finish or close →
  // Home), or skip straight to Home — a first-class path.
  els.setupKey.addEventListener("click", () => openKeySetup({ onDone }));
  els.skipKey.addEventListener("click", () => onDone());

  els.retry.addEventListener("click", () => {
    const run = retry;
    retry = null;
    if (run) run();
  });

  return {
    /** Blocking message while the sheet is actually being created. */
    showSettingUp() {
      showScreen("state-onboard-setup");
    },

    /** STEP 1 OF 2 — the picker, fresh (nothing selected). */
    showLanguage() {
      selected = null;
      saving = false;
      render();
      showScreen("state-onboard-language");
    },

    /** Continue's saving state (spec: disabled + "Saving…" caption). */
    setSaving(value) {
      saving = value;
      render();
    },

    /** STEP 2 OF 2 — the optional, skippable key offer. */
    showKeyOffer() {
      showScreen("state-onboard-key");
    },

    /**
     * Setup failed: blocking error + Retry. `onRetry` re-runs only the
     * failed step (find-or-create and ensureTabs are idempotent, so a
     * retry never duplicates — ADR-0008). No skip out of this state.
     */
    showError(onRetry) {
      retry = onRetry;
      showScreen("state-onboard-error");
    },
  };
}
