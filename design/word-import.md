# Word Import Flow — Design Spec (issue #27)

Bulk import: paste or upload a plain word list, the system enriches each word
(translation, phrase, phrase translation, 4 audio clips) and appends rows to
the sheet. Three steps, each a full screen. Entry point: **Home → "Import
words"** (see `home-screen.md`). Mockups: `design/mockups/import.html`,
every step in a 375px mobile and an 820px web frame.

All screens share a slim header: caption-style title ("IMPORT WORDS") on the
left, `✕` close (48px) on the right. Closing from step 1 discards input
(no confirmation — re-pasting is cheap). Closing from step 2 behaves like
Cancel (below). Closing from step 3 returns Home.

## Step 1 — Add words

- A text area (design-system "Text area"), autofocused, placeholder:
  "One Spanish word per line". Paste is the primary path.
- Under it, left: outline button "Upload .txt" — reads the file and
  **appends its lines into the text area**, so there is exactly one review
  path and the learner can still edit before generating. Right: live muted
  caption "`12 words`".
- Parsing: trim whitespace, drop empty lines, collapse duplicates within the
  input (silently — the count reflects unique words).
- Primary full-width button: "Generate 12 words". Disabled (hairline) at 0.

## Step 2 — Progress

The batch runs one word at a time; each finished word is already appended to
the sheet (a cancelled batch keeps what it completed).

- Top: the standard progress component — counter "`7 / 12`" + 2px bar.
- Below: a list row per word (design-system "List row"), in input order:
  - done → `✓`
  - in progress → "generating…" muted caption
  - pending → word in muted
  - failed → `✕` + short muted reason ("audio failed") — the batch continues
  - duplicate of a word already in the sheet → `—` + "already in list"
- Muted caption under the bar: "about 10 seconds per word · you can leave
  this open in the background".
- Bottom: outline "Cancel" — stops after the current word, then jumps to
  Step 3 showing what was completed. Closing the tab mid-batch is equivalent;
  a word is appended atomically or not at all (Maya: per-word commit).

## Step 3 — Results

- Headline: "`9 added`" (h3 size); muted line "`2 skipped · 1 failed`"
  (groups that are empty are omitted).
- **Added** list: one row per word — word (body weight 600), translation to
  the right in muted; the generated Spanish phrase underneath in italic with
  a small speaker (plays the phrase clip) so bad phrases can be caught by
  eye and ear right here.
- **Failed** list (if any): word + `✕` + reason.
- **Skipped** list (if any): word + `—` + "already in list", collapsed to a
  single muted line when more than 3.
- Actions: if failures exist, primary solid "Retry 1 failed" (re-runs only
  the failed words through Step 2) and outline "Done"; otherwise just solid
  "Done" (→ Home). A muted caption link "Open sheet" sits below — **editing
  a generated phrase happens in the sheet**, per the issue; this screen only
  surfaces what to edit.

## Error states

| State | Trigger | Treatment |
|-------|---------|-----------|
| Generator unreachable | API/auth error before any word succeeds | Standard message state: "Couldn't reach the generator", muted detail line, solid "Retry", outline "Back". Input is preserved. |
| Mid-batch failures | individual words fail | Never abort the batch — row-level `✕`, retry from Step 3. |
| Write failure | sheet append fails | Reuse the existing sync-error banner; the word is marked failed and retryable. |

## Out of scope here

- Where audio files live, API-key handling, new sheet columns — Maya (#27
  architecture notes).
- Regenerating audio after a manual phrase edit in the sheet — belongs to
  the backfill flow (#28).
