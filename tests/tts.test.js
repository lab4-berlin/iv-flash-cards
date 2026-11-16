import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  synthesize,
  pcmToWav,
  SAMPLE_RATE,
  RateLimitError,
  TtsError,
} from "../site/js/tts.js";

const ascii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.slice(offset, offset + length));

test("pcmToWav writes a correct 44-byte header for 24 kHz 16-bit mono", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]); // 3 samples
  const wav = pcmToWav(pcm);
  const view = new DataView(wav.buffer);

  assert.equal(wav.length, 44 + pcm.length);

  assert.equal(ascii(wav, 0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + pcm.length);
  assert.equal(ascii(wav, 8, 4), "WAVE");

  assert.equal(ascii(wav, 12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16); // fmt chunk size
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 1); // mono
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), SAMPLE_RATE * 2); // byte rate
  assert.equal(view.getUint16(32, true), 2); // block align
  assert.equal(view.getUint16(34, true), 16); // bits per sample

  assert.equal(ascii(wav, 36, 4), "data");
  assert.equal(view.getUint32(40, true), pcm.length);
});

test("pcmToWav copies the PCM payload verbatim after the header", () => {
  const pcm = Uint8Array.from({ length: 100 }, (_, i) => i % 256);
  const wav = pcmToWav(pcm);
  assert.deepEqual([...wav.slice(44)], [...pcm]);
});

test("pcmToWav honours a custom sample rate", () => {
  const wav = pcmToWav(new Uint8Array(0), 44100);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(24, true), 44100);
  assert.equal(view.getUint32(28, true), 88200);
  assert.equal(wav.length, 44);
  assert.equal(view.getUint32(40, true), 0);
});

test("RateLimitError is a TtsError with status 429", () => {
  const err = new RateLimitError("slow down");
  assert.ok(err instanceof TtsError);
  assert.equal(err.status, 429);
  assert.equal(err.name, "RateLimitError");
});

// ------------------------------- language codes from languages.js (#78)

describe("synthesize speechConfig.languageCode", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // A minimal valid response: inlineData carrying a tiny WAV ("RIFF"
  // header), so synthesize returns it without PCM wrapping.
  function stubFetch() {
    const calls = [];
    const wav = Buffer.from("RIFFxxxxWAVE").toString("base64");
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { data: wav } }] } },
          ],
        }),
        { status: 200 },
      );
    };
    return calls;
  }

  async function sentLanguageCode(language) {
    const calls = stubFetch();
    await synthesize("key", "bonjour", language, "Puck");
    return JSON.parse(calls[0].options.body).generationConfig.speechConfig
      .languageCode;
  }

  test("maps codes via languages.js ttsCode", async () => {
    assert.equal(await sentLanguageCode("es"), "es-ES");
    assert.equal(await sentLanguageCode("fr"), "fr-FR");
    assert.equal(await sentLanguageCode("de"), "de-DE");
    assert.equal(await sentLanguageCode("en"), "en-US");
  });

  test("an unknown code is passed through as-is", async () => {
    assert.equal(await sentLanguageCode("fr-CA"), "fr-CA");
  });
});
