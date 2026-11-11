import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WavFormatError,
  parseWav,
  silence,
  clipDuration,
  stitch,
  createClipCache,
} from "../site/js/stitcher.js";
import { pcmToWav } from "../site/js/tts.js";
import { wordSequence, buildBlockPlan, GAP_MS } from "../site/js/playlist.js";

/** Int16Array with a recognizable ramp: value = seed + index. */
function ramp(length, seed = 0) {
  return Int16Array.from({ length }, (_, i) => seed + i);
}

function wavBuffer(pcm, sampleRate) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const wav = pcmToWav(bytes, sampleRate);
  // Copy so the returned ArrayBuffer is exactly the file, nothing more.
  return wav.slice().buffer;
}

// ------------------------------------------------------------------ parseWav

test("parseWav round-trips pcmToWav output", () => {
  const pcm = ramp(480, -100);
  const { pcm: parsed, sampleRate } = parseWav(wavBuffer(pcm, 24000));
  assert.equal(sampleRate, 24000);
  assert.deepEqual([...parsed], [...pcm]);
});

test("parseWav tolerates an extra chunk between fmt and data", () => {
  const base = new Uint8Array(wavBuffer(ramp(10), 24000));
  // Rebuild: RIFF header + fmt (bytes 12..36) + a LIST chunk + data chunk.
  const list = new Uint8Array([
    0x4c, 0x49, 0x53, 0x54, // "LIST"
    4, 0, 0, 0, // size 4
    1, 2, 3, 4, // payload
  ]);
  const out = new Uint8Array(base.length + list.length);
  out.set(base.subarray(0, 36), 0); // RIFF/WAVE + fmt chunk
  out.set(list, 36);
  out.set(base.subarray(36), 36 + list.length); // data chunk
  new DataView(out.buffer).setUint32(4, out.length - 8, true); // RIFF size
  const { pcm } = parseWav(out.buffer);
  assert.deepEqual([...pcm], [...ramp(10)]);
});

test("parseWav rejects non-WAV bytes", () => {
  assert.throws(() => parseWav(new ArrayBuffer(4)), WavFormatError);
  const notRiff = new Uint8Array(wavBuffer(ramp(4), 24000));
  notRiff[0] = 0x58; // "XIFF"
  assert.throws(() => parseWav(notRiff.buffer), WavFormatError);
});

function corrupt(pcm, sampleRate, patch) {
  const bytes = new Uint8Array(wavBuffer(pcm, sampleRate));
  patch(new DataView(bytes.buffer), bytes);
  return bytes.buffer;
}

test("parseWav rejects compressed, stereo, and non-16-bit WAVs", () => {
  const bad = [
    (view) => view.setUint16(20, 3, true), // format: IEEE float
    (view) => view.setUint16(22, 2, true), // stereo
    (view) => view.setUint16(34, 8, true), // 8-bit
  ];
  for (const patch of bad) {
    assert.throws(() => parseWav(corrupt(ramp(8), 24000, patch)), WavFormatError);
  }
});

test("parseWav rejects a data chunk that overruns the file", () => {
  const buffer = corrupt(ramp(8), 24000, (view) =>
    view.setUint32(40, 9999, true),
  );
  assert.throws(() => parseWav(buffer), WavFormatError);
});

test("parseWav rejects a WAV missing fmt or data", () => {
  // Just "RIFF....WAVE" with no chunks at all.
  const bare = new Uint8Array(wavBuffer(ramp(1), 24000)).subarray(0, 12);
  const copy = bare.slice();
  new DataView(copy.buffer).setUint32(4, 4, true);
  assert.throws(() => parseWav(copy.buffer), WavFormatError);
});

// ---------------------------------------------------- silence / clipDuration

test("silence is zero-filled and sample-exact", () => {
  const gap = silence(2000, 24000);
  assert.equal(gap.length, 48000);
  assert.ok(gap.every((s) => s === 0));
  assert.equal(silence(1, 24000).length, 24); // rounds, not truncates
  assert.equal(silence(1.5, 1000).length, 2);
});

test("clipDuration inverts sample math", () => {
  assert.equal(clipDuration(ramp(24000), 24000), 1000);
  assert.equal(clipDuration(silence(2000, 24000), 24000), 2000);
  assert.equal(clipDuration(ramp(12), 24000), 0.5);
});

// -------------------------------------------------------------------- stitch

const RATE = 1000; // 1 sample per ms — readable sample math in tests

function clip(length, seed) {
  return { pcm: ramp(length, seed), sampleRate: RATE };
}

