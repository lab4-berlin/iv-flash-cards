// Gemini text enrichment for one word (issue #34, ADR-0004).
// Given a new Spanish word and the current vocabulary, asks a Gemini flash
// model for an English translation, a simple (A2-level) Spanish example
// phrase that contains the word and prefers in-vocabulary words, and the
// English translation of that phrase.
//
// `buildPrompt` and `parseEnrichment` are pure (unit-tested); `enrichWord`
// is the thin fetch glue. The API key is user-supplied and passed in by the
// caller (issue #33's module owns storage) — it never lives in this module.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Gemini flash model used for text enrichment (ADR-0004). */
export const MODEL = "gemini-2.5-flash";

/** Any non-OK Gemini API response. `status` is the HTTP status code. */
export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GeminiError";
    this.status = status;
  }
}

/** A 429 — free-tier rate limit hit; the orchestrator backs off on this. */
export class RateLimitError extends GeminiError {
  constructor(message) {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

/** The model's response text is not the JSON shape we asked for. */
export class EnrichmentParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentParseError";
  }
}

// Wire format the model is asked to produce (snake_case on purpose: it is
// the JSON contract with the model, not an app object — parseEnrichment
// maps it to camelCase for consumers).
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    translation: { type: "STRING" },
    phrase_es: { type: "STRING" },
    phrase_en: { type: "STRING" },
  },
  required: ["translation", "phrase_es", "phrase_en"],
};

/**
 * Build the enrichment prompt for one word (pure).
 * @param {string} word the new Spanish word
 * @param {string[]} vocabulary current words column from the sheet; the
 *   model is told to prefer these in the example phrase
 * @returns {string} prompt text
 */
export function buildPrompt(word, vocabulary) {
  const known = vocabulary.filter((w) => w && w.trim() !== "");
  const lines = [
    "You are helping a learner of Spanish build vocabulary flashcards.",
    `The new Spanish word is: "${word}".`,
    "",
    "Produce:",
    `1. "translation": the English translation of "${word}".`,
    `2. "phrase_es": one short, simple (A2-level) Spanish example phrase` +
      ` that MUST contain the word "${word}".`,
    `3. "phrase_en": the English translation of that phrase.`,
  ];
  if (known.length > 0) {
    lines.push(
      "",
      "The learner already knows these Spanish words. Where it is natural," +
        " prefer them over other words in the example phrase; otherwise keep" +
        " the phrase simple:",
      known.join(", "),
    );
  }
  lines.push(
    "",
    "Respond with a single JSON object with exactly the keys" +
      ' "translation", "phrase_es" and "phrase_en", all strings.',
  );
  return lines.join("\n");
}

function invalid(detail) {
  return new EnrichmentParseError(`Gemini enrichment: ${detail}`);
}

/**
 * Strictly parse and validate the model's response text (pure).
 * @param {string} responseText the model output (expected: JSON object with
 *   non-empty string values for translation, phrase_es, phrase_en)
 * @returns {{translation: string, phraseEs: string, phraseEn: string}}
 * @throws {EnrichmentParseError} on malformed JSON or a wrong shape
 */
export function parseEnrichment(responseText) {
  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw invalid("response is not valid JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw invalid("response is not a JSON object");
  }
  const fields = {};
  for (const key of ["translation", "phrase_es", "phrase_en"]) {
    const value = data[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw invalid(`"${key}" is missing or not a non-empty string`);
    }
    fields[key] = value.trim();
  }
  return {
    translation: fields.translation,
    phraseEs: fields.phrase_es,
    phraseEn: fields.phrase_en,
  };
}

/**
 * Enrich one word via Gemini `generateContent` with structured JSON output.
 * @param {string} key user-supplied Gemini API key (ADR-0004)
 * @param {string} word the new Spanish word
 * @param {string[]} vocabulary current words column from the sheet
 * @returns {Promise<{translation: string, phraseEs: string, phraseEn: string}>}
 * @throws {RateLimitError} on 429, {GeminiError} on other API failures,
 *   {EnrichmentParseError} when the model output has the wrong shape
 */
export async function enrichWord(key, word, vocabulary) {
  const url = `${API_BASE}/${MODEL}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(word, vocabulary) }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    }),
  });
  if (response.status === 429) {
    throw new RateLimitError(`Gemini API: rate limited (word "${word}")`);
  }
  if (!response.ok) {
    throw new GeminiError(
      `Gemini API: ${response.status} (word "${word}")`,
      response.status,
    );
  }
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw invalid("response contains no candidate text");
  }
  return parseEnrichment(text);
}
