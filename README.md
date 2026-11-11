# IV Flash Cards

A personal vocabulary trainer: a single static web page backed by a Google
Sheet. No backend, no build step. See [docs/architecture.md](docs/architecture.md)
for the full picture and `docs/adr/` for the decisions behind it.

## Run locally

Serve the `site/` directory with any static server:

```sh
cd site
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Run tests

Unit tests use Node's built-in test runner (no dependencies, Node ≥ 20):

```sh
node --test "tests/**/*.test.js"
```

(Equivalently: `npm test`. On Node ≥ 21 the test runner takes glob patterns,
not directories, so plain `node --test tests/` does not work.)

## Deployment

GitHub Actions ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs the
tests on every push; on push to `main` it also deploys `site/` to GitHub Pages.

## Configuration

`site/js/config.js` holds the Google OAuth client ID and the spreadsheet ID.
It is **not** checked in (gitignored); both values come out of the one-time
setup below.

- **Local development:** copy the example and fill in your values:

  ```sh
  cp site/js/config.example.js site/js/config.js
  ```

- **Production (GitHub Pages):** the deploy job generates `config.js` from
  the `OAUTH_CLIENT_ID` and `SPREADSHEET_ID` repository secrets (GitHub repo
  **Settings → Secrets and variables → Actions**). If either secret is
  missing, the deploy fails instead of publishing a placeholder config.

Both values stay visible in the deployed page's JS — the browser needs them.
They are identifiers, not secrets; the only goal is keeping them out of the
public source (issue #24).

## One-time Google Cloud setup

The app talks to the Google Sheets API directly from the browser
(see [ADR-0001](docs/adr/0001-static-page-with-browser-oauth.md)), so it needs
a Google Cloud project with an OAuth web client. These steps are done once,
manually, in the [Google Cloud console](https://console.cloud.google.com/):

1. **Create a project.** Top bar → project picker → **New project**. Name it
   e.g. `iv-flash-cards`. No billing account is needed.
2. **Enable the APIs.** **APIs & Services → Library**, search for
   "Google Sheets API", open it, click **Enable**. Repeat for
   "Google Drive API" (used to store audio clips, see
   [ADR-0005](docs/adr/0005-audio-clips-in-google-drive.md)).
3. **Configure the OAuth consent screen.** **APIs & Services → OAuth consent
   screen** (in newer consoles: **Google Auth Platform → Branding**):
   - User type: **External**.
   - App name (e.g. "IV Flash Cards") and your email for both support and
     developer contact.
   - No scopes need to be added here; the app requests
     `https://www.googleapis.com/auth/spreadsheets` and
     `https://www.googleapis.com/auth/drive.file` at runtime.
   - Leave the publishing status in **Testing** and add your own Google
     account under **Test users** (Audience → Test users in newer consoles).
4. **Create the OAuth client.** **APIs & Services → Credentials → Create
   credentials → OAuth client ID**:
   - Application type: **Web application**.
   - Authorized JavaScript origins:
     - `https://lab4-berlin.github.io` (the GitHub Pages origin)
     - `http://localhost:8000` (local development)
   - No authorized redirect URIs are needed (the GIS token client uses a
     popup, not redirects).
5. **Wire up the IDs** (see [Configuration](#configuration)):
   - The client ID shown after step 4 (ends in `.apps.googleusercontent.com`)
     goes into `CLIENT_ID` in your local `config.js` and into the
     `OAUTH_CLIENT_ID` repository secret.
   - The spreadsheet ID — the long segment of the sheet's URL,
     `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit` — goes
     into `SPREADSHEET_ID` in your local `config.js` and into the
     `SPREADSHEET_ID` repository secret.

Notes:

- While the consent screen is in Testing mode, only the listed test users can
  sign in, Google shows an "unverified app" warning during consent, and it may
  occasionally re-prompt for consent. All acceptable for a single user
  (ADR-0001).
- The client ID and spreadsheet ID are identifiers, not secrets — they are
  visible in the deployed page's JS by design; they're only kept out of the
  repo source. The sheet itself stays private behind Google sign-in.
