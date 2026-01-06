// functions/api/v1/game-default-vehicles.js
//
// Public (no-auth) endpoint used by the Unity game to determine the *game-level*
// default vehicle for each competition type.
//
// This is separate from:
//   /api/v1/vehicle-defaults/:type
// which stores per-user (viewer) defaults.
//
// Storage:
// - The admin site (manage.viewerfrenzy.com) writes these defaults.
// - Both sites must bind the same Cloudflare KV namespace as VF_KV_GAME_DEFAULTS.

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";

const TYPES = ["ground", "resort", "space"];
const KV_PREFIX = "game_default_vehicle:";

function kvKey(type) {
  return `${KV_PREFIX}${type}`;
}

function sanitizeRecord(rec) {
  if (!rec || typeof rec !== "object") return null;

  const vehicleId = String(rec.vehicleId || "").trim();
  if (!vehicleId) return null;

  return {
    vehicleId,
    updatedAt: String(rec.updatedAt || ""),
    updatedBy: String(rec.updatedBy || ""),
  };
}

async function readDefaults(env) {
  const defaults = {};

  for (const t of TYPES) {
    const rec = await env.VF_KV_GAME_DEFAULTS.get(kvKey(t), { type: "json" });
    defaults[t] = sanitizeRecord(rec);
  }

  return defaults;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  if (!env?.VF_KV_GAME_DEFAULTS) {
    return jsonResponse(
      request,
      { error: "kv_not_bound", message: "Missing KV binding: VF_KV_GAME_DEFAULTS" },
      500,
    );
  }

  const defaults = await readDefaults(env);
  return jsonResponse(request, { ok: true, defaults });
}
