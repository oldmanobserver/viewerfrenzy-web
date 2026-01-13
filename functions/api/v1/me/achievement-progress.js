// functions/api/v1/me/achievement-progress.js
// Authenticated endpoint: list all active achievements + completion/progress for the current website user.

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { getAchievementProgressForViewer } from "../../../../_lib/achievements.js";

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

  let data;
  try {
    data = await getAchievementProgressForViewer(env, viewerUserId);
  } catch (e) {
    return jsonResponse(
      request,
      {
        error: "server_error",
        message: "Failed to compute achievement progress.",
        details: String(e?.message || e),
      },
      500,
    );
  }

  if (!data?.ok) {
    if (data?.error === "db_not_initialized") {
      return jsonResponse(
        request,
        {
          error: "db_not_initialized",
          message:
            "Stats DB not initialized (achievements tables missing). Run the next migration on manage.viewerfrenzy.com → /db.html.",
          details: data?.details || data?.message || "",
        },
        503,
      );
    }

    return jsonResponse(
      request,
      {
        error: data?.error || "unknown_error",
        message: data?.message || "Unable to load achievement progress.",
        details: data?.details || "",
      },
      400,
    );
  }

  return jsonResponse(request, {
    ok: true,
    serverTimeMs: Date.now(),
    viewerUserId: data.viewerUserId,
    metrics: data.metrics,
    achievements: data.achievements,
  });
}
