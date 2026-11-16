// Example configuration. For local development, copy this file:
//
//   cp site/js/config.example.js site/js/config.js
//
// and fill in your value (see README, "One-time Google Cloud setup").
// config.js itself is gitignored; in production the Pages deploy job
// generates it from the OAUTH_CLIENT_ID GitHub Actions secret. The value
// is an identifier, not a secret — it is visible in the deployed page's
// JS by design (ADR-0001); the only goal is keeping it out of the public
// source (issue #24).
//
// The spreadsheet needs no configuration: the app discovers — or creates —
// the vocabulary sheet in the signed-in user's own Drive (ADR-0008).

// Google OAuth client ID (Google Identity Services, token client).
export const CLIENT_ID = "REPLACE_WITH_OAUTH_CLIENT_ID";
