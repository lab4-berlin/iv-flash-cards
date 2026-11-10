// Review session state machine (issue #15). Wires auth, sheets, scheduler
// and the write-back queue into the UI designed in design/flashcard-review.md.
//
// States: loading → signin? → (empty | nothing-due | reviewing) → done;
// error screen on startup read failure; sync banner driven by the queue.

import { CLIENT_ID, SPREADSHEET_ID } from "./config.js";
import * as auth from "./auth.js";
import { loadWords, writeStats } from "./sheets.js";
import { buildQueue, grade, requeue, nextDue } from "./scheduler.js";
import { createWriteQueue } from "./queue.js";

const $ = (id) => document.getElementById(id);

const els = {
  banner: $("banner"),
  progress: $("progress"),
  progressCount: $("progress-count"),
  progressFill: $("progress-fill"),
  card: $("card"),
  cardFront: $("card-front"),
  cardBack: $("card-back"),
  wordFront: $("word-front"),
  wordBack: $("word-back"),
  translation: $("translation"),
  phraseRow: $("phrase-row"),
  phrase: $("phrase"),
  hint: $("hint"),
  grades: $("grades"),
  keys: $("keys"),
  btnWrong: $("btn-wrong"),
  btnRight: $("btn-right"),
  btnSignin: $("btn-signin"),
  signinHint: $("signin-hint"),
  btnRetry: $("btn-retry"),
  btnDone: $("btn-done"),
  linkSheet: $("link-sheet"),
  nextDue: $("next-due"),
  doneStats: $("done-stats"),
  doneWarn: $("done-warn"),
};

const MESSAGE_STATES = [
  "state-loading",
  "state-signin",
  "state-error",
  "state-empty",
  "state-nothing-due",
  "state-done",
];

const FADE_MS = 150;

let session = null; // { queue, today, knew, didnt }
let revealed = false;

// ---------------------------------------------------------- write-back queue

const writeQueue = createWriteQueue({
  writeStats: async (entry) => {
    const token = auth.getToken();
    if (!token) {
      throw Object.assign(new Error("Not signed in"), { status: 401 });
    }
    return writeStats(token, entry);
  },
  refreshAuth: async () => {
    try {
      await auth.requestToken({ silent: true });
      return true;
    } catch {
      return false;
    }
  },
});

writeQueue.onStatusChange(({ pendingCount }) => {
  els.banner.hidden = pendingCount === 0;
  renderDoneWarn(pendingCount);
});

// ------------------------------------------------------------------- helpers

function isoLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function localToday() {
  return isoLocal(new Date());
}

function localTomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return isoLocal(date);
}

/** Show one screen; everything else (incl. the card chrome) follows. */
function showState(name) {
  for (const id of MESSAGE_STATES) $(id).hidden = id !== name;
  els.card.hidden = name !== "card";
  els.progress.hidden = name !== "card";
  if (name !== "card") {
    els.grades.hidden = true;
    els.keys.hidden = true;
  }
}

/** 150ms opacity fade on card reveal/advance (the only animation). */
function withFade(update) {
  els.card.classList.add("fading");
  setTimeout(() => {
    update();
    els.card.classList.remove("fading");
  }, FADE_MS);
}

// ------------------------------------------------------------------ rendering

function renderProgress() {
  const graded = session.knew + session.didnt;
  const total = graded + session.queue.length;
  els.progressCount.textContent = `${graded + 1} / ${total}`;
  els.progressFill.style.width = `${(graded / total) * 100}%`;
}

/** Render the front of the current card. */
function renderCard() {
  const word = session.queue[0];
  revealed = false;
  els.wordFront.textContent = word.word;
  els.wordBack.textContent = word.word;
  els.translation.textContent = word.translation;
  els.phraseRow.hidden = word.example === null;
  els.phrase.textContent = word.example ?? "";
  els.cardFront.hidden = false;
  els.cardBack.hidden = true;
  els.hint.hidden = false;
  els.grades.hidden = true;
  els.keys.hidden = true;
  els.card.style.cursor = "pointer";
  renderProgress();
}

