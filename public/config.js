// ViewerFrenzy web config.
//
// IMPORTANT:
// Replace twitchClientId with your real Twitch application Client ID.
//
// This file is intentionally plain JS (no bundler). Cloudflare Pages will serve it as a static asset.

window.VF_CONFIG = {
  twitchClientId: "6kx9k44jtil58jgxtemvmrcc45rfxw",
  // Required for alpha/beta access gating (so the server can verify the viewer subscribes to the configured broadcaster).
  // You may add additional scopes separated by spaces. Example: "user:read:subscriptions user:read:email"
  twitchScopes: "user:read:subscriptions",
};
