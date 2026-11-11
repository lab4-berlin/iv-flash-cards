// Listen-mode playlist logic: eligibility, shuffle, per-word segment
// sequence, and block planning (issue #38, ADR-0006). Pure module: no DOM,
// no audio, no network; randomness and clip durations are injected.
//
// The player (separate module) consumes this to stitch WAV blocks: it
// shuffles the eligible pool, takes ~10-minute blocks of whole words off
// the queue, and reshuffles when the pool has cycled — so no word repeats
// until every word has played once.

/** Silence between segments within a word (#29 flow). */
export const GAP_MS = 2000;

/** Default block length target (~10 minutes, ADR-0006). */
export const DEFAULT_BLOCK_MS = 10 * 60 * 1000;

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
 * The fixed per-word playback sequence (#29 flow):
 * Spanish word · 2s gap · Spanish phrase · 2s gap · English word ·
 * English phrase. Returned as data for the stitcher.
 * @returns {Array<{type: "clip", fileId: string} | {type: "gap", ms: number}>}
 */
export function wordSequence(word) {
  return [
    { type: "clip", fileId: word.audioWordEs },
    { type: "gap", ms: GAP_MS },
    { type: "clip", fileId: word.audioPhraseEs },
    { type: "gap", ms: GAP_MS },
    { type: "clip", fileId: word.audioWordEn },
    { type: "clip", fileId: word.audioPhraseEn },
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
