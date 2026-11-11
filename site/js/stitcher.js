// PCM stitcher: clips + silence gaps → one playable WAV block (issue #39,
// ADR-0006).
//
// All clips are 24 kHz 16-bit mono PCM (ADR-0005, produced by tts.js), so a
// block is plain Int16Array concatenation — no encoding. The playlist module
// plans a block as segments ({type:"clip"|"gap"}); this module renders that
// plan into a Blob for one <audio> element, plus the sample-exact start
// offset of every segment (the player reads word cues from these).
//
// Everything except the clip cache is pure math — no DOM, no network — and
// unit-tested under Node.

import { pcmToWav, SAMPLE_RATE } from "./tts.js";

/** A WAV that is not what we produce/expect (24 kHz 16-bit mono PCM aside,
 * any valid RIFF/WAVE with PCM mono 16-bit parses; everything else throws
 * this). */
export class WavFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = "WavFormatError";
  }
}

/**
 * Parse a WAV file into its samples.
 *
 * Accepts what pcmToWav produces (44-byte header) and, more generally, any
 * RIFF/WAVE with extra chunks around `fmt `/`data` — but strictly 16-bit
 * mono uncompressed PCM; anything else throws {@link WavFormatError}.
 *
 * @param {ArrayBuffer} arrayBuffer the file's bytes (e.g. from
 *   `blob.arrayBuffer()`)
 * @returns {{pcm: Int16Array, sampleRate: number}} `pcm` is a view into
 *   `arrayBuffer`, not a copy.
 */
export function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const ascii = (offset, length) => {
    let s = "";
    for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };

  if (view.byteLength < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") {
    throw new WavFormatError("not a RIFF/WAVE file");
  }

  let sampleRate = null;
  let pcm = null;

  // Walk the chunk list: 4-byte id, 4-byte LE size, payload, pad to even.
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;
    if (payload + size > view.byteLength) {
      throw new WavFormatError(`truncated "${id}" chunk`);
    }
    if (id === "fmt ") {
      if (size < 16) throw new WavFormatError("fmt chunk too short");
      const format = view.getUint16(payload, true);
      const channels = view.getUint16(payload + 2, true);
      const bits = view.getUint16(payload + 14, true);
      if (format !== 1) throw new WavFormatError(`not uncompressed PCM (format ${format})`);
      if (channels !== 1) throw new WavFormatError(`not mono (${channels} channels)`);
      if (bits !== 16) throw new WavFormatError(`not 16-bit (${bits})`);
      sampleRate = view.getUint32(payload + 4, true);
    } else if (id === "data") {
      if (size % 2 !== 0) throw new WavFormatError("odd data chunk size for 16-bit samples");
      pcm = new Int16Array(arrayBuffer, payload, size / 2);
    }
    offset = payload + size + (size % 2); // chunks are word-aligned
  }

  if (sampleRate === null) throw new WavFormatError("no fmt chunk");
  if (pcm === null) throw new WavFormatError("no data chunk");
  return { pcm, sampleRate };
}

/** Zero-filled samples for a gap of `ms` milliseconds. */
export function silence(ms, sampleRate = SAMPLE_RATE) {
  return new Int16Array(Math.round((ms / 1000) * sampleRate));
}

/** Duration of a clip in milliseconds (possibly fractional). */
export function clipDuration(pcm, sampleRate = SAMPLE_RATE) {
  return (pcm.length / sampleRate) * 1000;
}

/**
 * Render a block plan into one playable WAV.
 *
 * @param {Array<{type:"clip",fileId:string}|{type:"gap",ms:number}>} segments
 *   a plan from playlist.js (`buildBlockPlan().segments`)
 * @param {Map<string, {pcm: Int16Array, sampleRate: number}>} clips parsed
 *   clips (from the clip cache) for every fileId in the plan; all must share
 *   one sample rate.
 * @returns {{blob: Blob, offsetsMs: number[], totalMs: number}}
 *   `blob` is `audio/wav`; `offsetsMs[i]` is the sample-exact start of
 *   `segments[i]` in the block. Word cues follow: a word's actual start is
 *   the offset of its first segment (with playlist.js's fixed 6-segment
 *   word sequence, cue k sits at `offsetsMs[k * 6]`).
 */
export function stitch(segments, clips) {
  const parts = segments.map((segment) => {
    if (segment.type === "gap") return segment; // resolved once we know the rate
    const clip = clips.get(segment.fileId);
    if (!clip) throw new Error(`missing clip ${segment.fileId}`);
    return clip;
  });

  const rates = new Set(parts.filter((p) => p.pcm).map((p) => p.sampleRate));
  if (rates.size > 1) {
    throw new WavFormatError(`mixed sample rates: ${[...rates].join(", ")}`);
  }
  const sampleRate = rates.size ? [...rates][0] : SAMPLE_RATE;

  const samples = parts.map((p) => (p.pcm ? p.pcm : silence(p.ms, sampleRate)));
  const total = samples.reduce((n, s) => n + s.length, 0);

  const block = new Int16Array(total);
  const offsetsMs = [];
  let at = 0;
  for (const s of samples) {
    offsetsMs.push((at / sampleRate) * 1000);
    block.set(s, at);
    at += s.length;
  }

  const bytes = new Uint8Array(block.buffer, 0, block.byteLength);
  return {
    blob: new Blob([pcmToWav(bytes, sampleRate)], { type: "audio/wav" }),
    offsetsMs,
    totalMs: (total / sampleRate) * 1000,
  };
}

/**
 * In-memory clip cache keyed by Drive file ID (ADR-0006: clips are fetched
 * once per visit; a full vocabulary's clips fit in memory, so nothing is
 * evicted in MVP).
 *
 * @param {(fileId: string) => Promise<Blob>} fetchClip normally
 *   `drive.fetchClip` with the token bound by the caller.
 * @returns {{get: (fileId: string) => Promise<{pcm, sampleRate}>,
 *   size: () => number}} `get` resolves to the parsed clip; concurrent gets
 *   for one ID share a single fetch. A failed fetch is not cached, so the
 *   next `get` retries.
 */
export function createClipCache(fetchClip) {
  const cache = new Map();

  function get(fileId) {
    let pending = cache.get(fileId);
    if (!pending) {
      pending = fetchClip(fileId)
        .then(async (blob) => parseWav(await blob.arrayBuffer()))
        .catch((error) => {
          cache.delete(fileId);
          throw error;
        });
      cache.set(fileId, pending);
    }
    return pending;
  }

  return { get, size: () => cache.size };
}
