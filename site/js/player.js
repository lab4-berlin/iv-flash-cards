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
  buildBlockPlan,
  GAP_MS,
  DEFAULT_BLOCK_MS,
} from "./playlist.js";
import { stitch, clipDuration, createClipCache } from "./stitcher.js";

/**
 * What plays at each index of playlist.js's fixed 6-segment word sequence
 * (`null` = silence gap). Kind names match drive.js's clip kinds; the UI
 * maps them to the word's text fields for the now-playing line.
 */
const SEGMENT_KINDS = ["word_es", null, "phrase_es", null, "word_en", "phrase_en"];

// Player states, in the design's terms (design/listening-mode.md):
// idle → loading → playing ⇄ paused, plus empty (nothing listenable) and
// error (a block could not be built at all, e.g. offline).

function clipIds(word) {
  return [word.audioWordEs, word.audioPhraseEs, word.audioWordEn, word.audioPhraseEn];
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
 * @returns {{
 *   start: (words: object[]) => Promise<void>,
 *   pause: () => void,
 *   resume: () => Promise<void>,
 *   skipWord: () => Promise<void>,
 *   stop: () => void,
 *   onNowPlaying: (cb: (np: {word: object, clip: string|null,
 *     position: number, cycleSize: number}) => void) => () => void,
 *   onStateChange: (cb: (state: string) => void) => () => void,
 *   state: () => string,
 * }} `clip` in the now-playing payload is one of SEGMENT_KINDS (null during
 *   gaps); `position`/`cycleSize` drive the "12 / 87" cycle counter.
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
    const segment = indexAt(current.segStarts, ms);
    const clip = SEGMENT_KINDS[segment % SEGMENT_KINDS.length];
    const key = `${k}:${clip}`;
    if (key === lastEmitKey) return;
    lastEmitKey = key;
    for (const cb of nowPlayingCbs) {
      cb({ word: cue.word, clip, position: cue.position, cycleSize: pool.length });
    }
  }

  /**
   * Build the next block: take whole words off the cycle queue until the
   * block is long enough or the cycle ends (a block never spans a
   * reshuffle), fetch their clips, and stitch. A word whose clips cannot be
   * fetched is skipped silently — never a gap or an error (#29); the cache
   * does not keep failures, so the word gets retried next cycle. Throws
   * only if not a single word could be built (e.g. offline).
   */
  async function buildBlock() {
    const gen = generation;
    if (queue.length === 0) {
      queue = shuffle(pool, random); // pool exhausted → new cycle (#29)
      cyclePos = 0;
    }
    const taken = [];
    const positions = [];
    const durations = new Map();
    const clips = new Map();
    let totalMs = 0;

    while (queue.length > 0 && totalMs < blockMs) {
      const word = queue.shift();
      cyclePos += 1;
      const ids = clipIds(word);
      let parsed;
      try {
        parsed = await Promise.all(ids.map((id) => clipCache.get(id)));
      } catch {
        continue; // skip this word silently for this cycle
      }
      if (generation !== gen) throw new Error("stale build");
      taken.push(word);
      positions.push(cyclePos);
      for (const [i, id] of ids.entries()) {
        clips.set(id, parsed[i]);
        durations.set(id, clipDuration(parsed[i].pcm, parsed[i].sampleRate));
        totalMs += durations.get(id);
      }
      totalMs += 2 * GAP_MS;
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
    nextPromise = buildBlock().catch(() => null);
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
    if (!block) block = await buildBlock().catch(() => null);
    if (generation !== gen) return;
    if (!block) {
      setState("error");
      return;
    }
    await playBlock(block, { play });
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
    if (mediaSession) {
      mediaSession.setActionHandler("play", resume);
      mediaSession.setActionHandler("pause", pause);
      mediaSession.setActionHandler("nexttrack", skipWord);
    }
    setState("loading");
    const block = await buildBlock().catch(() => null);
    if (generation !== gen) return;
    if (!block) {
      setState("error");
      return;
    }
    await playBlock(block);
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
