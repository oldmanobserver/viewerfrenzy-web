// functions/api/v1/me.js
import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { requireWebsiteUser } from "../../_lib/twitchAuth.js";
import { tableExists, toStr } from "../../_lib/dbUtil.js";

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

async function hasHostedAsStreamer(env, userId) {
  const uid = toStr(userId);
  if (!uid) return false;

  const db = env?.VF_D1_STATS;
  if (!db) return false;

  // If the stats DB isn't initialized yet, treat as not a streamer.
  const ok = await tableExists(db, "competitions");
  if (!ok) return false;

  try {
    const row = await db
      .prepare("SELECT 1 AS ok FROM competitions WHERE streamer_user_id = ? LIMIT 1")
      .bind(uid)
      .first();
    return !!row;
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const user = normalizeUser(auth.user);
  user.isStreamer = await hasHostedAsStreamer(env, user.userId);

  return jsonResponse(request, {
    ok: true,

    // preferred field for the web UI
    user,

    // keep the original payload for debugging + future needs
    twitch: auth.user,
  });
}
