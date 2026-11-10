# ADR-0003: Immediate per-grade writes with a localStorage pending queue

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** Maya (architect)
**Related issues:** #4

## Context

Issue #4 requires every grading action to end up in the Google Sheet, with the
guarantee that a closed tab loses at most the card in progress, and that write
failures (offline, expired token) are surfaced instead of silently losing
data. Concurrency is a non-issue (single user), so conflict handling must stay
minimal.

## Decision

1. **Write immediately after every grade.** Each grade triggers one
   `spreadsheets.values.update` of the app-managed columns (`F:K`) of that
   word's row only. User-owned columns (`A:E`) are never written by the app,
   so manual edits to a word or translation can never be clobbered.
2. **Row identity = row index captured at load.** The app records each word's
   sheet row number when it loads the data and writes back to that same row.
   Constraint (documented for the user): append new words at the bottom and
   don't insert/delete rows while a review session is open on some device.
   Editing cell contents in place is always safe.
3. **Pending-write queue in localStorage.** A write that fails (network error,
   401 after silent re-auth failed) is appended to a queue persisted in
   localStorage, the UI shows a persistent "N unsaved reviews — reconnect"
   banner, and the session continues. The queue is retried after re-auth, on a
   timer, and on next app start. Queue entries carry the full target cell
   values (not deltas), so replaying them is idempotent — last write wins.
4. **UI is optimistic:** the in-memory word state updates instantly; the sheet
   write happens in the background.

## Consequences

- A closed tab can lose only the card being graded at that instant; everything
  else is either in the sheet or in the persisted queue.
- One API call per grade is well within Sheets API quotas (60 write
  requests/min/user) for any realistic review pace.
- Stats could theoretically go stale if the same user reviews simultaneously
  on two devices; accepted as out of scope per issue #4.
