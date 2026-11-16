// Import screen controller — issue #37 (design/word-import.md).
//
// Owns the #state-import section and its four sub-screens: the blocked
// invitation (issue #64, design/key-setup.md — shown whenever no key is
// saved; the guided setup replaces the old technical key entry), step 1
// (paste / upload), step 2 (batch progress with Cancel), and step 3
// (report with per-word retry). app.js shows the section and calls
// `open()`; this module never touches other screens — leaving goes through
// `deps.onExit`. The key-setup guide (keysetup.js) is the one exception:
// it is a sibling overlay with its own entry contract, opened directly.
//
// All data access is injected (same pattern as importer.js), so this file
// is pure DOM glue: app.js binds the importer, the sheet/Drive calls and
// the key module when wiring it up.

import {
  uniqueWords,
  countCaption,
  generateLabel,
  backfillCaption,
  failureCaption,
  rowView,
  progressView,
  resultsView,
  retryLabel,
  skippedView,
  partitionFailed,
  isGeneratorUnreachable,
} from "./importflow.js";
import { needsBackfill } from "./importer.js";
import { openKeySetup } from "./keysetup.js";
import { importSubscreen } from "./keysetupflow.js";

const $ = (id) => document.getElementById(id);

/**
 * Wire up the import screen once.
 *
 * @param {object} deps
 * @param {{run, backfill, generateMissingClips}} deps.importer an
 *   importer.js instance
 * @param {() => string[]} deps.getVocabulary current words column
 * @param {() => object[]} deps.getWords current Words (model.js) — drives
 *   the step-1 backfill button's incomplete-row count (#72)
 * @param {() => Promise<object[]>} deps.reloadWords refetch the sheet (and
 *   update the app's word list); resolves with the fresh Words
 * @param {(fileId: string) => Promise<Blob>} deps.fetchClip Drive download
 * @param {{getKey}} deps.apiKey apikey.js — only the has-key check lives
 *   here; saving, validating and removing belong to the guide (keysetup.js)
 * @param {string} deps.sheetUrl "Open sheet" target
 * @param {() => void} deps.onExit leave the import screen (app decides where)
 * @param {(text: string|null) => void} deps.setBanner show the sync-error
 *   banner with `text`, or restore its normal (write-queue) behavior on null
 * @returns {{open: () => void}}
 */
