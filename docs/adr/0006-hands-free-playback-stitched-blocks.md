# ADR-0006: Hands-free playback via stitched WAV blocks and MediaSession

**Status:** Accepted (amended 2026-11-16: recall cue sequence per #81,
ramp-up block schedule per #82, one-word first block per #89)
**Date:** 2026-11-11
**Deciders:** Maya (architect)
**Related issues:** #29, #81, #82, #89

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
- **Block duration ramps up** (#82, revised by #89): the first block of a
  session is a **single word** (~16–18 s of audio, exactly **4 clip
  fetches** before sound — the first Spanish word is audible ~2 s after
  pressing play on a normal connection), the second targets **~60
  seconds**, the third **~5 minutes**, the fourth and all later blocks the
  full **~10 minutes**. The ramp is sized so each block plays longer than
  the next block takes to build: the ~60 s block (12–16 clips) builds
  during the one-word block's ~17 s — a few seconds at the fetch cap —
  the 5-minute block during the 60-second one, and the 10-minute block
  during the 5-minute one. Block builds must not fetch ahead of need: the
  one-word block issues exactly its word's 4 clip fetches before playback
  starts (falling through to the next word only if one of them fails).
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
  - **Session start (revised by #89):** three best-effort boundaries, at
    ~20 s, ~1:20, and ~6:20 after play. The first two land shortly after
    the user pressed play, normally still in the foreground where the
    swap succeeds silently. Worst case — phone locked immediately after
    play — up to **three** extra taps during the first ~6½ minutes (one
    more than the previous contract, and only the new ~20 s boundary is
    ever plausibly under lock), then the ~10-minute cadence. Accepted as
    the price of first audio in ~2 s instead of ~5 s or more.
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

**2026-11-16 — one-word first block (#89).** Shipped #82 still meant 12–16
clip fetches before any sound — ≤ 5 s on paper, perceptibly slow in real
use. The first block shrinks to a **single word**: 4 clip fetches, audio
~2 s after play; the schedule becomes 1 word → ~60 s → ~5 min → ~10 min.
Build margins hold: the tightest pair is the ~60 s block building during
the one-word block's ~17 s of playback, a few seconds of fetching at the
concurrency cap. Revised iOS worst case under lock: up to three taps in a
session's first ~6½ minutes (new best-effort boundary ~20 s in, which in
practice is almost always still foreground), steady state unchanged at one
per ~10 minutes. Alternatives rejected:

- *Keep the 60 s first block, prioritize the first word's fetches* — no
  help: a stitched block only plays once fully built, so sound still
  waits for all 12–16 clips. The block itself must shrink.
- *One word, then straight to ~10 minutes* — the ~140-clip block would
  have to build within ~77 s of playback; fragile on slow connections.
  Keeping the 60 s and 5 min steps preserves a wide margin at every
  boundary.
- *One-word blocks throughout* — a possible lock-screen tap every ~17 s on
  iPhone; breaks the platform contract (same reason the constant ~3-word
  blocks were rejected in #82).
