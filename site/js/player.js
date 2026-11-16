// Continuous listen-mode player (issue #40, ADR-0006): stitched WAV blocks
// through one persistent <audio> element, with background prefetch and
// MediaSession lock-screen/headphone controls.
//
// The playlist module (#38) plans blocks and the stitcher (#39) renders
// them; this module owns playback: play block N while building N+1 from the
// clip cache, swap on `ended` (revoking the used blob URL), and loop
// forever — when the shuffled pool is exhausted, reshuffle and keep going
// (#29). Words whose clips cannot be fetched are skipped silently; the
// listener never hears a gap, an error, or a fallback voice.
//
// Every browser dependency (<audio>, MediaSession, blob URLs, Drive
// fetches, randomness) is injected, so the whole state machine is
// unit-testable under Node. The UI (#41) wires the real ones.

import {
  eligibleWords,
  shuffle,
  wordSequence,
  buildBlockPlan,
  blockTargetMs,
  DEFAULT_BLOCK_MS,
  GAP_RECALL_MS,
  GAP_BREATHER_MS,
  GAP_BETWEEN_WORDS_MS,
} from "./playlist.js";
import { stitch, clipDuration, createClipCache } from "./stitcher.js";

/**
 * What plays at each index of playlist.js's fixed 8-segment word sequence
 * (`null` = silence gap). Kind names match drive.js's clip kinds; the UI
 * maps them to the word's text fields for the now-playing line.
 */
const SEGMENT_KINDS = ["word_es", null, "word_en", null, "phrase_es", null, "phrase_en", null];

// Player states, in the design's terms (design/listening-mode.md):
// idle → loading → playing ⇄ paused, plus empty (nothing listenable) and
// error (a block could not be built at all, e.g. offline).

/** Cap on clip fetches in flight while building a block (#82): upcoming
 * words' clips are pipelined up to this many concurrent Drive requests. */
const MAX_CLIP_FETCHES = 6;

/** Conservative lower bound on one word's stitched length — its gaps alone
 * (clips counted as zero). Bounds fetch pipelining to words that can still
 * fit in the block being built (#89): a 1 ms target admits exactly one
 * word, so the one-word first block issues exactly 4 clip fetches. */
const MIN_WORD_MS = GAP_RECALL_MS * 2 + GAP_BREATHER_MS + GAP_BETWEEN_WORDS_MS;

function clipIds(word) {
  return [word.audioWordEs, word.audioPhraseEs, word.audioWordEn, word.audioPhraseEn];
}

/** Run async tasks with at most `max` running at once, started in call
 * order; a finishing task hands its slot straight to the next waiter. */
function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async (task) => {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next(); // slot handed over; `active` count unchanged
      else active -= 1;
    }
  };
}

/** Index of the last entry in sorted `startsMs` at or before `ms`. */
function indexAt(startsMs, ms) {
  let index = 0;
  for (let i = 1; i < startsMs.length; i++) {
    if (startsMs[i] <= ms) index = i;
    else break;
  }
  return index;
}

/**
 * Create the continuous player.
 *
 * @param {{
 *   fetchClip: (fileId: string) => Promise<Blob>,
 *   audio?: HTMLAudioElement,
 *   mediaSession?: MediaSession | null,
 *   createUrl?: (blob: Blob) => string,
 *   revokeUrl?: (url: string) => void,
 *   random?: () => number,
 *   blockMs?: number,
 * }} options `fetchClip` is normally drive.fetchClip with the token bound
 *   by the caller; everything else defaults to the real browser APIs.
 *   `blockMs` is the steady-state block target used once the ramp-up
 *   schedule (one word, then 60 s, then 5 min; #82/#89) is past.
 * @returns {{
 *   start: (words: object[]) => Promise<void>,
 *   pause: () => void,
 *   resume: () => Promise<void>,
 *   skipWord: () => Promise<void>,
 *   stop: () => void,
 *   onNowPlaying: (cb: (np: {word: object, clip: string|null,
 *     segment: number, position: number, cycleSize: number}) => void) =>
 *     () => void,
 *   onStateChange: (cb: (state: string) => void) => () => void,
 *   state: () => string,
 * }} `clip` in the now-playing payload is one of SEGMENT_KINDS (null during
 *   gaps); `segment` is the index 0–7 within the word's fixed 8-segment
 *   sequence (#92 — the listen screen maps it to its two text slots);
 *   `position`/`cycleSize` drive the "12 / 87" cycle counter.
 */
