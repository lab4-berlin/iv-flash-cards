// Bulk import orchestrator — issue #36, part of #27 (ADR-0004/0005).
//
// Two layers, following the queue.js pattern:
//   1. A pure core (input parsing, duplicate detection, the per-word state
//      machine, backoff scheduling, report summary) — no DOM, no network.
//   2. `createImporter(deps)` — the glue running the two-phase pipeline per
//      word. Dependencies are injected so the module stays unit-testable
//      and does not hard-couple to sheets.js/gemini.js/tts.js/drive.js
//      (app.js wires those in, binding the API key and OAuth token):
//        - enrich(word, vocabulary): Gemini text enrichment, e.g.
//          (w, v) => gemini.enrichWord(key, w, v)
//        - appendWord(word): append one A:P row, resolve with the 1-based
//          row index it landed on (sheets.appendWords)
//        - writeAudioRefs(word): write the word's M:P audio-ref cells
//        - synthesize(text, language, voice): TTS, resolves with a Blob
//        - uploadClip(filename, blob): Drive upload, resolves with file ID
//        - writePhrase(word): write the word's C phrase cell (backfill)
//        - writePhraseTranslation(word): write the word's D cell (backfill)
//        - translatePhrase(phrase): Gemini translation of one existing
//          phrase (backfill rows with C filled but D empty), e.g.
//          (p) => gemini.translatePhrase(key, p)
//
// Words are processed sequentially — free-tier rate limits, not throughput,
// are the constraint (ADR-0004). Within one word, the 4 TTS calls run in
// parallel and then the 4 uploads run in parallel (#59). On a
// RateLimitError the pipeline backs off (1s/2s/4s/8s), then marks the word
// failed-retryable and moves on. One word failing never aborts the batch
// (#27 acceptance).

import { pickVoice as defaultPickVoice } from "./voices.js";
import { clipFilename } from "./drive.js";

// ---------------------------------------------------------------- pure core

/**
 * Parse pasted/uploaded import input: one word per line, trimmed, empty
 * lines dropped. Handles CRLF.
 * @param {string} text raw input
 * @returns {string[]} words in input order, original spelling kept
 */
