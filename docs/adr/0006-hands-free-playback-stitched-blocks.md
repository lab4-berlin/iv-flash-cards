# ADR-0006: Hands-free playback via stitched WAV blocks and MediaSession

**Status:** Accepted (amended 2026-11-16: recall cue sequence per #81,
ramp-up block schedule per #82)
**Date:** 2026-11-11
**Deciders:** Maya (architect)
**Related issues:** #29, #81, #82

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

- The player builds **blocks** of stitched audio: for each word, the
  sequence `word_es · 2 s gap · word_en · 1 s gap · phrase_es · 2 s gap ·
  phrase_en · 2 s gap` (#81: hear the Spanish, pause to recall, get the
  confirmation — first for the word, then for the phrase; the trailing
  2 s separates words). Words play in shuffled order with no repeats until
  the whole pool has cycled. All clips are 24 kHz 16-bit PCM (ADR-0005),
  so stitching is plain `Int16Array` concatenation plus zero-filled gaps —
  no encoding.
- **Block duration ramps up** (#82): the first block of a session targets
  **~60 seconds** (≈ 3–4 words, ~12–16 clip fetches — audible playback
  within a few seconds of pressing play), the second **~5 minutes**, the
  third and all later blocks the full **~10 minutes**. The ramp is sized so
  each block plays several times longer than the next block takes to
  build: the 5-minute block is built during the 60-second one (~70 clips,
  comfortably under a minute on a normal connection), and the 10-minute
  block during the 5-minute one.
- One persistent `<audio>` element plays block N while block N+1 is built
  in the background (clips fetched from Drive — capped concurrent fetches
  across words — and cached in memory). On `ended`, the player swaps in
  the next block.
- **MediaSession** provides lock-screen/headphone/car controls: metadata
  shows the current word (updated via `timeupdate` against the block's cue
  list); handlers for play, pause, and next-track (= skip to next word by
  seeking to its cue).
- Words missing any required clip are silently excluded from the pool
  (#29 acceptance; rows without a phrase are not listenable until enriched).

## Platform contract (the limits Jane asked to have stated)

- **Android Chrome, desktop browsers:** fully continuous, including
  automatic block-to-block advance with the screen locked. Guaranteed.
- **iPhone Safari:** continuous and lock-safe *within* a block. Automatic
  advance to the next block under lock is best-effort — iOS sometimes
  blocks it; the lock screen keeps showing our media controls, and one tap
  of play (also from headphones/car) resumes with the next block.
  - **Steady state (unchanged):** worst case one tap every ~10 minutes.
  - **Session start (new with the ramp):** two extra best-effort
    boundaries, ~1 minute and ~6 minutes after play. The first lands
    moments after the user pressed play, normally still in the foreground
    where the swap succeeds silently. Worst case — phone locked
    immediately after play — up to two extra taps during the first
    ~6 minutes, then the ~10-minute cadence. Accepted as the price of
    starting in seconds instead of 30–40 s of silence.
- Not a native app: true gapless infinite playback plus guaranteed
  background operation would require the mobile app (#9). This ADR is the
  best achievable in-browser without AAC encoding machinery.

## Consequences

- Memory stays bounded: a ~10-min mono WAV block ≈ 30 MB; at most two
  blocks live at once ≈ 60 MB (unchanged ceiling — during the ramp the
  live pair is smaller). Shrinking via client-side MP3/AAC encoding
  remains a possible later optimization.
- With ~7 s of gaps per word the full sequence runs ≈ 16–18 s per word,
  so a ~10-minute block holds ≈ 35 words.
- Skip-to-next-word is a seek within the current block — instant.
- The pauses are baked into the audio, so pause/resume lands naturally
  anywhere in the sequence.
- Listening is read-only: no stats, no scheduling changes (per #29).

## Amendments

**2026-11-16 — cue sequence (#81).** Per-word order changed from
`word_es · 2s · phrase_es · 2s · word_en · phrase_en` to
`word_es · 2s · word_en · 1s · phrase_es · 2s · phrase_en (· 2s)` to create
a recall moment before each translation. Pause lengths fixed in code, not
configurable; eligibility (all four clips required) unchanged.

**2026-11-16 — ramp-up block schedule (#82).** Replaced the uniform
~10-minute first block (30–40 s of startup silence) with the
60 s → 5 min → 10 min ramp above. Alternatives rejected:

- *Constant ~3-word blocks* — a possible lock-screen tap every ~50 s on
  iPhone; breaks the platform contract.
- *60 s block, then straight to 10 minutes* — one less early boundary, but
  the full block must build within a single minute of playback; fragile on
  slow connections. The 5-minute step keeps a wide build-time margin at
  every boundary.
- *MSE/ManagedMediaSource with AAC* — would remove boundaries entirely but
  stays rejected for the reasons in the original decision; this amendment
  does not reopen it.
