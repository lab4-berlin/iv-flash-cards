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

`site/js/config.js` holds the (non-secret) Google OAuth client ID and the
spreadsheet ID. Replace the placeholders to point the app at your own sheet.
