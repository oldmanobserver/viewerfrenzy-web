// functions/api/v1/vehicle-role-vehicles.js
//
// Public (no-auth) endpoint used by the Unity Track Editor to load the vehicles
// assigned to a specific Vehicle Role.
//
// Query params:
//   roleId=<vehicle_role_id>
//
// Storage: D1
// - vf_vehicle_assignments
// - vf_vehicle_assignment_roles

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { tableExists, toStr } from "../../_lib/dbUtil.js";

function isValidRoleId(id) {
  return /^[a-z0-9_-]{1,48}$/.test(String(id || "").trim());
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const roleId = toStr(url.searchParams.get("roleId")).toLowerCase();
  if (!roleId || !isValidRoleId(roleId)) {
    return jsonResponse(request, { ok: false, error: "invalid_role_id", message: "roleId is required." }, 400);
  }

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { ok: true, roleId, vehicleIds: [], meta: { source: "none", reason: "d1_not_bound" } });
  }

  const ok1 = await tableExists(db, "vf_vehicle_assignments");
  const ok2 = await tableExists(db, "vf_vehicle_assignment_roles");
  if (!ok1 || !ok2) {
    return jsonResponse(request, { ok: true, roleId, vehicleIds: [], meta: { source: "none", reason: "tables_missing" } });
  }

  const rs = await db
    .prepare(
      `SELECT DISTINCT ar.vehicle_id
       FROM vf_vehicle_assignment_roles ar
       JOIN vf_vehicle_assignments a ON a.vehicle_id = ar.vehicle_id
       WHERE LOWER(ar.vehicle_role_id) = ?
         AND a.disabled = 0
       ORDER BY ar.vehicle_id`,
    )
    .bind(roleId)
    .all();

  const vehicleIds = (rs?.results || [])
    .map((r) => toStr(r?.vehicle_id))
    .filter((s) => !!s);

  return jsonResponse(request, { ok: true, roleId, vehicleIds, meta: { source: "d1" } });
}
