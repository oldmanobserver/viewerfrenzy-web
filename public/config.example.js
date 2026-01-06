// Copy this file to /public/config.js and set your Twitch client id.
//
// Why is this not bundled?
// - Cloudflare Pages + static hosting (no build step)
// - You can keep environment-specific values out of git.

window.VF_CONFIG = {
  // Get this from your Twitch Developer Console app settings.
  // Example: "abcd1234efgh5678ijkl9012mnop3456"
  twitchClientId: "YOUR_TWITCH_CLIENT_ID",

  // Required scopes.
  // ViewerFrenzy uses `user:read:subscriptions` so the server can verify the user is
  // subscribed to the configured broadcaster (alpha/beta gate).
  //
  // You may add additional scopes separated by spaces. Example:
  //   "user:read:subscriptions user:read:email"
  twitchScopes: "user:read:subscriptions",
};
