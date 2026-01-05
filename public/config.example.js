// Copy this file to /public/config.js and set your Twitch client id.
//
// Why is this not bundled?
// - Cloudflare Pages + static hosting (no build step)
// - You can keep environment-specific values out of git.

window.VF_CONFIG = {
  // Get this from your Twitch Developer Console app settings.
  // Example: "abcd1234efgh5678ijkl9012mnop3456"
  twitchClientId: "YOUR_TWITCH_CLIENT_ID",

  // Optional scopes.
  // For ViewerFrenzy defaults, you can typically leave this empty.
  // If you want email in the /api/v1/me payload, request: "user:read:email".
  twitchScopes: "",
};
