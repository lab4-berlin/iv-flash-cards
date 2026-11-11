# Listening Mode — Design Spec (issue #29)

Hands-free continuous playback for walks and drives. Entry point: **Home →
"Listen"** (see `home-screen.md`). Mockups: `design/mockups/listen.html`.

The screen uses the **inverted palette** (white on black — see
`design-system.md` → Inverted mode): dark-friendly for cars and evenings,
still strictly monochrome. It is the only inverted screen in the app.

## Anatomy (both platforms, one layout)

```
┌──────────────────────────────┐
│ ✕                    12 / 87 │  ← close (48px) · cycle counter, muted
│                              │
│                              │
│          la ventana          │  ← current word, huge, white
│                              │
│  Abre la ventana, por favor. │  ← line being spoken now, muted
│                              │
│                              │
│        ┌──────┐ ┌────┐       │
│        │  ⏸   │ │ ⏭  │       │  ← pause 96px solid · next 72px outline
│        └──────┘ └────┘       │
└──────────────────────────────┘
```

- **Current word**: 44px mobile / 64px web, weight 600, centered. Stays on
  screen through the whole 6-step sequence of that word — this is the
  glanceable anchor for the walking case.
- **Now-playing line** (muted, 20px): shows the text of the clip currently
  being spoken — the phrase, then the English word translation, then the
  English phrase translation. Empty during the word clip itself and during
  the 2-second pauses. Drivers ignore it; walkers can read along.
- **Controls**, bottom-center: play/pause (96×96, solid white square, black
  glyph) and next-word (72×72, outline). Fixed positions, never move or
  disappear. **The entire screen outside the controls also toggles
  play/pause** — a glove-friendly, no-look target.
- Counter top-right (muted): position within the current cycle ("12 / 87").
  Resets when the cycle restarts. No other chrome.

## Behavior

- Sequence per word (from the issue): Spanish word → 2s pause → Spanish
  phrase → 2s pause → English word translation → English phrase translation
  → next word.
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
| Paused | tap/Space | Play glyph (triangle); word and now-playing line stay frozen; muted "paused" caption above the controls. |
| Loading | clips buffering at start or on slow network | Muted "loading…" caption in place of the now-playing line; controls visible but play disabled (hairline-inv) until the first clip is ready. |
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
