// The curated language list (ADR-0008, design/onboarding.md) — the single
// source for the onboarding picker, the sheet's `language` column F, and
// TTS language codes (pure module, no DOM/fetch).

/**
 * The supported learning languages, exactly the six of
 * design/onboarding.md, in picker order. `code` is what the `Settings`
 * tab's `learning_language` and column `F` store; `ttsCode` feeds
 * `speechConfig.languageCode` and the Web Speech voice pick.
 */
export const SUPPORTED = [
  { code: "es", name: "Spanish", ttsCode: "es-ES" },
  { code: "fr", name: "French", ttsCode: "fr-FR" },
  { code: "de", name: "German", ttsCode: "de-DE" },
  { code: "it", name: "Italian", ttsCode: "it-IT" },
  { code: "pt", name: "Portuguese", ttsCode: "pt-PT" },
  { code: "en", name: "English", ttsCode: "en-US" },
];

/**
 * Look a language up by its code.
 * @param {string} code e.g. "es"
 * @returns {{code: string, name: string, ttsCode: string}|null} the entry,
 *   or null for an unknown code
 */
export function byCode(code) {
  return SUPPORTED.find((language) => language.code === code) ?? null;
}
