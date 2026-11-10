# ADR-0002: Spaced repetition via a fixed interval ladder

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** Maya (architect)
**Related issues:** #3

## Context

Issue #3 asks for a deliberately simple scheduling rule — explicitly not full
SM-2. It must make failed words reappear within the same session and be due
again the next day, and make known words come back at growing intervals.

## Decision

A **fixed interval ladder** (a flattened Leitner system):

```
LADDER = [1, 3, 7, 14, 30, 60]   // days
```

Per-word scheduling state, stored in the sheet (see ADR-0003 / sheet template):

- `interval_days` — integer, `0` for new or just-failed words.
- `due_date` — ISO date (`YYYY-MM-DD`), empty for never-reviewed words.

Rules (all dates in the device's local timezone):

1. **New word** (empty scheduling cells): treated as `interval_days = 0`,
   due today.
2. **"Knew it":** `interval_days` becomes the smallest ladder value strictly
   greater than the current value, capped at 60 (0→1, 1→3, 3→7, 7→14, 14→30,
   30→60, 60→60). `due_date` = today + new interval.
3. **"Didn't know":** `interval_days` = 0, `due_date` = today, and the card is
   re-queued at the end of the current session queue. When it comes up again
   and is answered "Knew it", rule 2 gives it interval 1 → due tomorrow,
   satisfying issue #3's acceptance criterion.
4. **Session queue:** all words with `due_date` ≤ today (never-reviewed words
   count as due). Ordered by `due_date` ascending (most overdue first), ties
   broken by `date_added` ascending. Empty queue ⇒ "Nothing due today" state.

## Consequences

- The rule is a pure function of `(interval_days, grade, today)` — trivially
  unit-testable and tunable later by editing one array.
- No ease factors or per-word difficulty; a word the user repeatedly fails
  simply climbs the ladder from the bottom each time. Good enough for the MVP;
  upgrading to simplified SM-2 later only changes the scheduler module and
  reuses the same two sheet columns.
