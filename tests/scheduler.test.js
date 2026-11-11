import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  LADDER,
  nextInterval,
  grade,
  isDue,
  buildQueue,
  buildAheadQueue,
  requeue,
  nextDue,
} from "../site/js/scheduler.js";

const TODAY = "2026-11-10";

describe("nextInterval", () => {
  test("climbs the full ladder and caps at 60", () => {
    assert.equal(nextInterval(0), 1);
    assert.equal(nextInterval(1), 3);
    assert.equal(nextInterval(3), 7);
    assert.equal(nextInterval(7), 14);
    assert.equal(nextInterval(14), 30);
    assert.equal(nextInterval(30), 60);
    assert.equal(nextInterval(60), 60);
  });

  test("off-ladder values climb to the next ladder step", () => {
    assert.equal(nextInterval(2), 3);
    assert.equal(nextInterval(100), 60);
  });
});

describe("grade", () => {
  test('"knew it" climbs the full ladder with matching due dates', () => {
    let word = { intervalDays: 0, dueDate: TODAY };
    const expected = [
      { intervalDays: 1, dueDate: "2026-11-11" },
      { intervalDays: 3, dueDate: "2026-11-13" },
      { intervalDays: 7, dueDate: "2026-11-17" },
      { intervalDays: 14, dueDate: "2026-11-24" },
      { intervalDays: 30, dueDate: "2026-12-10" },
      { intervalDays: 60, dueDate: "2027-01-09" },
      { intervalDays: 60, dueDate: "2027-01-09" }, // capped at 60
    ];
    for (const step of expected) {
      word = grade(word, true, TODAY);
      assert.deepEqual(word, step);
    }
  });

  test("new word (empty scheduling cells) passed ⇒ interval 1, due tomorrow", () => {
    assert.deepEqual(grade({}, true, TODAY), {
      intervalDays: 1,
      dueDate: "2026-11-11",
    });
  });

  test('"didn\'t know" resets to 0 and due today', () => {
    assert.deepEqual(grade({ intervalDays: 30, dueDate: TODAY }, false, TODAY), {
      intervalDays: 0,
      dueDate: TODAY,
    });
  });

  test("fail then pass ⇒ due tomorrow (issue #3 criterion)", () => {
    const failed = grade({ intervalDays: 14, dueDate: TODAY }, false, TODAY);
    const passed = grade(failed, true, TODAY);
    assert.deepEqual(passed, { intervalDays: 1, dueDate: "2026-11-11" });
  });

  test("date arithmetic crosses month boundaries", () => {
    assert.equal(grade({ intervalDays: 1 }, true, "2026-11-29").dueDate, "2026-12-02");
  });

  test("does not mutate the input word", () => {
    const word = { intervalDays: 3, dueDate: TODAY };
    grade(word, true, TODAY);
    assert.deepEqual(word, { intervalDays: 3, dueDate: TODAY });
  });
});

describe("isDue", () => {
  test("never-reviewed word (no due date) counts as due", () => {
    assert.equal(isDue({}, TODAY), true);
    assert.equal(isDue({ dueDate: "" }, TODAY), true);
  });

  test("due today and overdue are due; future is not", () => {
    assert.equal(isDue({ dueDate: TODAY }, TODAY), true);
    assert.equal(isDue({ dueDate: "2026-11-01" }, TODAY), true);
    assert.equal(isDue({ dueDate: "2026-11-11" }, TODAY), false);
  });
});

describe("buildQueue", () => {
  test("includes only due words, most overdue first", () => {
    const words = [
      { id: "future", dueDate: "2026-12-01", dateAdded: "2026-10-01" },
      { id: "today", dueDate: TODAY, dateAdded: "2026-10-01" },
      { id: "overdue", dueDate: "2026-11-01", dateAdded: "2026-10-01" },
      { id: "new", dueDate: "", dateAdded: "2026-10-01" },
    ];
    const queue = buildQueue(words, TODAY);
    assert.deepEqual(
      queue.map((w) => w.id),
      ["overdue", "today", "new"]
    );
  });

  test("never-reviewed words sort as due today", () => {
    const words = [
      { id: "new", dateAdded: "2026-01-01" },
      { id: "overdue", dueDate: "2026-11-09", dateAdded: "2026-10-01" },
    ];
    assert.deepEqual(
      buildQueue(words, TODAY).map((w) => w.id),
      ["overdue", "new"]
    );
  });

  test("ties on due date are broken by dateAdded ascending", () => {
    const words = [
      { id: "b", dueDate: TODAY, dateAdded: "2026-10-05" },
      { id: "a", dueDate: TODAY, dateAdded: "2026-10-01" },
    ];
    assert.deepEqual(
      buildQueue(words, TODAY).map((w) => w.id),
      ["a", "b"]
    );
  });

  test("returns an empty queue when nothing is due", () => {
    const words = [{ dueDate: "2026-11-11" }, { dueDate: "2027-01-01" }];
    assert.deepEqual(buildQueue(words, TODAY), []);
    assert.deepEqual(buildQueue([], TODAY), []);
  });

  test("does not mutate the input array", () => {
    const words = [
      { id: "b", dueDate: TODAY, dateAdded: "2026-10-05" },
      { id: "a", dueDate: TODAY, dateAdded: "2026-10-01" },
    ];
    buildQueue(words, TODAY);
    assert.deepEqual(
      words.map((w) => w.id),
      ["b", "a"]
    );
  });
});

