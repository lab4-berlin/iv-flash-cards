// The 6-voice pool for Gemini TTS — ADR-0004, issue #35.
//
// Gemini TTS voices are multilingual, so one pool serves both Spanish and
// English clips (ADR-0004's documented deviation from issue #27 as written).
// A voice is picked at random per clip so the vocabulary doesn't sound
// monotone (#27 voice rules).

/** Perceived-male Gemini TTS voice names. */
export const MALE_VOICES = ["Puck", "Charon", "Fenrir"];

/** Perceived-female Gemini TTS voice names. */
export const FEMALE_VOICES = ["Kore", "Aoede", "Leda"];

/** The full pool, in a fixed order (3 male + 3 female). */
export const VOICES = [...MALE_VOICES, ...FEMALE_VOICES];

/**
 * Pick one voice from the pool at random.
 *
 * @param {() => number} [random] RNG returning a float in [0, 1), injectable
 *   for tests; defaults to `Math.random`.
 * @returns {string} a voice name from {@link VOICES}.
 */
export function pickVoice(random = Math.random) {
  return VOICES[Math.floor(random() * VOICES.length)];
}
