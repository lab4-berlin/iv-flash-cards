import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlayer } from "../site/js/player.js";
import { pcmToWav } from "../site/js/tts.js";

// All fake clips use 1000 Hz (1 sample = 1 ms) for readable time math,
// like the stitcher tests. Every clip is CLIP_MS long, so one word is
// 4 × CLIP_MS + 7000 ms of gaps (#81 sequence) = 31000 ms. Block 1 of a
// session targets 60 s (#82 ramp) and therefore takes exactly two words
// (31000 < 60000 → take another → 62000 ≥ 60000); with the default
// 3-word pool, block 2 (5-minute target) holds just word 3, the cycle's
// end — the same two-then-one block shape the suite always used.
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

  // Block 1 = words 1+2; block 2 (word 3) builds in the background.
  await settle();
  assert.ok(t.fetched.includes("3-we"));
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

  await t.audio.playTo(31.5); // word 2's word_es clip (31–37 s)
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[1],
    clip: "word_es",
    position: 2,
    cycleSize: 3,
  });
  assert.deepEqual(t.mediaSession.metadata, { title: "es2", artist: "en2" });

  // No duplicate emissions while staying inside one segment.
  const emissions = t.playing.length;
  await t.audio.playTo(31.6);
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
  await settle(); // block 2 (word 3, cycle end) prefetched

  await t.audio.end();
  assert.equal(t.audio.src, "blob:2");
  assert.deepEqual(t.revoked, ["blob:1"]);
  assert.equal(t.audio.plays, 2);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[2],
    clip: "word_es",
    position: 3,
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

  t.audio.currentTime = 15.5; // inside word 1's phrase_es
  await t.player.skipWord();
  assert.equal(t.audio.currentTime, WORD_MS / 1000); // word 2's cue
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[1],
    clip: "word_es",
    position: 2,
    cycleSize: 3,
  });
  assert.equal(t.audio.plays, 1); // a seek, not a restart
});

test("skipWord at the block's last word starts the next block", async () => {
  const t = setup();
  await t.player.start(t.pool);
  await settle();

  t.audio.currentTime = 35.0; // inside word 2, the block's last cue
  await t.player.skipWord();
  assert.equal(t.audio.src, "blob:2");
  assert.equal(t.playing.at(-1).word, t.pool[2]);
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

// --------------------------------------------- ramp-up block schedule (#82)

test("block targets ramp 60 s → 5 min → steady across start → advance → advance", async () => {
  // 15 words of 31 s each, steady target injected as one word. Block 1
  // (60 s) = words 1–2; block 2 (5 min) = words 3–12 (9 × 31 s < 300 s, the
  // 10th crosses it); block 3 (steady) = word 13.
  const t = setup({ poolSize: 15, blockMs: WORD_MS });
  await t.player.start(t.pool);
  assert.equal(t.playing.at(-1).position, 1);

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 3, "60 s block held exactly 2 words");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 13, "5-min block held exactly 10 words");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 14, "steady block held one 31 s word");
});

test("a fresh start() resets the ramp to the small first block", async () => {
  const t = setup({ poolSize: 15, blockMs: WORD_MS });
  await t.player.start(t.pool);
  await settle();
  await t.audio.end(); // into block 2 — the session is past the 60 s target
  assert.equal(t.playing.at(-1).position, 3);

  await t.player.start(t.pool); // new session, same player
  assert.equal(t.playing.at(-1).position, 1);
  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 3, "first block is the 60 s one again");
});

test("skipWord from a block's last word advances with the correct next target", async () => {
  const t = setup({ poolSize: 15, blockMs: WORD_MS });
  await t.player.start(t.pool);
  await settle(); // block 2 prefetched

  t.audio.currentTime = 35.0; // inside word 2, the 60 s block's last cue
  await t.player.skipWord();
  assert.equal(t.playing.at(-1).position, 3);
  assert.equal(t.player.state(), "playing");

  await settle();
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 13, "the skipped-to block used the 5-min target");
});

test("clip fetches pipeline across words, capped at 6 in flight", async () => {
  // Overlapping fetches (3 ticks each): the 60 s first block alone needs 8
  // clips, so the limiter fills — but never exceeds — its 6 slots.
  const t = setup({ poolSize: 15, blockMs: WORD_MS, fetchTicks: 3 });
  await t.player.start(t.pool);
  assert.equal(t.concurrency.peak, 6);

  await settle(); // the 10-word block-2 prefetch (40 clips) runs through too
  await t.audio.end();
  assert.equal(t.playing.at(-1).position, 3, "pipelining kept queue order");
  assert.equal(t.concurrency.peak, 6, "cap held during the big prefetch");
});

// ------------------------------------------------------------ failure modes

test("a word whose clip fetch fails is skipped silently", async () => {
  const t = setup({ fail: (id) => id.startsWith("2-") });
  await t.player.start(t.pool);

  // Block 1 holds words 1 and 3 (positions 1 and 3); no error surfaced.
  assert.equal(t.player.state(), "playing");
  await t.audio.playTo(WORD_MS / 1000);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[2],
    clip: "word_es",
    position: 3,
    cycleSize: 3,
  });
  assert.ok(!t.states.includes("error"));
});

test("start surfaces error when no block can be built at all", async () => {
  const t = setup({ fail: () => true });
  await t.player.start(t.pool);
  assert.deepEqual(t.states, ["loading", "error"]);
  assert.equal(t.audio.plays, 0);
});

test("a failed prefetch is retried when the block boundary arrives", async () => {
  let down = true;
  const t = setup({ fail: (id) => down && id.startsWith("3-") });
  await t.player.start(t.pool);
  await settle(); // prefetch of block 2 (word 3 alone) fails entirely

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
