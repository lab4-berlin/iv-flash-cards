import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  nextStep,
  moveSelection,
  languageCaption,
  continueDisabled,
} from "../site/js/onboardflow.js";

// `sheetExisted` is the session constant: did discovery find the sheet at
// the start of this visit (false = the app created it this visit).

describe("nextStep — the resume-rules table (design/onboarding.md)", () => {
  test("no sheet yet → Setting up (find-or-create runs)", () => {
    assert.equal(
      nextStep({ sheetExisted: false, learningLanguage: null, hasKey: false }),
      "settingUp",
    );
    // A key on the device changes nothing about this step.
    assert.equal(
      nextStep({ sheetExisted: false, learningLanguage: null, hasKey: true }),
      "settingUp",
    );
  });

  test("sheet exists but no language → language step directly, no Setting-up flash", () => {
    const step = nextStep({ sheetExisted: true, learningLanguage: null, hasKey: false });
    assert.equal(step, "language");
    assert.notEqual(step, "settingUp");
  });

  test("language set on a previous visit → returning user, straight Home", () => {
    assert.equal(
      nextStep({ sheetExisted: true, learningLanguage: "es", hasKey: true }),
      "home",
    );
  });

  test("language set on a previous visit → never the key offer, even with no key", () => {
    // Left off at the key offer and closed the tab: that counted as
    // skipping — they meet the key invitation on Import/Listen instead.
    assert.equal(
      nextStep({ sheetExisted: true, learningLanguage: "es", hasKey: false }),
      "home",
    );
  });

  test("first run, language just saved, no key on device → the key offer", () => {
    assert.equal(
      nextStep({ sheetExisted: false, learningLanguage: "es", hasKey: false }),
      "keyOffer",
    );
  });

  test("first run, language just saved, key already on device → skip the offer", () => {
    assert.equal(
      nextStep({ sheetExisted: false, learningLanguage: "es", hasKey: true }),
      "home",
    );
  });

  test("every supported language code routes the same way", () => {
    for (const code of ["es", "fr", "de", "it", "pt", "en"]) {
      assert.equal(
        nextStep({ sheetExisted: true, learningLanguage: code, hasKey: false }),
        "home",
      );
      assert.equal(
        nextStep({ sheetExisted: false, learningLanguage: code, hasKey: false }),
        "keyOffer",
      );
    }
  });
});

describe("moveSelection — keyboard on the picker (↑/↓ per spec)", () => {
  const COUNT = 6;

  test("nothing selected: ↓ starts at the top, ↑ at the bottom", () => {
    assert.equal(moveSelection(null, 1, COUNT), 0);
    assert.equal(moveSelection(null, -1, COUNT), COUNT - 1);
  });

  test("↑/↓ move by one", () => {
    assert.equal(moveSelection(2, 1, COUNT), 3);
    assert.equal(moveSelection(2, -1, COUNT), 1);
  });

  test("the ends clamp — no wrap-around", () => {
    assert.equal(moveSelection(0, -1, COUNT), 0);
    assert.equal(moveSelection(COUNT - 1, 1, COUNT), COUNT - 1);
  });

  test("no options → no selection", () => {
    assert.equal(moveSelection(null, 1, 0), null);
  });
});

describe("the Continue button and its caption (states summary)", () => {
  test("disabled until a language is selected; selection enables it", () => {
    assert.equal(continueDisabled({ selected: false, saving: false }), true);
    assert.equal(continueDisabled({ selected: true, saving: false }), false);
  });

  test("disabled again while the write runs", () => {
    assert.equal(continueDisabled({ selected: true, saving: true }), true);
  });

  test("caption: empty → stored-in-your-sheet → Saving…", () => {
    assert.equal(languageCaption({ selected: false, saving: false }), "");
    assert.equal(
      languageCaption({ selected: true, saving: false }),
      "Stored in your sheet, so it follows you on every device.",
    );
    assert.equal(languageCaption({ selected: true, saving: true }), "Saving\u2026");
  });
});
