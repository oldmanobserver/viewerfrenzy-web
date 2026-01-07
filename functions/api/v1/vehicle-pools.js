// functions/api/v1/vehicle-pools.js
//
// Public endpoint used by:
// - viewerfrenzy.com garage to decide which vehicles to show per competition type
// - ViewerFrenzy Unity game to pick a fallback vehicle when a user has no default
//
// Requires KV bindings:
// - VF_KV_VEHICLE_POOLS (preferred; precomputed for fast reads)
// - VF_KV_VEHICLE_ROLES (fallback compute)
// - VF_KV_VEHICLE_ASSIGNMENTS (fallback compute)

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

  // Cache: this endpoint is hit frequently (garage + Unity). Once we have
  // VF_KV_VEHICLE_POOLS it is already O(1) (single KV read). We still keep a very
  // short edge cache to reduce KV reads under load.
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
    computed.headers.set("Cache-Control", "public, max-age=5");
    await caches.default.put(cacheKey, computed.clone());
    return computed;
  } catch {
    // If cache API fails for any reason, fall back to normal computation.
  }

  return buildPoolsResponse(request, env);
}

async function buildPoolsResponse(request, env) {
  // Preferred path: a single O(1) KV read.
  // The admin site maintains this record any time roles/assignments change.
  if (env.VF_KV_VEHICLE_POOLS) {
    try {
      const rec = await env.VF_KV_VEHICLE_POOLS.get("current", { type: "json" });
      if (rec && typeof rec === "object" && rec.pools && typeof rec.pools === "object") {
        const normalizedPools = Object.fromEntries(
          COMPETITIONS.map((c) => {
            const p = rec.pools?.[c] || null;
            const eligibleIds = Array.isArray(p?.eligibleIds) ? p.eligibleIds : [];
            const defaultIds = Array.isArray(p?.defaultIds) ? p.defaultIds : [];
            return [c, { eligibleIds, defaultIds }];
          }),
        );

        return jsonResponse(request, {
          ok: true,
          source: "precomputed",
          version: rec.version ?? 1,
          generatedAt: rec.generatedAt || new Date().toISOString(),
          updatedBy: rec.updatedBy || "",
          reason: rec.reason || "",
          counts: rec.counts || undefined,
          ...(Array.isArray(rec.warnings) && rec.warnings.length ? { warnings: rec.warnings } : {}),
          pools: normalizedPools,
          disabledIds: Array.isArray(rec.disabledIds) ? rec.disabledIds : [],
        });
      }
    } catch {
      // Fall through to computed path.
    }
  }

  // Fallback path: compute from roles + assignments. This is slower and should
  // only happen if the pools KV is not bound yet or has not been seeded.
  if (!env.VF_KV_VEHICLE_ROLES || !env.VF_KV_VEHICLE_ASSIGNMENTS) {
    return jsonResponse(request, {
      ok: true,
      source: "empty",
      warning: "KV bindings missing: VF_KV_VEHICLE_POOLS (preferred) and/or VF_KV_VEHICLE_ROLES / VF_KV_VEHICLE_ASSIGNMENTS",
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
    source: "computed",
    ...(warnings.length ? { warnings } : {}),
    generatedAt: new Date().toISOString(),
    pools: Object.fromEntries(
      COMPETITIONS.map((c) => [c, { eligibleIds: Array.from(pools[c]).sort(), defaultIds: Array.from(defaults[c]).sort() }]),
    ),
    disabledIds: Array.from(disabledIds).sort(),
  };

  // Best-effort: store computed result so future reads are O(1) even if the admin
  // site hasn't rebuilt pools yet.
  if (env.VF_KV_VEHICLE_POOLS) {
    try {
      const record = {
        version: 1,
        generatedAt: resp.generatedAt,
        pools: resp.pools,
        disabledIds: resp.disabledIds,
        ...(warnings.length ? { warnings } : {}),
        updatedBy: "",
        reason: "computed_fallback",
      };
      await env.VF_KV_VEHICLE_POOLS.put("current", JSON.stringify(record));
    } catch {
      // ignore
    }
  }

  return jsonResponse(request, resp);
}
