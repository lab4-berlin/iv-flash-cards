import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlayer } from "../site/js/player.js";
import { pcmToWav } from "../site/js/tts.js";

// All fake clips use 1000 Hz (1 sample = 1 ms) for readable time math,
// like the stitcher tests. Every clip is CLIP_MS long, so one word is
// 4 × CLIP_MS + 2 × GAP_MS = 4400 ms, and with blockMs = 5000 a block
// takes exactly two words (4400 < 5000 → take another → 8800 ≥ 5000).
const RATE = 1000;
const CLIP_MS = 100;
const WORD_MS = 4 * CLIP_MS + 2 * 2000;

/** Let promise chains (clip fetch → blob.arrayBuffer → parse) settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
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
 * Player wired to fakes. `fail(fileId)` makes that clip's fetch throw.
 * random always returns ~1, so shuffle keeps the original order.
 */
function setup({ poolSize = 3, blockMs = 5000, fail = () => false } = {}) {
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

  const player = createPlayer({
    fetchClip: async (fileId) => {
      fetched.push(fileId);
      if (fail(fileId)) throw new Error("drive down");
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

  return { player, audio, mediaSession, fetched, revoked, pool, states, playing };
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

  // Word 1 segments: word_es 0–100, gap –2100, phrase_es –2200, gap –4200,
  // word_en –4300, phrase_en –4400; word 2 starts at 4400.
  await t.audio.playTo(0.15);
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[0],
    clip: null, // the gap
    position: 1,
    cycleSize: 3,
  });

  await t.audio.playTo(2.15);
  assert.equal(t.playing.at(-1).clip, "phrase_es");

  await t.audio.playTo(4.45); // word 2's word_es clip (4400–4500)
  assert.deepEqual(t.playing.at(-1), {
    word: t.pool[1],
    clip: "word_es",
    position: 2,
    cycleSize: 3,
  });
  assert.deepEqual(t.mediaSession.metadata, { title: "es2", artist: "en2" });

  // No duplicate emissions while staying inside one segment.
  const emissions = t.playing.length;
  await t.audio.playTo(4.46);
  assert.equal(t.playing.length, emissions);
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

  t.audio.currentTime = 2.15; // inside word 1's phrase_es
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

  t.audio.currentTime = 5.0; // inside word 2, the block's last cue
  await t.player.skipWord();
  assert.equal(t.audio.src, "blob:2");
  assert.equal(t.playing.at(-1).word, t.pool[2]);
  assert.equal(t.player.state(), "playing");
});

// ------------------------------------------------------------- pause/resume

test("pause freezes; resume restarts the interrupted clip from its start", async () => {
  const t = setup();
  await t.player.start(t.pool);

  await t.audio.playTo(2.15); // mid phrase_es (2100–2200)
  t.player.pause();
  assert.equal(t.player.state(), "paused");
  assert.equal(t.mediaSession.playbackState, "paused");
  assert.ok(t.audio.paused);

  await t.player.resume();
  assert.equal(t.audio.currentTime, 2.1); // snapped back to the clip start
  assert.equal(t.player.state(), "playing");

  // Pausing inside a silence gap resumes in place.
  await t.audio.playTo(1.0);
  t.player.pause();
  await t.player.resume();
  assert.equal(t.audio.currentTime, 1.0);
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