export function parseInput(text) {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * Normalize a word for duplicate comparison: lowercase, trimmed, inner
 * whitespace collapsed to single spaces.
 * @param {string} word
 * @returns {string}
 */
export function normalizeWord(word) {
  return word.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Item states, in pipeline order (see the state machine below). */
export const STATES = [
  "pending",
  "skipped-duplicate",
  "enriching",
  "appending",
  "audio",
  "done",
  "failed",
];

// Legal state transitions: pending → enriching → appending → audio(0..4)
// → done, with failed(phase) reachable from any active phase and
// skipped-duplicate decided up front. audio → audio bumps clipsDone.
// The backfill run (#72) works on rows that already exist, so it skips
// appending: enriching → audio is legal too.
const TRANSITIONS = {
  pending: ["enriching", "skipped-duplicate"],
  enriching: ["appending", "audio", "failed"],
  appending: ["audio", "failed"],
  audio: ["audio", "done", "failed"],
  "skipped-duplicate": [],
  done: [],
  failed: [],
};

/**
 * Create a fresh batch item for one input word.
 * @param {string} word original spelling from the input
 */
export function createItem(word) {
  return { word, state: "pending", clipsDone: 0, phase: null, error: null };
}

/**
 * Advance an item to the next state (pure — returns a new item, throws on
 * an illegal transition so pipeline bugs surface in tests, not silently).
 * @param {object} item a batch item
 * @param {string} next the target state
 * @param {object} [detail] extra fields to merge (e.g. clipsDone, error,
 *   retryable, rowIndex)
 */
export function transition(item, next, detail = {}) {
  if (!TRANSITIONS[item.state]?.includes(next)) {
    throw new Error(`illegal transition: ${item.state} → ${next}`);
  }
  const phase = next === "failed" ? { phase: item.state } : {};
  return { ...item, state: next, ...phase, ...detail };
}

/**
 * Build the batch for an import run: one item per input word, duplicates
 * (against the existing vocabulary and earlier in the same input, compared
 * normalized) marked `skipped-duplicate` up front.
 * @param {string} inputText raw pasted/uploaded text
 * @param {string[]} vocabulary existing words (the sheet's words column)
 * @returns {object[]} batch items in input order
 */
export function planBatch(inputText, vocabulary) {
  const seen = new Set(vocabulary.map(normalizeWord));
  return parseInput(inputText).map((word) => {
    const item = createItem(word);
    const normalized = normalizeWord(word);
    if (seen.has(normalized)) return transition(item, "skipped-duplicate");
    seen.add(normalized);
    return item;
  });
}

/**
 * Summarize a batch for the report: counts by outcome. Items themselves are
 * the per-word outcomes (word, state, failed phase, error).
 * @param {object[]} items batch items
 * @returns {{total: number, imported: number, skipped: number,
 *   failed: number, inProgress: number}}
 */
export function summarize(items) {
  const count = (state) => items.filter((i) => i.state === state).length;
  return {
    total: items.length,
    imported: count("done"),
    skipped: count("skipped-duplicate"),
    failed: count("failed"),
    inProgress:
      items.length - count("done") - count("skipped-duplicate") - count("failed"),
  };
}

/** Backoff delays after consecutive rate-limit errors (issue #36). */
export const BACKOFF_DELAYS_MS = [1000, 2000, 4000, 8000];

function isRateLimit(error) {
  return error != null && error.name === "RateLimitError";
}

/**
 * Run `fn`, backing off on RateLimitError per {@link BACKOFF_DELAYS_MS}.
 * After the last delay the next RateLimitError is rethrown (the caller
 * marks the word failed-retryable and continues). Non-rate-limit errors
 * are rethrown immediately.
 * @param {() => Promise<any>} fn
 * @param {(ms: number) => Promise<void>} sleep injectable for tests
 */
export async function withBackoff(fn, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRateLimit(error) || attempt >= BACKOFF_DELAYS_MS.length) {
        throw error;
      }
      await sleep(BACKOFF_DELAYS_MS[attempt]);
    }
  }
}

// The four audio clips per word: which Word field holds the Drive file ID,
// which field holds the text to say, and in which language (ADR-0005).
const CLIPS = [
  { kind: "word_es", field: "audioWordEs", textField: "word", language: "es" },
  { kind: "phrase_es", field: "audioPhraseEs", textField: "example", language: "es" },
  { kind: "word_en", field: "audioWordEn", textField: "translation", language: "en" },
  { kind: "phrase_en", field: "audioPhraseEn", textField: "phraseTranslation", language: "en" },
];

/**
 * The backfill fill decision for one row (#72, pure): what's missing →
 * what's generated. Never plans a write to a non-empty cell.
 *
 * - `phrase`: C is empty → a phrase is generated (Gemini enrichment).
 * - `phraseTranslation`: D is empty → filled from the enrichment when the
 *   phrase is generated too, otherwise by translating the existing phrase.
 * - `clips`: the clip kinds whose M:P cell is empty *and* whose source
 *   text exists or is itself being filled this run. A clip whose source
 *   text is missing and not fillable (e.g. `word_en` on a row without a
 *   translation — B is user-owned, never backfilled) is not planned.
 *
 * An empty audio cell means "missing — please generate" (ADR-0005), so a
 * cell the user cleared to request regeneration is simply planned again.
 *
 * @param {object} word a Word (model.js)
 * @returns {{phrase: boolean, phraseTranslation: boolean, clips: string[]}}
 */
export function backfillNeeds(word) {
  const phrase = !word.example;
  const phraseTranslation = !word.phraseTranslation;
  const willHaveText = (textField) =>
    Boolean(word[textField]) ||
    (textField === "example" && phrase) ||
    (textField === "phraseTranslation" && phraseTranslation);
  const clips = CLIPS.filter(
    ({ field, textField }) => !word[field] && willHaveText(textField),
  ).map(({ kind }) => kind);
  return { phrase, phraseTranslation, clips };
}