export function createPlayer({
  fetchClip,
  audio = new Audio(),
  mediaSession = typeof navigator === "undefined" ? null : navigator.mediaSession,
  createUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
  random = Math.random,
  blockMs = DEFAULT_BLOCK_MS,
}) {
  const clipCache = createClipCache(fetchClip);
  const nowPlayingCbs = new Set();
  const stateCbs = new Set();

  let state = "idle";
  let pool = []; // eligible words, fixed by start()
  let queue = []; // shuffled words remaining in the current cycle
  let cyclePos = 0; // words consumed from the current cycle
  let current = null; // playing block: {url, cues, cueStarts, segStarts, totalMs}
  let nextPromise = null; // block N+1 being built in the background
  let blockIndex = 0; // per-session index of the next block to build (#82 ramp);
  // owned by start()/advance() so stale or aborted builds can't drift it
  let generation = 0; // bumped by reset(); stale async work aborts
  let suppressEvents = false; // reset() pauses audio without emitting "paused"
  let lastEmitKey = null; // dedupes now-playing emissions
  let lastMetadataWord = null; // dedupes MediaSession metadata updates

  // (Returning advance's promise is harmless in browsers and lets tests
  // await the block swap.)
  audio.addEventListener("ended", () => current && advance({ play: true }));
  audio.addEventListener("timeupdate", () => {
    if (current) sync(audio.currentTime * 1000);
  });
  // System-initiated transitions (phone call, lock-screen UI acting on the
  // element directly) must keep our state truthful.
  audio.addEventListener("play", () => {
    if (state === "paused") setState("playing");
  });
  audio.addEventListener("pause", () => {
    if (!suppressEvents && !audio.ended && state === "playing") setState("paused");
  });

  function setState(next) {
    if (next === state) return;
    state = next;
    if (mediaSession) {
      mediaSession.playbackState =
        next === "playing" ? "playing" : next === "paused" ? "paused" : "none";
    }
    for (const cb of stateCbs) cb(next);
  }

  /** Emit now-playing / MediaSession metadata for position `ms` in the
   * current block, deduped against the last emission. */
  function sync(ms) {
    const k = indexAt(current.cueStarts, ms);
    const cue = current.cues[k];
    if (mediaSession && cue.word !== lastMetadataWord) {
      lastMetadataWord = cue.word;
      const data = { title: cue.word.word, artist: cue.word.translation };
      mediaSession.metadata =
        typeof MediaMetadata === "undefined" ? data : new MediaMetadata(data);
    }
    // The block-wide segment index dedupes per segment (#92): two gaps have
    // the same `clip` (null) but render differently — e.g. the recall pause
    // hides the translation line, the breather shows it — so a sparse
    // timeupdate jumping gap-to-gap must still emit.
    const blockSegment = indexAt(current.segStarts, ms);
    const segment = blockSegment % SEGMENT_KINDS.length;
    const clip = SEGMENT_KINDS[segment];
    if (blockSegment === lastEmitKey) return;
    lastEmitKey = blockSegment;
    for (const cb of nowPlayingCbs) {
      cb({ word: cue.word, clip, segment, position: cue.position, cycleSize: pool.length });
    }
  }

  /**
   * Build the next block: take whole words off the cycle queue until the
   * block reaches `targetMs` or the cycle ends (a block never spans a
   * reshuffle), fetch their clips, and stitch. Upcoming words' clips are
   * fetched concurrently — at most MAX_CLIP_FETCHES in flight in total
   * (#82) — but words enter the block strictly in queue order, and fetches
   * only start for words that can still fit in the block (#89): a word is
   * admitted to the fetch pipeline while the block's conservative minimum
   * length — actual ms of the words taken so far plus MIN_WORD_MS for each
   * admitted word still ahead — is below the target. A 1 ms target thus
   * issues exactly the first word's 4 fetches before playback. A word
   * whose clips cannot be fetched is skipped silently — never a gap or an
   * error (#29) — and releases its reservation, sliding the bound to the
   * next word; the cache does not keep failures, so the word gets retried
   * next cycle. Throws only if not a single word could be built (e.g.
   * offline).
   */
  async function buildBlock(targetMs) {
    const gen = generation;
    if (queue.length === 0) {
      queue = shuffle(pool, random); // pool exhausted → new cycle (#29)
      cyclePos = 0;
    }

    // Clip fetches run through a limiter: started in queue order, at most
    // MAX_CLIP_FETCHES in flight. Once the block is full (`done`) or the
    // build is stale, tasks still queued in the limiter reject instead of
    // fetching.
    let done = false;
    const limit = createLimiter(MAX_CLIP_FETCHES);
    const words = [...queue]; // this cycle's order, fixed for the build
    const jobs = [];
    let totalMs = 0; // actual ms of the words taken into the block
    let aheadCount = 0; // admitted words not yet taken or failed

    /** Admit upcoming words into the fetch pipeline while they can still
     * fit in the block (#89; see the function comment). */
    function admit() {
      while (
        !done &&
        generation === gen &&
        jobs.length < words.length &&
        totalMs + aheadCount * MIN_WORD_MS < targetMs
      ) {
        const word = words[jobs.length];
        const job = { word, released: false };
        job.parsedClips = Promise.all(
          clipIds(word).map((id) =>
            limit(() => {
              if (done || generation !== gen) throw new Error("unneeded");
              return clipCache.get(id);
            })
          )
        );
        aheadCount += 1;
        job.parsedClips.catch(() => release(job)); // failure slides the bound
        jobs.push(job);
      }
    }

    /** Drop `job`'s reservation (it was taken into the block or failed)
     * and let the next word in, if it now fits. */
    function release(job) {
      if (job.released) return;
      job.released = true;
      aheadCount -= 1;
      admit();
    }

    const taken = [];
    const positions = [];
    const durations = new Map();
    const clips = new Map();

    try {
      for (let k = 0; ; k++) {
        if (generation !== gen) throw new Error("stale build");
        if (totalMs >= targetMs) break;
        admit(); // the bound allows another word here (totalMs < target)
        if (k >= jobs.length) break; // cycle queue exhausted
        const job = jobs[k];
        queue.shift(); // == job.word: consumed for this cycle either way
        cyclePos += 1;
        let parsed;
        try {
          parsed = await job.parsedClips;
        } catch {
          continue; // skip this word silently for this cycle
        }
        if (generation !== gen) throw new Error("stale build");
        const ids = clipIds(job.word);
        taken.push(job.word);
        positions.push(cyclePos);
        for (const [i, id] of ids.entries()) {
          clips.set(id, parsed[i]);
          durations.set(id, clipDuration(parsed[i].pcm, parsed[i].sampleRate));
        }
        // The word's duration comes from its actual sequence, so playlist.js
        // stays the single source of truth for the gaps.
        for (const segment of wordSequence(job.word)) {
          totalMs += segment.type === "gap" ? segment.ms : durations.get(segment.fileId);
        }
        release(job); // its reservation is now counted in totalMs
      }
    } finally {
      done = true; // fetches not yet started for untaken words never start
    }

    if (taken.length === 0) throw new Error("no block: every clip fetch failed");

    const plan = buildBlockPlan(taken, Infinity, durations);
    const { blob, offsetsMs, totalMs: plannedMs } = stitch(plan.segments, clips);
    return {
      blob,
      cues: plan.cues.map((cue, i) => ({ ...cue, position: positions[i] })),
      cueStarts: plan.cues.map((cue) => cue.startMs),
      segStarts: offsetsMs,
      totalMs: plannedMs,
    };
  }

  function prefetch() {
    nextPromise = buildBlock(blockTargetMs(blockIndex, blockMs)).catch(() => null);
  }

  /** Swap `block` into the audio element and (unless `play` is false)
   * start it, revoking the previous block's URL. */
  async function playBlock(block, { play = true } = {}) {
    const url = createUrl(block.blob);
    if (current) revokeUrl(current.url);
    current = { ...block, url };
    lastEmitKey = null;
    lastMetadataWord = null;
    audio.src = url;
    sync(0);
    if (!play) {
      setState("paused");
      return;
    }
    try {
      await audio.play();
      setState("playing");
    } catch {
      // Autoplay refused (iOS sometimes blocks an unattended block swap,
      // per the ADR-0006 contract). The block stays loaded and the lock
      // screen keeps our controls: one tap of play resumes here.
      setState("paused");
    }
  }

  /** Move to the next block: the prefetched one if it's ready, otherwise
   * build one now (one retry — a prefetch that failed on a network blip
   * may succeed later). */
  async function advance({ play }) {
    const gen = generation;
    const pending = nextPromise;
    nextPromise = null;
    setState("loading");
    let block = pending ? await pending : null;
    if (generation !== gen) return;
    // The failed prefetch never advanced blockIndex, so the retry rebuilds
    // with the same target.
    if (!block) block = await buildBlock(blockTargetMs(blockIndex, blockMs)).catch(() => null);
    if (generation !== gen) return;
    if (!block) {
      setState("error");
      return;
    }
    await playBlock(block, { play });
    blockIndex += 1;
    prefetch();
  }

  /** Quietly drop all playback state (no state emission — callers emit the
   * state that follows). Bumps the generation so in-flight builds abort. */
  function reset() {
    generation += 1;
    suppressEvents = true;
    audio.pause();
    audio.src = "";
    suppressEvents = false;
    if (current) revokeUrl(current.url);
    current = null;
    nextPromise = null;
    lastEmitKey = null;
    lastMetadataWord = null;
    if (mediaSession) {
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
      for (const action of ["play", "pause", "nexttrack"]) {
        mediaSession.setActionHandler(action, null);
      }
    }
  }

  /**
   * Begin continuous playback over `words`. Words missing any clip are
   * excluded (state becomes "empty" if nothing is listenable). Safe to call
   * again to restart with a fresh pool.
   */
  async function start(words) {
    reset();
    const gen = generation;
    pool = eligibleWords(words);
    if (pool.length === 0) {
      setState("empty");
      return;
    }
    queue = [];
    cyclePos = 0;
    blockIndex = 0; // every session ramps up from the one-word first block (#89)
    if (mediaSession) {
      mediaSession.setActionHandler("play", resume);
      mediaSession.setActionHandler("pause", pause);
      mediaSession.setActionHandler("nexttrack", skipWord);
    }
    setState("loading");
    const block = await buildBlock(blockTargetMs(0, blockMs)).catch(() => null);
    if (generation !== gen) return;
    if (!block) {
      setState("error");
      return;
    }
    await playBlock(block);
    blockIndex = 1;
    prefetch();
  }

  function pause() {
    if (!current) return;
    audio.pause();
    setState("paused");
  }

  /** Resume playback. Per the design, a clip interrupted mid-way restarts
   * from its beginning (clips are seconds long); pausing inside a silence
   * gap resumes in place. */
  async function resume() {
    if (!current || state !== "paused") return;
    const segment = indexAt(current.segStarts, audio.currentTime * 1000);
    if (SEGMENT_KINDS[segment % SEGMENT_KINDS.length]) {
      audio.currentTime = current.segStarts[segment] / 1000;
    }
    try {
      await audio.play();
      setState("playing");
    } catch {
      // Still blocked — stay paused; the UI keeps showing play.
    }
  }

  /** Jump to the next word: a seek within the block, or — from the block's
   * last word — a swap to the next block. Works while paused too (the
   * display updates; playback stays paused). */
  async function skipWord() {
    if (!current || state === "loading") return;
    const k = indexAt(current.cueStarts, audio.currentTime * 1000);
    if (k + 1 < current.cues.length) {
      const startMs = current.cues[k + 1].startMs;
      audio.currentTime = startMs / 1000;
      sync(startMs);
    } else {
      await advance({ play: state === "playing" });
    }
  }

  /** Stop playback and release everything (the UI's close action). The
   * clip cache stays warm for the next start(). */
  function stop() {
    reset();
    setState("idle");
  }

  return {
    start,
    pause,
    resume,
    skipWord,
    stop,
    onNowPlaying(cb) {
      nowPlayingCbs.add(cb);
      return () => nowPlayingCbs.delete(cb);
    },
    onStateChange(cb) {
      stateCbs.add(cb);
      return () => stateCbs.delete(cb);
    },
    state: () => state,
  };
}
