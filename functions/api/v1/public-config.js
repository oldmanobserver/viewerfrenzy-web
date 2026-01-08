// functions/api/v1/public-config.js
import { jsonResponse } from "../../_lib/response.js";

/**
 * Public (non-secret) configuration for the browser.
 *
 * Exposes:
 *  - TWITCH_CLIENT_ID (safe to expose; required by Twitch authorize URL)
 *  - TWITCH_SCOPES (optional; additional scopes to request)
 */
export async function onRequestGet({ request, env }) {
  const twitchClientId = String(env?.TWITCH_CLIENT_ID || "").trim();
  const twitchScopes = String(env?.TWITCH_SCOPES || "").trim();

  return jsonResponse(
    request,
    {
      twitchClientId,
      twitchScopes,
    },
    200,
  );
}
