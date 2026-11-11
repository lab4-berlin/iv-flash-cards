import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_KEY,
  getKey,
  setKey,
  clearKey,
  validateKey,
} from "../site/js/apikey.js";

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

// ------------------------------------------------------------------ storage

test("getKey returns null when no key is stored", () => {
  assert.equal(getKey(fakeStorage()), null);
});

test("setKey stores and getKey returns it (reload = same storage, new calls)", () => {
  const storage = fakeStorage();
  setKey("AIzaFakeKey123", storage);
  assert.equal(getKey(storage), "AIzaFakeKey123");
  // The value survives because it sits in storage, not module state.
  assert.equal(storage.getItem(STORAGE_KEY), "AIzaFakeKey123");
});

test("setKey trims pasted whitespace", () => {
  const storage = fakeStorage();
  setKey("  AIzaFakeKey123\n", storage);
  assert.equal(getKey(storage), "AIzaFakeKey123");
});

test("setKey with empty, blank, or non-string input clears instead", () => {
  for (const value of ["", "   ", null, undefined]) {
    const storage = fakeStorage({ [STORAGE_KEY]: "old" });
    setKey(value, storage);
    assert.equal(getKey(storage), null);
  }
});

test("clearKey removes the stored key", () => {
  const storage = fakeStorage({ [STORAGE_KEY]: "AIzaFakeKey123" });
  clearKey(storage);
  assert.equal(getKey(storage), null);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

// --------------------------------------------------------------- validation

function fetchReturning(status) {
  return async () => ({ ok: status >= 200 && status < 300, status });
}

test("validateKey: 200 means ok", async () => {
  assert.equal(await validateKey("good", fetchReturning(200)), "ok");
});

test("validateKey: 400/401/403 mean invalid", async () => {
  for (const status of [400, 401, 403]) {
    assert.equal(await validateKey("bad", fetchReturning(status)), "invalid");
  }
});

test("validateKey: fetch rejection means network-error, not invalid", async () => {
  const offline = async () => {
    throw new TypeError("Failed to fetch");
  };
  assert.equal(await validateKey("good", offline), "network-error");
});

test("validateKey: 429/5xx are not a verdict on the key", async () => {
  for (const status of [429, 500, 503]) {
    assert.equal(await validateKey("good", fetchReturning(status)), "network-error");
  }
});

test("validateKey sends the key in a header, never in the URL", async () => {
  let seenUrl;
  let seenHeaders;
  const spy = async (url, options) => {
    seenUrl = url;
    seenHeaders = options.headers;
    return { ok: true, status: 200 };
  };
  await validateKey("AIzaFakeKey123", spy);
  assert.ok(!seenUrl.includes("AIzaFakeKey123"));
  assert.equal(seenHeaders["x-goog-api-key"], "AIzaFakeKey123");
  assert.ok(seenUrl.startsWith("https://generativelanguage.googleapis.com/"));
});
