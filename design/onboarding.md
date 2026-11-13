# Onboarding / First Run — Design Spec (issue #62)

The first-sign-in flow: Google sign-in → the app finds or creates the user's
vocabulary sheet → one language question → an optional AI-key offer → Home.
Mockups: `design/mockups/onboarding.html`. The key-setup guide itself is a
separate spec (`design/key-setup.md`, issue #64) — onboarding only *offers*
it.

**Returning users see none of this.** A user whose sheet exists and whose
`learning_language` is set goes silent-token → Home, exactly like today.
No screen below may appear for them, so nothing here is designed for them.

## Flow (first run only)

1. **Sign-in** — the existing sign-in screen, unchanged.
2. **Setting up** — a blocking message while the app finds or creates the
   sheet (`Words` header + `Settings` tab). Appears only when discovery
   finds nothing and creation actually runs; if the sheet is found quickly,
   this state is skipped.
3. **Language** (STEP 1 OF 2) — "Which language are you learning?", one
   picker, saved to the `Settings` tab.
4. **AI key offer** (STEP 2 OF 2) — optional, skippable. "Set up the free
   key" opens the guided key setup (`key-setup.md`); "Skip for now" goes
   straight to Home.
5. **Home** — the normal empty state ("No words yet", `home-screen.md`).
   Onboarding adds no screens after this point.

There is no tour, no carousel, no welcome slides — the two functional steps
are the whole onboarding (per the issue's out-of-scope list).

## Screens

### Setting up

Message state (same bones as the existing "Loading…"):

```
┌──────────────────────────────┐
│                              │
│   Setting up your word list… │  ← h3
│                              │
│   Your words live in a       │  ← body, muted
│   Google Sheet in your own   │
│   Drive. The app is creating │
│   it for you — a few seconds.│
│                              │
└──────────────────────────────┘
```

No spinner, no indeterminate bar — the design system has neither, and the
copy already says it takes seconds. If creation outlasts ~10 s it simply
stays on screen; the message remains true.

### Language (STEP 1 OF 2)

```
┌──────────────────────────────┐
│  STEP 1 OF 2                 │  ← caption, muted
│  Which language are you      │  ← h3
│  learning?                   │
│                              │
│  [ Spanish            ]      │  ← option buttons (design-system
│  [ French             ]      │    "Option button" metrics), outline;
│  [ German             ]      │    the selected one turns solid ink
│  [ Italian            ]      │
│  [ Portuguese         ]      │
│  [ English            ]      │
│                              │
│  [      Continue      ]      │  ← solid; disabled (hairline) until
│                              │    a language is selected
│  Stored in your sheet, so it │  ← caption, muted
│  follows you on every device.│
└──────────────────────────────┘
```

- Curated list, exactly these six for now (per the issue: "small curated
  list is fine"). Order fixed, no search, no flags, no emoji.
- Tap selects (solid ink, like a chosen option in Choices); tapping another
  option moves the selection. **Continue** commits — selection alone does
  not advance, because changing the language later is out of scope for this
  phase, so a mis-tap must not be final.
- On Continue the value is written to the `Settings` tab as
  `learning_language`. While the write runs, Continue is disabled with a
  muted caption "Saving…" beneath it; on failure → the Setup-failed state
  below (retry re-runs only the write).
- Keyboard (web): `↑`/`↓` move selection, `Enter` = Continue.

### AI key offer (STEP 2 OF 2)

```
┌──────────────────────────────┐
│  STEP 2 OF 2                 │
│  One more thing —            │  ← h3
│  AI features                 │
│                              │
│  Importing new words and     │  ← body, muted
│  natural audio run on        │
│  Google's AI. That needs a   │
│  free key from your Google   │
│  account — the app will walk │
│  you through it.             │
│                              │
│  [ Set up the free key ]     │  ← solid (primary)
│  [    Skip for now     ]     │  ← outline
│                              │
│  You can do this anytime     │  ← caption, muted
│  later from Import.          │
│  Reviewing cards works       │
│  without a key.              │
└──────────────────────────────┘
```

- "Set up the free key" opens the guide (`key-setup.md`) in its onboarding
  context: finishing *or skipping out of* the guide lands on Home.
- "Skip for now" → Home immediately. Skipping is a first-class path, not a
  small escape link — review must feel fully intentional without a key.
- This step is shown only when no key is stored on the device (it always is
  on a true first run; the check costs nothing).

### Setup failed (blocking error + retry)

Reuses the existing blocking startup-error pattern ("Couldn't load your
words" / Retry) verbatim in structure:

```
│   Couldn't set things up     │  ← h3
│   Check your connection and  │  ← body, muted
│   try again. Nothing is lost.│
│   [        Retry       ]     │  ← solid
```

Shown when sheet discovery/creation or the language write fails. Retry
re-runs the failed step. There is no "skip" out of this state — a
half-created setup must never leak the user onto Home (acceptance
criterion; idempotent find-or-create is Maya's side of the contract).

## Resume rules (interrupted first run)

The signal for "onboarding is done" is: **sheet exists AND
`learning_language` is set**. If the user closes the tab mid-flow:

| Left off at | Next visit |
|-------------|-----------|
| Setting up (sheet not yet created) | Setting up again — find-or-create must not duplicate |
| Language (sheet exists, no `learning_language`) | Language step directly, no "Setting up" flash |
| Key offer (language already saved) | Treated as a returning user → Home. The key offer is shown only in the same session, immediately after Language; closing the tab counts as skipping. They'll meet the key invitation on Import/Listen (`key-setup.md`) instead. |

## States summary

| State | Trigger | Treatment |
|-------|---------|-----------|
| Setting up | first run, sheet being created | Message state, no controls |
| Language | sheet ready, no `learning_language` | Picker + Continue |
| Saving language | Continue tapped | Continue disabled, "Saving…" caption |
| Key offer | language saved, no key on device | Two buttons + skip caption |
| Setup failed | create/discovery/write error | Blocking error + Retry (existing pattern) |

## Out of scope here

- How "our" sheet is identified in Drive, scopes, idempotency of
  find-or-create — Maya (issue #62 architecture notes).
- The key-setup guide itself and the blocked import/listen states —
  `design/key-setup.md` (issue #64).
- Changing the learning language from the UI — explicitly out of scope for
  this phase (edit the `Settings` tab).