function reveal() {
  if (!session || revealed) return;
  revealed = true;
  withFade(() => {
    els.cardFront.hidden = true;
    els.cardBack.hidden = false;
    els.hint.hidden = true;
    els.grades.hidden = false;
    els.keys.hidden = false;
    els.card.style.cursor = "default";
  });
}

function renderDoneWarn(pendingCount) {
  els.doneWarn.hidden = pendingCount === 0;
  els.doneWarn.textContent =
    pendingCount === 1
      ? "1 unsaved review — retrying in the background"
      : `${pendingCount} unsaved reviews — retrying in the background`;
}

function showDone() {
  const reviewed = session.knew + session.didnt;
  els.doneStats.textContent = `${reviewed} reviewed · ${session.knew} knew · ${session.didnt} didn't`;
  renderDoneWarn(writeQueue.pendingCount());
  session = null;
  showState("state-done");
}

function renderNothingDue(words, today) {
  const info = nextDue(words, today);
  if (!info) {
    els.nextDue.hidden = true;
  } else {
    const noun = info.count === 1 ? "word" : "words";
    const when = info.date === localTomorrow() ? "tomorrow" : `on ${info.date}`;
    els.nextDue.textContent = `${info.count} ${noun} due ${when}`;
    els.nextDue.hidden = false;
  }
  showState("state-nothing-due");
}

// ------------------------------------------------------------------- grading

function onGrade(knewIt) {
  if (!session || !revealed) return;
  const today = session.today;
  const word = session.queue[0];

  const next = grade(word, knewIt, today);
  word.timesShown += 1;
  if (knewIt) word.timesRight += 1;
  else word.timesWrong += 1;
  word.lastReviewed = today;
  word.intervalDays = next.intervalDays;
  word.dueDate = next.dueDate;

  // Optimistic UI: the write (or its pending-queue fallback) is async.
  void writeQueue.recordGrade(word);

  if (knewIt) session.knew += 1;
  else session.didnt += 1;
  session.queue = session.queue.slice(1);
  if (!knewIt) session.queue = requeue(session.queue, word); // ADR-0002 rule 3

  if (session.queue.length === 0) {
    showDone();
  } else {
    withFade(renderCard);
  }
}

// -------------------------------------------------------------------- startup

async function loadAndBegin() {
  showState("state-loading");
  let words;
  try {
    words = await loadWords(auth.getToken());
  } catch (error) {
    if (error?.status === 401) {
      els.signinHint.textContent = "Your session expired — sign in again.";
      showState("state-signin");
    } else {
      showState("state-error");
    }
    return;
  }

  void writeQueue.flush(); // replay pending writes from a previous session

  if (words.length === 0) {
    showState("state-empty");
    return;
  }

  const today = localToday();
  const due = buildQueue(words, today);
  if (due.length === 0) {
    renderNothingDue(words, today);
    return;
  }

  session = { queue: due, today, knew: 0, didnt: 0 };
  renderCard();
  showState("card");
}

async function start() {
  showState("state-loading");
  try {
    await auth.init(CLIENT_ID);
  } catch {
    showState("state-error");
    return;
  }
  if (!auth.getToken()) {
    try {
      await auth.requestToken({ silent: true });
    } catch {
      showState("state-signin");
      return;
    }
  }
  await loadAndBegin();
}

// --------------------------------------------------------------------- wiring

els.linkSheet.href = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

els.card.addEventListener("click", () => {
  if (!revealed) reveal();
});

els.btnWrong.addEventListener("click", () => onGrade(false));
els.btnRight.addEventListener("click", () => onGrade(true));
els.btnRetry.addEventListener("click", () => loadAndBegin());
els.btnDone.addEventListener("click", () => loadAndBegin());

els.btnSignin.addEventListener("click", async () => {
  try {
    await auth.requestToken(); // interactive popup — needs the user gesture
    await loadAndBegin();
  } catch {
    els.signinHint.textContent = "Sign-in failed — try again.";
  }
});

document.addEventListener("keydown", (event) => {
  if (!session) return;
  if (event.key === " ") {
    event.preventDefault(); // don't scroll
    reveal();
  } else if (revealed && (event.key === "1" || event.key === "ArrowLeft")) {
    onGrade(false);
  } else if (revealed && (event.key === "2" || event.key === "ArrowRight")) {
    onGrade(true);
  }
});

start();
