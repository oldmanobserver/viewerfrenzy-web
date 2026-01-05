// functions/api/v1/admin/twitch/connect.js
import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireTwitchUser, buildBroadcasterConnectUrl } from "../../../../_lib/twitchAuth.js";

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
  const broadcasterLogin = (env?.VF_TWITCH_BROADCASTER_LOGIN || "oldmanobserver").toLowerCase();

  // Only the broadcaster can run this connect flow
  if (login !== broadcasterLogin) {
    return jsonResponse(
      request,
      { error: "forbidden", message: "Only the broadcaster account can connect subscriber checks." },
      403,
    );
  }

  const built = await buildBroadcasterConnectUrl(env, { redirectUri: CALLBACK_URL, broadcasterLogin });
  if (!built.ok) {
    return jsonResponse(request, { error: built.error || "connect_failed", message: built.message || "Unable to start connect flow." }, built.status || 500);
  }

  return Response.redirect(built.url, 302);
}
