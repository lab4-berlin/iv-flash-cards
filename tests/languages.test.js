import { test } from "node:test";
import assert from "node:assert/strict";

import { SUPPORTED, byCode } from "../site/js/languages.js";

test("SUPPORTED is exactly the six languages of design/onboarding.md, in order", () => {
  assert.deepEqual(SUPPORTED, [
    { code: "es", name: "Spanish", ttsCode: "es-ES" },
    { code: "fr", name: "French", ttsCode: "fr-FR" },
    { code: "de", name: "German", ttsCode: "de-DE" },
    { code: "it", name: "Italian", ttsCode: "it-IT" },
    { code: "pt", name: "Portuguese", ttsCode: "pt-PT" },
    { code: "en", name: "English", ttsCode: "en-US" },
  ]);
});

test("byCode finds a language by its code", () => {
  assert.deepEqual(byCode("de"), { code: "de", name: "German", ttsCode: "de-DE" });
});

test("byCode returns null for an unknown code", () => {
  assert.equal(byCode("xx"), null);
  assert.equal(byCode(""), null);
});
