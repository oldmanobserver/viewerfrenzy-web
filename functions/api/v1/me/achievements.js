// functions/api/v1/me/achievements.js
// Authenticated endpoint: list achievements unlocked by the current website user.

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";

function toStr(v) {
  return String(v ?? "").trim();
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  if (!env?.VF_D1_STATS) {
    return jsonResponse(request, { error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" }, 500);
  }

  const viewerUserId = toStr(auth?.user?.userId);
  if (!viewerUserId) {
    return jsonResponse(request, { error: "auth_missing_user_id" }, 401);
  }

  let rows;
  try {
    rows = await env.VF_D1_STATS.prepare(
      `SELECT
         ua.achievement_id AS achievementId,
         ua.unlocked_at_ms AS unlockedAtMs,
         a.name AS name,
         a.description AS description
       FROM viewer_achievements ua
       JOIN achievements a ON a.id = ua.achievement_id
       WHERE ua.viewer_user_id = ?
       ORDER BY ua.unlocked_at_ms DESC`,
    )
      .bind(viewerUserId)
      .all();
  } catch (e) {
    return jsonResponse(
      request,
      {
        error: "db_not_initialized",
        message: "Stats DB not initialized (achievements tables missing). Run the next migration on manage.viewerfrenzy.com → /db.html.",
        details: String(e?.message || e),
      },
      503,
    );
  }

  return jsonResponse(request, { ok: true, viewerUserId, achievements: rows?.results || [] });
}
