// Web Speech API (speechSynthesis) wrapper with Spanish voice selection
// (issue #16 / #5). Thin adapter, verified manually per the testing strategy.
//
// The voice list is often empty until the browser fires `voiceschanged`
// (notoriously async in Chrome). We therefore re-pick lazily on every call
// while no voice has been found yet, and notify subscribers when the list
// changes so the UI can enable the speaker buttons late.

const synth = globalThis.speechSynthesis ?? null;

let cachedVoice = null;
const changeListeners = new Set();

function pickVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  return (
    voices.find((voice) => voice.lang?.toLowerCase().startsWith("es-es")) ??
    voices.find((voice) => voice.lang?.toLowerCase().startsWith("es")) ??
    null
  );
}

/** The preferred Spanish voice (es-ES first, any es-* otherwise), or null. */
export function getSpanishVoice() {
  if (!cachedVoice) cachedVoice = pickVoice();
  return cachedVoice;
}

/** Whether Spanish TTS is possible on this device. */
export function isAvailable() {
  return getSpanishVoice() !== null;
}

/**
 * Speak `text` with the Spanish voice. Cancels any current utterance first,
 * so tapping a speaker while audio plays restarts playback (per design).
 * No-ops (returns false) when no Spanish voice is available — never throws.
 */
export function speak(text) {
  const voice = getSpanishVoice();
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
