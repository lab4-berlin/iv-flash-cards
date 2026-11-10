# Sheet Template — `Words` worksheet

The app's entire database is one Google Sheet with a single worksheet named
**`Words`**. This document tells you how to create it by hand — no developer
tools needed.

## How to create the sheet

1. Go to [sheets.new](https://sheets.new) to create a new Google Sheet.
   Name it anything you like (e.g. "IV Flash Cards").
2. Rename the first worksheet tab (bottom left) to exactly `Words`.
3. Put the headers below into **row 1**, columns A through K, exactly as
   written (lowercase, with underscores).
4. Add your words starting from **row 2**, filling only columns A–E.
   Leave columns F–K empty — the app fills them as you review.

## Columns

| Col | Header | Who fills it | Format | Notes |
|-----|--------|--------------|--------|-------|
| A | `word` | you | text | The Spanish word, e.g. `la manzana` |
| B | `translation` | you | text | English translation |
| C | `example` | you | text | Optional example phrase; leave empty if none |
| D | `date_added` | you | `YYYY-MM-DD` | The day you added the word |
| E | `language` | you | text | `es` for Spanish (the only language for now) |
| F | `times_shown` | the app | whole number | How often the card was shown |
| G | `times_right` | the app | whole number | "Knew it" count |
| H | `times_wrong` | the app | whole number | "Didn't know" count |
| I | `last_reviewed` | the app | `YYYY-MM-DD` | Day of the last review |
| J | `interval_days` | the app | whole number | Current repetition interval; `0` = new or just failed |
| K | `due_date` | the app | `YYYY-MM-DD` | Next review day; empty = never reviewed = due now |

**You own columns A–E, the app owns columns F–K.** The app never writes to
A–E, so you can safely correct a word, translation, or example at any time.
Don't type into F–K yourself; empty app columns simply mean "new word".

## Example rows

| | A | B | C | D | E | F | G | H | I | J | K |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | word | translation | example | date_added | language | times_shown | times_right | times_wrong | last_reviewed | interval_days | due_date |
| 2 | la manzana | apple | Como una manzana cada mañana. | 2026-11-01 | es | 4 | 3 | 1 | 2026-11-08 | 7 | 2026-11-15 |
| 3 | el perro | dog | | 2026-11-05 | es | 2 | 1 | 1 | 2026-11-09 | 1 | 2026-11-10 |
| 4 | correr | to run | Me gusta correr por el parque. | 2026-11-10 | es | | | | | | |

- Row 3 has no example phrase (column C empty) — that's fine.
- Row 4 was never reviewed (columns F–K empty) — the app treats it as a new
  word that is due immediately.

## One important rule

The app remembers each word by its **row number** during a review session
(see ADR-0003). Therefore:

- **Add new words only at the bottom** of the sheet.
- **Don't insert or delete rows while a review session is open** on any
  device. Finish (or close) the session first.
- Editing the *contents* of cells in place is always safe.
