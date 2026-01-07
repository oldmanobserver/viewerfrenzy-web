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

  // Cache: this endpoint is hit frequently (garage + Unity), and the underlying KV data
  // changes relatively infrequently. Caching avoids repeated KV scans and makes the
  // response effectively instant after the first request.
  //
  // IMPORTANT: CORS varies by Origin. Include Origin in the cache key so we don't
  // serve the wrong Access-Control-Allow-Origin header.
  try {
    const origin = request.headers.get("Origin") || "";
    const cacheUrl = new URL(request.url);
    if (origin) cacheUrl.searchParams.set("__origin", origin);
    const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    // Compute response below and store it in cache before returning.
    const computed = await buildPoolsResponse(request, env);
    // Short TTL keeps admin edits reasonably fresh while still preventing stampedes.
    computed.headers.set("Cache-Control", "public, max-age=30");
    await caches.default.put(cacheKey, computed.clone());
    return computed;
  } catch {
    // If cache API fails for any reason, fall back to normal computation.
  }

  return buildPoolsResponse(request, env);
}

async function buildPoolsResponse(request, env) {
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

  const warnings = [];
  if (rolesRaw?._meta?.truncated) {
    warnings.push(`Vehicle roles KV had ${rolesRaw._meta.totalKeys} keys; only processed ${rolesRaw._meta.usedKeys}. Check KV binding.`);
  }
  if (assignsRaw?._meta?.truncated) {
    warnings.push(`Vehicle assignments KV had ${assignsRaw._meta.totalKeys} keys; only processed ${assignsRaw._meta.usedKeys}. Check KV binding.`);
  }

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
    ...(warnings.length ? { warnings } : {}),
    generatedAt: new Date().toISOString(),
    pools: Object.fromEntries(
      COMPETITIONS.map((c) => [c, { eligibleIds: Array.from(pools[c]).sort(), defaultIds: Array.from(defaults[c]).sort() }]),
    ),
    disabledIds: Array.from(disabledIds).sort(),
  };

  return jsonResponse(request, resp);
}
