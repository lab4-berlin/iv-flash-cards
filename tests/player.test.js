import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlayer } from "../site/js/player.js";
import { pcmToWav } from "../site/js/tts.js";

// All fake clips use 1000 Hz (1 sample = 1 ms) for readable time math,
// like the stitcher tests. Every clip is CLIP_MS long, so one word is
// 4 × CLIP_MS + 7000 ms of gaps (#81 sequence) = 31000 ms. Block 1 of a
// session is a single word (#89 ramp: 1 ms target), block 2 targets 60 s
// and takes exactly two words (31000 < 60000 → take another →
// 62000 ≥ 60000) — so with the default 3-word pool, block 1 holds word 1
// and block 2 holds words 2–3, the cycle's end.
const RATE = 1000;
const CLIP_MS = 6000;
const WORD_MS = 4 * CLIP_MS + 7000;

/** Let promise chains (clip fetch → blob.arrayBuffer → parse) settle.
 * Generous: a prefetched 5-minute block pipelines many words. */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

class FakeAudio {
  constructor() {
    this.listeners = new Map();
    this.src = "";
    this.currentTime = 0;
    this.paused = true;
    this.ended = false;
    this.plays = 0;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  dispatch(type) {
    return Promise.all((this.listeners.get(type) ?? []).map((fn) => fn()));
  }
  async play() {
    this.plays += 1;
    this.paused = false;
    this.ended = false;
    await this.dispatch("play");
  }
  pause() {
    this.paused = true;
    this.dispatch("pause");
  }
  /** Simulate playback reaching `seconds` (fires timeupdate). */
  async playTo(seconds) {
    this.currentTime = seconds;
    await this.dispatch("timeupdate");
  }
  /** Simulate the block finishing (browsers fire pause, then ended). */
  async end() {
    this.ended = true;
    this.paused = true;
    await this.dispatch("pause");
    await this.dispatch("ended");
  }
}

function word(n) {
  return {
    word: `es${n}`,
    translation: `en${n}`,
    audioWordEs: `${n}-we`,
    audioPhraseEs: `${n}-pe`,
    audioWordEn: `${n}-wn`,
    audioPhraseEn: `${n}-pn`,
  };
}

function wavBlob(ms) {
  const pcm = new Int16Array(ms); // 1 sample per ms at RATE
  return new Blob([pcmToWav(new Uint8Array(pcm.buffer), RATE)]);
}

/**
 * Player wired to fakes. `fail(fileId)` makes that clip's fetch throw;
 * `fetchTicks` makes every fetch take that many macrotask ticks, so
 * fetches overlap and `concurrency.peak` records the in-flight maximum.
 * random always returns ~1, so shuffle keeps the original order.
 */
function setup({ poolSize = 3, blockMs = 8000, fail = () => false, fetchTicks = 0 } = {}) {
  const audio = new FakeAudio();
  const mediaSession = {
    metadata: null,
    playbackState: "none",
    handlers: new Map(),
    setActionHandler(type, fn) {
      this.handlers.set(type, fn);
    },
  };
  const fetched = [];
  const revoked = [];
  let urls = 0;
  const pool = Array.from({ length: poolSize }, (_, i) => word(i + 1));
  const states = [];
  const playing = [];
  let inFlight = 0;
  const concurrency = { peak: 0 };

  const player = createPlayer({
    fetchClip: async (fileId) => {
      fetched.push(fileId);
      if (fail(fileId)) throw new Error("drive down");
      inFlight += 1;
      concurrency.peak = Math.max(concurrency.peak, inFlight);
      for (let i = 0; i < fetchTicks; i++) await new Promise((r) => setImmediate(r));
      inFlight -= 1;
      return wavBlob(CLIP_MS);
    },
    audio,
    mediaSession,
    createUrl: () => `blob:${++urls}`,
    revokeUrl: (url) => revoked.push(url),
    random: () => 0.9999999,
    blockMs,
  });
  player.onStateChange((s) => states.push(s));
  player.onNowPlaying((np) => playing.push(np));

  return { player, audio, mediaSession, fetched, revoked, pool, states, playing, concurrency };
}

// ------------------------------------------------------------------- startup

test("start with nothing listenable goes to empty without touching audio", async () => {
  const t = setup();
  await t.player.start([{ word: "no-clips" }, { ...word(1), audioWordEn: null }]);
  assert.deepEqual(t.states, ["empty"]);
  assert.equal(t.audio.plays, 0);
  assert.equal(t.player.state(), "empty");
});

test("start plays the first block and prefetches the next", async () => {
  const t = setup();
  await t.player.start(t.pool);

  assert.deepEqual(t.states, ["loading", "playing"]);
  assert.equal(t.audio.src, "blob:1");
  assert.equal(t.audio.plays, 1);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[0],
    clip: "word_es",
    position: 1,
    cycleSize: 3,
  });
  assert.deepEqual(t.mediaSession.metadata, { title: "es1", artist: "en1" });
  assert.equal(t.mediaSession.playbackState, "playing");
  for (const action of ["play", "pause", "nexttrack"]) {
    assert.equal(typeof t.mediaSession.handlers.get(action), "function");
  }

