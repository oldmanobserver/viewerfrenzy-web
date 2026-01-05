// functions/api/v1/admin/twitch/connect.js
import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireTwitchUser, buildBroadcasterConnectUrl } from "../../../../_lib/twitchAuth.js";

// Must match what you registered in the Twitch dev console
const CALLBACK_URL = "https://viewerfrenzy.com/api/v1/admin/twitch/callback";

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  // Must be logged in with Twitch (any scope is fine; just identity)
  const auth = await requireTwitchUser(context);
  if (!auth.ok) return auth.response;

  const login = (auth.user?.login || "").toLowerCase();
  const broadcasterLogin = (env?.VF_TWITCH_BROADCASTER_LOGIN || "").toLowerCase();

  if (!broadcasterLogin) {
    return jsonResponse(
      request,
      { error: "server_misconfigured", message: "Missing VF_TWITCH_BROADCASTER_LOGIN env var." },
      500
    );
  }

  // Only the broadcaster should be able to connect broadcaster tokens.
  if (login !== broadcasterLogin) {
    return jsonResponse(
      request,
      { error: "forbidden", message: "Only the broadcaster can connect Twitch tokens." },
      403
    );
  }

  // ✅ IMPORTANT FIX:
  // Pass env (NOT context), and pass redirectUri so twitchAuth can build the URL
  const built = await buildBroadcasterConnectUrl(env, {
    redirectUri: CALLBACK_URL,
    broadcasterLogin,
  });

  if (!built.ok) {
    return jsonResponse(
      request,
      {
        error: built.error || "connect_failed",
        message: built.message || "Unable to start connect flow.",
        details: built.details || null,
      },
      built.status || 500
    );
  }

  // Return JSON so the client can redirect the browser to Twitch consent.
  // A server-side 302 redirect doesn't work when the request includes Authorization (fetch),
  // and a normal browser navigation can't attach that header.
  return jsonResponse(request, { ok: true, url: built.url }, 200);
}
