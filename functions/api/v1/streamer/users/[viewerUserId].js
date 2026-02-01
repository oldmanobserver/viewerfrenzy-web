// functions/api/v1/streamer/users/[viewerUserId].js
//
// Streamer-only deletion: removing a user from THIS streamer's list.
// IMPORTANT: This does NOT delete the global user record.

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { tableExists, toStr } from "../../../../_lib/dbUtil.js";

async function hasHostedAsStreamer(env, userId) {
  const uid = toStr(userId);
  if (!uid) return false;
  const db = env?.VF_D1_STATS;
  if (!db) return false;
  if (!(await tableExists(db, "competitions"))) return false;

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
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "DELETE") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const streamerUserId = toStr(auth.user?.userId);
  if (!streamerUserId) {
    return jsonResponse(request, { error: "missing_streamer_user" }, 401);
  }

  const isStreamer = await hasHostedAsStreamer(env, streamerUserId);
  if (!isStreamer) {
    return jsonResponse(
      request,
      {
        error: "not_streamer",
        message:
          "Streamer tools become available after you host a competition and the game submits results.",
      },
      403,
    );
  }

  const viewerUserId = toStr(params?.viewerUserId);
  if (!viewerUserId) {
    return jsonResponse(request, { error: "missing_viewerUserId" }, 400);
  }

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { error: "db_not_bound", message: "Missing D1 binding: VF_D1_STATS" }, 500);
  }

  if (!(await tableExists(db, "vf_user_streamers"))) {
    return jsonResponse(
      request,
      {
        error: "db_migration_required",
        message: "Missing required table vf_user_streamers. Run DB migration v0.20+.",
      },
      500,
    );
  }

  await db
    .prepare("DELETE FROM vf_user_streamers WHERE user_id = ? AND streamer_user_id = ?")
    .bind(viewerUserId, streamerUserId)
    .run();

  return jsonResponse(request, { ok: true, removed: true });
}
