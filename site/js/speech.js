// Web Speech API (speechSynthesis) wrapper with voice selection for the
// active learning language (issue #16 / #5, parameterized by #78). Thin
// adapter, verified manually per the testing strategy.
//
// The voice list is often empty until the browser fires `voiceschanged`
// (notoriously async in Chrome). We therefore re-pick lazily on every call
// while no voice has been found yet, and notify subscribers when the list
// changes so the UI can enable the speaker buttons late.

import { byCode } from "./languages.js";

const synth = globalThis.speechSynthesis ?? null;

// The active learning language: the exact-locale prefix tried first (e.g.
// "es-es") and the bare code tried second (e.g. "es"). Defaults to Spanish
// until setLanguage runs — the pre-#78 behavior.
let localePrefix = "es-es";
let codePrefix = "es";

let cachedVoice = null;
const changeListeners = new Set();

function pickVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  return (
    voices.find((voice) => voice.lang?.toLowerCase().startsWith(localePrefix)) ??
    voices.find((voice) => voice.lang?.toLowerCase().startsWith(codePrefix)) ??
    null
  );
}

/**
 * Set the active learning language (#78): subsequent picks prefer its
 * exact locale (languages.js ttsCode, e.g. fr-FR), then any voice of the
 * bare code (fr-*). Re-picks immediately and notifies subscribers, since
 * availability may change with the language.
 * @param {string} code a language code per languages.js, e.g. "es"
 */
export function setLanguage(code) {
  codePrefix = code.toLowerCase();
  localePrefix = (byCode(code)?.ttsCode ?? code).toLowerCase();
  cachedVoice = pickVoice();
  for (const cb of changeListeners) cb(cachedVoice !== null);
}

/** The preferred voice for the active language (its exact locale first,
 *  any same-code voice otherwise), or null. */
export function getVoice() {
  if (!cachedVoice) cachedVoice = pickVoice();
  return cachedVoice;
}

/** Whether TTS in the active language is possible on this device. */
export function isAvailable() {
  return getVoice() !== null;
}

/**
 * Speak `text` with the active-language voice. Cancels any current
 * utterance first, so tapping a speaker while audio plays restarts
 * playback (per design). No-ops (returns false) when no matching voice is
 * available — never throws.
 */
export function speak(text) {
  const voice = getVoice();
  if (!synth || !voice || !text) return false;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  synth.speak(utterance);
  return true;
}

/**
 * Subscribe to availability changes (the async `voiceschanged` quirk).
 * `cb(available: boolean)` fires when the voice list updates.
 * Returns an unsubscribe function.
 */
export function onVoicesChanged(cb) {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

if (synth?.addEventListener) {
  synth.addEventListener("voiceschanged", () => {
    cachedVoice = pickVoice();
    for (const cb of changeListeners) cb(cachedVoice !== null);
  });
}
