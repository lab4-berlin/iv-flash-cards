import { test } from "node:test";
import assert from "node:assert/strict";

// The real config.js is gitignored (issue #24); tests must not depend on it.
import { CLIENT_ID } from "../site/js/config.example.js";

test("config example exports the expected placeholder", () => {
  assert.equal(typeof CLIENT_ID, "string");
  assert.ok(CLIENT_ID.length > 0);
});
