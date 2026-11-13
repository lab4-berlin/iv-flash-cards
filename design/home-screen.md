# Home Screen — Design Spec

A new top-level screen introduced by the V2 milestone: the app now has four
actions (Cards #2, Choices #31, Listen #29, Import #27), so it needs one
place to choose. Mockups: `design/mockups/home.html`.

## Change to the existing flow

Today the app auto-starts the review session after sign-in. With this spec,
sign-in lands on **Home** instead. Review is one tap/keypress away, so the
cost to the existing habit is minimal. The review screen gets a close (`✕`)
affordance in the top-left (48px) that returns Home; "Done" on the
end-of-session screen also returns Home.

## Anatomy

```
┌──────────────────────────────┐
│                              │
│        IV Flash Cards        │   ← wordmark, h3 size
│     14 due · 87 words        │   ← muted status line
│                              │
│   ┌──────────────────────┐   │
│   │        Cards         │   │   ← solid (primary)
│   └──────────────────────┘   │
│   ┌──────────────────────┐   │
│   │       Choices        │   │   ← outline
│   └──────────────────────┘   │
│   ┌──────────────────────┐   │
│   │       Listen         │   │   ← outline
│   └──────────────────────┘   │
│   ┌──────────────────────┐   │
│   │     Import words     │   │   ← outline
│   └──────────────────────┘   │
│                              │
└──────────────────────────────┘
```

- Four buttons, one per action, each starting it directly — there is no
  separate "Review" button or mode picker. **Cards** starts a classic
  review session, **Choices** a multiple-choice one (`multiple-choice.md`).
- Buttons stack vertically, all identical in size: 48px min height, 12px
  gap; full-width minus margins on mobile, 280px fixed on web. Order never
  changes.
- Status line: "`N due · M words`". It is the only stat on the screen.

## States

| State | Trigger | Difference |
|-------|---------|------------|
| Default | ≥1 word due | As above; Cards is solid. |
| Nothing due | 0 due | Status line: "Nothing due · next 12 tomorrow". **Listen becomes the solid button** (it's the natural thing to do when nothing is due); Cards and Choices turn outline. Labels don't change — the status line already says you'd be reviewing ahead. |
| Choices unavailable | fewer than 4 words with distinct translations | The Choices button is disabled (hairline border, muted text, not tappable) with a persistent muted caption directly under it: "Choices needs at least 4 words". Full rules: `multiple-choice.md`. Combines with the other states. |
| Empty sheet | no words | Existing empty state (#1 design) shown instead of buttons, plus outline "Import words" — import is now the primary fix for an empty sheet, "Open sheet" stays as secondary. |

## Keyboard (web)

- `Enter` or `Space` — the solid action (Cards by default, Listen when
  nothing is due).
- `C` — Choices, `L` — Listen, `I` — Import. Shortcuts printed in muted
  caption under the buttons, web only.
