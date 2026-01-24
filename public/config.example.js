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


  // Vehicle size conversion
  //
  // The vehicle catalog can include sizeX/sizeY/sizeZ (Unity units).
  // We convert Unity units -> meters for display on the website.
  //
  // Default conversion (fallback): how many Unity units equal 1 meter.
  // Example: if 0.05 Unity units should display as 1 meter, set this to 0.05.
  vehicleSizeUnitsPerMeter: 0.05,

  // Optional per-vehicle-type override.
  // Useful if (for example) space ships and ground cars are authored at different scales.
  //
  // NOTE: meters = unityUnits / unitsPerMeter
  vehicleSizeUnitsPerMeterByType: {
    ground: 0.14,
    space: 0.05,
    resort: 0.14,
    trackfield: 0.14,
    water: 0.14,
    winter: 0.14,
  },
};
