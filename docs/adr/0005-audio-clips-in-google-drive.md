# ADR-0005: Audio clips stored in Google Drive, referenced by file ID in the sheet

**Status:** Accepted
**Date:** 2026-11-11
**Deciders:** Maya (architect)
**Related issues:** #27, #28, #29

## Context

Import (#27) produces four audio clips per word (Spanish word, Spanish
phrase, English word translation, English phrase translation); review (#28)
and hands-free mode (#29) play them back on any device. Clips need private,
free, zero-maintenance storage writable from the browser. Options: a GCS
bucket (needs billing, public URLs or signed-URL machinery, a second
credential) vs **Google Drive**, writable with the OAuth sign-in the app
already has.

## Decision

- **Storage: Google Drive**, using the existing GIS token with one added
  scope, **`drive.file`** — the narrowest Drive scope: the app can only see
  and touch files *it created*, not the rest of the user's Drive.
- The app ensures one folder (`IV Flash Cards Audio`) and uploads clips via
  the Drive multipart upload endpoint. Clips are **WAV** (Gemini TTS returns
  24 kHz PCM; the app adds the 44-byte WAV header client-side). Compressing
  to MP3 client-side is a possible later optimization, not MVP.
- **Reference: Drive file IDs** in four new sheet columns (L–P, see the
  data model in `docs/architecture.md`):
  `L phrase_translation`, `M audio_word_es`, `N audio_phrase_es`,
  `O audio_word_en`, `P audio_phrase_en`. Columns F–K and the stats write
  path (ADR-0003) are unchanged; import appends whole rows at the bottom via
  `values.append`, which never shifts existing row indices.
- **Playback:** Drive media downloads require the auth header, so the app
  fetches `files/{id}?alt=media` with the OAuth token and plays through a
  blob URL; clips are cached in memory per session (and may later be cached
  in the browser Cache API for #29).
- **Regeneration convention (sheet-native):** an empty audio cell means
  "missing — please generate". The backfill run (#28) generates whatever is
  missing; to regenerate a clip after editing a phrase, the user simply
  clears its cell(s). No hashes, no extra bookkeeping state.

## Consequences

- Zero new infrastructure or cost; files live in the user's own account
  (15 GB free ≫ realistic vocabulary size — ~1000 fully enriched words are
  on the order of 0.5 GB as WAV).
- Clip access is gated by the same Google sign-in as everything else; the
  public page remains data-free.
- `drive.file` scope means manually uploaded clips (backlog #8) would be
  invisible to the app; that feature will need the Drive Picker or a
  broader scope — accepted, out of scope now.
- Adding the scope triggers a one-time re-consent on next sign-in.
- Orphaned files (clip replaced after a cell was cleared) are not garbage
  collected in MVP; the folder can be tidied by hand.
