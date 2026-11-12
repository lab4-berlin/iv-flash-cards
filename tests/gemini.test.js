import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL,
  buildPrompt,
  parseEnrichment,
  enrichWord,
  GeminiError,
  RateLimitError,
  EnrichmentParseError,
} from "../site/js/gemini.js";

describe("buildPrompt", () => {
  test("names the new word and the three JSON keys", () => {
    const prompt = buildPrompt("perro", []);
    assert.match(prompt, /"perro"/);
    assert.match(prompt, /"translation"/);
    assert.match(prompt, /"phrase_es"/);
    assert.match(prompt, /"phrase_en"/);
  });

  test("includes the vocabulary with the preference instruction", () => {
    const prompt = buildPrompt("perro", ["gato", "casa", "comer"]);
    assert.match(prompt, /gato, casa, comer/);
    assert.match(prompt, /prefer/i);
    assert.match(prompt, /simple/i);
  });

  test("requires the phrase to contain the new word", () => {
    const prompt = buildPrompt("perro", []);
    assert.match(prompt, /MUST contain the word "perro"/);
  });

  test("empty or blank vocabulary omits the known-words section", () => {
    for (const vocabulary of [[], ["", "  "]]) {
      const prompt = buildPrompt("perro", vocabulary);
      assert.doesNotMatch(prompt, /already knows/);
    }
  });
});

describe("parseEnrichment", () => {
  const valid = {
    translation: "dog",
    phrase_es: "El perro come en casa.",
    phrase_en: "The dog eats at home.",
  };

  test("maps a valid response to camelCase fields", () => {
    assert.deepEqual(parseEnrichment(JSON.stringify(valid)), {
      translation: "dog",
      phraseEs: "El perro come en casa.",
      phraseEn: "The dog eats at home.",
    });
  });

  test("trims whitespace around values", () => {
    const padded = JSON.stringify({
      translation: " dog ",
      phrase_es: "\nEl perro come.\n",
      phrase_en: " The dog eats. ",
    });
    assert.deepEqual(parseEnrichment(padded), {
      translation: "dog",
      phraseEs: "El perro come.",
      phraseEn: "The dog eats.",
    });
  });

  test("malformed JSON throws EnrichmentParseError", () => {
    assert.throws(() => parseEnrichment("not json {"), EnrichmentParseError);
    assert.throws(() => parseEnrichment(""), EnrichmentParseError);
  });

  test("non-object JSON throws EnrichmentParseError", () => {
    for (const text of ['"a string"', "42", "null", "[1, 2]"]) {
      assert.throws(() => parseEnrichment(text), EnrichmentParseError);
    }
  });

  test("missing, empty, or non-string fields throw EnrichmentParseError", () => {
    for (const bad of [
      { ...valid, translation: undefined },
      { ...valid, phrase_es: "" },
      { ...valid, phrase_en: "   " },
      { ...valid, translation: 7 },
      { ...valid, phrase_es: null },
    ]) {
      assert.throws(
        () => parseEnrichment(JSON.stringify(bad)),
        EnrichmentParseError,
        JSON.stringify(bad),
      );
    }
  });
});

describe("enrichWord", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(response) {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return response;
    };
    return calls;
  }

  function geminiResponse(payload) {
    return new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: JSON.stringify(payload) }] } },
        ],
      }),
      { status: 200 },
    );
  }

  test("posts the prompt with the key header and JSON response config", async () => {
    const calls = stubFetch(
      geminiResponse({
        translation: "dog",
        phrase_es: "El perro come.",
        phrase_en: "The dog eats.",
      }),
    );

    const result = await enrichWord("test-key", "perro", ["gato"]);

    assert.deepEqual(result, {
      translation: "dog",
      phraseEs: "El perro come.",
      phraseEn: "The dog eats.",
    });
    assert.equal(calls.length, 1);
    const { url, options } = calls[0];
    assert.match(url, new RegExp(`${MODEL}:generateContent$`));
    assert.equal(options.method, "POST");
    assert.equal(options.headers["x-goog-api-key"], "test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].text, buildPrompt("perro", ["gato"]));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseSchema.required, [
      "translation",
      "phrase_es",
      "phrase_en",
    ]);
    // Thinking disabled on enrichment — the import speed-up of issue #59.
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  });

  test("429 surfaces as RateLimitError", async () => {
    stubFetch(new Response("quota", { status: 429 }));
    await assert.rejects(
      enrichWord("k", "perro", []),
      (err) => err instanceof RateLimitError && err.status === 429,
    );
  });

  test("other HTTP failures surface as GeminiError with the status", async () => {
    stubFetch(new Response("boom", { status: 403 }));
    await assert.rejects(
      enrichWord("k", "perro", []),
      (err) =>
        err instanceof GeminiError &&
        !(err instanceof RateLimitError) &&
        err.status === 403,
    );
  });

  test("a response without candidate text throws EnrichmentParseError", async () => {
    stubFetch(new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    await assert.rejects(enrichWord("k", "perro", []), EnrichmentParseError);
  });

  test("malformed candidate text throws EnrichmentParseError", async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "not json" }] } }],
        }),
        { status: 200 },
      ),
    );
    await assert.rejects(enrichWord("k", "perro", []), EnrichmentParseError);
  });
});