/**
 * Whether a row is incomplete, i.e. the backfill would touch it (#72).
 * Drives the count on the step-1 entry button and the run's target list.
 * @param {object} word a Word (model.js)
 * @returns {boolean}
 */
export function needsBackfill(word) {
  const needs = backfillNeeds(word);
  return needs.phrase || needs.phraseTranslation || needs.clips.length > 0;
}

// ---------------------------------------------------------------- glue

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoToday = () => new Date().toISOString().slice(0, 10);

/**
 * Create the import pipeline.
 *
 * @param {object} deps see the module header for each function's contract
 * @param {(word, vocabulary) => Promise<object>} deps.enrich
 * @param {(word) => Promise<number>} deps.appendWord
 * @param {(word) => Promise<void>} deps.writeAudioRefs
 * @param {(text, language, voice) => Promise<Blob>} deps.synthesize
 * @param {(filename, blob) => Promise<string>} deps.uploadClip
 * @param {(word) => Promise<void>} [deps.writePhrase] backfill only
 * @param {(word) => Promise<void>} [deps.writePhraseTranslation] backfill only
 * @param {(phrase) => Promise<string>} [deps.translatePhrase] backfill only
 * @param {() => string} [deps.pickVoice] defaults to voices.js
 * @param {(ms) => Promise<void>} [deps.sleep] injectable clock for tests
 * @param {() => string} [deps.today] YYYY-MM-DD for date_added
 * @returns {{run, backfill, generateMissingClips}}
 */