test("stitch concatenates clips and gaps sample-exactly with cue offsets", async () => {
  const clips = new Map([
    ["a", clip(100, 1000)],
    ["b", clip(50, 2000)],
  ]);
  const segments = [
    { type: "clip", fileId: "a" },
    { type: "gap", ms: 30 },
    { type: "clip", fileId: "b" },
  ];
  const { blob, offsetsMs, totalMs } = stitch(segments, clips);

  assert.deepEqual(offsetsMs, [0, 100, 130]);
  assert.equal(totalMs, 180);
  assert.equal(blob.type, "audio/wav");

  const { pcm, sampleRate } = parseWav(await blob.arrayBuffer());
  assert.equal(sampleRate, RATE);
  assert.equal(pcm.length, 180);
  assert.deepEqual([...pcm.subarray(0, 100)], [...ramp(100, 1000)]);
  assert.ok(pcm.subarray(100, 130).every((s) => s === 0)); // the gap
  assert.deepEqual([...pcm.subarray(130)], [...ramp(50, 2000)]);
});

test("stitch rejects a plan referencing a clip it was not given", () => {
  assert.throws(
    () => stitch([{ type: "clip", fileId: "missing" }], new Map()),
    /missing clip/,
  );
});

test("stitch rejects mixed sample rates", () => {
  const clips = new Map([
    ["a", { pcm: ramp(10), sampleRate: 24000 }],
    ["b", { pcm: ramp(10), sampleRate: 16000 }],
  ]);
  const segments = [
    { type: "clip", fileId: "a" },
    { type: "clip", fileId: "b" },
  ];
  assert.throws(() => stitch(segments, clips), WavFormatError);
});

test("a planned block stitches with cues matching the plan", () => {
  // Two words with distinct clip lengths, planned by playlist.js.
  const word = (n) => ({
    audioWordEs: `${n}-we`,
    audioPhraseEs: `${n}-pe`,
    audioWordEn: `${n}-wn`,
    audioPhraseEn: `${n}-pn`,
  });
  const clips = new Map();
  const durations = new Map();
  for (const [i, w] of [word(1), word(2)].entries()) {
    for (const [j, id] of Object.values(w).entries()) {
      const pcm = ramp(100 * (j + 1) + i);
      clips.set(id, { pcm, sampleRate: RATE });
      durations.set(id, clipDuration(pcm, RATE));
    }
  }

  const plan = buildBlockPlan([word(1), word(2)], Infinity, durations);
  const { offsetsMs, totalMs } = stitch(plan.segments, clips);

  // Word k's actual start = offset of its first segment (6 segments/word).
  const segmentsPerWord = wordSequence(word(1)).length;
  for (const [k, cue] of plan.cues.entries()) {
    assert.equal(offsetsMs[k * segmentsPerWord], cue.startMs);
  }
  assert.equal(totalMs, plan.totalMs);
  // Sanity: the gaps the plan counts are the ones stitched (word 1:
  // 100 + gap + 200 + gap + 300 + 400).
  assert.equal(plan.cues[1].startMs, 1000 + 2 * GAP_MS);
});

// --------------------------------------------------------------- clip cache

function wavBlob(pcm, sampleRate = RATE) {
  return new Blob([new Uint8Array(wavBuffer(pcm, sampleRate))]);
}

test("clip cache fetches and parses each clip once", async () => {
  const fetched = [];
  const cache = createClipCache(async (fileId) => {
    fetched.push(fileId);
    return wavBlob(ramp(10, 7));
  });

  const [a1, a2] = await Promise.all([cache.get("a"), cache.get("a")]);
  await cache.get("a");
  assert.deepEqual(fetched, ["a"]); // concurrent + repeat gets share one fetch
  assert.equal(a1, a2);
  assert.deepEqual([...a1.pcm], [...ramp(10, 7)]);
  assert.equal(a1.sampleRate, RATE);

  await cache.get("b");
  assert.deepEqual(fetched, ["a", "b"]);
  assert.equal(cache.size(), 2);
});

test("clip cache does not cache failures", async () => {
  let calls = 0;
  const cache = createClipCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error("drive hiccup");
    return wavBlob(ramp(4));
  });

  await assert.rejects(cache.get("a"), /drive hiccup/);
  assert.equal(cache.size(), 0);
  const parsed = await cache.get("a"); // retried, now cached
  assert.equal(calls, 2);
  assert.deepEqual([...parsed.pcm], [...ramp(4)]);
  assert.equal(cache.size(), 1);
});