export function initImportScreen(deps) {
  const els = {
    close: $("imp-close"),
    blocked: $("imp-blocked"),
    setupKey: $("imp-setup-key"),
    input: $("imp-input"),
    text: $("imp-text"),
    upload: $("imp-upload"),
    file: $("imp-file"),
    count: $("imp-count"),
    generate: $("imp-generate"),
    backfill: $("imp-backfill"),
    backfillCap: $("imp-backfill-cap"),
    keyChange: $("imp-key-change"),
    progress: $("imp-progress"),
    progressCount: $("imp-progress-count"),
    progressFill: $("imp-progress-fill"),
    rows: $("imp-rows"),
    cancel: $("imp-cancel"),
    results: $("imp-results"),
    headline: $("imp-headline"),
    sub: $("imp-sub"),
    report: $("imp-report"),
    retry: $("imp-retry"),
    done: $("imp-done"),
    sheet: $("imp-sheet"),
    error: $("imp-error"),
    errorRetry: $("imp-error-retry"),
    errorBack: $("imp-error-back"),
  };

  const SUBSCREENS = ["blocked", "input", "progress", "results", "error"];

  let sub = null; // the visible subscreen name
  let running = false; // a batch (or retry) is in flight
  let cancelled = false; // Cancel/✕ pressed during a run
  let unreachable = false; // whole-batch failure detected this run
  let lastRunText = ""; // input of the last run, for the error-state Retry
  let mode = "import"; // "import" | "backfill" — steers Retry (#72)
  // The cumulative session report: Word objects added (for translations,
  // phrases and clips), skipped word strings, and failed batch items.
  let report = { added: [], skipped: [], failed: [] };

  const clipUrls = new Map(); // fileId → object URL, revoked on exit
  const player = new Audio();

  function showSub(name) {
    sub = name;
    for (const id of SUBSCREENS) els[id].hidden = id !== name;
  }

  // ------------------------------------------------- key state (issue #64)

  /** Step 1 with a key, the blocked invitation without; also the landing
   *  point whenever the key-setup guide hands control back — which is what
   *  unlocks import immediately after a validated key, no reload. */
  function showForKey() {
    if (importSubscreen(deps.apiKey.getKey() != null) === "input") showInput();
    else showSub("blocked");
  }

  function openGuide() {
    openKeySetup({ onDone: showForKey });
  }

  // ---------------------------------------------------------- step 1: input

  function refreshCount() {
    const count = uniqueWords(els.text.value).length;
    els.count.textContent = countCaption(count);
    els.generate.textContent = generateLabel(count);
    els.generate.disabled = count === 0;
    els.generate.classList.toggle("disabled", count === 0);
    els.generate.classList.toggle("solid", count > 0);
  }

  /** The backfill entry (#72): outline button + incomplete-row caption,
   *  both hidden when every row is complete. */
  function refreshBackfill() {
    const count = deps.getWords().filter(needsBackfill).length;
    els.backfill.hidden = count === 0;
    els.backfillCap.hidden = count === 0;
    els.backfillCap.textContent = backfillCaption(count);
  }

  function showInput() {
    refreshCount();
    refreshBackfill();
    showSub("input");
    els.text.focus();
  }

  async function appendFile(file) {
    if (!file) return;
    const text = await file.text();
    const current = els.text.value.replace(/\s+$/, "");
    els.text.value = (current === "" ? "" : current + "\n") + text.trim() + "\n";
    els.file.value = ""; // allow re-uploading the same file
    refreshCount();
  }

  // -------------------------------------------------------- step 2: progress

  /** One design-system "List row" from an importflow.js row view. */
  function buildRow(view) {
    const row = document.createElement("div");
    row.className = "imp-row" + (view.pending ? " pending" : "");
    const word = document.createElement("span");
    word.className = "w";
    word.textContent = view.word;
    const status = document.createElement("span");
    status.className = "st";
    if (view.glyph) {
      const glyph = document.createElement("span");
      glyph.className = "glyph" + (view.glyphMuted ? " glyph-muted" : "");
      glyph.textContent = view.glyph;
      status.append(glyph);
    }
    if (view.caption) {
      const caption = document.createElement("span");
      caption.className = "cap";
      caption.textContent = view.caption;
      status.append(caption);
    }
    row.append(word, status);
    return row;
  }

  function renderRows(views) {
    els.rows.replaceChildren(...views.map(buildRow));
  }

  function renderProgress(views, { label, percent }) {
    els.progressCount.textContent = label;
    els.progressFill.style.width = `${percent}%`;
    renderRows(views);
  }

  function showProgress(views) {
    cancelled = false;
    unreachable = false;
    els.cancel.disabled = false;
    renderProgress(views, { label: `0 / ${views.length}`, percent: 0 });
    showSub("progress");
  }

  function cancelRun() {
    cancelled = true;
    els.cancel.disabled = true; // the current word still finishes
  }

  // A sheet append failed mid-batch: data-loss-risk, so the existing
  // sync-error banner is reused (design/word-import.md error states).
  let bannerShown = false;
  function noteWriteFailure(items) {
    if (bannerShown) return;
    if (items.some((i) => i.state === "failed" && i.phase === "appending")) {
      bannerShown = true;
      deps.setBanner("Couldn't save to the sheet");
    }
  }

  // ----------------------------------------------------------- run a batch

  async function startBatch(text) {
    mode = "import";
    lastRunText = text;
    report = { added: [], skipped: [], failed: [] };
    deps.setBanner(null);
    bannerShown = false;
    running = true;
    showProgress(uniqueWords(text).map((word) => rowView({ word, state: "pending" })));

    const { items } = await deps.importer.run(
      text,
      deps.getVocabulary(),
      (snapshot) => {
        if (!unreachable && isGeneratorUnreachable(snapshot)) {
          unreachable = true;
          cancelled = true; // stop after the current word
        }
        noteWriteFailure(snapshot);
        renderProgress(snapshot.map(rowView), progressView(snapshot));
      },
      () => cancelled,
    );
    running = false;

    if (unreachable) {
      showSub("error"); // step-1 input is untouched behind "Back"
      return;
    }
    await collectOutcomes(items);
    showResults();
  }

  /** Fold a finished run's items into the session report. */
  async function collectOutcomes(items) {
    let byRow = new Map();
    try {
      const words = await deps.reloadWords();
      byRow = new Map(words.map((w) => [w.rowIndex, w]));
    } catch {
      // The report then shows added words without translation/phrase; the
      // sheet itself has everything — not worth failing the screen over.
    }
    for (const item of items) {
      if (item.state === "done") {
        report.added.push(byRow.get(item.rowIndex) ?? { word: item.word });
      } else if (item.state === "skipped-duplicate") {
        report.skipped.push(item.word);
      } else if (item.state === "failed") {
        report.failed.push(item);
      }
      // cancelled runs leave `pending` items — dropped, per the design
    }
  }

  // ------------------------------------------------------- backfill (#72)

  /** Run one backfill over the given rows; shared by start and retry.
   *  Reuses step 2 (progress) and the error state unchanged. Resolves with
   *  the run's items, or null when the generator was unreachable. */
  async function runBackfill(words) {
    const targets = words.filter(needsBackfill);
    showProgress(
      targets.map((w) => rowView({ word: w.word, state: "pending" })),
    );
    const { items } = await deps.importer.backfill(
      words,
      (snapshot) => {
        if (!unreachable && isGeneratorUnreachable(snapshot)) {
          unreachable = true;
          cancelled = true; // stop after the current word
        }
        renderProgress(snapshot.map(rowView), progressView(snapshot));
      },
      () => cancelled,
    );
    running = false;

    if (unreachable) {
      showSub("error");
      return null;
    }
    return items;
  }

  async function startBackfill() {
    mode = "backfill";
    report = { added: [], skipped: [], failed: [] };
    deps.setBanner(null);
    bannerShown = false;
    running = true;
    // Work from a fresh read so hand edits since app load (new rows,
    // cleared audio cells, ADR-0005) are picked up; on a failed reload the
    // in-memory words still give a correct, if possibly stale, run.
    let words = deps.getWords();
    try {
      words = await deps.reloadWords();
    } catch {
      // fall through with the in-memory words
    }
    const items = await runBackfill(words);
    if (!items) return;
    await collectOutcomes(items);
    showResults();
  }

  /** Step-3 Retry in backfill mode: backfill the failed rows again — the
   *  run only ever fills what is still missing, so this is idempotent. */
  async function retryBackfill() {
    const toRetry = report.failed;
    report.failed = [];
    deps.setBanner(null);
    bannerShown = false;
    running = true;

    let byRow = new Map();
    try {
      const words = await deps.reloadWords();
      byRow = new Map(words.map((w) => [w.rowIndex, w]));
    } catch {
      // Lookups below miss; those rows simply stay failed, retryable.
    }
    const targets = [];
    for (const item of toRetry) {
      const word = byRow.get(item.rowIndex);
      if (word) targets.push(word);
      else report.failed.push(item); // row lookup didn't resolve
    }

    const items = await runBackfill(targets);
    if (!items) return;
    // Rows a cancel never reached (still incomplete) were failed before —
    // they stay so; rows completed by hand since drop out silently.
    const settled = new Set(
      items.filter((i) => i.state !== "pending").map((i) => i.rowIndex),
    );
    for (const item of toRetry) {
      const word = byRow.get(item.rowIndex);
      if (word && !settled.has(item.rowIndex) && needsBackfill(word)) {
        report.failed.push(item);
      }
    }
    await collectOutcomes(items);
    showResults();
  }

  // ---------------------------------------------------------- step 3: report

  function resRow(word) {
    const row = document.createElement("div");
    row.className = "res-row";
    const top = document.createElement("div");
    top.className = "res-top";
    const w = document.createElement("span");
    w.className = "w";
    w.textContent = word.word;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = word.translation ?? "";
    top.append(w, t);
    row.append(top);
    if (word.example) {
      const phrase = document.createElement("div");
      phrase.className = "res-phrase";
      if (word.audioPhraseEs) {
        const speaker = document.createElement("button");
        speaker.type = "button";
        speaker.className = "speaker sm";
        speaker.setAttribute("aria-label", "Play phrase");
        speaker.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';
        speaker.addEventListener("click", () => playClip(word.audioPhraseEs));
        phrase.append(speaker);
      }
      phrase.append(document.createTextNode(word.example));
      row.append(phrase);
    }
    return row;
  }

  function groupCap(text) {
    const cap = document.createElement("div");
    cap.className = "group-cap";
    cap.textContent = text;
    return cap;
  }

  function failedRow(item) {
    return buildRow({
      word: item.word,
      glyph: "\u2715",
      glyphMuted: false,
      caption: failureCaption(item),
      pending: false,
    });
  }

  function showResults() {
    const counts = {
      imported: report.added.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
    };
    const { headline, sub: subline } = resultsView(counts);
    els.headline.textContent = headline;
    els.sub.textContent = subline ?? "";
    els.sub.hidden = subline == null;

    const children = report.added.map(resRow);
    if (counts.failed > 0) {
      children.push(groupCap("Failed"), ...report.failed.map(failedRow));
    }
    if (counts.skipped > 0) {
      const view = skippedView(report.skipped);
      children.push(groupCap("Skipped"));
      if (view.collapsed) {
        const line = document.createElement("div");
        line.className = "cap skipped-line";
        line.textContent = view.line;
        children.push(line);
      } else {
        children.push(
          ...view.words.map((word) =>
            buildRow({
              word,
              glyph: "\u2014",
              glyphMuted: true,
              caption: "already in list",
              pending: false,
            }),
          ),
        );
      }
    }
    els.report.replaceChildren(...children);

    els.retry.hidden = counts.failed === 0;
    els.retry.textContent = retryLabel(counts.failed);
    els.done.classList.toggle("solid", counts.failed === 0);
    els.done.classList.toggle("outline", counts.failed > 0);
    showSub("results");
  }

  async function playClip(fileId) {
    try {
      if (!clipUrls.has(fileId)) {
        const blob = await deps.fetchClip(fileId);
        clipUrls.set(fileId, URL.createObjectURL(blob));
      }
      player.src = clipUrls.get(fileId);
      await player.play();
    } catch {
      // Audition is best-effort; the sheet link is the recovery path.
    }
  }

  // ------------------------------------------------------------ retry failed

  async function retryFailed() {
    const toRetry = report.failed;
    report.failed = [];
    deps.setBanner(null);
    bannerShown = false;
    running = true;

    // Words that broke generating audio already own a sheet row — they
    // retry via generateMissingClips; the rest re-run the full pipeline.
    const { clipRetries, rerunWords } = partitionFailed(toRetry);

    // One combined row list for step 2: clip retries first, then the rerun.
    const clipRows = clipRetries.map((item) => ({ word: item.word, state: "pending" }));
    let rerunItems = rerunWords.map((word) => ({ word, state: "pending" }));
    const render = () => {
      const all = [...clipRows, ...rerunItems];
      renderProgress(all.map(rowView), progressView(all));
    };
    showProgress([...clipRows, ...rerunItems].map(rowView));

    let byRow = new Map();
    try {
      const words = await deps.reloadWords();
      byRow = new Map(words.map((w) => [w.rowIndex, w]));
    } catch {
      // Lookups below miss; those words simply fail again, retryable.
    }

    for (const [i, item] of clipRetries.entries()) {
      if (cancelled) break;
      const word = byRow.get(item.rowIndex);
      if (!word) {
        clipRows[i] = { ...item }; // still failed (row lookup didn't resolve)
        report.failed.push(item);
        render();
        continue;
      }
      clipRows[i] = { word: item.word, state: "audio" };
      render();
      try {
        const result = await deps.importer.generateMissingClips(word);
        if (result.failures.length > 0) throw result.failures[0].error;
        clipRows[i] = { word: item.word, state: "done" };
        report.added.push(result.word);
      } catch (error) {
        clipRows[i] = { word: item.word, state: "failed", phase: "audio", error };
        report.failed.push({ ...item, error });
      }
      render();
    }
    // Anything not reached before a cancel stays failed.
    for (const [i, item] of clipRetries.entries()) {
      if (clipRows[i].state === "pending") report.failed.push(item);
    }

    let runResult = { items: [] };
    if (rerunWords.length > 0) {
      runResult = await deps.importer.run(
        rerunWords.join("\n"),
        deps.getVocabulary(),
        (snapshot) => {
          rerunItems = snapshot;
          noteWriteFailure(snapshot);
          render();
        },
        () => cancelled,
      );
    }
    running = false;

    let rerunByRow = new Map();
    if (runResult.items.some((i) => i.state === "done")) {
      try {
        const words = await deps.reloadWords();
        rerunByRow = new Map(words.map((w) => [w.rowIndex, w]));
      } catch {
        // Same degradation as collectOutcomes.
      }
    }
    for (const item of runResult.items) {
      if (item.state === "done") {
        report.added.push(rerunByRow.get(item.rowIndex) ?? { word: item.word });
      } else if (item.state === "skipped-duplicate") {
        report.skipped.push(item.word);
      } else {
        // failed, or pending after a cancel — it was failed before, stays so
        report.failed.push(item.state === "failed" ? item : { ...item, state: "failed" });
      }
    }
    showResults();
  }

  // ----------------------------------------------------------------- leaving

  function exit() {
    deps.setBanner(null);
    bannerShown = false;
    for (const url of clipUrls.values()) URL.revokeObjectURL(url);
    clipUrls.clear();
    player.pause();
    deps.onExit();
  }

  function onClose() {
    if (running) {
      cancelRun(); // ✕ during step 2 behaves like Cancel (design)
      return;
    }
    exit();
  }

  // ------------------------------------------------------------------ wiring

  els.close.addEventListener("click", onClose);

  // Into the guided key setup (issue #64): from the blocked invitation,
  // and from "Change key" on step 1 (which lands on its manage state).
  els.setupKey.addEventListener("click", openGuide);
  els.keyChange.addEventListener("click", openGuide);

  els.text.addEventListener("input", refreshCount);
  els.upload.addEventListener("click", () => els.file.click());
  els.file.addEventListener("change", () => void appendFile(els.file.files[0]));
  els.generate.addEventListener("click", () => {
    const words = uniqueWords(els.text.value);
    if (words.length === 0) return;
    void startBatch(words.join("\n"));
  });
  els.backfill.addEventListener("click", () => void startBackfill());

  els.cancel.addEventListener("click", cancelRun);

  els.retry.addEventListener("click", () =>
    void (mode === "backfill" ? retryBackfill() : retryFailed()),
  );
  els.done.addEventListener("click", exit);
  els.sheet.href = deps.sheetUrl;

  els.errorRetry.addEventListener("click", () =>
    void (mode === "backfill" ? startBackfill() : startBatch(lastRunText)),
  );
  els.errorBack.addEventListener("click", () => showInput());

  // ------------------------------------------------------------------- open

  function open() {
    els.text.value = ""; // closing discarded any previous input
    report = { added: [], skipped: [], failed: [] };
    showForKey();
  }

  return { open };
}
