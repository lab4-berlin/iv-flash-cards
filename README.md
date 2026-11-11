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
2. **Enable the Sheets API.** **APIs & Services → Library**, search for
   "Google Sheets API", open it, click **Enable**.
3. **Configure the OAuth consent screen.** **APIs & Services → OAuth consent
   screen** (in newer consoles: **Google Auth Platform → Branding**):
   - User type: **External**.
   - App name (e.g. "IV Flash Cards") and your email for both support and
     developer contact.
   - No scopes need to be added here; the app requests
     `https://www.googleapis.com/auth/spreadsheets` at runtime.
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

## Gemini API key (AI features)

AI features (bulk-import enrichment, generated audio — see
[ADR-0004](docs/adr/0004-client-side-ai-with-user-supplied-key.md)) call
Google's Generative Language API directly from the browser with a **key you
create in your own Google account**. The key is **never** put in the repo,
in GitHub secrets, or in the deploy — anything the deployed page contains is
public. Instead you paste it into the app once per device; it is kept in
that browser's localStorage and sent only to Google's API. Without a key the
AI features show an "add a key" prompt and everything else works normally.

### 1. Create the key

1. Open [Google AI Studio](https://aistudio.google.com/apikey) and sign in
   with the same Google account as the app.
2. Click **Create API key** and pick the Google Cloud project to attach it
   to (the `iv-flash-cards` project from the setup above is fine). No
   billing account is needed — the free tier covers this app.
3. Copy the key (starts with `AIza…`).

### 2. Restrict the key (mandatory)

An unrestricted key that leaks can be abused by anyone. These two
restrictions make a leaked key useless anywhere but this app. In the
[Google Cloud console](https://console.cloud.google.com/apis/credentials),
pick the project from step 1, open the key under **API keys**, and set:

- **Application restrictions → Websites** (HTTP referrers), allowing exactly:
  - `https://lab4-berlin.github.io/*`
  - `http://localhost:8000/*`
- **API restrictions → Restrict key**, selecting only the
  **Generative Language API**.

Save. Restrictions can take a minute or two to propagate.

### 3. Enter it in the app

Paste the key into the app's key prompt. The app validates it with one
cheap API call and tells you right away whether it works, distinguishing a
rejected key (typo, revoked, or restrictions that don't match the origin)
from a network problem. The key stays on that device until you clear it in
the app (or clear the site's browser data); a new device or browser needs
the key pasted again.
