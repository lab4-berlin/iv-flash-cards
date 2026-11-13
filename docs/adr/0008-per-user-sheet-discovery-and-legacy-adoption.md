# ADR-0008: Per-user sheet, discovered — not configured; legacy sheet adopted by copy

**Status:** Accepted (supersedes the baked-in `SPREADSHEET_ID` of ADR-0001/#24)
**Date:** 2026-11-13
**Deciders:** Ilya (product owner), Maya (architect)
**Related issues:** #62, #63

## Context

V3 makes the app multi-user (family & friends, OAuth test-user list, settled
direction): each user's vocabulary sheet and audio folder live in their own
Google account, created by the app at first sign-in. The single baked-in
`SPREADSHEET_ID` (a deploy-time secret, #24) cannot serve many users, and no
backend or database exists to map users to sheets. Two problems, one design:

1. **Discovery:** how does the app find *this* user's sheet on any device,
   with nothing configured and nothing stored outside the user's account?
2. **Legacy adoption (#63):** the owner's existing sheet was created *by
   hand*. The scope asymmetry matters: the `spreadsheets` scope can open any
   sheet by ID the user can access, but `drive.file` only *lists* files the
   app itself created — a hand-made sheet is invisible to discovery forever,
   regardless of knowing its ID.

## Decision

### Discovery: the ADR-0007 pattern, applied to the spreadsheet

- OAuth scopes stay exactly `spreadsheets` + `drive.file` (least privilege,
  unchanged).
- At startup the app locates the user's vocabulary sheet by querying Drive:
  `files.list` with
  `q = "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"`.
  Under `drive.file` this can only return spreadsheets the app itself
  created, so — exactly as with the audio folder (ADR-0007) — no name
  matching, no `appProperties`, and no persisted ID are needed. If several
  exist (historical accident), the oldest by `createdTime` wins. The ID is
  cached in memory for the session; nothing is persisted anywhere.
- **The user may freely move and rename the sheet in Drive** — discovery
  depends on neither, and no duplicate is ever created for a renamed sheet.
- If none exists, the app creates one (first run): `files.create` with the
  spreadsheet MIME type and the name **"IV Flash Cards"** — created through
  the Drive API precisely so `drive.file` visibility is beyond doubt — then
  a Sheets `batchUpdate` renames the default tab to `Words` and adds the
  `Settings` tab, then the `Words` header `A1:P1` and the `Settings` header
  are written. Every step is check-then-write (idempotent), so a retry after
  a mid-setup failure finds the sheet and completes the missing steps
  instead of duplicating anything — the design's "Setup failed → Retry"
  contract.
- `sheets.js` stops importing the ID from `config.js`; the discovered ID is
  injected once at startup (`setSpreadsheetId`). `SPREADSHEET_ID` disappears
  from `config.js`, the deploy workflow, and the repo secrets. `config.js`
  keeps only the OAuth client ID.

### Settings tab

A second worksheet `Settings`, key–value layout: `A` = key, `B` = value,
header row `key | value`. First key: `learning_language` (language codes per
`site/js/languages.js`). Settings live in the sheet — not localStorage — so
they follow the user across devices; this is also the onboarding "done"
signal (sheet exists AND `learning_language` set → returning user, zero
onboarding UI). Future per-user settings (#30's `new_words_per_day`) are new
rows, no schema change.

### Legacy adoption: copy into an app-created sheet, never adopt-by-ID

Chosen mechanism for #63: a **one-time guided copy**, not adopt-by-ID.

- Adopt-by-ID is rejected because the adopted ID would have to be persisted
  *somewhere* for every future visit — localStorage is per device (breaking
  "any device" access), and there is no other store. It would also leave
  discovery permanently special-cased for one sheet.
- The copy needs no Drive access to the old sheet at all: the `spreadsheets`
  scope reads any sheet by ID the user owns. The migration reads the old
  sheet's `Words!A2:P` verbatim and writes all rows into the app-created
  sheet **in one batched `values.update`** — preserving row order and
  therefore `rowIndex`, the stats block `G:L`, and the audio file IDs `M:P`
  unchanged. Audio needs no migration: the clips were uploaded by the app,
  so the folder is still discovered (ADR-0007) and the `M:P` IDs still
  resolve under `drive.file`.
- **No destructive writes:** the old sheet is only ever read. The migration
  refuses to run if the target sheet already has data rows, so a retry
  after failure is safe and a double-run cannot duplicate rows.
- The migration ships as a small unlinked page (`site/migrate.html`) reusing
  the production modules, and the procedure is documented in
  `docs/migration.md` so another hand-made sheet can be adopted the same way
  if it ever comes to that.

## Consequences

- Zero configuration per user: signing in is the only setup a device needs;
  switching Google accounts switches sheets automatically (discovery is per
  account). No secrets, no backend, no stored IDs.
- The app can own at most one spreadsheet per user by construction
  (find-or-create). If a future feature ever creates *other* spreadsheets,
  discovery must gain a discriminator (`appProperties`) — same recorded
  caveat as ADR-0007's folder query.
- A user who trashes their sheet gets a fresh empty one on next sign-in
  (same transparent-recreation behavior as the audio folder); restoring from
  trash restores discovery, since trashed files are merely filtered out.
- The owner's old hand-made sheet remains untouched in Drive after
  migration, as a natural backup; the deploy pipeline loses one secret.
