// Stats write-back with a pending-write queue (ADR-0003).
//
// Two layers in this module:
//   1. A pure core (entry building, enqueue with per-row dedupe,
//      serialization) — no DOM, no network, no localStorage.
//   2. `createWriteQueue(deps)` — the storage + fetch glue. Dependencies are
//      injected so the module stays unit-testable and does not hard-couple
//      to auth.js/sheets.js (which app.js wires in):
//        - writeStats(entry): writes the entry's F:K values to its row
//          (e.g. a wrapper around sheets.writeStats with the current token);
//          must reject with an error carrying `status: 401` on auth failure.
//        - refreshAuth(): one silent re-auth attempt; resolves true when a
//          fresh token is available (auth.js).
//        - storage: localStorage-compatible {getItem,setItem,removeItem};
//          defaults to globalThis.localStorage.

export const STORAGE_KEY = "iv-flash-cards.pending-writes";

// ---------------------------------------------------------------- pure core

/**
 * Snapshot the app-owned stats of a word as a queue entry. Entries carry the
 * full target cell values (not deltas), so replaying them is idempotent —
 * last write wins (ADR-0003).
 */
export function wordToEntry(word) {
  return {
    rowIndex: word.rowIndex,
    timesShown: word.timesShown,
    timesRight: word.timesRight,
    timesWrong: word.timesWrong,
    lastReviewed: word.lastReviewed ?? null,
    intervalDays: word.intervalDays,
    dueDate: word.dueDate ?? null,
  };
}

/**
 * Add an entry to the queue. Any older entry for the same row is dropped
 * (its values are superseded — last write per row wins), the new entry goes
 * to the end. Returns a new array.
 */
export function enqueue(entries, entry) {
  return [...entries.filter((e) => e.rowIndex !== entry.rowIndex), entry];
}

/** Serialize a queue for persistence. */
export function serialize(entries) {
  return JSON.stringify(entries);
}

/**
 * Parse a persisted queue. Anything unreadable (corrupt JSON, wrong shape)
 * yields an empty queue rather than an error.
 */
export function deserialize(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && Number.isInteger(e.rowIndex));
  } catch {
    return [];
  }
}

// ---------------------------------------------- storage + fetch glue

function isAuthError(error) {
  return error != null && error.status === 401;
}

/**
 * Create the write-back queue.
 *
 * @param {object} deps
 * @param {(entry: object) => Promise<void>} deps.writeStats
 * @param {() => Promise<boolean>} [deps.refreshAuth]
 * @param {{getItem,setItem,removeItem}} [deps.storage]
 * @param {number} [deps.retryIntervalMs] retry timer while the queue is
 *   non-empty; 0 disables the timer (used in tests). Default 30s.
 * @returns {{recordGrade, flush, onStatusChange, pendingCount}}
 */
export function createWriteQueue({
  writeStats,
  refreshAuth,
  storage = globalThis.localStorage,
  retryIntervalMs = 30_000,
} = {}) {
  let entries = deserialize(storage.getItem(STORAGE_KEY));
  const listeners = new Set();
  let timer = null;
  let flushing = false;

  function notify() {
    for (const listener of listeners) listener({ pendingCount: entries.length });
  }

  function persist() {
    if (entries.length === 0) {
      storage.removeItem(STORAGE_KEY);
      stopTimer();
    } else {
      storage.setItem(STORAGE_KEY, serialize(entries));
      startTimer();
    }
    notify();
  }

  function startTimer() {
    if (timer !== null || retryIntervalMs <= 0) return;
    timer = setInterval(() => {
      flush();
    }, retryIntervalMs);
  }

  function stopTimer() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  /**
   * Try to write one entry. On a 401, ask for one silent re-auth and retry
   * once. Returns true when the write went through.
   */
  async function attemptWrite(entry) {
    try {
      await writeStats(entry);
      return true;
    } catch (error) {
      if (!isAuthError(error) || !refreshAuth) return false;
    }
    let refreshed = false;
    try {
      refreshed = await refreshAuth();
    } catch {
      refreshed = false;
    }
    if (!refreshed) return false;
    try {
      await writeStats(entry);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Record a graded card: attempt the sheet write immediately; on failure
   * park the entry in the persisted pending queue (UI stays optimistic).
   */
  async function recordGrade(word) {
    const entry = wordToEntry(word);
    if (await attemptWrite(entry)) {
      // A successful fresh write supersedes any queued value for this row.
      if (entries.some((e) => e.rowIndex === entry.rowIndex)) {
        entries = entries.filter((e) => e.rowIndex !== entry.rowIndex);
        persist();
      }
      return;
    }
    entries = enqueue(entries, entry);
    persist();
  }

  /**
   * Replay the queue in order. Stops at the first entry that still fails
   * (the rest keep their order for the next attempt). Called by app.js on
   * start and after re-auth, and by the internal timer while non-empty.
   */
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      while (entries.length > 0) {
        const ok = await attemptWrite(entries[0]);
        if (!ok) break;
        entries = entries.slice(1);
        persist();
      }
    } finally {
      flushing = false;
    }
  }

  /**
   * Subscribe to queue status for the "N unsaved reviews" banner. The
   * callback fires immediately with the current state and on every change.
   * Returns an unsubscribe function.
   */
  function onStatusChange(callback) {
    listeners.add(callback);
    callback({ pendingCount: entries.length });
    return () => listeners.delete(callback);
  }

  function pendingCount() {
    return entries.length;
  }

  // If a previous session left entries behind, keep the retry timer alive
  // until app.js flushes them.
  if (entries.length > 0) startTimer();

  return { recordGrade, flush, onStatusChange, pendingCount };
}
