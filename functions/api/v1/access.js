// functions/api/v1/access.js
import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { requireWebsiteUser } from "../../_lib/twitchAuth.js";

export async function onRequest(context) {
  const { request } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  // This already enforces:
  // - VIP-by-role access (Admin/MOD/VIP flags)
  // - Subscriber-to-broadcaster check (using the viewer's own token + user:read:subscriptions)
  // - Friendly 403 message that includes VF_TWITCH_BROADCASTER_LOGIN
  // - 500 if VF_TWITCH_BROADCASTER_LOGIN is missing (after your earlier edits)
  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  return jsonResponse(request, {
    ok: true,
    allowed: true,
    reason: auth?.access?.reason || "allowed",
  });
}
