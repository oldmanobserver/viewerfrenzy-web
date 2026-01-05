// functions/api/v1/admin/twitch/callback.js
import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { storeBroadcasterAuthFromCallback } from "../../../../_lib/twitchAuth.js";

const CALLBACK_URL = "https://viewerfrenzy.com/api/v1/admin/twitch/callback";

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  const error = url.searchParams.get("error") || "";
  const errorDesc = url.searchParams.get("error_description") || "";

  if (error) {
    return jsonResponse(
      request,
      { error: "oauth_denied", message: errorDesc || error },
      400,
    );
  }

  const stored = await storeBroadcasterAuthFromCallback(env, { code, state, redirectUri: CALLBACK_URL });
  if (!stored.ok) {
    return jsonResponse(
      request,
      { error: stored.error || "callback_failed", message: "Could not complete Twitch connection.", details: stored.details || null },
      stored.status || 500,
    );
  }

  // Send admin back to the site (home) with a small hint flag
  return Response.redirect("/?twitch_connected=1", 302);
}
