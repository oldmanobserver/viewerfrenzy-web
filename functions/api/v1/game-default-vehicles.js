// functions/api/v1/game-default-vehicles.js
//
// Public (no-auth) endpoint used by the Unity game to determine the *game-level*
// default vehicle for each competition type.
//
// New storage (v0.6+): D1
// - vf_game_default_vehicles
//
// Legacy fallback (pre-v0.6): KV
// - VF_KV_GAME_DEFAULTS (keys: game_default_vehicle:<type>)

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { isoFromMs, tableExists } from "../../_lib/dbUtil.js";

const TYPES = ["ground", "resort", "space"];
const KV_PREFIX = "game_default_vehicle:";

function kvKey(type) {
  return `${KV_PREFIX}${type}`;
}

function sanitizeVehicleId(v) {
  const s = String(v || "").trim();
  return s || "";
}

function sanitizeRecord(rec) {
  if (!rec || typeof rec !== "object") return null;

  const vehicleId = sanitizeVehicleId(rec.vehicleId);
  if (!vehicleId) return null;

  return {
    vehicleId,
    updatedAt: String(rec.updatedAt || ""),
    updatedBy: String(rec.updatedBy || ""),
  };
}

async function readDefaultsFromKv(env) {
  const defaults = {};
  for (const t of TYPES) {
    const rec = await env.VF_KV_GAME_DEFAULTS.get(kvKey(t), { type: "json" });
    defaults[t] = sanitizeRecord(rec);
  }
  return defaults;
}

async function readDefaultsFromD1(env) {
  const db = env?.VF_D1_STATS;
  if (!db) return null;
  const ok = await tableExists(db, "vf_game_default_vehicles");
  if (!ok) return null;

  const placeholders = TYPES.map(() => "?").join(",");
  const rs = await db
    .prepare(
      `SELECT competition_type, vehicle_id, updated_at_ms, updated_by_login
       FROM vf_game_default_vehicles
       WHERE competition_type IN (${placeholders})`,
    )
    .bind(...TYPES)
    .all();

  const defaults = {};
  for (const t of TYPES) defaults[t] = null;

  for (const r of Array.isArray(rs?.results) ? rs.results : []) {
    const type = String(r?.competition_type || "").trim().toLowerCase();
    if (!type || !TYPES.includes(type)) continue;
    const vehicleId = sanitizeVehicleId(r?.vehicle_id);
    if (!vehicleId) continue;
    defaults[type] = {
      vehicleId,
      updatedAt: isoFromMs(r?.updated_at_ms),
      updatedBy: String(r?.updated_by_login || ""),
    };
  }

  return defaults;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  // Prefer D1
  try {
    const d1Defaults = await readDefaultsFromD1(env);
    if (d1Defaults) {
      return jsonResponse(request, { ok: true, defaults: d1Defaults, meta: { source: "d1" } });
    }
  } catch {
    // fall back to KV
  }

  // Legacy KV fallback
  if (!env?.VF_KV_GAME_DEFAULTS) {
    return jsonResponse(
      request,
      { error: "kv_not_bound", message: "Missing KV binding: VF_KV_GAME_DEFAULTS" },
      500,
    );
  }

  const defaults = await readDefaultsFromKv(env);
  return jsonResponse(request, { ok: true, defaults, meta: { source: "kv" } });
}
