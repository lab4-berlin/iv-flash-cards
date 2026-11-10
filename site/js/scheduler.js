// Spaced-repetition interval ladder: grading rules + session queue (ADR-0002).
// Pure module: no DOM, no fetch, no clock access — `today` is always a
// parameter, an ISO local date string ("YYYY-MM-DD").
//
// Word scheduling fields (mapped from the sheet by model.js):
// - `intervalDays` — integer, 0 for new or just-failed words. May be
//   missing/null for never-reviewed words.
// - `dueDate` — ISO date string, empty/missing for never-reviewed words.
// - `dateAdded` — ISO date string, used as the queue tie-breaker.

export const LADDER = [1, 3, 7, 14, 30, 60];

const MAX_INTERVAL = LADDER[LADDER.length - 1];

/**
 * Add `days` to an ISO date string ("YYYY-MM-DD") and return an ISO date
 * string. Uses UTC internally so DST changes can't shift the result.
 */
function addDays(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

/**
 * The smallest ladder value strictly greater than `intervalDays`,
 * capped at the top of the ladder (60).
 */
export function nextInterval(intervalDays) {
  const next = LADDER.find((value) => value > intervalDays);
  return next === undefined ? MAX_INTERVAL : next;
}

/**
 * Apply a review grade to a word's scheduling state (ADR-0002 rules 2–3).
 *
 * @param {object} word - current state; missing `intervalDays` counts as 0.
 * @param {boolean} knewIt - true for "Knew it", false for "Didn't know".
 * @param {string} today - ISO local date ("YYYY-MM-DD").
 * @returns {{intervalDays: number, dueDate: string}} the new scheduling state.
 */
export function grade(word, knewIt, today) {
  if (!knewIt) {
    return { intervalDays: 0, dueDate: today };
  }
  const intervalDays = nextInterval(word.intervalDays ?? 0);
  return { intervalDays, dueDate: addDays(today, intervalDays) };
}

/**
 * A word is due when its due date is today or earlier. Never-reviewed words
 * (no due date) count as due (ADR-0002 rules 1 and 4).
 */
export function isDue(word, today) {
  return !word.dueDate || word.dueDate <= today;
}

/**
 * Build the session queue: all due words, most overdue first (due date
 * ascending, never-reviewed words count as due today), ties broken by
 * `dateAdded` ascending (ADR-0002 rule 4). Returns a new array.
 */
export function buildQueue(words, today) {
  const effectiveDue = (word) => word.dueDate || today;
  return words
    .filter((word) => isDue(word, today))
    .sort((a, b) => {
      const byDue = effectiveDue(a).localeCompare(effectiveDue(b));
      if (byDue !== 0) return byDue;
      return (a.dateAdded ?? "").localeCompare(b.dateAdded ?? "");
    });
}

/**
 * Re-queue a failed card at the end of the current session queue
 * (ADR-0002 rule 3). Returns a new array; does not mutate `queue`.
 */
export function requeue(queue, word) {
  return [...queue, word];
}

/**
 * The earliest *future* due date and how many words are due on it, for the
 * nothing-due state ("12 words due tomorrow"). Returns null when there are
 * no words or no word has a future due date.
 *
 * @returns {{date: string, count: number} | null}
 */
export function nextDue(words, today) {
  let date = null;
  let count = 0;
  for (const word of words) {
    if (!word.dueDate || word.dueDate <= today) continue;
    if (date === null || word.dueDate < date) {
      date = word.dueDate;
      count = 1;
    } else if (word.dueDate === date) {
      count += 1;
    }
  }
  return date === null ? null : { date, count };
}
