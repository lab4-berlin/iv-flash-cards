# ADR-0007: Relocatable app-owned audio folder, discovered — not stored

**Status:** Accepted (refines the folder-management part of ADR-0005)
**Date:** 2026-11-12
**Deciders:** Ilya (product owner), Maya (architect)
**Related issues:** #54

## Context

The owner wants the audio clips in a folder of his choosing in Drive — not a
fixed app folder at Drive root — while explicitly keeping the app's Drive
access limited to "the sheet and one folder". Options considered:

1. **User pre-creates the folder, ID configured via deploy secret.** Rejected:
   it requires broadening OAuth from `drive.file` to full Drive access
   (a user-created folder is invisible to the app under `drive.file`,
   regardless of knowing its ID), and the owner declined full-Drive consent.
2. **Track the app-created folder's ID in the sheet's Settings tab.**
   Rejected by the owner: no folder bookkeeping in the sheet.
3. **App-created folder, discovered at runtime.** Chosen — see below.

## Decision

- The OAuth scope **stays `drive.file`** (least privilege: the app sees only
  files it created, plus the sheet via the Sheets scope).
- `drive.js` locates the audio folder by **querying Drive** instead of by
  name or stored ID: `files.list` with
  `q = "mimeType='application/vnd.google-apps.folder' and trashed=false"`.
  Under `drive.file` this can only return folders the app itself created, so
  no name matching and no persisted ID are needed. If several exist
  (historical accident), the oldest by `createdTime` wins — a stable choice.
  If none exists, the app creates **"IV Flash Cards Audio"** at Drive root.
- The folder ID is cached in memory for the session; one `files.list` per
  import/backfill batch is the steady-state cost. Nothing is persisted
  anywhere.
- **The user may freely move and rename the folder in Drive** — a Drive ID
  survives both operations, and discovery does not depend on name or
  location. This is the supported way to "choose where clips live".

## Consequences

- No new permissions, no secrets, no Settings-tab entries, works unchanged
  across devices (the `drive.file` grant is per user+app, so every signed-in
  device sees the same folder).
- The user cannot have the clips inside a folder the app didn't create; the
  nearest equivalent is moving the app's folder into any parent folder they
  like — which satisfies the stated need.
- If the user trashes the folder, the app transparently creates a fresh one;
  clips referenced in the sheet by file ID keep playing from the trash until
  it is emptied — emptying it orphans those references (cells must be
  cleared to regenerate, per ADR-0005).
