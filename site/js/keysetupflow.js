// Key-setup decision logic (issue #64, design/key-setup.md). Pure module:
// maps apikey.js validation outcomes and the has-key/no-key fact to what
// the guide, the import screen and the listen screen show. The DOM glue
// lives in keysetup.js / importscreen.js / listenscreen.js.

/** Step 1's outline button target (opens in a new tab). */
export const AI_STUDIO_URL = "https://aistudio.google.com";

/** Pasted keys always carry whitespace — trimmed silently (design). */
export function cleanKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** "Check my key" is disabled (hairline) while the field is blank. */
export function checkDisabled(value) {
  return cleanKey(value) === "";
}

/**
 * What the verdict area and the action button show for a validation
 * outcome (design states table). Outcomes are `validateKey()`'s three
 * verdicts plus the transient "checking" and `null` (nothing checked yet).
 *
 * Distinctness rules (acceptance): only "ok" gets ✓; only "invalid" gets ✕
 * and talks about the key's content; "network-error" has no verdict glyph
 * and explicitly exonerates the key.
 *
 * - `lead`: the weight-600 line ("" = none).
 * - `why`: the muted explanation ("" = none).
 * - `buttonLabel`: the action button's label.
 * - `busy`: the button is disabled regardless of the field (checking).
 * - `success`: the paste field collapses and the button closes the screen
 *   ("ok" only — the key is saved at this moment, not before).
 */
export function verdictView(outcome) {
  switch (outcome) {
    case "checking":
      return {
        lead: "",
        why: "Checking with Google\u2026",
        buttonLabel: "Check my key",
        busy: true,
        success: false,
      };
    case "ok":
      return {
        lead: "\u2713 It works!",
        why:
          "Import and Listen are unlocked. The key is saved only on this " +
          "device \u2014 on another phone or computer you'll paste it " +
          "there once too.",
        buttonLabel: "Done",
        busy: false,
        success: true,
      };
    case "invalid":
      return {
        lead: "\u2715 Google didn't accept this key.",
        why:
          "Check that you copied the whole key \u2014 it starts with AIza " +
          "and has no spaces around it. Still stuck? Create a fresh key " +
          "in AI Studio (step 2) and paste that one.",
        buttonLabel: "Check my key",
        busy: false,
        success: false,
      };
    case "network-error":
      return {
        lead: "Couldn't check the key.",
        why:
          "We couldn't reach Google \u2014 that's a connection problem, " +
          "not your key. Check your internet and try again.",
        buttonLabel: "Try again",
        busy: false,
        success: false,
      };
    default:
      // Nothing checked yet: no verdict, the button follows the field.
      return {
        lead: "",
        why: "",
        buttonLabel: "Check my key",
        busy: false,
        success: false,
      };
  }
}

/**
 * The masked key shown in the manage state: first 4 + last 4 characters
 * around a fixed run of middle dots ("AIza············3kfQ"). A key too
 * short to mask meaningfully (never produced by AI Studio) passes through.
 */
export function maskKey(key) {
  if (typeof key !== "string" || key.length <= 8) return key ?? "";
  return key.slice(0, 4) + "\u00b7".repeat(12) + key.slice(-4);
}

/** Which face the key-setup screen opens with: the numbered guide, or the
 *  manage state (masked key, Replace, Remove) when a key is saved. */
export function guideScreen(hasKey) {
  return hasKey ? "manage" : "guide";
}

/** Which import sub-screen `open()` lands on: step 1, or the blocked
 *  invitation ("Import uses Google's AI") when no key is saved. */
export function importSubscreen(hasKey) {
  return hasKey ? "input" : "blocked";
}

/**
 * Which empty-state variant Listen shows when nothing is playable:
 * the existing "Import words" message, or — with no key — the invitation
 * into the key setup (the import CTA would dead-end into the import
 * blocked state; route to the actual fix instead).
 */
export function listenEmptyVariant(hasKey) {
  return hasKey ? "import" : "no-key";
}
