# Flashcard Review Screen — Design Spec

Covers issues **#2** (web flashcard review) and **#5** (audio playback), and
the UI states implied by **#3** (nothing due) and **#4** (sync failures).

Mockups: open `design/mockups/review.html` in a browser — it shows every
state below in both a mobile (375px) and a web frame, pixel-styled with the
tokens from `design-system.md`.

## Screen anatomy

```
┌──────────────────────────────┐
│ (banner — only on sync error)│
│ 7 / 23        ▰▰▰▰▱▱▱▱▱▱     │  ← progress: counter + 2px bar
│                              │
│   ┌──────────────────────┐   │
│   │                      │   │
│   │      la ventana  🔊  │   │  ← card (front: word + speaker only)
│   │                      │   │
│   │   tap to reveal      │   │  ← muted hint, bottom of card
│   └──────────────────────┘   │
│                              │
│  [ Didn't know ] [ Knew it ] │  ← grading row (back state only)
└──────────────────────────────┘
```

## Flow (happy path)

1. **Front** — Spanish word, centered, with a speaker icon right of the
   word (plays the word, issue #5). A muted hint at the card's bottom edge:
   mobile "tap to reveal", web "press Space to reveal". The entire card is
   the reveal target; the speaker's hit area eats its own taps.
2. **Reveal** — same card, back state: the word stays at the top at reduced
   size (so context isn't lost), a hairline divider, then the translation,
   then the example phrase in italics with its own speaker icon (plays the
   phrase). If the row has no phrase, that block is simply absent — no
   placeholder.
3. **Grade** — two equal-width buttons appear below the card: outline
   "Didn't know" (left), solid "Knew it" (right). Position and order never
   change. On web, captions underneath show the shortcuts (1 / 2).
4. **Advance** — grading fades to the next card's front (150 ms). Progress
   counter increments. No confirmation, no undo in MVP.

## States

| State | Trigger | What the learner sees |
|-------|---------|------------------------|
| Front | session running | Word + word-speaker, reveal hint, progress |
| Back | reveal | Word (small), translation, phrase + phrase-speaker, grading row |
| Back, no phrase | row has empty phrase column | Same, phrase block absent |
| End of session | queue empty after last grade | "Session complete", stats line ("23 reviewed · 19 knew · 4 didn't"), primary button "Done" (returns to start screen / closes session) |
| Nothing due | app opened, 0 due words (#3) | "Nothing due today", muted line with next due info ("12 words due tomorrow"), optional outline button "Review ahead" |
| Empty sheet | sheet has no word rows (#1) | "No words yet", muted line "Add words to your Google Sheet and they appear here", outline button "Open sheet" (links to the sheet) |
| Sync error | a stat write fails (#4) | Black top banner: "COULDN'T SAVE PROGRESS — RETRYING". Review continues; banner disappears on successful retry. If still failing at session end, the end screen shows a muted warning line instead of silently losing data. |
| No Spanish voice | Web Speech API has no `es-*` voice (#5) | Speaker glyphs render in hairline gray, inert. First tap shows a one-line muted caption under the card: "No Spanish voice available on this device". Never crashes, never blocks review. |

## Audio details (issue #5)

- Word speaker: right of the word, both front **and** back states (same
  position, so it doesn't jump on reveal).
- Phrase speaker: left-aligned in front of the phrase text, back state only.
- Tapping a speaker while audio is playing restarts playback; no
  stop/pause UI.
- No autoplay in MVP.

## Responsive behavior

- **Mobile (<768px):** card fills width minus 16px margins; grading buttons
  form a full-width 2-up row fixed to the bottom third; min 48px heights.
- **Web (≥768px):** card max-width 560px, centered; grading buttons match
  card width; keyboard shortcuts active and labeled. Progress bar spans the
  card width, not the viewport.
- One layout, scaled — no separate mobile IA. This also keeps the future
  mobile app (#9) consistent by construction.

## Out of scope here

- Which card comes next (scheduling — #3, Maya).
- How stats are written to the sheet (#4, Maya).
- Any navigation beyond this single screen — the MVP app *is* this screen
  plus its empty/done states.
