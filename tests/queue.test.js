import { test } from "node:test";
import assert from "node:assert/strict";

import {
  STORAGE_KEY,
  wordToEntry,
  enqueue,
  serialize,
  deserialize,
  createWriteQueue,
} from "../site/js/queue.js";

function entryFor(rowIndex, overrides = {}) {
  return {
    rowIndex,
    timesShown: 1,
    timesRight: 1,
    timesWrong: 0,
    lastReviewed: "2026-11-10",
    intervalDays: 1,
    dueDate: "2026-11-11",
    ...overrides,
  };
}

// ------------------------------------------------------------- pure core

test("wordToEntry snapshots stats fields and rowIndex only", () => {
  const word = {
    word: "la manzana",
    translation: "apple",
    example: null,
    dateAdded: "2026-11-01",
    language: "es",
    timesShown: 4,
    timesRight: 3,
    timesWrong: 1,
    lastReviewed: "2026-11-08",
    intervalDays: 7,
    dueDate: "2026-11-15",
    rowIndex: 2,
  };
  assert.deepEqual(wordToEntry(word), {
    rowIndex: 2,
    timesShown: 4,
    timesRight: 3,
    timesWrong: 1,
    lastReviewed: "2026-11-08",
    intervalDays: 7,
    dueDate: "2026-11-15",
  });
});

test("enqueue keeps ordering of distinct rows", () => {
  let queue = [];
  queue = enqueue(queue, entryFor(2));
  queue = enqueue(queue, entryFor(5));
  queue = enqueue(queue, entryFor(3));
  assert.deepEqual(queue.map((e) => e.rowIndex), [2, 5, 3]);
});

test("enqueue dedupes by row, keeping the latest values", () => {
  let queue = [];
  queue = enqueue(queue, entryFor(2, { timesShown: 1 }));
  queue = enqueue(queue, entryFor(5));
  queue = enqueue(queue, entryFor(2, { timesShown: 2 }));
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.map((e) => e.rowIndex), [5, 2]);
  assert.equal(queue.find((e) => e.rowIndex === 2).timesShown, 2);
});

test("enqueue does not mutate its input", () => {
  const original = [entryFor(2)];
  enqueue(original, entryFor(3));
  assert.deepEqual(original.map((e) => e.rowIndex), [2]);
});

test("serialize/deserialize round-trip", () => {
  const queue = [entryFor(2), entryFor(7, { lastReviewed: null, dueDate: null })];
  assert.deepEqual(deserialize(serialize(queue)), queue);
});

test("deserialize tolerates missing or corrupt data", () => {
  assert.deepEqual(deserialize(null), []);
  assert.deepEqual(deserialize(""), []);
  assert.deepEqual(deserialize("not json"), []);
  assert.deepEqual(deserialize('{"a":1}'), []);
  assert.deepEqual(deserialize('[{"noRowIndex":true},null]'), []);
});

// ----------------------------------------------------- storage + fetch glue

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

function queueWith(deps = {}) {
  const storage = deps.storage ?? fakeStorage();
  const calls = [];
  const queue = createWriteQueue({
    writeStats: async (entry) => calls.push(entry.rowIndex),
    retryIntervalMs: 0, // no timer in tests
    storage,
    ...deps,
  });
  return { queue, storage, calls };
}

test("recordGrade: successful write leaves nothing pending", async () => {
  const { queue, storage, calls } = queueWith();
  await queue.recordGrade(entryFor(2));
  assert.deepEqual(calls, [2]);
  assert.equal(queue.pendingCount(), 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("recordGrade: failed write is queued and persisted", async () => {
  const storage = fakeStorage();
  const { queue } = queueWith({
    storage,
    writeStats: async () => {
      throw new TypeError("network down");
    },
  });
  await queue.recordGrade(entryFor(2));
  assert.equal(queue.pendingCount(), 1);
  assert.deepEqual(deserialize(storage.getItem(STORAGE_KEY)), [entryFor(2)]);
});

test("recordGrade: 401 triggers one silent re-auth and a single retry", async () => {
  let attempts = 0;
  let refreshes = 0;
  const { queue } = queueWith({
    writeStats: async () => {
      attempts += 1;
      if (attempts === 1) throw { status: 401 };
    },
    refreshAuth: async () => {
      refreshes += 1;
      return true;
    },
  });
  await queue.recordGrade(entryFor(2));
  assert.equal(attempts, 2);
  assert.equal(refreshes, 1);
  assert.equal(queue.pendingCount(), 0);
});

test("recordGrade: 401 with failed re-auth lands in the queue", async () => {
  const { queue } = queueWith({
    writeStats: async () => {
      throw { status: 401 };
    },
    refreshAuth: async () => false,
  });
  await queue.recordGrade(entryFor(2));
  assert.equal(queue.pendingCount(), 1);
});

test("queue survives a reload (restored from storage)", async () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: serialize([entryFor(2), entryFor(3)]),
  });
  const { queue } = queueWith({ storage });
  assert.equal(queue.pendingCount(), 2);
});

test("flush replays in order and clears storage", async () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: serialize([entryFor(5), entryFor(2), entryFor(9)]),
  });
  const { queue, calls } = queueWith({ storage });
  await queue.flush();
  assert.deepEqual(calls, [5, 2, 9]);
  assert.equal(queue.pendingCount(), 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("flush stops at the first failure and keeps the rest in order", async () => {
  const storage = fakeStorage({
    [STORAGE_KEY]: serialize([entryFor(5), entryFor(2), entryFor(9)]),
  });
  let succeeded = 0;
  const { queue } = queueWith({
    storage,
    writeStats: async (entry) => {
      if (entry.rowIndex === 2) throw new TypeError("still offline");
      succeeded += 1;
    },
  });
  await queue.flush();
  assert.equal(succeeded, 1);
  assert.deepEqual(
    deserialize(storage.getItem(STORAGE_KEY)).map((e) => e.rowIndex),
    [2, 9],
  );
});

test("a later successful write for a row supersedes its queued entry", async () => {
  const storage = fakeStorage({ [STORAGE_KEY]: serialize([entryFor(2)]) });
  const { queue } = queueWith({ storage });
  await queue.recordGrade(entryFor(2, { timesShown: 9 }));
  assert.equal(queue.pendingCount(), 0);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("onStatusChange fires immediately and on every change", async () => {
  const seen = [];
  const { queue } = queueWith({
    writeStats: async () => {
      throw new TypeError("offline");
    },
  });
  const unsubscribe = queue.onStatusChange((status) => seen.push(status.pendingCount));
  await queue.recordGrade(entryFor(2));
  await queue.recordGrade(entryFor(3));
  unsubscribe();
  await queue.recordGrade(entryFor(4));
  assert.deepEqual(seen, [0, 1, 2]);
});
