// App shell: home screen + navigation (issue #42) around the review session
// state machine (issue #15). Wires auth, sheets, scheduler and the
// write-back queue into the UI designed in design/home-screen.md and
// design/flashcard-review.md.
//
// States: loading → signin? → (empty | home) → reviewing → done → home;
// Import (issue #37, importscreen.js) and Listen (issue #41,
// listenscreen.js) are their own screens. Error screen on startup read
// failure; sync banner driven by the queue.

import { CLIENT_ID, SPREADSHEET_ID } from "./config.js";
import * as auth from "./auth.js";
import {
  ensureHeader,
  loadWords,
  writeStats,
  appendWords,
  writeAudioRefs,
  writePhrase,
  writePhraseTranslation,
} from "./sheets.js";
import {
  buildQueue,
  buildAheadQueue,
  grade,
  requeue,
  nextDue,
} from "./scheduler.js";
import { createWriteQueue } from "./queue.js";
import { choicesAvailable, buildQuestion } from "./distractors.js";
import * as speech from "./speech.js";
import * as apikey from "./apikey.js";
import { enrichWord, translatePhrase } from "./gemini.js";
import { synthesize } from "./tts.js";
import { ensureFolder, uploadClip, fetchClip } from "./drive.js";
import { createImporter } from "./importer.js";
import { initImportScreen } from "./importscreen.js";
import { createPlayer } from "./player.js";
import { initListenScreen } from "./listenscreen.js";
import { createClipPlayer, cardClipIds } from "./clipplayer.js";

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
  btnClose: $("btn-close"),
  linkSheet: $("link-sheet"),
  homeStatus: $("home-status"),
  btnCards: $("btn-cards"),
  btnChoices: $("btn-choices"),
  choicesCaption: $("choices-caption"),
  btnListen: $("btn-listen"),
  btnImport: $("btn-import"),
  btnImportEmpty: $("btn-import-empty"),
  doneStats: $("done-stats"),
  doneWarn: $("done-warn"),
  choiceBack: $("choice-back"),
  phraseChoice: $("phrase-choice"),
  options: $("options"),
  btnNext: $("btn-next"),
  speakWordFront: $("speak-word-front"),
  speakWordBack: $("speak-word-back"),
  speakPhrase: $("speak-phrase"),
  speakPhraseChoice: $("speak-phrase-choice"),
  voiceCaption: $("voice-caption"),
};

const optionButtons = [...els.options.querySelectorAll(".opt")];

const MESSAGE_STATES = [
  "state-loading",
  "state-signin",
  "state-error",
  "state-home",
  "state-listen",
  "state-empty",
  "state-done",
  "state-import",
];

const FADE_MS = 150;

