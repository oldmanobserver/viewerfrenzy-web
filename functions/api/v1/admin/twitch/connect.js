import { jsonResponse } from "../../../../_lib/response.js";
import { requireTwitchUser, buildBroadcasterConnectUrl } from "../../../../_lib/twitchAuth.js";

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireTwitchUser(context);
  if (!auth.ok) return auth.response;

  const broadcasterLogin = (context.env.VF_TWITCH_BROADCASTER_LOGIN || "").toLowerCase();
  if (!broadcasterLogin) {
    return jsonResponse(
      request,
      { error: "server_misconfigured", message: "VF_TWITCH_BROADCASTER_LOGIN is not configured." },
      500
    );
  }

  // Only the broadcaster should be able to connect broadcaster tokens.
  if ((auth.user.login || "").toLowerCase() !== broadcasterLogin) {
    return jsonResponse(request, { error: "forbidden", message: "Only the broadcaster can connect Twitch tokens." }, 403);
  }

  const built = await buildBroadcasterConnectUrl(context, { broadcasterLogin });

  // IMPORTANT:
  // We return JSON so the client can redirect the browser to Twitch.
  // A server-side 302 redirect doesn't work when the request includes an Authorization header (fetch),
  // and a normal browser navigation can't attach that header.
  return jsonResponse(request, { ok: true, url: built.url }, 200);
}
