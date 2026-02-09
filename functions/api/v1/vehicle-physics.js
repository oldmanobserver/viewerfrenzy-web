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
  computeCodeDefaultRaceTuning,
  computeCodeDefaultVehiclePhysics,
  computeEffectiveRaceTuning,
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

async function fetchRaceTuningFromDb(db, competitionType) {
  const codeDefaults = computeCodeDefaultRaceTuning(competitionType);

  const hasDefaultsTable = await tableExists(db, "vf_vehicle_physics_defaults");
  if (!hasDefaultsTable) return codeDefaults;

  // Race tuning columns were added in v0.30. If not present, return code defaults.
  const hasTuningCols = await columnExists(db, "vf_vehicle_physics_defaults", "max_catchup_boost");
  if (!hasTuningCols) return codeDefaults;

  try {
    const row = await db
      .prepare(
        "SELECT enable_pack_balancing, pack_balancing_start_delay_s, pack_balancing_update_interval_s, catchup_distance_for_max_boost_m, max_catchup_boost, lead_gap_for_max_drag_m, max_leader_drag, smooth_pack_balancing_ramp_in, pack_balancing_ramp_in_s, enable_slipstream, slipstream_range_m, slipstream_max_boost, slipstream_front_drag, enable_lead_swap_pressure, lead_hold_grace_s, lead_hold_ramp_s, max_lead_hold_drag, max_challenger_boost, lead_swap_pressure_max_gap_m FROM vf_vehicle_physics_defaults WHERE competition_type = ? LIMIT 1"
      )
      .bind(competitionType)
      .first();

    if (!row) return codeDefaults;

    return computeEffectiveRaceTuning(codeDefaults, row);
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
  let defaultsOverride = null;
  let tuningOverride = null;

  if (request.method === "GET") {
    const url = new URL(request.url);
    competitionType = normalizeCompetitionType(url.searchParams.get("competitionType") || "");
    const csv = url.searchParams.get("ids") || "";
    ids = sanitizeVehicleIds(csv.split(","));
  } else {
    const body = await readJsonBody(request);
    competitionType = normalizeCompetitionType(body?.competitionType || "");
    ids = sanitizeVehicleIds(body?.vehicleIds);

    // Optional per-map overrides (MapData.vehiclePhysicsOverrides)
    if (body?.defaultsOverride && typeof body.defaultsOverride === "object" && !Array.isArray(body.defaultsOverride))
      defaultsOverride = body.defaultsOverride;
    if (body?.tuningOverride && typeof body.tuningOverride === "object" && !Array.isArray(body.tuningOverride))
      tuningOverride = body.tuningOverride;
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

  let defaults = await fetchDefaultsFromDb(db, competitionType);
  let tuning = await fetchRaceTuningFromDb(db, competitionType);

  // Apply request-level overrides *on top of* DB defaults.
  // This is used for per-map physics overrides.
  if (defaultsOverride)
  {
    defaults = computeEffectiveVehiclePhysics(defaults, {
      physics_linear_damping: defaultsOverride.linearDamping,
      physics_angular_damping: defaultsOverride.angularDamping,
      physics_friction: defaultsOverride.friction,
      physics_bounciness: defaultsOverride.bounciness,
      physics_lateral_grip: defaultsOverride.lateralGrip,
      physics_collision_impulse_mult: defaultsOverride.collisionImpulseMult,
      physics_collision_spin_mult: defaultsOverride.collisionSpinMult,
    });
  }

  if (tuningOverride)
  {
    tuning = computeEffectiveRaceTuning(tuning, {
      enable_pack_balancing: tuningOverride.enablePackBalancing,
      pack_balancing_start_delay_s: tuningOverride.packBalancingStartDelaySeconds,
      pack_balancing_update_interval_s: tuningOverride.packBalancingUpdateInterval,
      catchup_distance_for_max_boost_m: tuningOverride.catchupDistanceForMaxBoost,
      max_catchup_boost: tuningOverride.maxCatchupBoost,
      lead_gap_for_max_drag_m: tuningOverride.leadGapForMaxDrag,
      max_leader_drag: tuningOverride.maxLeaderDrag,
      smooth_pack_balancing_ramp_in: tuningOverride.smoothPackBalancingRampIn,
      pack_balancing_ramp_in_s: tuningOverride.packBalancingRampInSeconds,

      enable_slipstream: tuningOverride.enableSlipstream,
      slipstream_range_m: tuningOverride.slipstreamRangeMeters,
      slipstream_max_boost: tuningOverride.slipstreamMaxBoost,
      slipstream_front_drag: tuningOverride.slipstreamFrontDrag,

      enable_lead_swap_pressure: tuningOverride.enableLeadSwapPressure,
      lead_hold_grace_s: tuningOverride.leadHoldGraceSeconds,
      lead_hold_ramp_s: tuningOverride.leadHoldRampSeconds,
      max_lead_hold_drag: tuningOverride.maxLeadHoldDrag,
      max_challenger_boost: tuningOverride.maxChallengerBoost,
      lead_swap_pressure_max_gap_m: tuningOverride.leadSwapPressureMaxGapMeters,
    });
  }

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
    tuning,
    vehicles,
    missing,
  });
}