let words = []; // the loaded vocabulary; grading mutates its entries
let session = null; // { queue, today, knew, didnt, mode: "cards" | "choices" }
let revealed = false; // classic: back face shown
let question = null; // choices: { word, options, correctIndex }
let answered = false; // choices: an option was picked
let currentState = null; // the visible MESSAGE_STATES id, or "card"

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
  currentState = name;
  for (const id of MESSAGE_STATES) $(id).hidden = id !== name;
  els.card.hidden = name !== "card";
  els.progress.hidden = name !== "card";
  if (name !== "card") {
    els.grades.hidden = true;
    els.keys.hidden = true;
    els.options.hidden = true;
    els.btnNext.hidden = true;
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

/** Render the front of the current card (classic mode). */
function renderCard() {
  const word = session.queue[0];
  revealed = false;
  prepareAudio(word);
  els.wordFront.textContent = word.word;
  els.wordBack.textContent = word.word;
  els.translation.textContent = word.translation;
  els.phraseRow.hidden = word.example === null;
  els.phrase.textContent = word.example ?? "";
  els.cardFront.hidden = false;
  els.cardBack.hidden = true;
  els.choiceBack.hidden = true;
  els.hint.hidden = false;
  els.grades.hidden = true;
  els.keys.hidden = true;
  els.options.hidden = true;
  els.btnNext.hidden = true;
  els.card.classList.remove("choices", "answered");
  els.card.style.cursor = "pointer";
  renderProgress();
}

/** Render the current multiple-choice question (design/multiple-choice.md). */
function renderChoice() {
  const word = session.queue[0];
  answered = false;
  // Availability is checked at session start and the vocabulary doesn't
  // change mid-session, so a question always exists here.
  question = { word, ...buildQuestion(words, word, Math.random) };
  prepareAudio(word);
  els.wordFront.textContent = word.word;
  els.cardFront.hidden = false;
  els.cardBack.hidden = true;
  els.choiceBack.hidden = true;
  els.hint.hidden = true;
  els.grades.hidden = true;
  els.keys.hidden = true;
  els.card.classList.add("choices");
  els.card.classList.remove("answered");
  els.card.style.cursor = "default"; // the card is not tappable pre-answer
  for (const [i, button] of optionButtons.entries()) {
    button.classList.remove("correct", "wrong", "faded");
    button.disabled = false;
    button.querySelector(".label").textContent = question.options[i];
  }
  els.options.hidden = false;
  els.btnNext.hidden = true;
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

// ------------------------------------------------- home (design/home-screen.md)

/**
 * Home status line: "N due · M words", or in the nothing-due state
 * "Nothing due · next 12 tomorrow" (date form when it isn't tomorrow).
 */
function homeStatusText(dueCount, today) {
  if (dueCount > 0) {
    const noun = words.length === 1 ? "word" : "words";
    return `${dueCount} due · ${words.length} ${noun}`;
  }
  const info = nextDue(words, today);
  if (!info) return "Nothing due";
  const when = info.date === localTomorrow() ? "tomorrow" : `on ${info.date}`;
  return `Nothing due · next ${info.count} ${when}`;
}

/**
 * Render Home from the current (locally graded) word list: four equal
 * direct-action buttons (issue #69). In the nothing-due state Listen
 * becomes the solid button and Cards turns outline; labels and order
 * never change. Choices disables (with a persistent caption) while the
 * vocabulary can't fill a 4-option question.
 */
function showHome() {
  session = null;
  const today = localToday();
  const dueCount = buildQueue(words, today).length;
  const nothingDue = dueCount === 0;
  const available = choicesAvailable(words);

  els.homeStatus.textContent = homeStatusText(dueCount, today);
  els.btnCards.classList.toggle("solid", !nothingDue);
  els.btnCards.classList.toggle("outline", nothingDue);
  els.btnListen.classList.toggle("solid", nothingDue);
  els.btnListen.classList.toggle("outline", !nothingDue);
  els.btnChoices.classList.toggle("outline", available);
  els.btnChoices.classList.toggle("disabled", !available);
  els.btnChoices.disabled = !available;
  els.choicesCaption.hidden = available;
  showState("state-home");
}

// --------------------------------------------------- word import (issue #37)

/** A valid token, silently refreshed when it expired mid-import (#36 runs
 *  can outlive the hour-long OAuth token). */
async function freshToken() {
  return auth.getToken() ?? auth.requestToken({ silent: true });
}

// The orchestrator (#36) with its real dependencies: Gemini text + TTS use
// the user-supplied key (ADR-0004), rows and clips go through the OAuth
// token (sheets.js / drive.js, ADR-0005).
const importer = createImporter({
  enrich: (word, vocabulary) => enrichWord(apikey.getKey(), word, vocabulary),
  appendWord: async (word) => appendWords(await freshToken(), [word]),
  writeAudioRefs: async (word) => writeAudioRefs(await freshToken(), word),
  synthesize: (text, language, voice) =>
    synthesize(apikey.getKey(), text, language, voice),
  uploadClip: async (filename, blob) => {
    const token = await freshToken();
    return uploadClip(token, await ensureFolder(token), filename, blob);
  },
  // Backfill-only writers/translator (#72): single user-text cells C/D.
  writePhrase: async (word) => writePhrase(await freshToken(), word),
  writePhraseTranslation: async (word) =>
    writePhraseTranslation(await freshToken(), word),
  translatePhrase: (phrase) => translatePhrase(apikey.getKey(), phrase),
});

const importScreen = initImportScreen({
  importer,
  getVocabulary: () => words.map((w) => w.word),
  getWords: () => words,
  reloadWords: async () => {
    words = await loadWords(await freshToken());
    return words;
  },
  fetchClip: async (fileId) => fetchClip(await freshToken(), fileId),
  apiKey: apikey,
  sheetUrl: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`,
  // Leaving import lands wherever makes sense with the (reloaded) words.
  onExit: () => (words.length === 0 ? showState("state-empty") : showHome()),
  // The import screen may borrow the sync banner for failed sheet appends
  // (design/word-import.md); null restores the write-queue's own display.
  setBanner: (text) => {
    if (text) {
      els.banner.textContent = text;
      els.banner.hidden = false;
    } else {
      els.banner.textContent = "Couldn't save progress \u2014 retrying";
      els.banner.hidden = writeQueue.pendingCount() === 0;
    }
  },
});

function openImport() {
  showState("state-import");
  importScreen.open();
}

// --------------------------------------------------- listen mode (issue #41)

// The continuous player (#40, ADR-0006) with its real browser defaults;
// clips come from Drive through the OAuth token (ADR-0005). Listening
// writes no stats — nothing here touches the scheduler or the write queue.
const player = createPlayer({
  fetchClip: async (fileId) => fetchClip(await freshToken(), fileId),
});

const listenScreen = initListenScreen({
  player,
  getWords: () => words,
  // Leaving lands wherever makes sense with the current words (like import).
  onExit: () => (words.length === 0 ? showState("state-empty") : showHome()),
  onImport: () => openImport(),
});

function openListen() {
  showState("state-listen");
  listenScreen.open();
}

// ------------------------------------------------------------ session start

/**
 * Start a review session from Home in the given mode ("cards" or
 * "choices"): the due queue, or — when nothing is due — the review-ahead
 * queue (issue #42). Grading ahead-of-schedule words uses the normal
 * rules. One mode per session (issue #31); tapping the button *is* the
 * choice — nothing is selected or remembered (issue #69).
 */
function startSession(mode) {
  const today = localToday();
  let queue = buildQueue(words, today);
  if (queue.length === 0) queue = buildAheadQueue(words, today);
  if (queue.length === 0) return; // unreachable while Home requires words

  session = { queue, today, knew: 0, didnt: 0, mode };
  if (mode === "choices") renderChoice();
  else renderCard();
  showState("card");
}

/** Choices needs 4 distinct translations; the button is disabled below
 *  that, but the keyboard shortcut must check too. */
function startChoices() {
  if (!choicesAvailable(words)) return;
  startSession("choices");
}

// ------------------------------------------------------------------- grading

/**
 * Record a grade: scheduling + stats + write-back + session counters +
 * queue advance/re-queue. Shared by both modes — a correct pick in Choices
 * is exactly "Knew it" (issue #31 acceptance).
 */
function applyGrade(word, knewIt) {
  const today = session.today;
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
}

function onGrade(knewIt) {
  if (!session || !revealed) return;
  applyGrade(session.queue[0], knewIt);

  if (session.queue.length === 0) {
    showDone();
  } else {
    withFade(renderCard);
  }
}

// --------------------------------------------- choices answering (issue #31)

/**
 * An option was picked: immediate monochrome feedback (correct always
 * revealed solid ✓, a wrong pick ✕ + strikethrough, the rest faded), the
 * card expands with the phrase, and the grade is recorded right away —
 * advancing is explicit (Next / card tap / Space), never timed.
 */
function onPick(index) {
  if (!session || session.mode !== "choices" || answered) return;
  answered = true;
  const { word, options, correctIndex } = question;
  const knewIt = index === correctIndex;

  for (const [i, button] of optionButtons.entries()) {
    button.disabled = true; // inert after the pick — no second guessing
    if (i === correctIndex) {
      button.classList.add("correct");
      button.querySelector(".label").textContent = `\u2713 ${options[i]}`;
    } else if (i === index) {
      button.classList.add("wrong");
      button.querySelector(".label").textContent = `\u2715 ${options[i]}`;
    } else {
      button.classList.add("faded");
    }
  }

  els.choiceBack.hidden = word.example === null;
  els.phraseChoice.textContent = word.example ?? "";
  els.card.classList.add("answered");
  els.card.style.cursor = "pointer"; // tapping the card advances now
  els.btnNext.hidden = false;

  applyGrade(word, knewIt);
}

function advanceChoice() {
  if (!session || !answered) return;
  if (session.queue.length === 0) {
    showDone();
  } else {
    withFade(renderChoice);
  }
}

// -------------------------------------------------------------------- startup

// The header check runs once per app load (issue #56): a brand-new blank
// sheet gets its header row written before the first read.
let headerEnsured = false;

/** Load the sheet and land on Home (or the empty/signin/error states). */
async function loadAndBegin() {
  showState("state-loading");
  try {
    const token = auth.getToken();
    if (!headerEnsured) {
      await ensureHeader(token);
      headerEnsured = true;
    }
    words = await loadWords(token);
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

  showHome();
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

// --------------------------------------------------------------------- audio

// Review speakers play stored natural clips through the clip player
// (issue #71, part 1 of #28); Web Speech remains the fallback for rows
// without clips and on fetch/play errors. Clips come from Drive through
// the OAuth token, exactly like listen mode.
const clipPlayer = createClipPlayer({
  fetchClip: async (fileId) => fetchClip(await freshToken(), fileId),
});

// Which clip each speaker button plays: word speakers the Spanish word
// clip, phrase speakers the Spanish phrase clip (#71).
const speakerClips = [
  [els.speakWordFront, "audioWordEs"],
  [els.speakWordBack, "audioWordEs"],
  [els.speakPhrase, "audioPhraseEs"],
  [els.speakPhraseChoice, "audioPhraseEs"],
];

/**
 * Hairline/inert vs active speaker buttons (design-system disabled state).
 * A speaker is active when its clip exists OR a Spanish voice does (#71);
 * re-run on every card render (clips are per word) and on voiceschanged.
 */
function updateSpeakers() {
  const word = shownWord();
  const voice = speech.isAvailable();
  for (const [button, clipField] of speakerClips) {
    const enabled = voice || Boolean(word?.[clipField]);
    button.classList.toggle("disabled", !enabled);
    button.setAttribute("aria-disabled", String(!enabled));
  }
  if (voice) els.voiceCaption.hidden = true;
}

/** Per-render audio prep: speaker states follow the word's clips, and the
 * card's clips are warmed so the first tap is instant (#28 acceptance). */
function prepareAudio(word) {
  updateSpeakers();
  clipPlayer.preload(cardClipIds(word));
}

/**
 * The word currently on screen. In choices mode the queue advances at pick
 * time (the grade is recorded immediately), so `queue[0]` is already the
 * next word — the displayed one lives on `question`.
 */
function shownWord() {
  if (!session) return null;
  return session.mode === "choices" ? question.word : session.queue[0];
}

/**
 * A speaker tap: eats the event (never reveals/advances the card), plays
 * the stored clip when there is one, falls back to Web Speech on a missing
 * clip or fetch/play error, and shows the muted caption (#5) only when
 * both are absent (#71).
 */
async function onSpeakerTap(event, getText, clipField) {
  event.stopPropagation();
  const word = shownWord();
  if (!word) return;
  globalThis.speechSynthesis?.cancel(); // a clip must not play over speech
  if (await clipPlayer.play(word[clipField])) return;
  clipPlayer.stop(); // nor speech over a clip
  if (!speech.isAvailable()) {
    els.voiceCaption.hidden = false;
    return;
  }
  speech.speak(getText(word));
}

els.speakWordFront.addEventListener("click", (e) =>
  onSpeakerTap(e, (w) => w.word, "audioWordEs"),
);
els.speakWordBack.addEventListener("click", (e) =>
  onSpeakerTap(e, (w) => w.word, "audioWordEs"),
);
els.speakPhrase.addEventListener("click", (e) =>
  onSpeakerTap(e, (w) => w.example, "audioPhraseEs"),
);
els.speakPhraseChoice.addEventListener("click", (e) =>
  onSpeakerTap(e, (w) => w.example, "audioPhraseEs"),
);

speech.onVoicesChanged(updateSpeakers);
updateSpeakers();

// --------------------------------------------------------------------- wiring

els.linkSheet.href = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`;

els.card.addEventListener("click", () => {
  if (session?.mode === "choices") {
    advanceChoice(); // no-op until answered; the card isn't tappable before
    return;
  }
  if (!revealed) reveal();
});

for (const [i, button] of optionButtons.entries()) {
  button.addEventListener("click", () => onPick(i));
}
els.btnNext.addEventListener("click", () => advanceChoice());

els.btnWrong.addEventListener("click", () => onGrade(false));
els.btnRight.addEventListener("click", () => onGrade(true));
els.btnRetry.addEventListener("click", () => loadAndBegin());
els.btnDone.addEventListener("click", () => loadAndBegin()); // refetch, lands Home

// Home navigation (issue #42). ✕ abandons the current card ungraded; words
// already graded this session keep their (optimistically written) state.
els.btnClose.addEventListener("click", () => showHome());
els.btnCards.addEventListener("click", () => startSession("cards"));
els.btnChoices.addEventListener("click", () => startChoices());
els.btnListen.addEventListener("click", () => openListen());
els.btnImport.addEventListener("click", () => openImport());
els.btnImportEmpty.addEventListener("click", () => openImport());

els.btnSignin.addEventListener("click", async () => {
  try {
    await auth.requestToken(); // interactive popup — needs the user gesture
    await loadAndBegin();
  } catch {
    els.signinHint.textContent = "Sign-in failed — try again.";
  }
});

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  // Home: Enter/Space = the solid action (Cards by default, Listen when
  // nothing is due), C = Choices, L = Listen, I = Import.
  if (currentState === "state-home") {
    if (event.key === "Enter" || event.key === " ") {
      // A focused button/link activates natively — don't double-fire.
      if (document.activeElement?.closest("button, a")) return;
      event.preventDefault(); // don't scroll
      if (buildQueue(words, localToday()).length === 0) openListen();
      else startSession("cards");
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "c") startChoices();
    else if (key === "l") openListen();
    else if (key === "i") openImport();
    return;
  }

  if (!session) return;

  // Choices session: 1–4 pick an option, Space/Enter advance after answering.
  if (session.mode === "choices") {
    if (event.key === " ") event.preventDefault(); // don't scroll
    if (!answered && ["1", "2", "3", "4"].includes(event.key)) {
      onPick(Number(event.key) - 1);
    } else if (answered && (event.key === " " || event.key === "Enter")) {
      advanceChoice();
    }
    return;
  }

  // Classic session: Space = reveal, 1/← and 2/→ = grade.
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