  // Block 1 = word 1; block 2 (60 s target: words 2+3) builds in the
  // background once block 1 plays.
  await settle();
  assert.ok(t.fetched.includes("2-we"));
  assert.ok(t.fetched.includes("3-we"));
  // Exactly the two blocks' words were fetched — nothing ahead of need.
  assert.equal(t.fetched.length, 12);
});

test("cold start issues exactly the first word's 4 fetches before play (#89)", async () => {
  // Plenty of queued words and slow fetches: without the #89 bound the
  // 6-slot limiter would already have started word 2's clips.
  const t = setup({ poolSize: 15, fetchTicks: 3 });
  let fetchedAtFirstPlay = null;
  const play = t.audio.play.bind(t.audio);
  t.audio.play = async () => {
    fetchedAtFirstPlay ??= [...t.fetched];
    return play();
  };
  await t.player.start(t.pool);

  assert.deepEqual(fetchedAtFirstPlay.sort(), ["1-pe", "1-pn", "1-we", "1-wn"]);
  assert.equal(t.audio.src, "blob:1");
  assert.equal(t.player.state(), "playing");
});

// --------------------------------------------------------------- now playing

test("timeupdate drives now-playing and MediaSession metadata", async () => {
  const t = setup();
  await t.player.start(t.pool);

  // Word 1 segments (s): word_es 0–6, gap –8, word_en –14, gap –15,
  // phrase_es –21, gap –23, phrase_en –29, gap –31; word 2 starts at 31.
  await t.audio.playTo(6.5);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[0],
    clip: null, // the recall pause
    position: 1,
    cycleSize: 3,
  });

  await t.audio.playTo(8.5);
  assert.equal(t.playing.at(-1).clip, "word_en");
  await t.audio.playTo(15.5);
  assert.equal(t.playing.at(-1).clip, "phrase_es");
  await t.audio.playTo(23.5);
  assert.equal(t.playing.at(-1).clip, "phrase_en");
  // Metadata holds the same word through the whole 8-segment sequence.
  assert.deepEqual(t.mediaSession.metadata, { title: "es1", artist: "en1" });

  // Word 2 arrives with block 2 (the one-word first block holds word 1 only).
  await settle();
  await t.audio.end();
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[1],
    clip: "word_es",
    position: 2,
    cycleSize: 3,
  });
  assert.deepEqual(t.mediaSession.metadata, { title: "es2", artist: "en2" });

  // No duplicate emissions while staying inside one segment.
  const emissions = t.playing.length;
  await t.audio.playTo(0.5); // still inside word 2's word_es (0–6 s)
  assert.equal(t.playing.length, emissions);
});

test("now-playing walks all 8 segments of a word in the #81 order", async () => {
  const t = setup();
  await t.player.start(t.pool);

  const seen = [];
  // One probe inside each of word 1's eight segments (see timeline above).
  for (const s of [0.5, 6.5, 8.5, 14.5, 15.5, 21.5, 23.5, 29.5]) {
    await t.audio.playTo(s);
    seen.push(t.playing.at(-1).clip);
  }
  assert.deepEqual(seen, [
    "word_es",
    null,
    "word_en",
    null,
    "phrase_es",
    null,
    "phrase_en",
    null,
  ]);
});

// ------------------------------------------------- block chaining & looping