describe("buildAheadQueue", () => {
  test("includes only non-due words, soonest due first", () => {
    const words = [
      { id: "later", dueDate: "2026-12-01", dateAdded: "2026-10-01" },
      { id: "due-today", dueDate: TODAY, dateAdded: "2026-10-01" },
      { id: "soon", dueDate: "2026-11-12", dateAdded: "2026-10-01" },
      { id: "overdue", dueDate: "2026-11-01", dateAdded: "2026-10-01" },
    ];
    assert.deepEqual(
      buildAheadQueue(words, TODAY).map((w) => w.id),
      ["soon", "later"]
    );
  });

  test("excludes never-reviewed words — they are due, not ahead", () => {
    const words = [
      { id: "new", dateAdded: "2026-10-01" },
      { id: "blank", dueDate: "", dateAdded: "2026-10-01" },
      { id: "ahead", dueDate: "2026-11-20", dateAdded: "2026-10-01" },
    ];
    assert.deepEqual(
      buildAheadQueue(words, TODAY).map((w) => w.id),
      ["ahead"]
    );
  });

  test("ties on due date are broken by dateAdded ascending", () => {
    const words = [
      { id: "b", dueDate: "2026-11-15", dateAdded: "2026-10-05" },
      { id: "a", dueDate: "2026-11-15", dateAdded: "2026-10-01" },
    ];
    assert.deepEqual(
      buildAheadQueue(words, TODAY).map((w) => w.id),
      ["a", "b"]
    );
  });

  test("empty when every word is due or the list is empty", () => {
    assert.deepEqual(buildAheadQueue([{ dueDate: TODAY }, {}], TODAY), []);
    assert.deepEqual(buildAheadQueue([], TODAY), []);
  });

  test("complements buildQueue: every word lands in exactly one queue", () => {
    const words = [
      { id: "overdue", dueDate: "2026-11-01", dateAdded: "2026-10-01" },
      { id: "new", dateAdded: "2026-10-01" },
      { id: "ahead", dueDate: "2026-11-20", dateAdded: "2026-10-01" },
    ];
    const due = buildQueue(words, TODAY).map((w) => w.id);
    const ahead = buildAheadQueue(words, TODAY).map((w) => w.id);
    assert.equal(due.length + ahead.length, words.length);
    assert.deepEqual(new Set([...due, ...ahead]).size, words.length);
  });

  test("does not mutate the input array", () => {
    const words = [
      { id: "b", dueDate: "2026-11-20", dateAdded: "2026-10-05" },
      { id: "a", dueDate: "2026-11-15", dateAdded: "2026-10-01" },
    ];
    buildAheadQueue(words, TODAY);
    assert.deepEqual(
      words.map((w) => w.id),
      ["b", "a"]
    );
  });
});

describe("requeue", () => {
  test("appends the failed card to the end without mutating", () => {
    const queue = [{ id: "a" }, { id: "b" }];
    const failed = { id: "failed" };
    const next = requeue(queue, failed);
    assert.deepEqual(
      next.map((w) => w.id),
      ["a", "b", "failed"]
    );
    assert.equal(queue.length, 2);
  });
});

describe("nextDue", () => {
  test("returns null when the sheet has no words", () => {
    assert.equal(nextDue([], TODAY), null);
  });

  test("returns null when no word has a future due date", () => {
    const words = [{ dueDate: TODAY }, { dueDate: "2026-11-01" }, {}];
    assert.equal(nextDue(words, TODAY), null);
  });

  test("returns the earliest future due date with its count", () => {
    const words = [
      { dueDate: "2026-11-12" },
      { dueDate: "2026-11-11" },
      { dueDate: "2026-11-11" },
      { dueDate: TODAY }, // due now — not future
      {}, // never reviewed — not future
    ];
    assert.deepEqual(nextDue(words, TODAY), { date: "2026-11-11", count: 2 });
  });
});

describe("LADDER", () => {
  test("matches ADR-0002", () => {
    assert.deepEqual(LADDER, [1, 3, 7, 14, 30, 60]);
  });
});
