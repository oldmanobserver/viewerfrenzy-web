// ViewerFrenzy web config.
//
// IMPORTANT:
// Replace twitchClientId with your real Twitch application Client ID.
//
// This file is intentionally plain JS (no bundler). Cloudflare Pages will serve it as a static asset.

window.VF_CONFIG = {
  // RECOMMENDED: leave this blank and configure TWITCH_CLIENT_ID in Cloudflare Pages environment variables.
  // The frontend will fetch /api/v1/public-config to obtain the right value for prod/dev deployments.
  twitchClientId: "",

  // Optional additional scopes (space-delimited). The site will always request the required
  // website scope: user:read:subscriptions.
  // You can also set TWITCH_SCOPES in Cloudflare Pages environment variables.
  twitchScopes: "",
};
