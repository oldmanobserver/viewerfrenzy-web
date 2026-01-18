// functions/api/v1/vehicle-pools.js
//
// Public endpoint that returns per-competition vehicle pools:
// - eligibleIds: all eligible vehicles for that competition type
// - defaultIds: "competition default" vehicles (used when a viewer chooses Random)
//
// Caching strategy:
// - Prefer precomputed cache in KV (VF_KV_VEHICLE_POOLS)
// - If missing, compute from D1 (v0.6+)
// - Otherwise fall back to legacy KV config tables

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { listAllJsonRecords } from "../../_lib/kv.js";
import { tableExists, toStr, toBool } from "../../_lib/dbUtil.js";

const COMPETITIONS = ["ground", "resort", "space", "trackfield", "water", "winter"];

function buildEmptyPools() {
  const pools = {};
  for (const c of COMPETITIONS) {
    pools[c] = { eligibleIds: [], defaultIds: [] };
  }
  return pools;
}

function normalizePools(poolRecord) {
  const pools = buildEmptyPools();
  const inPools = poolRecord?.pools || {};
  for (const c of COMPETITIONS) {
    const p = inPools[c] || {};
    // Support both the current naming (eligibleIds/defaultIds) and legacy naming
    // (allVehicles/defaultVehicles) for compatibility.
    const eligible = Array.isArray(p.eligibleIds)
      ? p.eligibleIds
      : Array.isArray(p.allVehicles)
        ? p.allVehicles
        : [];

    const defaults = Array.isArray(p.defaultIds)
      ? p.defaultIds
      : Array.isArray(p.defaultVehicles)
        ? p.defaultVehicles
        : [];

    // de-dup and sanitize
    pools[c].eligibleIds = Array.from(new Set(eligible.map((x) => String(x || "").trim()).filter(Boolean))).sort();
    pools[c].defaultIds = Array.from(new Set(defaults.map((x) => String(x || "").trim()).filter(Boolean))).sort();
  }
  return pools;
}

function pickDefaultCache(pools) {
  const caches = { default: {} };
  for (const c of COMPETITIONS) {
    const d = pools[c]?.defaultIds || [];
    const a = pools[c]?.eligibleIds || [];
    caches.default[c] = d[0] || a[0] || "";
  }
  return caches;
}

async function computePoolsFromD1(env) {
  const db = env?.VF_D1_STATS;
  if (!db) return null;

  const ok =
    (await tableExists(db, "vf_vehicle_roles")) &&
    (await tableExists(db, "vf_vehicle_role_competitions")) &&
    (await tableExists(db, "vf_vehicle_assignments")) &&
    (await tableExists(db, "vf_vehicle_assignment_roles"));

  if (!ok) return null;

  // role -> set(competition_type)
  const roleIdsRs = await db.prepare("SELECT vehicle_role_id FROM vf_vehicle_roles").all();
  const roleIds = (roleIdsRs?.results || []).map((r) => toStr(r?.vehicle_role_id).toLowerCase()).filter(Boolean);

  const compByRole = new Map();
  for (const rid of roleIds) compByRole.set(rid, new Set());

  const compRs = await db.prepare("SELECT vehicle_role_id, competition_type FROM vf_vehicle_role_competitions").all();
  for (const r of Array.isArray(compRs?.results) ? compRs.results : []) {
    const rid = toStr(r?.vehicle_role_id).toLowerCase();
    const ct = toStr(r?.competition_type).toLowerCase();
    if (!rid || !ct) continue;
    if (!compByRole.has(rid)) compByRole.set(rid, new Set());
    compByRole.get(rid).add(ct);
  }

  // assignment base (disabled)
  const aRs = await db.prepare("SELECT vehicle_id, disabled, unlock_is_free, unlock_achievement_id FROM vf_vehicle_assignments").all();
  const assignments = new Map();
  for (const r of Array.isArray(aRs?.results) ? aRs.results : []) {
    const vid = toStr(r?.vehicle_id);
    if (!vid) continue;
    assignments.set(vid, {
      vehicleId: vid,
      disabled: toBool(r?.disabled),
      unlockIsFree: toBool(r?.unlock_is_free),
      unlockAchievementId: Number(r?.unlock_achievement_id || 0) || 0,
    });
  }

  // assignment roles
  const arRs = await db.prepare("SELECT vehicle_id, vehicle_role_id, is_default FROM vf_vehicle_assignment_roles").all();
  const rolesByVehicle = new Map();
  for (const r of Array.isArray(arRs?.results) ? arRs.results : []) {
    const vid = toStr(r?.vehicle_id);
    const rid = toStr(r?.vehicle_role_id).toLowerCase();
    if (!vid || !rid) continue;
    if (!rolesByVehicle.has(vid)) rolesByVehicle.set(vid, []);
    rolesByVehicle.get(vid).push({ roleId: rid, isDefault: toBool(r?.is_default) });
  }

  const pools = buildEmptyPools();
  const disabledVehicles = [];
  const unlockRules = {};

  for (const [vehicleId, a] of assignments.entries()) {
    if (a.disabled) {
      disabledVehicles.push(vehicleId);
      continue;
    }

    unlockRules[vehicleId] = {
      unlockIsFree: a.unlockIsFree,
      unlockAchievementId: a.unlockAchievementId,
    };

    const roleLinks = rolesByVehicle.get(vehicleId) || [];
    for (const link of roleLinks) {
      const comps = compByRole.get(link.roleId);
      if (!comps || comps.size === 0) continue;

      for (const ct of comps) {
        if (!COMPETITIONS.includes(ct)) continue;
        pools[ct].eligibleIds.push(vehicleId);
        if (link.isDefault) {
          pools[ct].defaultIds.push(vehicleId);
        }
      }
    }
  }

  // normalize
  const normalizedPools = normalizePools({ pools });

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    pools: normalizedPools,
    // Primary name used by the game client
    disabledIds: Array.from(new Set(disabledVehicles)).sort(),
    // Legacy name retained for backwards compatibility
    disabledVehicles: Array.from(new Set(disabledVehicles)).sort(),
    unlockRules,
    caches: pickDefaultCache(normalizedPools),
    meta: {
      computedFrom: "d1",
      counts: {
        roles: roleIds.length,
        assignments: assignments.size,
      },
    },
  };
}

