import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_STUDIO_URL,
  cleanKey,
  checkDisabled,
  verdictView,
  maskKey,
  guideScreen,
  importSubscreen,
  listenEmptyVariant,
} from "../site/js/keysetupflow.js";

// ------------------------------------------------------------ field hygiene

test("cleanKey trims the whitespace copy-paste always brings", () => {
  assert.equal(cleanKey("  AIzaSyD4k9mQ3kfQ \n"), "AIzaSyD4k9mQ3kfQ");
  assert.equal(cleanKey("AIza"), "AIza");
  assert.equal(cleanKey(null), "");
});

test("Check my key is disabled only while the field is blank", () => {
  assert.equal(checkDisabled(""), true);
  assert.equal(checkDisabled("   \n"), true);
  assert.equal(checkDisabled(" AIza… "), false);
});

// ------------------------------------------- verdict views (states table)

test("before any check: no verdict, the button is Check my key", () => {
  assert.deepEqual(verdictView(null), {
    lead: "",
    why: "",
    buttonLabel: "Check my key",
    busy: false,
    success: false,
  });
});

test("checking: transient muted line, button busy, no verdict lead", () => {
  const view = verdictView("checking");
  assert.equal(view.lead, "");
  assert.equal(view.why, "Checking with Google\u2026");
  assert.equal(view.busy, true);
  assert.equal(view.success, false);
});

test("ok: ✓ lead, Done button, success collapses the field", () => {
  const view = verdictView("ok");
  assert.equal(view.lead, "\u2713 It works!");
  assert.equal(view.buttonLabel, "Done");
  assert.equal(view.success, true);
  assert.equal(view.busy, false);
  // Per-device storage stated as fact at the success moment (acceptance).
  assert.match(view.why, /saved only on this device/);
  assert.match(view.why, /unlocked/i);
});

test("invalid: ✕ lead that talks about the key's content", () => {
  const view = verdictView("invalid");
  assert.equal(view.lead, "\u2715 Google didn't accept this key.");
  assert.equal(view.buttonLabel, "Check my key");
  assert.equal(view.success, false);
  // Tells the user what to re-check, and the fresh-key fallback.
  assert.match(view.why, /whole key/);
  assert.match(view.why, /AIza/);
  assert.match(view.why, /fresh key/);
});

test("network-error: no verdict glyph, exonerates the key, Try again", () => {
  const view = verdictView("network-error");
  assert.equal(view.lead, "Couldn't check the key.");
  assert.equal(view.buttonLabel, "Try again");
  assert.equal(view.success, false);
  // Must not accuse the key (acceptance criterion).
  assert.match(view.why, /not your key/);
  assert.match(view.why, /connection/);
});

test("distinctness: only ok gets ✓, only invalid gets ✕", () => {
  const outcomes = [null, "checking", "ok", "invalid", "network-error"];
  const withCheck = outcomes.filter((o) => verdictView(o).lead.includes("\u2713"));
  const withCross = outcomes.filter((o) => verdictView(o).lead.includes("\u2715"));
  assert.deepEqual(withCheck, ["ok"]);
  assert.deepEqual(withCross, ["invalid"]);
});

test("the three validateKey outcomes produce three distinct messages", () => {
  const views = ["ok", "invalid", "network-error"].map(verdictView);
  const leads = new Set(views.map((v) => v.lead));
  const whys = new Set(views.map((v) => v.why));
  assert.equal(leads.size, 3);
  assert.equal(whys.size, 3);
});

// ------------------------------------------------------------- masked key

test("maskKey keeps the first and last 4 characters around fixed dots", () => {
  const masked = maskKey("AIzaSyD4k9bQ7wXp2vR8mQ3kfQ");
  assert.equal(masked, "AIza\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b73kfQ");
  // The mask never leaks the middle, whatever the key length.
  assert.ok(!masked.includes("SyD4k9"));
});

test("maskKey passes degenerate values through instead of mangling", () => {
  assert.equal(maskKey("AIzashort"), "AIza\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7\u00b7hort");
  assert.equal(maskKey("12345678"), "12345678");
  assert.equal(maskKey(null), "");
});

// ------------------------------------------------------- screen decisions

test("the setup screen opens on the guide, or manage when a key exists", () => {
  assert.equal(guideScreen(false), "guide");
  assert.equal(guideScreen(true), "manage");
});

test("import lands on step 1 with a key, the blocked invitation without", () => {
  assert.equal(importSubscreen(true), "input");
  assert.equal(importSubscreen(false), "blocked");
});

test("listen's empty state routes to key setup only when no key is saved", () => {
  assert.equal(listenEmptyVariant(true), "import");
  assert.equal(listenEmptyVariant(false), "no-key");
});

test("step 1 links to Google AI Studio", () => {
  assert.equal(AI_STUDIO_URL, "https://aistudio.google.com");
});
