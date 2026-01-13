// functions/api/v1/achievements/index.js
// Public endpoint: list active achievements.

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { listActiveAchievements } from "../../../_lib/achievements.js";

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  if (!env?.VF_D1_STATS) {
    return jsonResponse(request, { error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" }, 500);
  }

  let achievements = [];
  try {
    achievements = await listActiveAchievements(env);
  } catch (e) {
    return jsonResponse(
      request,
      {
        error: "db_not_initialized",
        message: "Stats DB not initialized (achievements table missing). Run the next migration on manage.viewerfrenzy.com → /db.html.",
        details: String(e?.message || e),
      },
      503,
    );
  }

  return jsonResponse(request, { ok: true, achievements });
}
