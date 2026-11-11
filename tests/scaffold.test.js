import { test } from "node:test";
import assert from "node:assert/strict";

// The real config.js is gitignored (issue #24); tests must not depend on it.
import { CLIENT_ID, SPREADSHEET_ID } from "../site/js/config.example.js";

test("config example exports the expected placeholders", () => {
  assert.equal(typeof CLIENT_ID, "string");
  assert.equal(typeof SPREADSHEET_ID, "string");
  assert.ok(CLIENT_ID.length > 0);
  assert.ok(SPREADSHEET_ID.length > 0);
});
