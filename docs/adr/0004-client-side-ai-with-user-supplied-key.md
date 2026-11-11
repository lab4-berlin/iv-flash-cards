# ADR-0004: Client-side AI enrichment with a user-supplied, restricted Gemini API key

**Status:** Accepted
**Date:** 2026-11-11
**Deciders:** Maya (architect)
**Related issues:** #27, #28, #29

## Context

Bulk import (#27) needs text generation (translation, example phrase,
phrase translation) and natural-sounding speech synthesis, replacing the
robotic Web Speech output. The app is a static page on public GitHub Pages
with no backend (ADR-0001), so a checked-in or deployed API key would be
visible to anyone and abused. Options considered:

1. **Key in GitHub secrets, injected at deploy** — useless here: anything
   the deployed page contains is public; secrets only keep values out of the
   *source* (as done for the non-secret IDs in #24), not out of the page.
2. **A serverless proxy holding the key** — secure but reintroduces a
   backend, contradicting ADR-0001 for a single-user app.
3. **User-supplied key, entered at runtime and stored client-side** — the
   key never ships with the page; each user brings their own.

## Decision

Option 3: the user creates a **Gemini API key** in their own Google account
and pastes it into the app once per device. The app stores it in
**localStorage** and calls Google's Generative Language API directly from
the browser (it supports CORS).

- **One key for everything:** text enrichment uses a Gemini flash model with
  structured JSON output; audio uses the **Gemini TTS** models
  (`…-tts`), which offer ~30 named natural voices and need no billing
  account on the free tier. This matches issue #27's note ("GCP API key …
  for both text generation and speech synthesis").
- **Mandatory key restrictions** (documented in the README, done by the user
  in the Google console): HTTP-referrer restriction to the GitHub Pages
  origin + `http://localhost:8000`, and API restriction to the Generative
  Language API. A leaked key is then useless off-site and can't spend money
  (no billing attached).
- **Voice pool:** a fixed pool of 6 named voices — 3 perceived-male
  (Puck, Charon, Fenrir), 3 perceived-female (Kore, Aoede, Leda) — defined
  in a config module; one is picked at random per clip. **Deviation from
  issue #27 as written:** Gemini TTS voices are multilingual, so the same
  pool serves Spanish and English clips (the language comes from the text
  and prompt), instead of separate per-language pools. Variety and
  naturalness — the rule's intent — are preserved.
- **In-vocabulary phrase preference** is a prompting concern: the enrichment
  prompt includes the current word list from the sheet and instructs the
  model to prefer those words in generated phrases.

## Consequences

- No backend, no shared secret, nothing to steal from the page or repo.
- The key sits in localStorage on the user's own device — acceptable for a
  personal tool (same device trust as the Google session itself), and the
  restrictions cap the blast radius of any leak.
- AI features are simply disabled until a key is entered; the manual
  workflow (ADR-0001..0003) keeps working without one.
- Free-tier rate limits (requests/minute) are real: the import pipeline must
  pace itself and back off on 429s rather than fire batches in parallel.
- If Gemini TTS Spanish quality disappoints, the fallback is Google Cloud
  Text-to-Speech (true per-language voice pools, Neural2/Chirp) — confined
  to the TTS module, but it requires a billing account and a differently
  restricted key.