test("ended swaps to the prefetched block, revokes the old URL, loops the cycle", async () => {
  const t = setup();
  await t.player.start(t.pool);
  await settle(); // block 2 (words 2–3, cycle end) prefetched

  // Word 1 was consumed by block 1: block 2 continues at position 2, it
  // does not replay the first word.
  await t.audio.end();
  assert.equal(t.audio.src, "blob:2");
  assert.deepEqual(t.revoked, ["blob:1"]);
  assert.equal(t.audio.plays, 2);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[1],
    clip: "word_es",
    position: 2,
    cycleSize: 3,
  });
  assert.equal(t.player.state(), "playing");

  // Block 3 starts a fresh shuffled cycle: positions restart at 1.
  await settle();
  await t.audio.end();
  assert.equal(t.audio.src, "blob:3");
  assert.deepEqual(t.revoked, ["blob:1", "blob:2"]);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[0],
    clip: "word_es",
    position: 1,
    cycleSize: 3,
  });
});

// ----------------------------------------------------------------- skipWord

test("skipWord seeks to the next word's cue within the block", async () => {
  const t = setup();
  await t.player.start(t.pool);
  await settle();
  await t.audio.end(); // into block 2: words 2 and 3
  const plays = t.audio.plays;

  t.audio.currentTime = 15.5; // inside word 2's phrase_es
  await t.player.skipWord();
  assert.equal(t.audio.currentTime, WORD_MS / 1000); // word 3's cue
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[2],
    clip: "word_es",
    position: 3,
    cycleSize: 3,
  });
  assert.equal(t.audio.plays, plays); // a seek, not a restart
});

test("skipWord at the block's last word starts the next block", async () => {
  const t = setup();
  await t.player.start(t.pool);
  await settle();

  t.audio.currentTime = 15.0; // inside word 1, the one-word block's only cue
  await t.player.skipWord();
  assert.equal(t.audio.src, "blob:2");
  assert.equal(t.playing.at(-1).word, t.pool[1]);
  assert.equal(t.player.state(), "playing");
});

// ------------------------------------------------------------- pause/resume

test("pause freezes; resume restarts the interrupted clip from its start", async () => {
  const t = setup();
  await t.player.start(t.pool);

  await t.audio.playTo(8.5); // mid word_en (8–14 s)
  t.player.pause();
  assert.equal(t.player.state(), "paused");
  assert.equal(t.mediaSession.playbackState, "paused");
  assert.ok(t.audio.paused);

  await t.player.resume();
  assert.equal(t.audio.currentTime, 8.0); // snapped back to the clip start
  assert.equal(t.player.state(), "playing");

  // Pausing inside a silence gap resumes in place.
  await t.audio.playTo(6.5);
  t.player.pause();
  await t.player.resume();
  assert.equal(t.audio.currentTime, 6.5);
});

test("MediaSession action handlers drive the player", async () => {
  const t = setup();
  await t.player.start(t.pool);
  const handler = (a) => t.mediaSession.handlers.get(a);

  handler("pause")();
  assert.equal(t.player.state(), "paused");
  await handler("play")();
  assert.equal(t.player.state(), "playing");
  await handler("nexttrack")();
  assert.equal(t.playing.at(-1).word, t.pool[1]);
  assert.equal(t.playing.at(-1).clip, "word_es"); // lands on the word's start
});

// ---------------------------------------- ramp-up block schedule (#82/#89)

test("block targets ramp 1 word → 60 s → 5 min → steady across the session", async () => {
  // 15 words of 31 s each, steady target injected as one word. Block 1
  // (1 ms) = word 1; block 2 (60 s) = words 2–3; block 3 (5 min) = words
  // 4–13 (9 × 31 s < 300 s, the 10th crosses it); block 4 (steady) =
  // word 14.
  const t = setup({ poolSize: 15, blockMs: WORD_MS });
  await t.player.start(t.pool);
  assert.equal(t.playing.at(-1).position, 1);

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 2, "first block held exactly 1 word");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 4, "60 s block held exactly 2 words");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 14, "5-min block held exactly 10 words");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 15, "steady block held one 31 s word");
});

test("a fresh start() resets the ramp to the one-word first block", async () => {
  const t = setup({ poolSize: 15, blockMs: WORD_MS });
  await t.player.start(t.pool);
  await settle();
  await t.audio.end(); // into block 2 — the session is past the 1-word target
  assert.equal(t.playing.at(-1).position, 2);

  await t.player.start(t.pool); // new session, same player
  assert.equal(t.playing.at(-1).position, 1);
  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 2, "first block is one word again");
});