async function computePoolsFromLegacyKv(env) {
  if (!env?.VF_KV_VEHICLE_ROLES || !env?.VF_KV_VEHICLE_ASSIGNMENTS) return null;

  const roles = await listAllJsonRecords(env.VF_KV_VEHICLE_ROLES);
  const roleById = {};
  for (const r of roles || []) {
    const rid = toStr(r?.roleId).toLowerCase();
    if (!rid) continue;
    roleById[rid] = r;
  }

  const assignments = await listAllJsonRecords(env.VF_KV_VEHICLE_ASSIGNMENTS);

  const pools = buildEmptyPools();
  const disabledVehicles = [];
  const unlockRules = {};

  for (const a of assignments || []) {
    const vehicleId = toStr(a?.vehicleId);
    if (!vehicleId) continue;

    if (toBool(a?.disabled)) {
      disabledVehicles.push(vehicleId);
      continue;
    }

    unlockRules[vehicleId] = {
      unlockIsFree: toBool(a?.unlockIsFree ?? a?.unlockFree ?? a?.unlock_no_achievement),
      unlockAchievementId: Number(a?.unlockAchievementId || 0) || 0,
    };

    const rolesObj = a?.roles || {};
    for (const [roleIdRaw, roleMeta] of Object.entries(rolesObj)) {
      const roleId = toStr(roleIdRaw).toLowerCase();
      const r = roleById[roleId];
      if (!r) continue;

      const isDefault = toBool(roleMeta?.isDefault ?? roleMeta);
      for (const ct of COMPETITIONS) {
        if (toBool(r?.[ct])) {
          pools[ct].eligibleIds.push(vehicleId);
          if (isDefault) pools[ct].defaultIds.push(vehicleId);
        }
      }
    }
  }

  const normalizedPools = normalizePools({ pools });

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    pools: normalizedPools,
    // Primary name used by the game client
    disabledIds: Array.from(new Set(disabledVehicles)).sort(),
    // Legacy name retained for backwards compatibility
    disabledVehicles: Array.from(new Set(disabledVehicles)).sort(),
    unlockRules,
    caches: pickDefaultCache(normalizedPools),
    meta: {
      computedFrom: "kv",
      counts: {
        roles: roles?.length || 0,
        assignments: assignments?.length || 0,
      },
    },
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  // 1) Prefer KV cache
  try {
    if (env?.VF_KV_VEHICLE_POOLS) {
      const cached = await env.VF_KV_VEHICLE_POOLS.get("current", { type: "json" });
      if (cached && typeof cached === "object") {
        return jsonResponse(request, {
          ok: true,
          ...cached,
          meta: { ...(cached.meta || {}), source: "kv_cache" },
        });
      }
    }
  } catch {
    // ignore
  }

  // 2) Compute from D1
  try {
    const computed = await computePoolsFromD1(env);
    if (computed) {
      // best-effort write-through cache (optional)
      try {
        if (env?.VF_KV_VEHICLE_POOLS) {
          await env.VF_KV_VEHICLE_POOLS.put("current", JSON.stringify(computed));
        }
      } catch {
        // ignore
      }

      return jsonResponse(request, { ok: true, ...computed, meta: { ...(computed.meta || {}), source: "d1" } });
    }
  } catch {
    // ignore
  }

  // 3) Legacy KV compute
  const legacy = await computePoolsFromLegacyKv(env);
  if (legacy) {
    return jsonResponse(request, { ok: true, ...legacy, meta: { ...(legacy.meta || {}), source: "kv" } });
  }

  // Nothing configured
  return jsonResponse(
    request,
    {
      ok: true,
      version: 2,
      generatedAt: new Date().toISOString(),
      pools: buildEmptyPools(),
      disabledIds: [],
      disabledVehicles: [],
      unlockRules: {},
      caches: pickDefaultCache(buildEmptyPools()),
      meta: { source: "empty", note: "No config bindings present" },
    },
    200,
  );
}
