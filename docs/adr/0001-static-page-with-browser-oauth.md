# ADR-0001: Static web page with browser OAuth to the Google Sheets API

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** Ilya (product owner), Maya (architect)
**Related issues:** #1, #4

## Context

The product is a single-user flashcard trainer whose entire database is one
Google Sheet (#1). Progress stats must be written back to the sheet from the
browser so progress follows the user across devices (#4). The owner wants a
serverless, simple solution. Three options were evaluated:

1. **Python serverless functions (Vercel) + static frontend** — a small Python
   API using a Google service account. Pros: testable Python backend, secrets
   stay server-side. Cons: one more platform (Vercel), service-account key
   management, frontend still JS.
2. **Google Apps Script web app** — a script bound to the sheet, deployed as a
   JSON API executing as the owner. Pros: zero extra accounts, free. Cons:
   clunky dev/test workflow, secret-URL auth, JavaScript only.
3. **Pure static page + Google Sheets API with browser OAuth** — no backend of
   any kind; the page authenticates the user via Google Identity Services and
   reads/writes the sheet directly.

## Decision

Option 3: **a pure static web app (vanilla JS, no framework, no build step)
hosted on GitHub Pages, talking directly to the Google Sheets API v4 with an
OAuth access token obtained in the browser via Google Identity Services (GIS).**

Key points:

- **Auth:** GIS *token client* with scope
  `https://www.googleapis.com/auth/spreadsheets`. The access token is kept in
  memory only (never persisted). On a 401 the app first attempts a silent
  refresh (`prompt: ''`, works while the Google session cookie is alive) and
  only then shows a one-click "Reconnect" prompt.
- **Reads:** `spreadsheets.values.get` over the whole data range on startup.
- **Writes:** `spreadsheets.values.update` on the app-managed columns of the
  affected row only (see ADR-0003).
- **Configuration:** OAuth client ID and spreadsheet ID live in a checked-in
  `config.js` (both are non-secret identifiers; the sheet itself stays
  private, protected by Google sign-in).
- **GCP setup (one-time, manual):** a Google Cloud project with the Sheets API
  enabled and an OAuth web client whose authorized JavaScript origins are the
  GitHub Pages URL and `http://localhost:8000`. The consent screen can stay in
  "testing" mode with the owner as a test user.

## Consequences

- No server, no hosting costs, no secrets to manage. Deploy = push to GitHub.
- **The whole codebase is JavaScript.** The original Python preference cannot
  be honored in a backend-less design; we compensate by keeping all logic in
  pure, unit-tested ES modules (see architecture.md, testing strategy).
- Access tokens expire after ~1 hour. Mitigated by silent refresh and by the
  pending-write queue (ADR-0003) so no grade is lost during re-auth.
- While the OAuth consent screen is unverified/in testing mode, Google may
  occasionally re-prompt for consent. Acceptable for a single user.
- The sheet is only as safe as the owner's Google account — which is already
  true of the sheet itself.
