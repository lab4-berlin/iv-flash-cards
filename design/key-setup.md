# Guided Gemini Key Setup — Design Spec (issue #64)

A guided, one-screen flow that takes a non-technical user from "no key" to a
validated, working Gemini key — and the clean "AI features need a free key"
states that invite them into it. Mockups: `design/mockups/key-setup.html`.

Settled constraints (ADR-0004, not design decisions): every user supplies
their own free key; it is stored in localStorage, per device; validation is
the existing `validateKey()` with exactly three outcomes ("ok" / "invalid" /
"network-error").

## Copy principles

The audience has never heard the words "API key".

- Our own copy says **"free AI key"** or "key" — never "API key" standalone.
  The numbered steps *do* quote Google's button labels ("Get API key",
  "Create API key") because that is what the user must find on screen.
- "Free" is stated wherever the key is first mentioned — fear of being
  charged is the realistic blocker, so it's load-bearing, not marketing.
- A missing key is **never an error**. Blocked states are invitations: calm
  copy, a time estimate ("about 2 minutes"), one primary button in. No red,
  no warnings (trivially true — the system is monochrome — but also no `✕`
  glyphs or "failed" wording).
- Per-device storage is stated plainly, as a fact, not an apology: "saved
  only on this device — on another phone or computer you'll paste it there
  once too."

## Entry points

| From | When | Exit (after Done or close) |
|------|------|---------------------------|
| Onboarding, step 2 of 2 (`onboarding.md`) | optional offer | Home |
| Import screen, blocked state | no key stored | back to Import, step 1 (unlocked) |
| Listen screen, blocked state | no key stored and nothing playable | back to Listen |
| "Change key" link on Import step 1 | key already stored | the Manage state of this same screen |

A validated key unlocks Import and Listen immediately — no reload
(acceptance criterion).

## The guide (one screen)

Slim header like Import: caption title "FREE GOOGLE AI KEY", `✕` close
(48px) on the right. Close = leave without a key: back to wherever the user
came from (Home when inside onboarding) — the blocked states remain and can
re-enter the guide anytime.

```
┌──────────────────────────────┐
│ FREE GOOGLE AI KEY         ✕ │
│                              │
│ Importing words and natural  │  ← body, muted
│ audio run on Google's AI.    │
│ Google gives every account a │
│ free key for it. You create  │
│ it once on Google's site and │
│ paste it here — about 2 min. │
│                              │
│ 1  Open Google AI Studio and │  ← numbered steps, body text,
│    sign in with your Google  │    hanging number column
│    account.                  │
│    [ Open aistudio.google.com ]   ← outline button, new tab
│ 2  Click "Get API key", then │
│    "Create API key".         │
│    Buttons may be worded     │  ← caption, muted
│    slightly differently —    │
│    look for "API key".       │
│ 3  Copy the key — a long     │
│    jumble of letters and     │
│    numbers starting with     │
│    AIza.                     │
│ 4  Come back here and paste  │
│    it below.                 │
│                              │
│ [ Paste your key here (AIza…)]│ ← key input (text-area border style,
│                              │    one line, monospace-ish spacing)
│ [      Check my key       ]  │  ← solid; disabled (hairline) while
│                              │    the field is empty
└──────────────────────────────┘
```

- Everything on **one screen** (acceptance criterion): no wizard, no
  sub-pages. On mobile the screen may scroll; the paste field and button
  are at the end of the reading order, which is also the task order.
- Step 2's muted caption absorbs Google AI Studio UI changes — instructions
  stay generic by design (issue out-of-scope note).
- Pasting into the field validates on "Check my key". The input trims
  whitespace silently (copy-paste always brings some).

## Validation — three distinct states

`validateKey()` outcomes map 1:1 to three visually and verbally distinct
results, rendered between the field and the button:

