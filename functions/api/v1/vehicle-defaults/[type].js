// functions/api/v1/vehicle-defaults/[type].js
import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";

const COMPETITIONS = ["ground", "resort", "space", "trackfield", "water", "winter"];

function normalizeAssignment(raw, vehicleId) {
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
  if (!obj || typeof obj !== "object") return null;
  const vid = String(obj.vehicleId || vehicleId || "").trim();
  if (!vid) return null;

  const roles = {};
  const r = obj.roles;
  if (Array.isArray(r)) {
    for (const it of r) {
      const rid = String(it?.roleId || "").trim().toLowerCase();
      if (!rid) continue;
      roles[rid] = { isDefault: Boolean(it?.isDefault) };
    }
  } else if (r && typeof r === "object") {
    for (const [ridRaw, v] of Object.entries(r)) {
      const rid = String(ridRaw || "").trim().toLowerCase();
      if (!rid) continue;
      roles[rid] = { isDefault: Boolean(v?.isDefault ?? v) };
    }
  }

  return {
    vehicleId: vid,
    disabled: Boolean(obj.disabled),
    roles,
  };
}

async function validateVehicleEligibility(vehicleId, type, env) {
  const t = String(type || "").trim().toLowerCase();
  if (!vehicleId) return { ok: true }; // clearing default is always allowed
  if (!COMPETITIONS.includes(t)) return { ok: true }; // unknown type => don't block

  // If bindings are not configured yet, don't block (backwards compatible).
  if (!env.VF_KV_VEHICLE_ASSIGNMENTS || !env.VF_KV_VEHICLE_ROLES) {
    return { ok: true, skipped: "vehicle_roles_kv_not_bound" };
  }

  // If the assignment record isn't present yet, do not block.
  // (This allows a smooth rollout before seeding is complete.)
  const assignRaw = await env.VF_KV_VEHICLE_ASSIGNMENTS.get(vehicleId);
  const assignment = normalizeAssignment(assignRaw, vehicleId);
  if (!assignment) {
    return { ok: true, skipped: "no_vehicle_assignment_record" };
  }

  if (assignment.disabled) {
    return { ok: false, error: "vehicle_disabled" };
  }

  const roleIds = Object.keys(assignment.roles || {});
  if (roleIds.length === 0) {
    return { ok: false, error: "vehicle_not_assigned_to_any_role" };
  }

  // Check if any assigned role has the flag for this competition.
  for (const rid of roleIds) {
    const roleRaw = await env.VF_KV_VEHICLE_ROLES.get(rid);
    if (!roleRaw) continue;
    let role = null;
    try { role = JSON.parse(roleRaw); } catch { role = null; }
    if (!role || typeof role !== "object") continue;
    if (Boolean(role[t])) return { ok: true };
  }

  return { ok: false, error: "vehicle_not_eligible_for_type", vehicleType: t };
}

function getKvForType(env, type) {
  const t = (type || "").toLowerCase();

  const map = {
    ground: env.VF_KV_GROUND,
    resort: env.VF_KV_RESORT,
    space: env.VF_KV_SPACE,
    water: env.VF_KV_WATER,
    winter: env.VF_KV_WINTER,
    trackfield: env.VF_KV_TRACKFIELD,
  };

  return map[t] || null;
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const userId = auth.validated.user_id;
  const type = params.type;

  const kv = getKvForType(env, type);
  if (!kv) {
    return jsonResponse(request, {
      error: "unknown_vehicle_type_or_kv_not_bound",
      vehicleType: type,
    }, 400);
  }

  // ---------- GET ----------
  if (request.method === "GET") {
    const value = await kv.get(userId, { type: "json" });

    // Semantics:
    //  - value === null => no server record yet (client should not overwrite local preference)
    //  - value.vehicleId === "" => explicit Random
    return jsonResponse(request, {
      vehicleType: (type || "").toLowerCase(),
      userId,
      value: value || null,
    });
  }

  // ---------- PUT / POST ----------
  if (request.method === "PUT" || request.method === "POST") {
    let body = null;
    try { body = await request.json(); } catch { body = null; }

    const vehicleIdRaw = body?.vehicleId ?? body?.selectedVehicleId ?? body?.id ?? "";
    const vehicleId = (vehicleIdRaw ?? "").toString();

    // Enforce disabled / eligibility rules (role-based) when configured.
    const eligibility = await validateVehicleEligibility(vehicleId, type, env);
    if (!eligibility.ok) {
      return jsonResponse(request, { ok: false, ...eligibility }, 400);
    }

    const nowIso = new Date().toISOString();

    // IMPORTANT: store a record even for Random (vehicleId === "")
    // so we can distinguish "never set" from "explicit random".
    const record = {
      vehicleId,
      updatedAt: nowIso,
      clientUpdatedAtUnix: body?.clientUpdatedAtUnix ?? null,
    };

    await kv.put(userId, JSON.stringify(record));

    return jsonResponse(request, { ok: true, vehicleType: (type || "").toLowerCase(), userId, value: record });
  }

  return jsonResponse(request, { error: "method_not_allowed" }, 405);
}
