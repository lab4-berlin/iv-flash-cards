// Listen-mode playlist logic: eligibility, shuffle, per-word segment
// sequence, and block planning (issue #38, ADR-0006). Pure module: no DOM,
// no audio, no network; randomness and clip durations are injected.
//
// The player (separate module) consumes this to stitch WAV blocks: it
// shuffles the eligible pool, takes blocks of whole words off the queue
// (60 s → 5 min → ~10 min per session, #82), and reshuffles when the pool
// has cycled — so no word repeats until every word has played once.

/** Recall pause after each Spanish clip, before its translation (#81). */
export const GAP_RECALL_MS = 2000;

/** Short breather between the word pair and the phrase pair (#81). */
export const GAP_BREATHER_MS = 1000;

/** Separator trailing every word's sequence (#81). The block's last word
 * keeps it as tail silence, so every word stays a fixed 8-segment unit. */
export const GAP_BETWEEN_WORDS_MS = 2000;

/** Default steady-state block length target (~10 minutes, ADR-0006). */
export const DEFAULT_BLOCK_MS = 10 * 60 * 1000;

/** Ramp-up block schedule for the start of a session (#82, ADR-0006 as
 * amended): the first block targets ~60 s so audio starts within seconds,
 * the second ~5 minutes; every later block uses the steady target. Each
 * block plays several times longer than the next one takes to build, so
 * prefetch always has margin. */
export const BLOCK_TARGET_SCHEDULE_MS = [60_000, 300_000];

/**
 * Target duration of a session's `blockIndex`-th block (0-based): the
 * ramp-up schedule entry, or `steadyMs` past the schedule's end.
 * @param {number} blockIndex
 * @param {number} steadyMs steady-state target (injectable for tests).
 */
export function blockTargetMs(blockIndex, steadyMs = DEFAULT_BLOCK_MS) {
  return blockIndex < BLOCK_TARGET_SCHEDULE_MS.length
    ? BLOCK_TARGET_SCHEDULE_MS[blockIndex]
    : steadyMs;
}

const AUDIO_FIELDS = ["audioWordEs", "audioPhraseEs", "audioWordEn", "audioPhraseEn"];

/**
 * Words that can be listened to: all four audio clip IDs present.
 * Everything else is silently excluded (#29 acceptance — listening must
 * never hit a fallback voice or an error). Returns a new array.
 */
export function eligibleWords(words) {
  return words.filter((word) => AUDIO_FIELDS.every((field) => word[field]));
}

/**
 * Fisher–Yates shuffle. Returns a new array; does not mutate `words`.
 * @param {Array} words
 * @param {() => number} random - returns a float in [0, 1), injected so
 *   tests can seed it.
 */
export function shuffle(words, random) {
  const result = [...words];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * The fixed per-word playback sequence (#81, ADR-0006 as amended):
 * word_es · 2s recall pause · word_en · 1s breather · phrase_es · 2s recall
 * pause · phrase_en · 2s separator — hear the Spanish, pause to recall, get
 * the confirmation; first for the word, then for the phrase. Returned as
 * data for the stitcher; always exactly 8 segments, so cue k in a block
 * sits at segment `k * 8`. Pause lengths are fixed, not configurable.
 * @returns {Array<{type: "clip", fileId: string} | {type: "gap", ms: number}>}
 */
export function wordSequence(word) {
  return [
    { type: "clip", fileId: word.audioWordEs },
    { type: "gap", ms: GAP_RECALL_MS },
    { type: "clip", fileId: word.audioWordEn },
    { type: "gap", ms: GAP_BREATHER_MS },
    { type: "clip", fileId: word.audioPhraseEs },
    { type: "gap", ms: GAP_RECALL_MS },
    { type: "clip", fileId: word.audioPhraseEn },
    { type: "gap", ms: GAP_BETWEEN_WORDS_MS },
  ];
}

function segmentMs(segment, clipDurations) {
  if (segment.type === "gap") return segment.ms;
  const ms = clipDurations.get(segment.fileId);
  if (ms === undefined) {
    throw new Error(`missing clip duration for ${segment.fileId}`);
  }
  return ms;
}

/**
 * Plan one playback block: take whole words off the front of `queue`
 * until the block reaches `targetMs` (a word is never split across
 * blocks, so the last word may push the block past the target).
 *
 * @param {Array} queue - shuffled eligible words still to play this cycle.
 * @param {number} targetMs - block length target; default ~10 minutes.
 * @param {Map<string, number>} clipDurations - clip file ID → duration ms.
 * @returns {{
 *   segments: ReturnType<typeof wordSequence>,
 *   cues: Array<{startMs: number, word: object}>,
 *   totalMs: number,
 *   remaining: Array,
 * }} `segments` is what the stitcher renders; `cues` maps each word's
 *   start offset in the block to the word (MediaSession metadata and
 *   skip-to-next-word); `remaining` is the untaken rest of the queue
 *   (does not mutate `queue`).
 */
export function buildBlockPlan(queue, targetMs = DEFAULT_BLOCK_MS, clipDurations) {
  const segments = [];
  const cues = [];
  let totalMs = 0;
  let taken = 0;

  while (taken < queue.length && totalMs < targetMs) {
    const word = queue[taken];
    const sequence = wordSequence(word);
    cues.push({ startMs: totalMs, word });
    for (const segment of sequence) {
      segments.push(segment);
      totalMs += segmentMs(segment, clipDurations);
    }
    taken += 1;
  }

  return { segments, cues, totalMs, remaining: queue.slice(taken) };
}
