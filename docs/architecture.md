# Architecture — IV Flash Cards

A single-user vocabulary trainer. The entire system is **one static web page**
plus **one Google Sheet**. There is no backend. See the ADRs in `docs/adr/`
for the reasoning behind each decision.

```
┌─────────────────────────────┐        OAuth token (GIS)
│  Browser (laptop / phone)   │◄──────────────────────────┐
│                             │                           │
│  Static app on GitHub Pages │        Google Sheets API  │
│  vanilla JS ES modules      │──── values.get ──────────►│  Google Sheet
│                             │──── values.update ───────►│  (vocabulary +
│  localStorage:              │                           │   stats, source
│   pending-write queue       │                           │   of truth)
└─────────────────────────────┘                           
```

## Components

| Component | Tech | Responsibility |
|---|---|---|
| Hosting | GitHub Pages (deployed from `site/` via GitHub Actions) | Serve the static app |
| Frontend | Vanilla JS ES modules, no framework, no build step | Review UI, flow |
| Auth | Google Identity Services token client | OAuth access token for the Sheets scope (ADR-0001) |
| Data store | Google Sheets API v4 | Single sheet, single worksheet `Words` |
| Scheduler | Pure JS module | Interval-ladder spaced repetition (ADR-0002) |
| Persistence | Pure JS module + localStorage | Immediate row writes, pending queue (ADR-0003) |
| Audio (fallback) | Web Speech API (`speechSynthesis`) | Spanish TTS when no stored clip exists (#5, #28) |
| AI enrichment (V2) | Gemini API, user-supplied restricted key (ADR-0004) | Translation, example phrase, phrase translation (#27) |
| Speech synthesis (V2) | Gemini TTS, 6-voice random pool (ADR-0004) | Natural clips: es word/phrase, en word/phrase translations (#27) |
| Audio storage (V2) | Google Drive, `drive.file` scope (ADR-0005) | Stores clips; sheet references them by file ID (#27–#29) |

## Repository layout

```
site/                 # everything deployed to GitHub Pages
  index.html
  css/styles.css
  js/
    config.js         # OAuth client ID, spreadsheet ID (non-secret)
    auth.js           # GIS token client wrapper
    sheets.js         # read all words / write one row (fetch + Sheets API)
    model.js          # sheet row ⇄ Word object mapping
    scheduler.js      # pure: grading rules + session queue building
    queue.js          # pure core + localStorage-backed pending-write queue
    speech.js         # TTS wrapper with Spanish voice selection
    app.js            # wires everything: state machine for the review session
tests/                # unit tests, run with `node --test`
docs/
  architecture.md     # this file
  sheet-template.md   # sheet column spec + example rows (task of issue #1)
  adr/                # decision records
design/               # Nick's artifacts
.github/workflows/    # CI: run tests, deploy site/ to Pages
```

## Data model (worksheet `Words`, header in row 1)

| Col | Header | Owner | Notes |
|---|---|---|---|
| A | `word` | user | Spanish word |
| B | `translation` | user | English |
| C | `example` | user | optional example phrase |
| D | `date_added` | user | `YYYY-MM-DD` |
| E | `language` | user | `es` for MVP; model is multi-language ready |
| F | `times_shown` | app | integer |
| G | `times_right` | app | integer |
| H | `times_wrong` | app | integer |
| I | `last_reviewed` | app | `YYYY-MM-DD` |
| J | `interval_days` | app | integer, 0 = new/just failed |
| K | `due_date` | app | `YYYY-MM-DD`, empty = never reviewed = due |

V2 (#27) extends the sheet with enrichment columns:

| Col | Header | Owner | Notes |
|---|---|---|---|
| L | `phrase_translation` | app (user may edit) | English translation of the example phrase |
| M | `audio_word_es` | app | Drive file ID, clip of the Spanish word |
| N | `audio_phrase_es` | app | Drive file ID, clip of the Spanish phrase |
| O | `audio_word_en` | app | Drive file ID, clip of the word translation |
| P | `audio_phrase_en` | app | Drive file ID, clip of the phrase translation |

Review grading only ever writes `F:K` (ADR-0003); import appends whole rows
at the bottom (`values.append`); enrichment/backfill writes `L:P`. An empty
audio cell means "missing — generate on next backfill" (ADR-0005), so rows
added by hand stay valid and a cleared cell requests regeneration.
Full spec with example rows: `docs/sheet-template.md`.

## Data flow

1. **Startup:** `auth.js` obtains a token (silent if possible) →
   `sheets.js` reads `Words!A2:K` → `model.js` maps rows to Word objects
   (keeping their row index) → `queue.js` flushes any pending writes from a
   previous session → `scheduler.js` builds the due queue.
2. **Review loop:** `app.js` shows front → reveal → grade. On grade:
   scheduler computes new `(interval_days, due_date)`, stats are incremented,
   and `queue.js` issues an immediate write of `F{row}:K{row}`. Failures land
   in the persisted pending queue with a visible banner (ADR-0003).
3. **Session end:** when the due queue (including same-session re-queues of
   failed cards) is empty, show the end-of-session state; if it was empty at
   startup, show "Nothing due today".

## Cross-cutting concerns

- **Auth/refresh:** token kept in memory; on 401 → silent re-request → else
  "Reconnect" button. Signing in is the only setup a new device needs.
- **Error handling:** read failure at startup = blocking error screen with
  retry; write failures = non-blocking banner + pending queue.
- **Testing strategy:** all logic (scheduler, row mapping, queue core,
  ladder math) lives in pure ES modules with no DOM or fetch dependencies and
  is covered by `node --test` unit tests (no test framework dependency).
  `auth.js`/`sheets.js`/UI are thin adapters verified manually.
- **CI/CD:** GitHub Actions — on every push: run tests; on push to `main`:
  deploy `site/` to GitHub Pages.
- **Local dev:** any static server (`python3 -m http.server 8000`);
  `localhost:8000` is an authorized OAuth origin.

## V2: bulk import pipeline (#27, ADR-0004/0005)

New modules, same no-build vanilla-JS rules:

```
site/js/
  apikey.js      # Gemini key entry/validation, localStorage persistence
  gemini.js      # text enrichment: prompt building + JSON response parsing
  tts.js         # Gemini TTS synthesis + WAV wrapping
  voices.js      # the 6-voice pool (3m + 3f), random pick per clip
  drive.js       # ensure folder, upload clip, fetch clip as blob
  importer.js    # batch orchestrator (pure core + glue)
```

Per imported word the orchestrator runs two phases, isolated per word so one
failure never aborts the batch (#27 acceptance):

1. **Text:** dedupe against the loaded vocabulary (normalized compare) →
   Gemini enrichment (prompt includes the current word list to bias phrases
   toward known vocabulary) → append row with `A:L` filled.
2. **Audio:** synthesize 4 clips (random voice each) → upload to Drive →
   write `L:P` file IDs. Partial audio failure leaves cells empty; retrying
   is the same operation as the #28 backfill ("fill whatever is missing").

Pacing: words are processed sequentially with backoff on 429s — free-tier
rate limits, not throughput, are the constraint.

## Out of scope for MVP (kept possible)

- Mobile app (#9): would consume the same sheet; a future API layer could be
  added without changing the data model.
- English→Spanish direction (#7), generated phrases (#6), recorded audio (#8):
  all are frontend/data additions, no architectural change needed.
