# Multiple-Choice Mode — Design Spec (issue #31)

A second answering interaction for the review session: Spanish word + 4
English options. Queue, scheduler, and stats are untouched — correct pick =
"Knew it", wrong pick = "Didn't know". Mockups:
`design/mockups/choice.html` (mobile 375 + web 820 frames for every state).

## Entry point (session start)

The mode is started directly from the **home screen** (`home-screen.md`):
there is no picker. Two full-width buttons, same size as the rest of the
menu, each starting a session immediately:

```
┌──────────────────────┐
│       ■ Cards        │   ← solid, starts a classic session
└──────────────────────┘
┌──────────────────────┐
│       Choices        │   ← outline, starts a multiple-choice session
└──────────────────────┘
```

- Labels: **Cards** (classic) and **Choices** (multiple choice). One mode
  per session, per the issue.
- Nothing is selected or remembered — tapping a button *is* the choice.
  (The old localStorage mode memory is removed.)
- In the nothing-due state both buttons turn outline and Listen becomes
  the solid action; see `home-screen.md` states.
- **Unavailable:** with fewer than 4 words with distinct translations, the
  Choices button is disabled (hairline border, muted text) and tapping it
  does nothing; a muted caption directly under it explains: "Choices needs
  at least 4 words". The caption is always visible while disabled — not a
  tap-to-discover hint.
- Keyboard (web): `C` starts Choices; `Enter`/`Space` starts the solid
  action (Cards by default).

## Question screen

Same chrome as classic review: progress counter + 2px bar on top, card
below. Differences:

- The card contains only the Spanish word + speaker (same type size as the
  classic front) — but the card is **content-height**, not 55vh, to leave
  room for the options.
- Below the card: **4 option buttons**, stacked vertically, 12px gap, 48px
  min height, full-width on mobile / card-width (560px) on web. Outline
  style, option text centered. Order randomized per question.
- No reveal hint — tapping an option *is* the interaction. The card itself
  is not tappable in this mode.
- Keyboard (web): `1`–`4` pick an option (shortcut digits shown in muted
  caption inside each option's left edge, web only).

## Feedback (after picking)

Monochrome and unambiguous, three simultaneous signals:

| Element | Treatment |
|---------|-----------|
| Correct option (always revealed) | **Solid** ink, paper text, prefixed `✓` |
| Picked wrong option | Outline, prefixed `✕`, option text **struck through** |
| Remaining options | Hairline border, muted text (faded out of contention) |

At the same moment, the card expands like the classic back: hairline
divider under the word, then the example phrase in italics with its small
speaker (phrase block absent if the row has none). The word's speaker keeps
working throughout.

Options are inert after the pick — no second guessing. The grade is already
recorded (correct = "Knew it", wrong = "Didn't know"; a wrong pick re-queues
the word within the session exactly like classic).

## Advancing

Explicit, never timed: a solid **Next** button appears below the options
(full-width mobile, card-width web). Tapping anywhere on the card also
advances. Keyboard: `Space` or `Enter`. Timed auto-advance is deliberately
out: phrase length and audio playback make any fixed delay wrong; if the
mode still feels slow in practice, auto-advance on *correct* picks is the
first tunable to revisit.

## States summary

| State | Notes |
|-------|-------|
| Question | Word + 4 outline options. |
| Answered — correct | Picked option solid `✓`; others faded; phrase shown; Next. |
| Answered — wrong | Picked `✕` struck through; correct solid `✓`; other two faded; phrase shown; Next. |
| Mode unavailable | Disabled "Choices" button + persistent caption on home. |
| End of session / nothing due / empty / sync banner | Identical to classic review — no new designs needed. |

## Distractor rules (restating the issue for dev)

3 distractors drawn randomly from other words of the same language; no
duplicates of the correct translation or of each other. Words whose
translation equals the correct answer's text are excluded. If fewer than 3
valid distractors exist the mode is unavailable (see above) — never pad
with fakes.

## Out of scope

Smarter distractors, reversed direction, lighter scheduler weighting —
listed as "later" in the issue.
