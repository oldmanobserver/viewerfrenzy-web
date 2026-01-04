// functions/api/v1/me.js
import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { requireTwitchUser } from "../../_lib/twitchAuth.js";

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireTwitchUser(context);
  if (!auth.ok) return auth.response;

  return jsonResponse(request, {
    ok: true,
    twitch: auth.user,
  });
}
