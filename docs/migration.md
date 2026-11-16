# Migrating a legacy (hand-made) sheet

One-time adoption of a vocabulary sheet that was created **by hand** —
i.e. not by the app — per
[ADR-0008](adr/0008-per-user-sheet-discovery-and-legacy-adoption.md)
("Legacy adoption: copy into an app-created sheet, never adopt-by-ID").

**Why a copy is needed at all:** the app finds its sheet by Drive discovery
under the `drive.file` scope, which can only list files the app itself
created. A hand-made sheet is invisible to discovery forever, no matter who
knows its ID. The migration therefore copies its rows once into an
app-created sheet; the old sheet **is only ever read, never modified**, and
stays in Drive as a natural backup.

## What the migration does

The unlinked page `site/migrate.html` (reached by URL only — nothing in the
app links to it), after Google sign-in:

1. Takes the old sheet's **URL or ID** pasted into the form (both work; the
   ID is extracted from a URL).
2. Reads the old sheet's `Words!A2:P` verbatim via the `spreadsheets` scope
   (reading by ID needs no Drive access to the old sheet).
3. Finds — or creates — the app's own sheet by discovery and makes sure the
   `Words` header and the `Settings` tab exist (the exact production
   startup path; idempotent).
4. **Refuses to run if the app's sheet already has any data rows.** This is
   the retry-safety rule: a failed attempt can be retried and a double-run
   can never duplicate rows. If you see this refusal on a *first* run, the
   app's sheet isn't empty — delete its data rows (or trash the sheet and
   let the app recreate it) and retry.
5. Writes all rows in **one** batched `values.update` of `A2:P{n}`,
   preserving row order — so `rowIndex`, the stats block `G:L`, and the
   audio file IDs `M:P` come through unchanged.
6. Writes `learning_language = es` to the `Settings` tab (the legacy sheet
   predates multi-language; its rows are Spanish).
7. Clears this browser's pending-write queue (queued stat writes referenced
   the old sheet's rows and must not replay into the new one).
8. Reports the row counts: rows read from the old sheet, rows written.

## Procedure

Run the migration **before** (or immediately after) the deploy that removed
the configured spreadsheet ID — after that deploy, devices resolve the
sheet by discovery only, and until the migration has run, discovery leads
to an empty app-created sheet.

1. **Run the migration from this branch, locally** (the previous deploy
   does not have the page): serve the site with your local `config.js` in
   place and open the page —

   ```sh
   cd site
   python3 -m http.server 8000
   # → http://localhost:8000/migrate.html
   ```

   (After this change is deployed, the same page is also at
   `https://flash-cards.lab4.berlin/migrate.html` — running it there works
   too, since the empty sheet that a first app visit creates is exactly
   what the copy wants to find.)

2. **Sign in** with the Google account that owns the old sheet (the owner's
   normal app account).
3. **Paste the old sheet's URL** (or its bare ID — the long segment of
   `https://docs.google.com/spreadsheets/d/<id>/edit`) and press **Copy
   into the app's sheet**.
4. Wait for **"Migration complete"** with the row counts. On any error:
   nothing destructive has happened (the only write is the final batched
   update into the empty app sheet) — fix the cause and retry; the
   empty-target guard makes retries safe.
5. **Deploy this change** (merge to `main`; the Pages job deploys
   automatically), if it wasn't deployed already.
6. **Delete the now-unused spreadsheet-ID repository secret** (GitHub repo
   **Settings → Secrets and variables → Actions** — the only remaining
   Actions secret besides `OAUTH_CLIENT_ID`). The deploy workflow no
   longer reads it; this is just hygiene.

## Post-checks

- **Every device lands on the full vocabulary:** open the app on each
  device, sign in with the same account — discovery finds the app-created
  sheet and Home shows the full word count. No per-device setup.
- **Audio still plays:** open a card with a speaker button, or Listen mode.
  The clips folder was created by the app, so folder discovery (ADR-0007)
  still finds it, and the copied `M:P` file IDs still resolve under
  `drive.file`. Nothing about audio migrates.
- **The old sheet is untouched:** check its modified time in Drive if in
  doubt. Keep it as a backup or trash it later — the app never looks at it
  again either way.
- **Re-running is safe:** opening `migrate.html` again and re-submitting
  refuses with "already has N data rows" — the expected behavior.

## Adopting another hand-made sheet later

The page is generic: any hand-made sheet with the standard `Words` column
layout (see [sheet-template.md](sheet-template.md)) can be adopted the same
way into an account whose app sheet is still empty.
