// Example configuration. For local development, copy this file:
//
//   cp site/js/config.example.js site/js/config.js
//
// and fill in your values (see README, "One-time Google Cloud setup").
// config.js itself is gitignored; in production the Pages deploy job
// generates it from the CLIENT_ID and SPREADSHEET_ID GitHub Actions
// secrets. Both values are identifiers, not secrets — they are visible in
// the deployed page's JS by design (ADR-0001); the only goal is keeping
// them out of the public source (issue #24).

// Google OAuth client ID (Google Identity Services, token client).
export const CLIENT_ID = "REPLACE_WITH_OAUTH_CLIENT_ID";

// ID of the Google Sheet holding the `Words` worksheet.
export const SPREADSHEET_ID = "REPLACE_WITH_SPREADSHEET_ID";
