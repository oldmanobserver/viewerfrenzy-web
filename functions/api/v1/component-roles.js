// functions/api/v1/component-roles.js
//
// Public (no-auth) endpoint used by the Unity Track Editor to populate the
// role dropdown when the palette is in "Components" mode.
//
// Storage (v0.24+): D1
// - vf_component_roles
// - vf_component_role_competitions
// - vf_component_role_assignments
// - vf_components
//
// Transitional fallback (pre-v0.24):
// - vf_vehicle_roles
// - vf_vehicle_role_competitions
// - vf_component_role_assignments (vehicle_role_id)

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { tableExists, toStr } from "../../_lib/dbUtil.js";

const COMPETITION_TYPES = ["ground", "resort", "space", "trackfield", "water", "winter"];

function isValidRoleId(id) {
  return /^[a-z0-9_-]{1,48}$/.test(String(id || "").trim());
}

function normalizeRoleFromDb(roleRow, flagsSet, itemCount, defaultTypesSet) {
  const roleId = toStr(roleRow?.role_id).toLowerCase();
  const flags = {};
  for (const t of COMPETITION_TYPES) flags[t] = flagsSet?.has(t) || false;
  const defaultCompetitions = Array.from(defaultTypesSet || [])
    .map((s) => String(s || "").trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return {
    roleId,
    name: toStr(roleRow?.name) || roleId,
    description: toStr(roleRow?.description),
    ...flags,
    isDefault: defaultCompetitions.length > 0,
    defaultCompetitions,
    itemCount: Number(itemCount || 0) || 0,
  };
}

async function componentRolesDbEnabled(db) {
  return (await tableExists(db, "vf_component_roles")) && (await tableExists(db, "vf_component_role_competitions"));
}

async function vehicleRolesDbEnabled(db) {
  return (await tableExists(db, "vf_vehicle_roles")) && (await tableExists(db, "vf_vehicle_role_competitions"));
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const includeEmpty = url.searchParams.get("includeEmpty") === "1";

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { ok: true, roles: [], meta: { source: "none", reason: "d1_not_bound" } });
  }

  const useComponentRoles = await componentRolesDbEnabled(db);
  const useVehicleFallback = !useComponentRoles && (await vehicleRolesDbEnabled(db));
  if (!useComponentRoles && !useVehicleFallback) {
    return jsonResponse(request, { ok: true, roles: [], meta: { source: "none", reason: "tables_missing" } });
  }

  const rolesTable = useComponentRoles ? "vf_component_roles" : "vf_vehicle_roles";
  const compsTable = useComponentRoles ? "vf_component_role_competitions" : "vf_vehicle_role_competitions";
  const roleIdCol = useComponentRoles ? "component_role_id" : "vehicle_role_id";
  const defaultsTable = useComponentRoles ? "vf_component_role_defaults" : "vf_vehicle_role_defaults";
  const defaultsRoleCol = useComponentRoles ? "component_role_id" : "vehicle_role_id";

  // v0.24 renamed assignment column: vehicle_role_id -> component_role_id
  let assignRoleCol = "component_role_id";
  try {
    if (await tableExists(db, "vf_component_role_assignments")) {
      const info = await db.prepare("PRAGMA table_info(vf_component_role_assignments)").all();
      const cols = new Set((info?.results || []).map((r) => String(r?.name || "").trim()));
      if (!cols.has("component_role_id") && cols.has("vehicle_role_id")) {
        assignRoleCol = "vehicle_role_id";
      }
    }
  } catch {
    assignRoleCol = "vehicle_role_id";
  }

  // 1) Roles
  const roleRows = await db
    .prepare(
      `SELECT ${roleIdCol} AS role_id, name, description
       FROM ${rolesTable}
       ORDER BY ${roleIdCol}`,
    )
    .all();

  // 2) Competition flags
  const compRows = await db
    .prepare(
      `SELECT ${roleIdCol} AS role_id, competition_type
       FROM ${compsTable}`,
    )
    .all();

  const compByRole = new Map();
  for (const r of Array.isArray(compRows?.results) ? compRows.results : []) {
    const rid = toStr(r?.role_id).toLowerCase();
    const type = toStr(r?.competition_type).toLowerCase();
    if (!rid || !type) continue;
    if (!compByRole.has(rid)) compByRole.set(rid, new Set());
    compByRole.get(rid).add(type);
  }

  // 2.5) Per-competition defaults (optional until v0.25 migration is applied).
  const defaultByRole = new Map();
  if (await tableExists(db, defaultsTable)) {
    const defRows = await db
      .prepare(
        `SELECT competition_type, ${defaultsRoleCol} AS role_id
         FROM ${defaultsTable}`,
      )
      .all();

    for (const r of Array.isArray(defRows?.results) ? defRows.results : []) {
      const rid = toStr(r?.role_id).toLowerCase();
      const type = toStr(r?.competition_type).toLowerCase();
      if (!rid || !type) continue;
      if (!defaultByRole.has(rid)) defaultByRole.set(rid, new Set());
      defaultByRole.get(rid).add(type);
    }
  }

  // 3) Item counts (enabled components) per role
  const countByRole = new Map();
  const canCount =
    (await tableExists(db, "vf_component_role_assignments")) &&
    (await tableExists(db, "vf_components"));

  if (canCount) {
    const countRs = await db
      .prepare(
        `SELECT LOWER(a.${assignRoleCol}) AS role_id, COUNT(DISTINCT a.component_id) AS item_count
         FROM vf_component_role_assignments a
         JOIN vf_components c ON c.component_id = a.component_id
         WHERE c.disabled = 0
         GROUP BY LOWER(a.${assignRoleCol})`,
      )
      .all();

    for (const r of Array.isArray(countRs?.results) ? countRs.results : []) {
      const rid = toStr(r?.role_id).toLowerCase();
      const n = Number(r?.item_count || 0) || 0;
      if (rid) countByRole.set(rid, n);
    }
  }

  const roles = [];
  for (const rr of Array.isArray(roleRows?.results) ? roleRows.results : []) {
    const rid = toStr(rr?.role_id).toLowerCase();
    if (!rid || !isValidRoleId(rid)) continue;
    const itemCount = countByRole.get(rid) || 0;
    if (!includeEmpty && itemCount <= 0) continue;
    roles.push(normalizeRoleFromDb(rr, compByRole.get(rid), itemCount, defaultByRole.get(rid)));
  }

  return jsonResponse(request, {
    ok: true,
    roles,
    meta: {
      source: useComponentRoles ? "component_roles" : "vehicle_roles_fallback",
      includeEmpty,
    },
  });
}
