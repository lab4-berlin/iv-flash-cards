// Google Identity Services (GIS) token client wrapper — ADR-0001, issue #12.
//
// Thin adapter around https://accounts.google.com/gsi/client. The access
// token lives in memory only and is NEVER persisted (no localStorage,
// no cookies of our own).
//
// Recovery contract for callers (e.g. sheets.js): on a 401 from the Sheets
// API, call `requestToken({ silent: true })` once; if it rejects, surface
// the "Reconnect" state to the user, whose click triggers an interactive
// `requestToken()`.

// drive.file (ADR-0005) is the narrowest Drive scope: the app can only see
// and touch files it created. Adding it triggers a one-time re-consent.
const SCOPE = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
].join(" ");
const GIS_SRC = "https://accounts.google.com/gsi/client";

// Refresh this many ms before the token's real expiry so callers never
// use an about-to-expire token.
const EXPIRY_MARGIN_MS = 60 * 1000;

let tokenClient = null;
let token = null; // { value: string, expiresAt: number } — in memory only
const authListeners = new Set();

/**
 * Load the GIS library (waiting for the script tag in index.html, or
 * injecting one if missing) and create the token client.
 */
export async function init(clientId) {
  await loadGis();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: () => {}, // replaced per requestToken() call
  });
}

/** @returns {string|null} current in-memory access token, or null if absent/expired. */
export function getToken() {
  if (token && Date.now() < token.expiresAt) return token.value;
  return null;
}

/**
 * Request an access token from Google.
 *
 * With `silent: true` the request uses `prompt: ''`, which completes without
 * user interaction while the Google session cookie is alive and consent was
 * already granted. Otherwise an interactive Google popup is shown (must be
 * called from a user gesture, e.g. the sign-in button click, so the browser
 * does not block the popup).
 *
 * @returns {Promise<string>} resolves with the access token.
 */
export function requestToken({ silent = false } = {}) {
  if (!tokenClient) {
    return Promise.reject(new Error("auth.init() has not been called"));
  }
  return new Promise((resolve, reject) => {
    const fail = (reason) => {
      setToken(null);
      reject(new Error(`Google sign-in failed: ${reason}`));
    };
    tokenClient.callback = (response) => {
      if (response.error) {
        fail(response.error);
      } else {
        setToken(response);
        resolve(response.access_token);
      }
    };
    // Fires when the popup fails to open (blocked) or is closed by the user.
    tokenClient.error_callback = (error) => fail(error.type || error.message);
    tokenClient.requestAccessToken({ prompt: silent ? "" : "consent" });
  });
}

/**
 * Subscribe to signed-in/out changes. `cb(signedIn: boolean)` is invoked
 * immediately with the current state, then on every change.
 *
 * @returns {() => void} unsubscribe function.
 */
export function onAuthChange(cb) {
  authListeners.add(cb);
  cb(getToken() !== null);
  return () => authListeners.delete(cb);
}

function setToken(response) {
  const wasSignedIn = getToken() !== null;
  token = response
    ? {
        value: response.access_token,
        expiresAt:
          Date.now() + Number(response.expires_in) * 1000 - EXPIRY_MARGIN_MS,
      }
    : null;
  const signedIn = getToken() !== null;
  if (signedIn !== wasSignedIn) {
    for (const listener of authListeners) listener(signedIn);
  }
}

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) {
      resolve();
      return;
    }
    let script = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GIS_SRC;
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(new Error("Failed to load Google Identity Services")),
    );
  });
}