| Outcome | Lead (weight 600) | Muted explanation | Button |
|---------|-------------------|-------------------|--------|
| checking (transient) | — | "Checking with Google…" | disabled |
| `ok` | `✓ It works!` | "Import and Listen are unlocked. The key is saved only on this device — on another phone or computer you'll paste it there once too." | solid **"Done"** (replaces Check) |
| `invalid` | `✕ Google didn't accept this key.` | "Check that you copied the whole key — it starts with AIza and has no spaces around it. Still stuck? Create a fresh key in AI Studio (step 2) and paste that one." | "Check my key" (field stays editable) |
| `network-error` | `Couldn't check the key.` | "We couldn't reach Google — that's a connection problem, not your key. Check your internet and try again." | **"Try again"** |

Distinctness rules: only `ok` gets `✓`; only `invalid` gets `✕` and talks
about the key's content; `network-error` gets **no verdict glyph** and
explicitly exonerates the key (acceptance criterion: "must not accuse the
key"). On `ok` the paste field collapses, replaced by the success block —
the key is saved at this moment, not before.

## Manage state (key already saved)

The same screen, reached via "Change key" on Import step 1 (replacing
today's technical key sub-screen) — the numbered guide is hidden:

```
│ FREE GOOGLE AI KEY         ✕ │
│                              │
│ Your AI key                  │  ← h3
│ A key is saved on this       │  ← body, muted
│ device.                      │
│                              │
│   AIza············3kfQ       │  ← masked: first 4 + last 4 chars
│                              │
│ It's used when you import    │  ← body, muted
│ words and to create audio.   │
│ Saved only on this device —  │
│ other devices need it pasted │
│ once too.                    │
│                              │
│ [     Replace key      ]     │  ← outline → reveals the guide's
│                              │    paste field + Check (same
│  Remove key                  │    validation states); the old key
│                              │    is kept until the new one is ok
└──────────────────────────────┘
```

- **Replace** swaps the lower half for the paste field + "Check my key".
  The stored key is replaced only on a successful `ok` — a failed
  validation never destroys a working key.
- **Remove key** (muted underlined caption, the de-emphasized action):
  removes immediately, no confirmation dialog (the system has none, and
  recovery is just pasting again). The screen returns to the fresh guide
  state; Import and Listen return to their blocked invitation states.

## Blocked states (invitation, not error)

### Import, no key

Replaces today's "Gemini API key" technical sub-screen entirely. Shown
inside the Import screen (header "IMPORT WORDS" + `✕` kept) before step 1:

```
│   Import uses Google's AI    │  ← h3
│   Translating words and      │  ← body, muted
│   creating audio needs a     │
│   free AI key from your      │
│   Google account. The app    │
│   walks you through getting  │
│   one — about 2 minutes.     │
│   [ Set up the free key ]    │  ← solid → the guide
│   Reviewing your cards       │  ← caption, muted
│   works without it.          │
```

After the guide returns with a validated key, Import continues to step 1
directly — the user never sees this state again on this device.

### Listen, no key

Inverted palette (the Listen screen's only mode). Shown when no key is
stored **and** nothing is playable; it takes the place of the existing
empty state, whose "Import words" CTA would dead-end into the import
blocked state anyway — route to the actual fix instead:

```
│   Nothing to listen to yet   │  ← h3, ink-inv
│   Audio is created when you  │  ← body, muted-inv
│   import words — and that    │
│   needs a free Google AI     │
│   key. About 2 minutes to    │
│   set up.                    │
│   [ Set up the free key ]    │  ← inverted outline button
```

The guide itself always opens in the normal (non-inverted) palette —
inversion never applies to a single component or a borrowed screen
(design-system rule). If complete audio clips already exist on the sheet
(key removed later), Listen plays them normally — playback of stored audio
needs no key; only *creating* audio does.

With no key, Review and Choices are untouched — no caption, no hint, no
difference (acceptance criterion: they "work untouched").

## Out of scope here

- Key syncing across devices, quota dashboards, automating key creation
  (issue out-of-scope list).
- When exactly `validateKey()` is called besides this screen — Maya.
- The onboarding offer screen that leads here — `design/onboarding.md`.
