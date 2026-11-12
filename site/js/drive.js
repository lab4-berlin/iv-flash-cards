// Google Drive storage for audio clips — ADR-0005, ADR-0007, issues #35, #54.
//
// Uses the app's OAuth token (NOT the Gemini API key) with the narrow
// `drive.file` scope: the app only sees files it created. All clips live in
// one app-created folder, discovered at runtime via a Drive query (ADR-0007)
// — never by name or stored ID, so the user may freely move and rename the
// folder in Drive. The sheet's `M:P` cells hold Drive file IDs and are the
// source of truth; filenames are informational only.
//
// Recovery contract matches sheets.js: on `DriveAuthError` the caller does
// one silent `requestToken()` retry, then surfaces "Reconnect".

const FILES_API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/**
 * Name given to the clips folder when the app creates it (ADR-0007). Only
 * used at creation time — discovery never matches on the name, so the user
 * may rename the folder afterwards.
 */
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

/** Forget the cached folder ID (used by tests). */
export function resetFolderCache() {
  cachedFolderId = null;
}

/**
 * Discover or create the clips folder and return its ID (ADR-0007).
 *
 * Discovery queries Drive for non-trashed folders — under `drive.file` that
 * can only return folders the app itself created, so no name matching and no
 * persisted ID are needed, and the user may freely move/rename the folder.
 * If several exist (historical accident), the oldest by `createdTime` wins.
 * If none exists, "IV Flash Cards Audio" is created at Drive root.
 *
 * The ID is cached in module memory for the session: call once per
 * import/backfill batch and pass the ID to {@link uploadClip}.
 *
 * @param {string} token OAuth access token (with the `drive.file` scope)
 * @returns {Promise<string>} the folder's Drive file ID
 * @throws {DriveAuthError} on 401, {DriveError} on other API failures
 */
export async function ensureFolder(token) {
  if (cachedFolderId) return cachedFolderId;

  const params = new URLSearchParams({
    q: `mimeType='${FOLDER_MIME}' and trashed=false`,
    fields: "files(id,createdTime)",
    orderBy: "createdTime",
  });
  const found = await driveFetch(
    token,
    `${FILES_API}?${params}`,
    {},
    "discover folder",
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
