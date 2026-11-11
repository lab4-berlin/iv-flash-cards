// Google Drive storage for audio clips — ADR-0005, issue #35.
//
// Uses the app's OAuth token (NOT the Gemini API key) with the narrow
// `drive.file` scope: the app only sees files it created. All clips live in
// one folder, "IV Flash Cards Audio". The sheet's `M:P` cells hold Drive
// file IDs and are the source of truth; filenames are informational only.
//
// Recovery contract matches sheets.js: on `DriveAuthError` the caller does
// one silent `requestToken()` retry, then surfaces "Reconnect".

const FILES_API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Name of the single Drive folder holding all clips (ADR-0005). */
export const FOLDER_NAME = "IV Flash Cards Audio";

/** Any non-OK Drive API response. `status` is the HTTP status code. */
export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

/** A 401 — the access token is missing/expired; re-auth is needed. */
export class DriveAuthError extends DriveError {
  constructor(message) {
    super(message, 401);
    this.name = "DriveAuthError";
  }
}

let cachedFolderId = null;

/**
 * Find or create the clips folder and return its ID. The ID is cached in
 * memory for the session, so repeated calls cost nothing.
 *
 * @param {string} token OAuth access token (with the `drive.file` scope)
 * @returns {Promise<string>} the folder's Drive file ID
 * @throws {DriveAuthError} on 401, {DriveError} on other API failures
 */
export async function ensureFolder(token) {
  if (cachedFolderId) return cachedFolderId;

  const q = encodeURIComponent(
    `name = '${FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
  );
  const found = await driveFetch(
    token,
    `${FILES_API}?q=${q}&fields=files(id)&pageSize=1`,
    {},
    "list folder",
  );
  if (found.files?.length) {
    cachedFolderId = found.files[0].id;
    return cachedFolderId;
  }

  const created = await driveFetch(
    token,
    `${FILES_API}?fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    },
    "create folder",
  );
  cachedFolderId = created.id;
  return cachedFolderId;
}

/**
 * Upload one clip into the clips folder (multipart upload).
 *
 * @param {string} token OAuth access token
 * @param {string} folderId the clips folder ID (from {@link ensureFolder})
 * @param {string} filename informational name, see {@link clipFilename}
 * @param {Blob} blob the clip, normally the `audio/wav` blob from tts.js
 * @returns {Promise<string>} the new file's Drive ID (goes into the sheet)
 * @throws {DriveAuthError} on 401, {DriveError} on other API failures
 */
export async function uploadClip(token, folderId, filename, blob) {
  const boundary = "iv-flash-cards-clip";
  const metadata = { name: filename, parents: [folderId] };
  const body = new Blob(
    [
      `--${boundary}\r\n` +
        "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\n` +
        `Content-Type: ${blob.type || "audio/wav"}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ],
  );
  const data = await driveFetch(
    token,
    `${UPLOAD_API}?uploadType=multipart&fields=id`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    },
    `upload ${filename}`,
  );
  return data.id;
}

/**
 * Download one clip. Drive media downloads need the auth header, so the
 * caller plays the returned blob through a blob URL (ADR-0005).
 *
 * @param {string} token OAuth access token
 * @param {string} fileId the clip's Drive file ID (from the sheet)
 * @returns {Promise<Blob>} the clip's bytes
 * @throws {DriveAuthError} on 401, {DriveError} on other API failures
 */
export async function fetchClip(token, fileId) {
  const response = await rawDriveFetch(
    token,
    `${FILES_API}/${fileId}?alt=media`,
    {},
    `fetch ${fileId}`,
  );
  return response.blob();
}

/**
 * Conventional clip filename: `{rowIndex}-{word}-{kind}.wav` (issue #35).
 * Informational only — the sheet's file ID is the source of truth.
 *
 * @param {number} rowIndex 1-based sheet row of the word
 * @param {string} word the word (sanitized for use in a filename)
 * @param {"word_es"|"phrase_es"|"word_en"|"phrase_en"} kind which clip
 * @returns {string}
 */
export function clipFilename(rowIndex, word, kind) {
  const safeWord = word
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return `${rowIndex}-${safeWord}-${kind}.wav`;
}

async function rawDriveFetch(token, url, init, what) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (response.status === 401) {
    throw new DriveAuthError(`Drive API: unauthorized (${what})`);
  }
  if (!response.ok) {
    throw new DriveError(`Drive API: ${response.status} (${what})`, response.status);
  }
  return response;
}

async function driveFetch(token, url, init, what) {
  const response = await rawDriveFetch(token, url, init, what);
  return response.json();
}
