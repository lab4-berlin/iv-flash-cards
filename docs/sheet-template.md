# Sheet Template — `Words` worksheet

The app's entire database is one Google Sheet with a single worksheet named
**`Words`**. This document tells you how to create it by hand — no developer
tools needed.

## How to create the sheet

1. Go to [sheets.new](https://sheets.new) to create a new Google Sheet.
   Name it anything you like (e.g. "IV Flash Cards").
2. Rename the first worksheet tab (bottom left) to exactly `Words`.
3. That's it — **the app creates the header row for you**: when it opens a
   completely blank `Words` sheet, it writes the headers below into row 1
   (issue #56). You can also type them in yourself (columns A through P,
   exactly as written, lowercase with underscores) — the app leaves any
   existing row 1 untouched.
4. Add your words starting from **row 2**, filling only columns A–C, E and
   F. Leave column D and columns G–P empty — the app fills them as you
   review and as it enriches words with translations and audio.

## Columns

| Col | Header | Who fills it | Format | Notes |
|-----|--------|--------------|--------|-------|
| A | `word` | you | text | The Spanish word, e.g. `la manzana` |
| B | `translation` | you | text | English translation |
| C | `example` | you | text | Optional example phrase; leave empty if none |
| D | `phrase_translation` | the app (you may edit) | text | English translation of the example phrase |
| E | `date_added` | you | `YYYY-MM-DD` | The day you added the word |
| F | `language` | you | text | `es` for Spanish (the only language for now) |
| G | `times_shown` | the app | whole number | How often the card was shown |
| H | `times_right` | the app | whole number | "Knew it" count |
| I | `times_wrong` | the app | whole number | "Didn't know" count |
| J | `last_reviewed` | the app | `YYYY-MM-DD` | Day of the last review |
| K | `interval_days` | the app | whole number | Current repetition interval; `0` = new or just failed |
| L | `due_date` | the app | `YYYY-MM-DD` | Next review day; empty = never reviewed = due now |
| M | `audio_word_es` | the app | Drive file ID | Audio clip of the Spanish word |
| N | `audio_phrase_es` | the app | Drive file ID | Audio clip of the Spanish example phrase |
| O | `audio_word_en` | the app | Drive file ID | Audio clip of the English word translation |
| P | `audio_phrase_en` | the app | Drive file ID | Audio clip of the English phrase translation |

**You own the text columns A–F (the app backfills D for you), the app owns
G–P.** During review grading the app writes only the stats block G–L, never
the text columns, so you can safely correct a word, translation, or example
at any time. Don't type into G–L yourself; empty stats columns simply mean
"new word".

### Empty enrichment cells mean "please generate"

For the phrase translation (D) and the audio columns M–P (ADR-0005): an
**empty cell means "missing — generate on the next enrichment/backfill
run"**. This gives you two things for free:

- Rows you add by hand (word/translation/example only) are valid as-is; the
  app fills D and M–P later.
- To **regenerate** a clip — say, after you edited the example phrase —
  simply **clear the matching audio cell(s)**. The next backfill run
  recreates whatever is empty. No other bookkeeping is needed.

The clips themselves live in a folder the app creates in your Google Drive.
To choose where clips are stored, move or rename the app's audio folder in
Google Drive — the app finds it regardless (ADR-0007). The sheet never stores
the folder, only the per-clip file IDs in M–P.

## Example rows

| | A | B | C | D | E | F | G | H | I | J | K | L | M | N | O | P |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | word | translation | example | phrase_translation | date_added | language | times_shown | times_right | times_wrong | last_reviewed | interval_days | due_date | audio_word_es | audio_phrase_es | audio_word_en | audio_phrase_en |
| 2 | la manzana | apple | Como una manzana cada mañana. | I eat an apple every morning. | 2026-11-01 | es | 4 | 3 | 1 | 2026-11-08 | 7 | 2026-11-15 | 1AbC…xYz | 1DeF…uVw | 1GhI…rSt | 1JkL…oPq |
| 3 | el perro | dog | | | 2026-11-05 | es | 2 | 1 | 1 | 2026-11-09 | 1 | 2026-11-10 | | | | |
| 4 | correr | to run | Me gusta correr por el parque. | | 2026-11-10 | es | | | | | | | | | | |

- Row 2 is fully enriched: the app filled the phrase translation (D) and the
  four audio clips (M–P, Google Drive file IDs — shortened here).
- Row 3 has no example phrase (column C empty) — that's fine; its empty
  enrichment cells will be filled on the next enrichment run.
- Row 4 was never reviewed (columns G–L empty) — the app treats it as a new
  word that is due immediately.

## One important rule

The app remembers each word by its **row number** during a review session
(see ADR-0003). Therefore:

- **Add new words only at the bottom** of the sheet.
- **Don't insert or delete rows while a review session is open** on any
  device. Finish (or close) the session first.
- Editing the *contents* of cells in place is always safe.
