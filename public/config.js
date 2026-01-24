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


  // Vehicle size conversion
  //
  // The vehicle catalog can include sizeX/sizeY/sizeZ (Unity units).
  // We convert Unity units -> meters for display on the website.
  //
  // Default conversion (fallback): how many Unity units equal 1 meter.
  // Example: if 0.05 Unity units should display as 1 meter, set this to 0.05.
  vehicleSizeUnitsPerMeter: 0.05,

  // Optional per-vehicle-type override.
  // This is useful if (for example) your space ships and ground cars use different in-game scales.
  //
  // NOTE: meters = unityUnits / unitsPerMeter
  //  - Smaller unitsPerMeter => larger displayed meters
  //  - Larger unitsPerMeter  => smaller displayed meters
  vehicleSizeUnitsPerMeterByType: {
    // Ground cars looked too large when using the same scale as space ships.
    // Setting this closer to ~0.14 makes a typical sedan feel more "real-life" sized.
    ground: 0.14,

    // Space ships: keep your original big/fun scale.
    space: 0.05,

    // If you add measurements for these later, you can tune them too.
    resort: 0.14,
    trackfield: 0.14,
    water: 0.14,
    winter: 0.14,
  },
};
