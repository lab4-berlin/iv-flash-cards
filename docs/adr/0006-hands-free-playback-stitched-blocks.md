# ADR-0006: Hands-free playback via stitched WAV blocks and MediaSession

**Status:** Accepted
**Date:** 2026-11-11
**Deciders:** Maya (architect)
**Related issues:** #29

## Context

Hands-free mode (#29) must keep playing with the phone in a pocket (screen
locked) and respond to headphone/car controls. In mobile browsers —
especially iOS Safari — JavaScript that chains many short clips
(`play → setTimeout(2s) → play …`) stops working in the background: timers
are throttled and newly started playback is blocked. Alternatives
considered:

1. **Clip chaining with timers** — simplest, but provably breaks when the
   screen locks on iOS. Rejected.
2. **MediaSource Extensions / ManagedMediaSource** — a never-ending stream,
   the "proper" solution, but iPhone Safari requires fMP4/AAC segments,
   which would force client-side AAC encoding. Too heavy for a no-build
   vanilla-JS app. Rejected.
3. **Stitched blocks** — concatenate the PCM of many clips (plus generated
   silence gaps) into one long WAV played by a single `<audio>` element.
   Continuous playback within a block is native audio, immune to JS
   throttling.

## Decision

Option 3:

- The player builds **blocks of ~10 minutes** (configurable word count):
  for each word, the sequence `word_es · 2s gap · phrase_es · 2s gap ·
  word_en · phrase_en`, words in shuffled order, no repeats until the whole
  pool has cycled. All clips are 24 kHz 16-bit PCM (ADR-0005), so stitching
  is plain `Int16Array` concatenation plus zero-filled gaps — no encoding.
- One persistent `<audio>` element plays block N while block N+1 is built
  in the background (clips fetched from Drive and cached in memory).
  On `ended`, the player swaps in the next block.
- **MediaSession** provides lock-screen/headphone/car controls: metadata
  shows the current word (updated via `timeupdate` against the block's cue
  list); handlers for play, pause, and next-track (= skip to next word by
  seeking to its cue).
- Words missing any required clip are silently excluded from the pool
  (#29 acceptance; rows without a phrase are not listenable until enriched).

## Platform contract (the limits Jane asked to have stated)

- **Android Chrome, desktop browsers:** fully continuous, including
  automatic block-to-block advance with the screen locked. Guaranteed.
- **iPhone Safari:** continuous and lock-safe *within* a block (~10 min).
  Automatic advance to the next block under lock is best-effort — iOS
  sometimes blocks it; the lock screen keeps showing our media controls,
  and one tap of play (also from headphones/car) resumes with the next
  block. Worst case: one tap every ~10 minutes.
- Not a native app: true gapless infinite playback plus guaranteed
  background operation would require the mobile app (#9). This ADR is the
  best achievable in-browser without AAC encoding machinery.

## Consequences

- Memory stays bounded: one ~10-min mono WAV block ≈ 30 MB; at most two
  blocks live at once. (Shrinking via client-side MP3/AAC encoding is a
  possible later optimization.)
- Skip-to-next-word is a seek within the current block — instant.
- The 2-second gaps are baked into the audio, so pause/resume lands
  naturally anywhere in the sequence.
- Listening is read-only: no stats, no scheduling changes (per #29).
