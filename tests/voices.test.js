import { test } from "node:test";
import assert from "node:assert/strict";

import { MALE_VOICES, FEMALE_VOICES, VOICES, pickVoice } from "../site/js/voices.js";

test("pool is 3 perceived-male + 3 perceived-female voices (ADR-0004)", () => {
  assert.deepEqual(MALE_VOICES, ["Puck", "Charon", "Fenrir"]);
  assert.deepEqual(FEMALE_VOICES, ["Kore", "Aoede", "Leda"]);
  assert.deepEqual(VOICES, [...MALE_VOICES, ...FEMALE_VOICES]);
  assert.equal(new Set(VOICES).size, 6);
});

test("pickVoice maps the RNG range onto the whole pool", () => {
  // Each sixth of [0, 1) lands on the corresponding pool entry.
  for (let i = 0; i < VOICES.length; i++) {
    assert.equal(pickVoice(() => i / VOICES.length), VOICES[i]);
    assert.equal(pickVoice(() => (i + 0.999) / VOICES.length), VOICES[i]);
  }
});

test("pickVoice edge values stay in bounds", () => {
  assert.equal(pickVoice(() => 0), VOICES[0]);
  // Math.random() is always < 1; the largest float below 1 picks the last voice.
  assert.equal(pickVoice(() => 1 - Number.EPSILON), VOICES[VOICES.length - 1]);
});

test("pickVoice defaults to Math.random and returns a pool voice", () => {
  for (let i = 0; i < 20; i++) {
    assert.ok(VOICES.includes(pickVoice()));
  }
});