export function createImporter({
  enrich,
  appendWord,
  writeAudioRefs,
  synthesize,
  uploadClip,
  writePhrase,
  writePhraseTranslation,
  translatePhrase,
  pickVoice = defaultPickVoice,
  sleep = realSleep,
  today = isoToday,
}) {
  /**
   * Fill whatever audio cells are missing on a word, then persist `M:P`.
   * Works on freshly imported words and on hand-added rows alike — a clip
   * is generated only when its cell is empty and its source text exists,
   * so existing clips are never overwritten and rows without a phrase get
   * their word clips only (the #28 backfill reuses these semantics).
   *
   * @param {object} word a Word (model.js) with a valid `rowIndex`
   * @param {(word, kind) => void} [onClip] progress callback per clip
   * @returns {Promise<{word: object, failures: {kind, error}[]}>} the
   *   updated word (generated file IDs set) and the clips that failed —
   *   their cells stay empty, so retrying is running this again.
   *   Rejects only when the final audio-ref write fails.
   */
  async function generateMissingClips(word, onClip) {
    let updated = { ...word };
    const finalFailures = new Map(); // clip kind → error
    let generated = 0;

    // Parallel passes (issue #59): each pass synthesizes every still-missing
    // clip with Promise.allSettled, then uploads the resulting blobs the
    // same way. A RateLimitError on any call rate-limits the whole word:
    // back off on the shared ladder, then retry only the clips still
    // missing — succeeded clips are never redone, and non-rate-limit
    // failures stay final for their clip (same semantics as the
    // sequential version, #36).
    for (let attempt = 0; ; attempt++) {
      const missing = CLIPS.filter(
        ({ kind, field, textField }) =>
          !updated[field] && updated[textField] && !finalFailures.has(kind),
      );
      if (missing.length === 0) break;

      const rateLimited = new Map(); // clip kind → error, this pass only

      const synthesized = await Promise.allSettled(
        missing.map(({ textField, language }) =>
          synthesize(updated[textField], language, pickVoice()),
        ),
      );
      const uploadable = [];
      for (const [i, result] of synthesized.entries()) {
        const clip = missing[i];
        if (result.status === "fulfilled") {
          uploadable.push({ clip, blob: result.value });
        } else if (isRateLimit(result.reason)) {
          rateLimited.set(clip.kind, result.reason);
        } else {
          finalFailures.set(clip.kind, result.reason);
        }
      }

      const uploaded = await Promise.allSettled(
        uploadable.map(({ clip, blob }) =>
          uploadClip(clipFilename(updated.rowIndex, updated.word, clip.kind), blob),
        ),
      );
      for (const [i, result] of uploaded.entries()) {
        const { clip } = uploadable[i];
        if (result.status === "fulfilled") {
          updated = { ...updated, [clip.field]: result.value };
          generated++;
          onClip?.(updated, clip.kind);
        } else if (isRateLimit(result.reason)) {
          rateLimited.set(clip.kind, result.reason);
        } else {
          finalFailures.set(clip.kind, result.reason);
        }
      }

      // Without a rate limit every clip is now done or failed-final; the
      // next pass finds nothing missing and exits the loop.
      if (rateLimited.size === 0) continue;
      if (attempt >= BACKOFF_DELAYS_MS.length) {
        // Ladder exhausted — the still-rate-limited clips fail (retryable).
        for (const [kind, error] of rateLimited) finalFailures.set(kind, error);
        break;
      }
      await sleep(BACKOFF_DELAYS_MS[attempt]);
    }

    // Report failures in CLIPS order, like the sequential version did.
    const failures = CLIPS.filter(({ kind }) => finalFailures.has(kind)).map(
      ({ kind }) => ({ kind, error: finalFailures.get(kind) }),
    );
    if (generated > 0) await writeAudioRefs(updated);
    return { word: updated, failures };
  }

  /**
   * Run one import batch, sequentially. Never rejects for a single word's
   * failure — per-word outcomes land in the returned items (#27).
   *
   * @param {string} inputText raw pasted/uploaded text (one word per line)
   * @param {string[]} vocabulary existing words (the sheet's words column)
   * @param {(items: object[]) => void} [onProgress] called with a fresh
   *   items snapshot after every state change, for the UI
   * @param {() => boolean} [shouldStop] checked before each word; when it
   *   returns true the batch stops there — the current word is never cut
   *   mid-flight (per-word atomicity, design/word-import.md Cancel), and
   *   unprocessed words simply stay `pending`
   * @returns {Promise<{items: object[], summary: object}>}
   */
  async function run(inputText, vocabulary, onProgress, shouldStop) {
    const items = planBatch(inputText, vocabulary);
    const vocab = [...vocabulary];
    const update = (index, next) => {
      items[index] = next;
      onProgress?.([...items]);
    };
    onProgress?.([...items]);

    for (let i = 0; i < items.length; i++) {
      if (shouldStop?.()) break;
      if (items[i].state !== "pending") continue;
      const fail = (error) => {
        // Full error to the console for diagnosis; the results screen shows
        // error.message via importflow.failureCaption.
        console.error(
          `[import] "${items[i].word}" failed in phase "${items[i].state}":`,
          error,
        );
        update(
          i,
          transition(items[i], "failed", {
            error,
            retryable: isRateLimit(error),
          }),
        );
      };

      // Phase 1: text enrichment → append the row (A:L filled — user text
      // incl. the D phrase translation, plus zeroed stats — M:P empty).
      update(i, transition(items[i], "enriching"));
      let enrichment;
      try {
        enrichment = await withBackoff(
          () => enrich(items[i].word, vocab),
          sleep,
        );
      } catch (error) {
        fail(error);
        continue;
      }
      let word = {
        word: items[i].word,
        translation: enrichment.translation,
        example: enrichment.phraseEs,
        dateAdded: today(),
        language: "es",
        timesShown: 0,
        timesRight: 0,
        timesWrong: 0,
        lastReviewed: null,
        intervalDays: 0,
        dueDate: null,
        phraseTranslation: enrichment.phraseEn,
        audioWordEs: null,
        audioPhraseEs: null,
        audioWordEn: null,
        audioPhraseEn: null,
      };
      update(i, transition(items[i], "appending"));
      try {
        word.rowIndex = await appendWord(word);
      } catch (error) {
        fail(error);
        continue;
      }
      // Later prompts in this batch may reuse the words imported so far.
      vocab.push(word.word);

      // Phase 2: 4 clips in parallel (random voice each) → write M:P IDs.
      update(i, transition(items[i], "audio", { rowIndex: word.rowIndex }));
      try {
        const result = await generateMissingClips(word, () =>
          update(
            i,
            transition(items[i], "audio", {
              clipsDone: items[i].clipsDone + 1,
            }),
          ),
        );
        word = result.word;
        if (result.failures.length > 0) {
          // The row exists with whatever clips succeeded; the empty cells
          // are retried by a later generateMissingClips run (#28 backfill).
          fail(result.failures[0].error);
          continue;
        }
      } catch (error) {
        fail(error);
        continue;
      }
      update(i, transition(items[i], "done"));
    }

    return { items, summary: summarize(items) };
  }

  /**
   * Run one backfill batch over existing rows (#72, part 2 of #28):
   * complete rows are left out entirely; each incomplete row gets, where
   * missing, a generated phrase (→ C), a phrase translation (→ D), and
   * whatever clips are absent (→ M:P via generateMissingClips). Non-empty
   * cells are never written (see backfillNeeds). Same per-word failure
   * isolation, backoff, progress snapshots and cancel semantics as `run`.
   *
   * @param {object[]} words Words (model.js) with valid `rowIndex`es —
   *   typically the freshly reloaded sheet
   * @param {(items: object[]) => void} [onProgress] fresh items snapshot
   *   after every state change, for the UI
   * @param {() => boolean} [shouldStop] checked before each word; the
   *   current word is never cut mid-flight
   * @returns {Promise<{items: object[], summary: object}>} summary.imported
   *   counts the rows fully enriched this run
   */
  async function backfill(words, onProgress, shouldStop) {
    const targets = words.filter(needsBackfill);
    const items = targets.map((w) => ({
      ...createItem(w.word),
      rowIndex: w.rowIndex,
    }));
    // The enrichment prompt may lean on the whole vocabulary, like import.
    const vocabulary = words.map((w) => w.word);
    const update = (index, next) => {
      items[index] = next;
      onProgress?.([...items]);
    };
    onProgress?.([...items]);

    for (let i = 0; i < items.length; i++) {
      if (shouldStop?.()) break;
      const fail = (error) => {
        console.error(
          `[backfill] "${items[i].word}" failed in phase "${items[i].state}":`,
          error,
        );
        update(
          i,
          transition(items[i], "failed", {
            error,
            retryable: isRateLimit(error),
          }),
        );
      };

      let word = { ...targets[i] };
      const needs = backfillNeeds(word);

      // Phase 1: text fills. A generated phrase brings its own translation
      // from the same enrichment call; a row that already has a phrase but
      // no D gets just that phrase translated. Cells already filled are
      // never written (needs.* is false for them).
      update(i, transition(items[i], "enriching"));
      try {
        if (needs.phrase) {
          const enrichment = await withBackoff(
            () => enrich(word.word, vocabulary),
            sleep,
          );
          word = { ...word, example: enrichment.phraseEs };
          await writePhrase(word);
          if (needs.phraseTranslation) {
            word = { ...word, phraseTranslation: enrichment.phraseEn };
            await writePhraseTranslation(word);
          }
        } else if (needs.phraseTranslation) {
          const phraseEn = await withBackoff(
            () => translatePhrase(word.example),
            sleep,
          );
          word = { ...word, phraseTranslation: phraseEn };
          await writePhraseTranslation(word);
        }
      } catch (error) {
        fail(error);
        continue;
      }

      // Phase 2: whatever clips are still missing (cells left empty by a
      // partial import, hand-added rows, or cleared for regeneration).
      update(i, transition(items[i], "audio", { rowIndex: word.rowIndex }));
      try {
        const result = await generateMissingClips(word, () =>
          update(
            i,
            transition(items[i], "audio", {
              clipsDone: items[i].clipsDone + 1,
            }),
          ),
        );
        if (result.failures.length > 0) {
          // Cells of failed clips stay empty — the next backfill retries.
          fail(result.failures[0].error);
          continue;
        }
      } catch (error) {
        fail(error);
        continue;
      }
      update(i, transition(items[i], "done"));
    }

    return { items, summary: summarize(items) };
  }

  return { run, backfill, generateMissingClips };
}
