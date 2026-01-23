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
  // The vehicle catalog may include sizeX/sizeY/sizeZ (Unity units).
  // This value defines how many Unity units equal 1 meter when displaying sizes on the website.
  //
  // Unity convention is 1 unit = 1 meter, so the default is 1.
  // If your exported sizes are in a different scale, change this.
  // Example: if 0.05 Unity units should display as 1 meter, set this to 0.05.
  vehicleSizeUnitsPerMeter: 1,
};
