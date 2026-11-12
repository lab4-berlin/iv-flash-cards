// Gemini TTS synthesis + WAV wrapping — ADR-0004, ADR-0005, issue #35.
//
// Calls the Generative Language API directly from the browser with the
// user-supplied API key (ADR-0004). The model returns raw 16-bit mono PCM
// at 24 kHz; `pcmToWav` (pure, unit-tested) prepends the 44-byte WAV header
// so the clip is playable and storable as-is (ADR-0005).
//
// Free-tier rate limits are real: callers (the import pipeline, backfill)
// must catch `RateLimitError` and back off rather than fire in parallel.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/** Gemini TTS model (exported so a GA successor is a one-line swap). */
export const TTS_MODEL = "gemini-3.8-flash-tts";

/** Sample rate of the PCM audio Gemini TTS returns. */
export const SAMPLE_RATE = 24000;

// BCP-47 codes for speechConfig.languageCode — steers pronunciation without
// putting instructions into the spoken text (the 3.8 TTS model reads any
// instruction text aloud, verbatim).
const LANGUAGE_CODES = { es: "es-ES", en: "en-US" };

/** Any non-OK TTS API response. `status` is the HTTP status code. */
export class TtsError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "TtsError";
    this.status = status;
  }
}

/** A 429 — the free-tier rate limit; the caller should back off and retry. */
export class RateLimitError extends TtsError {
  constructor(message) {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

/**
 * Synthesize `text` into a playable WAV clip.
 *
 * @param {string} key user-supplied Gemini API key (ADR-0004)
 * @param {string} text what to say
 * @param {"es"|"en"} language language of `text` (steers pronunciation —
 *   the voices themselves are multilingual, ADR-0004)
 * @param {string} voice a Gemini voice name, normally from voices.js
 * @returns {Promise<Blob>} an `audio/wav` blob (24 kHz, 16-bit, mono)
 * @throws {RateLimitError} on 429, {TtsError} on other API failures
 */
export async function synthesize(key, text, language, voice) {
  const response = await fetch(`${API_BASE}/${TTS_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Bare text only: anything else in the prompt gets spoken verbatim.
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: LANGUAGE_CODES[language] ?? language,
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
    }),
  });
  if (response.status === 429) {
    throw new RateLimitError(`Gemini TTS: rate limited ("${text}")`);
  }
  if (!response.ok) {
    throw new TtsError(
      `Gemini TTS: ${response.status} ("${text}")`,
      response.status,
    );
  }
  const data = await response.json();
  const inline = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!inline?.data) {
    throw new TtsError(`Gemini TTS: no audio in response ("${text}")`, 200);
  }
  const bytes = base64ToBytes(inline.data);
  // Newer TTS models (gemini-3.8-flash-tts) return a complete WAV file;
  // older ones returned raw PCM that needs the header prepended. Detect by
  // content, not mime type, so either server behavior works.
  const isWav = bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
  const wav = isWav ? bytes : pcmToWav(bytes, SAMPLE_RATE);
  return new Blob([wav], { type: "audio/wav" });
}

/**
 * Wrap raw 16-bit mono little-endian PCM in a 44-byte WAV header.
 * Pure — no browser APIs — so it is unit-testable under Node.
 *
 * @param {Uint8Array} pcm raw PCM sample bytes
 * @param {number} [sampleRate] samples per second, default {@link SAMPLE_RATE}
 * @returns {Uint8Array} a complete WAV file (header + samples)
 */
export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const channels = 1;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = channels * bytesPerSample;

  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const writeAscii = (offset, s) => {
    for (let i = 0; i < s.length; i++) wav[offset + i] = s.charCodeAt(i);
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true); // RIFF chunk size
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // audio format: PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
