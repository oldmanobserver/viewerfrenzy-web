// functions/api/v1/vehicle-roles.js
//
// Public (no-auth) endpoint used by the Unity Track Editor to populate the
// role dropdown when the palette is in "Vehicles" mode.
//
// Storage: D1
// - vf_vehicle_roles
// - vf_vehicle_role_competitions
// - vf_vehicle_assignments
// - vf_vehicle_assignment_roles

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

  const ok1 = await tableExists(db, "vf_vehicle_roles");
  const ok2 = await tableExists(db, "vf_vehicle_role_competitions");
  const ok3 = await tableExists(db, "vf_vehicle_assignments");
  const ok4 = await tableExists(db, "vf_vehicle_assignment_roles");
  if (!ok1 || !ok2 || !ok3 || !ok4) {
    return jsonResponse(request, { ok: true, roles: [], meta: { source: "none", reason: "tables_missing" } });
  }

  // 1) Roles
  const roleRows = await db
    .prepare(
      `SELECT vehicle_role_id AS role_id, name, description
       FROM vf_vehicle_roles
       ORDER BY vehicle_role_id`,
    )
    .all();

  // 2) Competition flags
  const compRows = await db
    .prepare(
      `SELECT vehicle_role_id AS role_id, competition_type
       FROM vf_vehicle_role_competitions`,
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
  if (await tableExists(db, "vf_vehicle_role_defaults")) {
    const defRows = await db
      .prepare(
        `SELECT competition_type, vehicle_role_id AS role_id
         FROM vf_vehicle_role_defaults`,
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

  // 3) Item counts (enabled vehicles) per role
  const countByRole = new Map();
  const countRs = await db
    .prepare(
      `SELECT LOWER(ar.vehicle_role_id) AS role_id, COUNT(DISTINCT ar.vehicle_id) AS item_count
       FROM vf_vehicle_assignment_roles ar
       JOIN vf_vehicle_assignments a ON a.vehicle_id = ar.vehicle_id
       WHERE a.disabled = 0
       GROUP BY LOWER(ar.vehicle_role_id)`,
    )
    .all();

  for (const r of Array.isArray(countRs?.results) ? countRs.results : []) {
    const rid = toStr(r?.role_id).toLowerCase();
    const n = Number(r?.item_count || 0) || 0;
    if (rid) countByRole.set(rid, n);
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
      source: "vehicle_roles",
      includeEmpty,
    },
  });
}
