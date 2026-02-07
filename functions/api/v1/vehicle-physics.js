// functions/api/v1/vehicle-physics.js
//
// Public endpoint used by Unity to fetch vehicle physics tuning at race start.
//
// Request:
//   POST { competitionType: "ground", vehicleIds: ["Vehicle_Delivery", ...] }
//   (or GET ?competitionType=ground&ids=Vehicle_Delivery,Vehicle_Firetruck)
//
// Response:
// {
//   ok: true,
//   competitionType: "ground",
//   defaults: { ... },
//   vehicles: [ { vehicleId, physics }, ... ],
//   missing: []
// }
//
// Notes:
// - Defaults come from vf_vehicle_physics_defaults (v0.28+).
// - Per-vehicle overrides come from nullable columns on vf_vehicle_assignments.
// - If DB isn't migrated yet, code defaults are used.

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { tableExists, columnExists } from "../../_lib/dbUtil.js";
import {
  computeCodeDefaultVehiclePhysics,
  computeEffectiveVehiclePhysics,
  isKnownCompetitionType,
  normalizeCompetitionType,
} from "../../_lib/vehiclePhysics.js";

const MAX_IDS = 500;

function sanitizeVehicleIds(ids) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (id.length > 128) continue;
    // Vehicle IDs are generated from Unity resources and can include uppercase.
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }

  return out;
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchDefaultsFromDb(db, competitionType) {
  const codeDefaults = computeCodeDefaultVehiclePhysics(competitionType);

  const hasDefaultsTable = await tableExists(db, "vf_vehicle_physics_defaults");
  if (!hasDefaultsTable) return codeDefaults;

  try {
    const row = await db
      .prepare(
        "SELECT linear_damping, angular_damping, friction, bounciness, lateral_grip, collision_impulse_mult, collision_spin_mult FROM vf_vehicle_physics_defaults WHERE competition_type = ? LIMIT 1"
      )
      .bind(competitionType)
      .first();

    if (!row) return codeDefaults;

    // Clamp/sanitize by treating the DB row as an override over code defaults.
    // (The defaults table uses explicit values, but this keeps the API robust.)
    return computeEffectiveVehiclePhysics(codeDefaults, {
      physics_linear_damping: row.linear_damping,
      physics_angular_damping: row.angular_damping,
      physics_friction: row.friction,
      physics_bounciness: row.bounciness,
      physics_lateral_grip: row.lateral_grip,
      physics_collision_impulse_mult: row.collision_impulse_mult,
      physics_collision_spin_mult: row.collision_spin_mult,
    });
  } catch {
    return codeDefaults;
  }
}

async function fetchVehicleOverrideRows(db, ids, hasOverrideCols) {
  if (!hasOverrideCols || !ids.length) return [];

  const cols = [
    "vehicle_id",
    "physics_linear_damping",
    "physics_angular_damping",
    "physics_friction",
    "physics_bounciness",
    "physics_lateral_grip",
    "physics_collision_impulse_mult",
    "physics_collision_spin_mult",
  ].join(", ");

  // Chunk IN(...) to stay safely under SQLite limits.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const rows = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT ${cols} FROM vf_vehicle_assignments WHERE vehicle_id IN (${placeholders})`;
    const resp = await db.prepare(sql).bind(...chunk).all();
    if (Array.isArray(resp?.results)) rows.push(...resp.results);
  }

  return rows;
}

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (!env?.VF_D1_STATS) {
    return jsonResponse(
      request,
      { ok: false, error: "missing_binding", message: "VF_D1_STATS binding is missing" },
      500
    );
  }

  if (request.method !== "POST" && request.method !== "GET") {
    return jsonResponse(request, { ok: false, error: "method_not_allowed" }, 405);
  }

  const db = env.VF_D1_STATS;

  // Read params
  let competitionType = "";
  let ids = [];

  if (request.method === "GET") {
    const url = new URL(request.url);
    competitionType = normalizeCompetitionType(url.searchParams.get("competitionType") || "");
    const csv = url.searchParams.get("ids") || "";
    ids = sanitizeVehicleIds(csv.split(","));
  } else {
    const body = await readJsonBody(request);
    competitionType = normalizeCompetitionType(body?.competitionType || "");
    ids = sanitizeVehicleIds(body?.vehicleIds);
  }

  if (!isKnownCompetitionType(competitionType)) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: "bad_competition_type",
        message: `Unknown competitionType '${competitionType}'. Expected one of: ground,resort,space,trackfield,water,winter`,
      },
      400
    );
  }

  const defaults = await fetchDefaultsFromDb(db, competitionType);

  // Overrides may not exist yet in some environments.
  const hasOverrideCols =
    (await tableExists(db, "vf_vehicle_assignments")) &&
    (await columnExists(db, "vf_vehicle_assignments", "physics_linear_damping"));

  const rows = await fetchVehicleOverrideRows(db, ids, hasOverrideCols);
  const byId = new Map();
  for (const r of Array.isArray(rows) ? rows : []) byId.set(String(r?.vehicle_id || ""), r);

  const vehicles = [];
  const missing = [];

  for (const id of ids) {
    const row = byId.get(id);
    if (!row) missing.push(id);
    vehicles.push({
      vehicleId: id,
      physics: computeEffectiveVehiclePhysics(defaults, row),
    });
  }

  return jsonResponse(request, {
    ok: true,
    competitionType,
    defaults,
    vehicles,
    missing,
  });
}
