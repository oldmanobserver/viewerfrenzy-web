// functions/api/v1/admin/twitch/status.js
import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireTwitchUser, getBroadcasterAuthStatus } from "../../../../_lib/twitchAuth.js";

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireTwitchUser(context);
  if (!auth.ok) return auth.response;

  const login = (auth.user?.login || "").toLowerCase();
  const broadcasterLogin = (env?.VF_TWITCH_BROADCASTER_LOGIN || "").toLowerCase();
  if (!broadcasterLogin) {
    return jsonResponse(request, { error: "server_misconfigured", message: "Missing VF_TWITCH_BROADCASTER_LOGIN env var." }, 500);
  }

  if (login !== broadcasterLogin) {
    return jsonResponse(request, { error: "forbidden" }, 403);
  }

  const status = await getBroadcasterAuthStatus(env);
  return jsonResponse(request, status, 200);
}
