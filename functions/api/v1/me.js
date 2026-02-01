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

async function hasStreamerViewers(env, userId) {
  const uid = toStr(userId);
  if (!uid) return false;

  const db = env?.VF_D1_STATS;
  if (!db) return false;

  // Prefer the materialized join table (v0.20+). This only tracks REAL viewers (bots excluded)
  // and intentionally does not include the streamer themselves.
  if (await tableExists(db, "vf_user_streamers")) {
    try {
      const row = await db
        .prepare("SELECT 1 AS ok FROM vf_user_streamers WHERE streamer_user_id = ? LIMIT 1")
        .bind(uid)
        .first();
      if (row) return true;
    } catch {
      // fall through
    }
  }

  // Fallback (older DBs): require that at least one non-streamer has a result row for one
  // of this streamer's competitions.
  const hasCompetitions = await tableExists(db, "competitions");
  const hasResults = await tableExists(db, "competition_results");
  if (!hasCompetitions || !hasResults) return false;

  try {
    const row = await db
      .prepare(
        `SELECT 1 AS ok
         FROM competitions c
         JOIN competition_results r ON r.competition_id = c.id
         WHERE c.streamer_user_id = ?
           AND r.viewer_user_id <> ?
           AND LOWER(r.viewer_user_id) NOT LIKE 'bot:%'
           AND LOWER(r.viewer_user_id) NOT LIKE 'bot_%'
           AND LOWER(r.viewer_user_id) NOT LIKE 'racer %'
         LIMIT 1`,
      )
      .bind(uid, uid)
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
  // The Streamer section is only enabled once this user has had *at least one viewer*
  // join their competitions (i.e., there is a viewer list to manage).
  user.isStreamer = await hasStreamerViewers(env, user.userId);

  return jsonResponse(request, {
    ok: true,

    // preferred field for the web UI
    user,

    // keep the original payload for debugging + future needs
    twitch: auth.user,
  });
}
