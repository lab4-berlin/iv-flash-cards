# Design System — Flashcards

A deliberately minimal, monochrome system. The content (the word) is the
interface; everything else stays out of the way.

## Principles

1. **Black on white, nothing else.** No accent colors, no shadows, no
   gradients, no rounded corners. Hierarchy is created with size, weight,
   and spacing only.
2. **One primary action per screen.** The biggest tap target is always the
   thing the learner should do next.
3. **Same bones on web and mobile.** The card is a fixed-proportion panel
   centered in the viewport; only margins and font sizes scale.
4. **Motion is optional.** A 150 ms opacity fade on card reveal/advance is
   the only animation. The app must feel complete with animations disabled.

## Color

| Token       | Value     | Use                                            |
|-------------|-----------|------------------------------------------------|
| `ink`       | `#000000` | Text, borders, filled buttons, progress fill   |
| `paper`     | `#FFFFFF` | Background, text on filled buttons             |
| `muted`     | `#666666` | Secondary text: hints, captions, stats         |
| `hairline`  | `#DDDDDD` | Subtle dividers, progress track, disabled      |

Nothing else. Disabled controls use `hairline` for border/icon and `muted`
for any label.

### Inverted mode (listening screen only)

The hands-free listening screen (#29) inverts the palette so it is glanceable
in the dark (car, evening walk) while staying monochrome:

| Token           | Value     | Replaces   |
|-----------------|-----------|------------|
| `ink-inv`       | `#FFFFFF` | `ink`      |
| `paper-inv`     | `#000000` | `paper`    |
| `muted-inv`     | `#999999` | `muted`    |
| `hairline-inv`  | `#333333` | `hairline` |

Inversion applies to the whole screen, never to a single component. No other
screen may use it.

## Typography

System font stack everywhere — no webfonts:

```
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
```

| Style        | Mobile      | Web (≥768px) | Weight | Use                         |
|--------------|-------------|--------------|--------|-----------------------------|
| Word         | 36px / 1.2  | 48px / 1.2   | 600    | The Spanish word on the card|
| Translation  | 24px / 1.3  | 30px / 1.3   | 400    | English translation         |
| Phrase       | 17px / 1.5  | 19px / 1.5   | 400 italic | Example phrase          |
| Body         | 16px / 1.5  | 16px / 1.5   | 400    | Messages, empty states      |
| Caption      | 12px / 1.4  | 12px / 1.4   | 500, uppercase, 0.08em tracking | Progress counter, hints, banner |
| Button       | 16px        | 16px         | 600    | All buttons                 |

## Spacing

4px base unit. Use 8 / 12 / 16 / 24 / 32 / 48. Card inner padding: 24px
mobile, 32px web.

## Components

### Card
White panel, `1px solid ink` border, sharp corners. Centered in the
viewport, max-width 560px on web, full-width minus 16px margins on mobile.
Min-height ~55vh so front and back don't jump in size. The whole card is a
tap/click target for "reveal" in the front state.

### Primary button
Solid `ink` background, `paper` text, no border radius, 48px min height,
full-width on mobile. Used for the grade the learner should reach fastest
is *not* chosen for them — both grading buttons share one row at equal
width; "Knew it" is solid (most frequent action), "Didn't know" is outline.

### Secondary / outline button
`1px solid ink` border, `ink` text on `paper`. Same metrics as primary.

### Icon button (speaker)
32×32px icon inside a 48×48px hit area, `1px solid ink` circle optional —
default is borderless glyph. Disabled: glyph in `hairline`, non-interactive,
with a one-line `muted` caption if the user taps it ("No Spanish voice on
this device").

### Progress
A `caption` counter ("7 / 23") plus a 2px-high bar: `hairline` track,
`ink` fill. Lives at the top of the screen, outside the card.

### Text area (import)
`1px solid ink` border, sharp corners, 16px body text, 16px padding, min
height 8 lines. Placeholder in `muted`. Focus state: border stays `ink`,
2px instead of 1px (no color change, no glow).

### List row (import progress / results)
Full-width row, 48px min height, hairline divider between rows. Left: the
word in body text. Right: a status glyph + optional `muted` caption. Status
glyphs are text-sized, monochrome:

| Glyph | Meaning |
|-------|---------|
| `✓` (ink) | done / added |
| `✕` (ink) | failed |
| `—` (muted) | skipped (with caption, e.g. "already in list") |
| "generating…" (muted caption, no glyph) | in progress |
| word itself in `muted` | pending, not yet started |

### Segmented control
A row of equal-width cells, `1px solid ink` outer border, hairline dividers
between cells, 48px height, button typography. Selected cell: solid `ink`
with `paper` text. Disabled cell: `hairline` border/divider, `muted` text,
non-interactive — with a persistent `muted` caption below the control
explaining why. Used for the review-mode picker on Home.

### Option button (multiple-choice mode)
Metrics of the standard button (48px min height, 16px/600), outline style,
stacked with 12px gaps. Feedback states after an answer:

| State | Treatment |
|-------|-----------|
| Correct (always revealed) | solid `ink`, `paper` text, `✓ ` prefix |
| Picked wrong | outline, `✕ ` prefix, label struck through |
| Not picked, not correct | `hairline` border, `muted` text |

All options are inert once answered.

### Large controls (listening screen only)
Driver-safe sizes, inverted palette: primary play/pause is a 96×96px solid
`ink-inv` square with a `paper-inv` glyph; next-word is a 72×72px
`1px solid ink-inv` outline square. Glyphs are plain geometric SVG
(triangle, two bars, triangle+bar). Nothing on this screen may have a hit
area under 48px.

### Banner (errors / sync)
Full-width strip pinned to the top, `ink` background, `paper` caption text.
Used only for data-loss-risk messages (e.g. failed sheet write). Never
blocks interaction with the card.

## Keyboard (desktop web)

- `Space` — reveal answer
- `1` or `←` — Didn't know
- `2` or `→` — Knew it
- Shortcut keys are printed in `muted` caption under the corresponding
  buttons on web only.

## Touch (mobile)

- All interactive targets ≥ 48×48px.
- Grading buttons sit in the bottom third of the screen, thumb-reachable.
- No swipe gestures in MVP — taps only (gestures can be layered on later
  without design changes).
