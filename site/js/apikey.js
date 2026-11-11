// User-supplied Gemini API key (ADR-0004).
//
// The key never ships with the page: the user creates it in their own
// Google account (restricted to our origins and to the Generative Language
// API — see "Gemini API key (AI features)" in the README) and pastes it in
// once per device. It lives in localStorage and is sent only to Google's
// Generative Language API. AI features check `getKey()` and degrade to an
// "add a key" state when it returns null; everything else works without it.
//
// `storage` and `fetchFn` are injectable for tests, defaulting to the real
// localStorage / fetch (same pattern as queue.js).

export const STORAGE_KEY = "iv-flash-cards.gemini-key";

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1";

/** The stored key, or null when none is set. */
export function getKey(storage = globalThis.localStorage) {
  return storage.getItem(STORAGE_KEY) || null;
}

/**
 * Store a key (trimmed — pasted keys often carry whitespace). An empty or
 * blank value clears instead, so there is never a stored-but-useless key.
 */
export function setKey(key, storage = globalThis.localStorage) {
  const trimmed = typeof key === "string" ? key.trim() : "";
  if (trimmed === "") {
    clearKey(storage);
    return;
  }
  storage.setItem(STORAGE_KEY, trimmed);
}

/** Forget the stored key. */
export function clearKey(storage = globalThis.localStorage) {
  storage.removeItem(STORAGE_KEY);
}

/**
 * Check a key with one cheap Generative Language API call (list models,
 * page size 1) so the UI can react immediately on paste.
 *
 * Returns:
 *   - "ok"            — the key works from this origin.
 *   - "invalid"       — the API rejected the key (bad/revoked key, or its
 *                       restrictions exclude this origin or this API).
 *   - "network-error" — could not reach the API or it failed on Google's
 *                       side; says nothing about the key itself.
 *
 * The key travels in the `x-goog-api-key` header, not the URL, so it cannot
 * leak via logged request URLs.
 */
export async function validateKey(key, fetchFn = globalThis.fetch) {
  let response;
  try {
    response = await fetchFn(MODELS_URL, {
      headers: { "x-goog-api-key": key },
    });
  } catch {
    return "network-error";
  }
  if (response.ok) return "ok";
  // 400 (API_KEY_INVALID), 401, 403 (restriction mismatch) all mean this
  // key is unusable from here; anything else (429, 5xx) is a transient
  // server-side condition, not a verdict on the key.
  if ([400, 401, 403].includes(response.status)) return "invalid";
  return "network-error";
}
