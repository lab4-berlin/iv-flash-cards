# Architecture — IV Flash Cards

A vocabulary trainer for a small circle of invited users (OAuth test-user
list). The entire system is **one static web page** plus, per user, **one
Google Sheet in that user's own account**. There is no backend. See the ADRs
in `docs/adr/` for the reasoning behind each decision.

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
| Data store | Google Sheets API v4 | One sheet per user in their own account, discovered at startup (ADR-0008); worksheets `Words` + `Settings` |
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
    config.js         # OAuth client ID only (non-secret; generated at deploy)
    auth.js           # GIS token client wrapper
    sheets.js         # read all words / write one row (fetch + Sheets API);
                      #   spreadsheet ID injected at startup (ADR-0008)
    settings.js       # Settings tab read/write (learning_language, …)
    languages.js      # supported-language list: code, name, TTS code
    model.js          # sheet row ⇄ Word object mapping + language filter
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

Column layout per #56 — `phrase_translation` sits in the user-text zone
next to the phrase it translates; the app-owned stats block is `G:L`; the
audio refs are `M:P`:

| Col | Header | Owner | Notes |
|---|---|---|---|
| A | `word` | user | Spanish word |
| B | `translation` | user | English |
| C | `example` | user | optional example phrase |
| D | `phrase_translation` | app (user may edit) | English translation of the example phrase |
| E | `date_added` | user | `YYYY-MM-DD` |
| F | `language` | user | language code (`es`, `fr`, …); rows not matching `Settings!learning_language` are ignored by all modes (#65); blank counts as the active language |
| G | `times_shown` | app | integer |
| H | `times_right` | app | integer |
| I | `times_wrong` | app | integer |
| J | `last_reviewed` | app | `YYYY-MM-DD` |
| K | `interval_days` | app | integer, 0 = new/just failed |
| L | `due_date` | app | `YYYY-MM-DD`, empty = never reviewed = due |
| M | `audio_word_es` | app | Drive file ID, clip of the Spanish word |
| N | `audio_phrase_es` | app | Drive file ID, clip of the Spanish phrase |
| O | `audio_word_en` | app | Drive file ID, clip of the word translation |
| P | `audio_phrase_en` | app | Drive file ID, clip of the phrase translation |

Review grading only ever writes the stats block `G:L` (ADR-0003) — never
user text columns; import appends whole `A:P` rows at the bottom
(`values.append`); the audio backfill writes `M:P`; the phrase-translation
backfill (#28) writes the single cell `D{row}`. An empty audio cell means
"missing — generate on next backfill" (ADR-0005), so rows added by hand
stay valid and a cleared cell requests regeneration. On a completely blank
sheet the app writes the header row itself (`A1:P1`) at startup (#56).
Full spec with example rows: `docs/sheet-template.md`.

## Data flow

1. **Startup:** `auth.js` obtains a token (silent if possible) → `drive.js`
   discovers the user's vocabulary spreadsheet (`files.list` under
   `drive.file`, oldest wins — ADR-0008; the ID is injected into `sheets.js`
   and never persisted) → `sheets.js` ensures the `Words` header and
   `Settings` tab exist (idempotent, #56/#62) → `settings.js` reads
   `learning_language` → first run (no sheet, or no language yet) branches
   into onboarding (create sheet → language picker → optional key offer,
   `design/onboarding.md`); returning users see none of it → `sheets.js`
   reads `Words!A2:P` → `model.js` maps rows to Word objects (keeping their
   row index) and **filters to the active language** (see below) →
   `queue.js` flushes any pending writes from a previous session →
   `scheduler.js` builds the due queue.
2. **Review loop:** `app.js` shows front → reveal → grade. On grade:
   scheduler computes new `(interval_days, due_date)`, stats are incremented,
   and `queue.js` issues an immediate write of `G{row}:L{row}`. Failures land
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
   toward known vocabulary) → append row with `A:L` filled (user text
   including the `D` phrase translation, plus zeroed stats; `M:P` empty).
2. **Audio:** synthesize 4 clips (random voice each) → upload to Drive →
   write `M:P` file IDs. Partial audio failure leaves cells empty; retrying
   is the same operation as the #28 backfill ("fill whatever is missing").

Pacing: words are processed sequentially with backoff on 429s — free-tier
rate limits, not throughput, are the constraint.

## V2: hands-free listening (#29, ADR-0006)

```
site/js/
  playlist.js    # pure: eligible-word filter, shuffle, cue sequencing
  stitcher.js    # pure PCM math: concat clips + silence gaps → WAV block
  player.js      # <audio> element, block chaining, prefetch, MediaSession
```

Blocks of ~10 minutes are stitched client-side from the Drive-stored PCM
clips and played by one `<audio>` element; MediaSession supplies lock-screen
and headphone controls. Platform limits are contractual, see ADR-0006.

## V3: per-user sheets, onboarding & multi-language (#62/#63/#65, ADR-0008)

Multi-user stays serverless: each user's sheet and audio folder live in
their own Google account, created by the app at first sign-in and found
again by **discovery, not configuration** — the same `drive.file` query
pattern as the audio folder (ADR-0007). `SPREADSHEET_ID` is gone from
`config.js`, the deploy workflow, and the repo secrets; `sheets.js` receives
the discovered ID once at startup (`setSpreadsheetId`). The sheet gains a
second worksheet **`Settings`** (`A` = key, `B` = value); its first key,
`learning_language`, doubles as the onboarding "done" signal: sheet exists
AND language set → returning user, zero onboarding UI (silent token → Home,
as before).

New modules, same no-build vanilla-JS rules:

```
site/js/
  settings.js        # Settings tab: read map, write learning_language
  languages.js       # the curated language list (code/name/TTS code) —
                     #   single source for the picker, column F, and TTS
  onboardflow.js     # pure: which onboarding step comes next
  onboardscreen.js   # the screens of design/onboarding.md
site/migrate.html    # one-time legacy-sheet adoption (ADR-0008); unlinked
```

**Language rule (#65), one place:** immediately after `loadWords`, the app
filters the mapped Word objects to rows whose column `F` matches
`Settings!learning_language` (a blank `F` counts as matching — forgiving to
hand-added rows). Everything downstream — scheduler queues, multiple-choice
distractors, listen playlists, home counts, import dedupe, backfill — sees
only active-language words, so no mode needs its own filter. Other-language
rows wait untouched in the sheet. Import writes the active language to
column `F` and passes its code to enrichment prompts and TTS
(`speechConfig.languageCode` via `languages.js`); the Web Speech fallback
picks a voice for the active language. The audio columns keep their
historical `audio_*_es` headers — they mean "target language" now; renaming
them would be a pointless migration. `_en` clips stay English: translations
are English app-wide.

**Legacy adoption (#63):** the owner's hand-made sheet is invisible to
`drive.file` discovery, so it is adopted by a one-time verbatim copy
(`Words!A2:P`, one batched write, old sheet only ever read) into an
app-created sheet — mechanism and reasoning in ADR-0008, procedure in
`docs/migration.md`.

## Out of scope for MVP (kept possible)

- Mobile app (#9): would consume the same sheet; a future API layer could be
  added without changing the data model.
- English→Spanish direction (#7), generated phrases (#6), recorded audio (#8):
  all are frontend/data additions, no architectural change needed.
