// Key-setup screen controller — issue #64 (design/key-setup.md).
//
// Owns the #state-keysetup section: the one-screen guided flow that takes
// a non-technical user from "no key" to a validated Gemini key, plus the
// manage state (masked key, Replace, Remove) when a key is already saved.
// The section is a self-contained fixed overlay in the normal palette —
// it sits above whatever opened it (including the inverted listen screen,
// which inversion never leaks into) and manages its own visibility, so
// callers never go through app.js's state machine.
//
// Entry contract (architecture note on #64): `openKeySetup({ onDone })`.
// Import, Listen — and later onboarding (#76) — open the guide with it;
// `onDone` fires on every exit (Done after a validated key, or ✕ without
// one) and the caller re-checks `getKey()` to react. The key itself is
// written only on a validated "ok" — a failed check never destroys a
// working key (Replace keeps the old key until the new one validates).
//
// All decisions (verdict views, masking, guide-vs-manage) live in
// keysetupflow.js; this file is pure DOM glue over apikey.js.

import { getKey, setKey, clearKey, validateKey } from "./apikey.js";
import {
  cleanKey,
  checkDisabled,
  verdictView,
  maskKey,
  guideScreen,
} from "./keysetupflow.js";

const $ = (id) => document.getElementById(id);

let els = null; // wired lazily on the first open
let onDone = null; // the current caller's exit callback
let screen = "guide"; // "guide" | "manage" (guideScreen of the saved key)
let replacing = false; // manage: the paste field is revealed
let outcome = null; // null | "checking" | a validateKey() verdict

function render() {
  const manage = screen === "manage";
  const view = verdictView(outcome);
  // The paste field + check button: the guide always shows them; manage
  // only after Replace. A validated key collapses the field into the
  // success block (design: the field is replaced, the button becomes Done).
  const pasting = !manage || replacing;

  els.guide.hidden = manage;
  els.manage.hidden = !manage;
  els.replace.hidden = !manage || replacing;
  els.remove.hidden = !manage || replacing;

  els.input.hidden = !pasting || view.success;
  els.check.hidden = !pasting;
  els.verdict.hidden = !pasting || (view.lead === "" && view.why === "");
  els.lead.hidden = view.lead === "";
  els.lead.textContent = view.lead;
  els.why.textContent = view.why;

  els.check.textContent = view.buttonLabel;
  const disabled = view.busy || (!view.success && checkDisabled(els.input.value));
  els.check.disabled = disabled;
  els.check.classList.toggle("disabled", disabled);
  els.check.classList.toggle("solid", !disabled);
}

function close() {
  els.section.hidden = true;
  const done = onDone;
  onDone = null;
  if (done) done();
}

async function check() {
  if (verdictView(outcome).success) {
    close(); // the button is "Done" now
    return;
  }
  const value = cleanKey(els.input.value);
  if (value === "") return; // the button is disabled; belt and braces
  outcome = "checking";
  render();
  const verdict = await validateKey(value);
  // Saved at this moment, not before (design) — so a Replace keeps the
  // old key through "invalid" and "network-error".
  if (verdict === "ok") setKey(value);
  outcome = verdict;
  render();
}

/** Back to the fresh guide state (first open with no key, or after Remove). */
function showGuide() {
  screen = "guide";
  replacing = false;
  outcome = null;
  els.input.value = "";
  render();
}

function init() {
  els = {
    section: $("state-keysetup"),
    close: $("ks-close"),
    guide: $("ks-guide"),
    manage: $("ks-manage"),
    masked: $("ks-masked"),
    replace: $("ks-replace"),
    remove: $("ks-remove"),
    verdict: $("ks-verdict"),
    lead: $("ks-lead"),
    why: $("ks-why"),
    input: $("ks-input"),
    check: $("ks-check"),
  };

  els.close.addEventListener("click", close);
  els.check.addEventListener("click", () => void check());
  els.input.addEventListener("input", render); // follow the field's emptiness
  els.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void check();
  });

  els.replace.addEventListener("click", () => {
    replacing = true;
    outcome = null;
    els.input.value = "";
    render();
    els.input.focus();
  });

  // No confirmation (design: recovery is pasting again). Import and Listen
  // fall back to their blocked invitations via the caller's onDone.
  els.remove.addEventListener("click", () => {
    clearKey();
    showGuide();
  });
}

/**
 * Open the key-setup screen over the current one. With no key saved it
 * shows the numbered guide; with one, the manage state. `onDone` fires on
 * every exit — callers re-check `getKey()` to unlock (or re-block) their
 * own screens, which is what makes a validated key take effect without a
 * reload.
 *
 * @param {{ onDone?: () => void }} [options]
 */
export function openKeySetup({ onDone: done } = {}) {
  if (!els) init();
  onDone = done ?? null;
  const key = getKey();
  if (guideScreen(key != null) === "manage") {
    screen = "manage";
    replacing = false;
    outcome = null;
    els.input.value = "";
    els.masked.textContent = maskKey(key);
    render();
  } else {
    showGuide();
  }
  els.section.hidden = false;
  els.section.scrollTop = 0; // the guide reads top-down; start there
}