test("skipWord from a block's last word advances with the correct next target", async () => {
  const t = setup({ poolSize: 15, blockMs: WORD_MS });
  await t.player.start(t.pool);
  await settle(); // block 2 prefetched

  t.audio.currentTime = 15.0; // inside word 1, the one-word block's only cue
  await t.player.skipWord();
  assert.equal(t.playing.at(-1).position, 2);
  assert.equal(t.player.state(), "playing");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 4, "the skipped-to block used the 60 s target");
});

test("clip fetches pipeline across words, capped at 6 in flight", async () => {
  // Overlapping fetches (3 ticks each): the 60 s block 2 alone needs 8
  // clips, so the limiter fills — but never exceeds — its 6 slots.
  const t = setup({ poolSize: 15, blockMs: WORD_MS, fetchTicks: 3 });
  await t.player.start(t.pool);
  await settle(); // block 2 (words 2–3) prefetched through the cap
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 2, "pipelining kept queue order");

  await settle(); // the 10-word block-3 prefetch (40 clips) runs through too
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 4);
  assert.equal(t.concurrency.peak, 6, "cap held during the big prefetch");
});

// ------------------------------------------------------------ failure modes

test("a word whose clip fetch fails is skipped silently", async () => {
  const t = setup({ fail: (id) => id.startsWith("2-") });
  await t.player.start(t.pool);
  assert.equal(t.player.state(), "playing");

  // Block 2 (60 s target) skips word 2 and holds word 3 alone (position 3,
  // the cycle counter not disturbed by the failure); no error surfaced.
  await settle();
  await t.audio.end();
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[2],
    clip: "word_es",
    position: 3,
    cycleSize: 3,
  });
  assert.ok(!t.states.includes("error"));
});

test("a failing first word slides the one-word block to the next word (#89)", async () => {
  const t = setup({ fail: (id) => id.startsWith("1-"), fetchTicks: 3 });
  await t.player.start(t.pool);

  // Word 1's fetch failure released its pipeline slot: word 2 was fetched
  // and became the one-word first block. Still no error.
  assert.equal(t.player.state(), "playing");
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[1],
    clip: "word_es",
    position: 2,
    cycleSize: 3,
  });
  assert.ok(!t.states.includes("error"));
});

test("start surfaces error when no block can be built at all", async () => {
  // Every word fails: even the one-word first block walks the whole cycle
  // and then reports the error state.
  const t = setup({ fail: () => true });
  await t.player.start(t.pool);
  assert.deepEqual(t.states, ["loading", "error"]);
  assert.equal(t.audio.plays, 0);
});

test("a failed prefetch is retried when the block boundary arrives", async () => {
  let down = true;
  const t = setup({ fail: (id) => down && !id.startsWith("1-") });
  await t.player.start(t.pool);
  await settle(); // prefetch of block 2 (words 2–3) fails entirely

  down = false; // network back
  await t.audio.end();
  assert.equal(t.audio.src, "blob:2");
  assert.equal(t.player.state(), "playing");
  // The failed cycle moved on; the rebuilt block starts the next cycle.
  assert.equal(t.playing.at(-1).position, 1);
});

test("autoplay refusal leaves the block loaded and paused", async () => {
  const t = setup();
  t.audio.play = async () => {
    throw new Error("NotAllowedError");
  };
  await t.player.start(t.pool);
  assert.deepEqual(t.states, ["loading", "paused"]);
  assert.equal(t.audio.src, "blob:1");
  assert.deepEqual(t.playing.at(-1).word, t.pool[0]);
});

// --------------------------------------------------------------------- stop

test("stop releases the block, clears MediaSession, and goes idle", async () => {
  const t = setup();
  await t.player.start(t.pool);

  t.player.stop();
  assert.equal(t.player.state(), "idle");
  assert.ok(t.audio.paused);
  assert.equal(t.audio.src, "");
  assert.deepEqual(t.revoked, ["blob:1"]);
  assert.equal(t.mediaSession.metadata, null);
  assert.equal(t.mediaSession.playbackState, "none");
  assert.equal(t.mediaSession.handlers.get("nexttrack"), null);
  // No stray "paused" emission from the internal audio.pause().
  assert.deepEqual(t.states, ["loading", "playing", "idle"]);
});

test("start after stop plays again from a fresh pool", async () => {
  const t = setup();
  await t.player.start(t.pool);
  t.player.stop();
  await t.player.start(t.pool);
  assert.equal(t.player.state(), "playing");
  assert.equal(t.audio.src, "blob:2");
  assert.equal(t.playing.at(-1).position, 1);
});
