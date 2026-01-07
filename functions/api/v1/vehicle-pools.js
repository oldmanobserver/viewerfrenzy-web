// functions/api/v1/vehicle-pools.js
//
// Public endpoint used by:
// - viewerfrenzy.com garage to decide which vehicles to show per competition type
// - ViewerFrenzy Unity game to pick a fallback vehicle when a user has no default
//
// Requires KV bindings:
// - VF_KV_VEHICLE_ROLES
// - VF_KV_VEHICLE_ASSIGNMENTS

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { listAllJsonRecords } from "../../_lib/kv.js";

const COMPETITIONS = ["ground", "resort", "space", "trackfield", "water", "winter"];

function normalizeRole(r) {
  if (!r || typeof r !== "object") return null;
  const roleId = String(r.roleId || "").trim().toLowerCase();
  if (!roleId) return null;
  const out = { roleId };
  for (const c of COMPETITIONS) out[c] = Boolean(r[c]);
  return out;
}

function normalizeAssignment(a) {
  if (!a || typeof a !== "object") return null;
  const vehicleId = String(a.vehicleId || "").trim();
  if (!vehicleId) return null;

  const roles = {};
  const raw = a.roles;
  if (Array.isArray(raw)) {
    for (const r of raw) {
      const rid = String(r?.roleId || "").trim().toLowerCase();
      if (!rid) continue;
      roles[rid] = { isDefault: Boolean(r?.isDefault) };
    }
  } else if (raw && typeof raw === "object") {
    for (const [ridRaw, v] of Object.entries(raw)) {
      const rid = String(ridRaw || "").trim().toLowerCase();
      if (!rid) continue;
      roles[rid] = { isDefault: Boolean(v?.isDefault ?? v) };
    }
  }

  return {
    vehicleId,
    disabled: Boolean(a.disabled),
    roles,
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return jsonResponse(request, { ok: false, error: "Method not allowed" }, 405);
  }

  // If KV bindings are missing (misconfigured env), return a safe empty payload.
  if (!env.VF_KV_VEHICLE_ROLES || !env.VF_KV_VEHICLE_ASSIGNMENTS) {
    return jsonResponse(request, {
      ok: true,
      warning: "KV bindings missing: VF_KV_VEHICLE_ROLES / VF_KV_VEHICLE_ASSIGNMENTS",
      generatedAt: new Date().toISOString(),
      pools: Object.fromEntries(COMPETITIONS.map((c) => [c, { eligibleIds: [], defaultIds: [] }])),
      disabledIds: [],
    });
  }

  const [rolesRaw, assignsRaw] = await Promise.all([
    listAllJsonRecords(env.VF_KV_VEHICLE_ROLES),
    listAllJsonRecords(env.VF_KV_VEHICLE_ASSIGNMENTS),
  ]);

  const roleById = new Map();
  for (const r of rolesRaw) {
    const nr = normalizeRole(r);
    if (nr) roleById.set(nr.roleId, nr);
  }

  const pools = {};
  const defaults = {};
  for (const c of COMPETITIONS) {
    pools[c] = new Set();
    defaults[c] = new Set();
  }

  const disabledIds = new Set();

  for (const a of assignsRaw) {
    const na = normalizeAssignment(a);
    if (!na) continue;

    if (na.disabled) {
      disabledIds.add(na.vehicleId);
      continue;
    }

    for (const [rid, v] of Object.entries(na.roles || {})) {
      const role = roleById.get(rid);
      if (!role) continue;
      for (const c of COMPETITIONS) {
        if (!role[c]) continue;
        pools[c].add(na.vehicleId);
        if (v?.isDefault) defaults[c].add(na.vehicleId);
      }
    }
  }

  const resp = {
    ok: true,
    generatedAt: new Date().toISOString(),
    pools: Object.fromEntries(
      COMPETITIONS.map((c) => [c, { eligibleIds: Array.from(pools[c]).sort(), defaultIds: Array.from(defaults[c]).sort() }]),
    ),
    disabledIds: Array.from(disabledIds).sort(),
  };

  return jsonResponse(request, resp);
}
