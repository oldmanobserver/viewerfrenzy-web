import { jsonResponse } from "../_lib/http.js";
import { requireTwitchUser } from "../_lib/twitchAuth.js";
import { isVipUser } from "../_lib/vips.js";
import { isSubscribedToBroadcaster } from "../_lib/subscriptions.js";

export async function onRequest({ request, env }) {
  // CORS/OPTIONS if you use it
  // const opt = handleOptions(request); if (opt) return opt;

  const user = await requireTwitchUser(request, env);

  // VIP bypass
  const vip = await isVipUser(user.login, env, request);
  if (vip) return jsonResponse(request, { allowed: true, reason: "vip" }, 200);

  const broadcasterLogin = (env.VF_TWITCH_BROADCASTER_LOGIN || "").toLowerCase();
  const ok = await isSubscribedToBroadcaster(user.id, env);

  if (ok) return jsonResponse(request, { allowed: true, reason: "sub" }, 200);

  return jsonResponse(
    request,
    {
      allowed: false,
      message: `Access is currently restricted during alpha/beta. To use the website, please subscribe to ${broadcasterLogin} on Twitch to get access.`,
    },
    403
  );
}
