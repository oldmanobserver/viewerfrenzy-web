// functions/api/v1/me.js
import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { requireWebsiteUser } from "../../_lib/twitchAuth.js";

function normalizeUser(authUser) {
  const helix = authUser?.helixUser || null;

  return {
    userId: authUser?.userId || "",
    login: authUser?.login || "",

    // Friendly display fields for browser UI
    displayName: helix?.display_name || authUser?.login || "",
    profileImageUrl: helix?.profile_image_url || "",

    broadcasterType: helix?.broadcaster_type || "",
    description: helix?.description || "",

    // Present only if the token was created with user:read:email scope
    email: helix?.email || null,
  };
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  return jsonResponse(request, {
    ok: true,

    // preferred field for the web UI
    user: normalizeUser(auth.user),

    // keep the original payload for debugging + future needs
    twitch: auth.user,
  });
}
