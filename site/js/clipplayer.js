// Review-mode clip player (issue #71, part 1 of #28): stored natural clips
// on speaker taps, one clip at a time through a single shared <audio>
// element.
//
// Clips come from the listen-mode clip cache (#39) — parsed PCM keyed by
// Drive file ID, fetched once per visit — and are re-wrapped as single-clip
// WAV blobs for playback. `play` never throws: it resolves false exactly
// when the caller should fall back to Web Speech (missing ID, fetch/parse
// error, playback refused), per the #28 architecture. Review may fall back
// to a robotic voice; listen mode (player.js) is untouched and never does
// (#29).
//
// Like player.js, every browser dependency (<audio>, blob URLs, Drive
// fetches) is injected so the module is unit-testable under Node; app.js
// wires the real ones.

import { createClipCache } from "./stitcher.js";
import { pcmToWav } from "./tts.js";

/**
 * The clip IDs to warm when a card renders (#28 acceptance: the first tap
 * is instant). Review speakers only ever play the Spanish word and phrase
 * clips, on both card faces and the choices back.
 *
 * @param {object} word a model.js word
 * @returns {string[]} the present clip IDs (hand-added rows yield [])
 */
export function cardClipIds(word) {
  return [word.audioWordEs, word.audioPhraseEs].filter(Boolean);
}

/**
 * Create the review clip player.
 *
 * @param {{
 *   fetchClip: (fileId: string) => Promise<Blob>,
 *   audio?: HTMLAudioElement,
 *   createUrl?: (blob: Blob) => string,
 *   revokeUrl?: (url: string) => void,
 * }} options `fetchClip` is normally drive.fetchClip with the token bound
 *   by the caller; everything else defaults to the real browser APIs.
 * @returns {{
 *   play: (fileId: string | null) => Promise<boolean>,
 *   preload: (fileIds: Array<string | null>) => void,
 *   stop: () => void,
 * }} `play` resolves true when the tap was handled with natural audio and
 *   false when the caller should fall back to Web Speech.
 */
export function createClipPlayer({
  fetchClip,
  audio = new Audio(),
  createUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
}) {
  const cache = createClipCache(fetchClip);
  let current = null; // loaded clip: { fileId, url }
  let generation = 0; // bumped per play()/stop(); stale async work yields

  /** Start the loaded clip; false = fall back (autoplay refused). A tap
   * superseded by a newer one resolves true — the newer tap decides. */
  async function tryPlay(gen) {
    try {
      await audio.play();
      return true;
    } catch {
      return gen === generation ? false : true;
    }
  }

  /**
   * Play the clip with this Drive file ID, restarting from the top if it is
   * already playing (same rule as the card design). Resolves true when
   * natural audio handled the tap; false means fall back to Web Speech
   * (no ID, fetch/parse failure — not cached, so the next tap retries —
   * or playback refused).
   */
  async function play(fileId) {
    if (!fileId) return false;
    const gen = ++generation;

    if (current?.fileId !== fileId) {
      let clip = null;
      try {
        clip = await cache.get(fileId);
      } catch {
        // fall through: clip stays null
      }
      if (gen !== generation) return true; // a newer tap took over
      if (!clip) return false;

      const bytes = new Uint8Array(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength);
      const blob = new Blob([pcmToWav(bytes, clip.sampleRate)], { type: "audio/wav" });
      const url = createUrl(blob);
      if (current) revokeUrl(current.url); // one live object URL at a time
      current = { fileId, url };
      audio.src = url;
    }

    audio.currentTime = 0;
    return tryPlay(gen);
  }

  /**
   * Warm the cache in the background (#28: preload the current card's
   * clips on render). Missing IDs are skipped; fetch failures are
   * swallowed — the cache drops them, so the tap itself retries and only
   * then falls back.
   */
  function preload(fileIds) {
    for (const fileId of fileIds) {
      if (fileId) cache.get(fileId).catch(() => {});
    }
  }

  /** Pause the clip and cancel pending plays (app.js stops clips before a
   * Web Speech fallback so the two voices never overlap). */
  function stop() {
    generation += 1;
    audio.pause();
  }

  return { play, preload, stop };
}
