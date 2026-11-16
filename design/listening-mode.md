# Listening Mode — Design Spec (issue #29)

Hands-free continuous playback for walks and drives. Entry point: **Home →
"Listen"** (see `home-screen.md`). Mockups: `design/mockups/listen.html`.

The screen uses the **inverted palette** (white on black — see
`design-system.md` → Inverted mode): dark-friendly for cars and evenings,
still strictly monochrome. It is the only inverted screen in the app.

## Anatomy (both platforms, one layout)

```
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ ✕                    12 / 87 │        │ ✕                    12 / 87 │
│                              │        │                              │
│                              │        │     Abre la ventana,         │
│          la ventana          │        │     por favor.               │  ← phrase half: Spanish phrase
│                              │        │                              │
│          the window          │        │   Open the window, please.   │  ← matching translation, muted
│                              │        │                              │
│                              │        │                              │
│        ┌──────┐ ┌────┐       │        │        ┌──────┐ ┌────┐       │
│        │  ⏸   │ │ ⏭  │       │        │        │  ⏸   │ │ ⏭  │       │
│        └──────┘ └────┘       │        │        └──────┘ └────┘       │
└──────────────────────────────┘        └──────────────────────────────┘
         word half (steps 1–4)                 phrase half (steps 5–8)
```

- **Big slot — always Spanish** (#90): the word during the word half of the
  sequence (44px mobile / 64px web), the phrase during the phrase half
  (smaller, wrapping: 28px mobile / 40px web) — weight 600, centered, white.
  The slot reserves the taller variant's height, so the swap causes no
  layout shift. This is the glanceable anchor: the language being learned is
  always the big thing on screen.
- **Translation line — always English** (muted, 20px): the word translation
  during the word half, the phrase translation during the phrase half.
  **Hidden during the recall pauses** (the pause is for recalling — the
  answer appears together with the spoken confirmation) and during the
  Spanish clips preceding them. Space is reserved, so showing/hiding shifts
  nothing. Drivers ignore it; walkers can read along.
- **Controls**, bottom-center: play/pause (96×96, solid white square, black
  glyph) and next-word (72×72, outline). Fixed positions, never move or
  disappear. **The entire screen outside the controls also toggles
  play/pause** — a glove-friendly, no-look target.
- Counter top-right (muted): position within the current cycle ("12 / 87").
  Resets when the cycle restarts. No other chrome.

Per-step view mapping (the 8-segment sequence from ADR-0006/#81):

| Steps                      | Big slot (Spanish) | Translation line (English) |
|----------------------------|--------------------|----------------------------|
| 1 word_es, 2 recall pause  | word               | hidden                     |
| 3 word_en, 4 breather      | word               | word translation           |
| 5 phrase_es, 6 recall pause| **phrase**         | hidden                     |
| 7 phrase_en, 8 separator   | phrase             | phrase translation         |

## Behavior

- Sequence per word (#81, ADR-0006 as amended): Spanish word → 2s recall
  pause → English word translation → 1s breather → Spanish phrase → 2s
  recall pause → English phrase translation → 2s pause → next word. Each
  Spanish clip is followed by a pause to recall its meaning before the
  English confirmation.
- Random order; no word repeats until the whole pool has played (then a new
  shuffled cycle starts — loops forever until stopped).
- Only words with **all four clips** enter the pool; anything else is
  skipped silently. No robotic fallback voice, ever (acceptance criterion).
- **Pause** stops audio immediately; **resume restarts the current clip from
  its beginning** (clips are seconds long; simpler and more comprehensible
  than mid-clip resume).
- **Next** jumps to the next word's step 1, even mid-pause.
- Listening changes **no stats and no scheduling** (per the issue).
- Keyboard (web): `Space` = play/pause, `→` = next, `Esc` = close.

## States

| State | Trigger | Treatment |
|-------|---------|-----------|
| Playing | default | Pause glyph (two bars) on the big control. |
| Paused | tap/Space | Play glyph (triangle); the big slot and translation line stay frozen; muted "paused" caption above the controls. |
| Loading | clips buffering at start or on slow network | Muted "loading…" caption in place of the translation line; controls visible but play disabled (hairline-inv) until the first clip is ready. |
| Empty | no word has a complete clip set | Inverted message state: "Nothing to listen to yet", muted "Import words to generate audio" (links the dependency on #27), outline button "Import words", `✕` returns Home. |

## Explicitly not assumed

Background playback with the screen locked, and system media controls
(headphone buttons, car bluetooth), are flagged in the issue as **feasibility
TBD by Maya**. This design works fully in the foreground and degrades to
nothing if backgrounding is impossible — no UI element depends on it. If
Maya confirms Media Session API support, no screen changes are needed (the
lock screen shows system UI, not ours). A screen-wake-lock while playing is
an architecture decision, not a design one.

## Driver-safety checklist

- No target under 48px; primary control 96px.
- Controls in fixed positions; no layout shifts during playback.
- Whole-screen tap = pause: recoverable without looking.
- High contrast (pure white on pure black), no mid-grays for essential info.
- Zero text entry, zero confirmation dialogs, zero toasts/banners.
