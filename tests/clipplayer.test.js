import { test } from "node:test";
import assert from "node:assert/strict";

import { createClipPlayer, cardClipIds } from "../site/js/clipplayer.js";
import { pcmToWav } from "../site/js/tts.js";

// Fake clips use 1000 Hz like the stitcher/player tests; content is
// irrelevant here — the player only re-wraps what the cache parsed.
const RATE = 1000;

function wavBlob(ms = 100) {
  const pcm = new Int16Array(ms);
  return new Blob([pcmToWav(new Uint8Array(pcm.buffer), RATE)]);
}

/** Let promise chains (clip fetch → blob.arrayBuffer → parse) settle. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

class FakeAudio {
  constructor() {
    this.src = "";
    this.currentTime = 7; // non-zero: play() must restart from the top
    this.paused = true;
    this.plays = 0;
    this.pauses = 0;
    this.refusePlay = false; // simulates an autoplay refusal
  }
  async play() {
    if (this.refusePlay) throw new Error("NotAllowedError");
    this.plays += 1;
    this.paused = false;
  }
  pause() {
    this.pauses += 1;
    this.paused = true;
  }
}

/**
 * Player wired to fakes. `fail(fileId)` makes that clip's fetch throw;
 * `defer(fileId)` parks the fetch until the returned release function runs.
 */
function setup({ fail = () => false, defer = () => false } = {}) {
  const audio = new FakeAudio();
  const fetched = [];
  const revoked = [];
  const deferred = [];
  let urls = 0;

  const player = createClipPlayer({
    fetchClip: async (fileId) => {
      fetched.push(fileId);
      if (fail(fileId)) throw new Error("drive down");
      if (defer(fileId)) await new Promise((r) => deferred.push(r));
      return wavBlob();
    },
    audio,
    createUrl: () => `blob:${++urls}`,
    revokeUrl: (url) => revoked.push(url),
  });

  return { player, audio, fetched, revoked, release: () => deferred.shift()() };
}

// ------------------------------------------------------------- preload set

test("cardClipIds: enriched word yields word + phrase clips", () => {
  const ids = cardClipIds({ audioWordEs: "w1", audioPhraseEs: "p1" });
  assert.deepEqual(ids, ["w1", "p1"]);
});

test("cardClipIds: hand-added row without clips yields nothing", () => {
  assert.deepEqual(cardClipIds({ audioWordEs: null, audioPhraseEs: null }), []);
  assert.deepEqual(cardClipIds({}), []);
});

test("cardClipIds: a partially enriched word yields only what exists", () => {
  assert.deepEqual(cardClipIds({ audioWordEs: "w1", audioPhraseEs: null }), ["w1"]);
});

// ---------------------------------------------------- clip vs fallback taps

test("play without a fileId reports fallback and never touches audio", async () => {
  const t = setup();
  assert.equal(await t.player.play(null), false);
  assert.equal(await t.player.play(undefined), false);
  assert.deepEqual(t.fetched, []);
  assert.equal(t.audio.plays, 0);
});

test("play fetches the clip, loads a blob URL, and starts playback", async () => {
  const t = setup();
  assert.equal(await t.player.play("w1"), true);
  assert.deepEqual(t.fetched, ["w1"]);
  assert.equal(t.audio.src, "blob:1");
  assert.equal(t.audio.currentTime, 0); // from the top
  assert.equal(t.audio.plays, 1);
});

test("fetch failure reports fallback; the next tap retries and recovers", async () => {
  let down = true;
  const t = setup({ fail: () => down });
  assert.equal(await t.player.play("w1"), false);
  assert.equal(t.audio.plays, 0);

  down = false; // the cache dropped the failure, so this tap refetches
  assert.equal(await t.player.play("w1"), true);
  assert.deepEqual(t.fetched, ["w1", "w1"]);
  assert.equal(t.audio.plays, 1);
});

test("refused playback (autoplay) reports fallback", async () => {
  const t = setup();
  t.audio.refusePlay = true;
  assert.equal(await t.player.play("w1"), false);
});

// -------------------------------------------------------- cache and re-taps

test("re-tapping the same clip restarts it without refetching or new URLs", async () => {
  const t = setup();
  await t.player.play("w1");
  t.audio.currentTime = 0.05; // mid-clip

  assert.equal(await t.player.play("w1"), true);
  assert.deepEqual(t.fetched, ["w1"]); // cached (#39)
  assert.equal(t.audio.src, "blob:1"); // same URL, nothing revoked
  assert.deepEqual(t.revoked, []);
  assert.equal(t.audio.currentTime, 0); // restarted from the top
  assert.equal(t.audio.plays, 2);
});

test("switching clips revokes the replaced object URL", async () => {
  const t = setup();
  await t.player.play("w1");
  await t.player.play("p1");
  assert.equal(t.audio.src, "blob:2");
  assert.deepEqual(t.revoked, ["blob:1"]);
});

// ------------------------------------------------------------------ preload

test("preload warms the cache so the first tap needs no fetch", async () => {
  const t = setup();
  t.player.preload(["w1", "p1"]);
  await settle();
  assert.deepEqual(t.fetched, ["w1", "p1"]);
  assert.equal(t.audio.plays, 0); // preload never plays anything

  await t.player.play("w1");
  assert.deepEqual(t.fetched, ["w1", "p1"]); // no refetch on tap
});

test("preload skips missing IDs and swallows fetch failures", async () => {
  const t = setup({ fail: (id) => id === "p1" });
  t.player.preload([null, "p1", undefined]);
  await settle(); // must not unhandled-reject
  assert.deepEqual(t.fetched, ["p1"]);
});

// ------------------------------------------------------- superseded plays

test("a newer tap wins over a slow one, which never reports fallback", async () => {
  const t = setup({ defer: (id) => id === "slow" });
  const first = t.player.play("slow");
  const second = await t.player.play("fast");
  assert.equal(second, true);
  assert.equal(t.audio.src, "blob:1"); // fast's URL

  t.release();
  assert.equal(await first, true); // superseded — no Web Speech fallback
  assert.equal(t.audio.src, "blob:1"); // slow never swapped the source
  assert.equal(t.audio.plays, 1);
});

test("stop pauses playback and cancels a pending play", async () => {
  const t = setup({ defer: (id) => id === "slow" });
  const pending = t.player.play("slow");
  t.player.stop();
  assert.equal(t.audio.pauses, 1);

  t.release();
  assert.equal(await pending, true); // cancelled, not a fallback
  assert.equal(t.audio.src, "");
  assert.equal(t.audio.plays, 0);
});
