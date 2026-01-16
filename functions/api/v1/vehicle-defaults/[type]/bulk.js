// functions/api/v1/vehicle-defaults/[type]/bulk.js
//
// Authenticated bulk lookup of saved defaults for many users.
// (Used by the Unity game to preload defaults for viewers in the current lobby.)
//
// New storage (v0.6+): D1
// - vf_viewer_default_vehicles
//
// Legacy fallback (pre-v0.6): KV per competition type

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { isoFromMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";

const COMPETITIONS = ["ground", "resort", "space", "trackfield", "water", "winter"];

function getKvForType(env, type) {
  const t = toStr(type).toLowerCase();
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

function normalizeUserIds(userIds) {
  if (!Array.isArray(userIds)) return [];
  return Array.from(
    new Set(userIds.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 200)),
  );
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const type = toStr(params?.type).toLowerCase();
  if (!COMPETITIONS.includes(type)) {
    return jsonResponse(request, { error: "unknown_vehicle_type", vehicleType: type }, 400);
  }

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const userIds = normalizeUserIds(body?.userIds);
  if (userIds.length === 0) {
    return jsonResponse(request, { ok: true, vehicleType: type, values: {}, meta: { count: 0 } });
  }

  // Prefer D1
  try {
    const db = env?.VF_D1_STATS;
    if (db && (await tableExists(db, "vf_viewer_default_vehicles"))) {
      const placeholders = userIds.map(() => "?").join(",");
      const rs = await db
        .prepare(
          `SELECT viewer_user_id, vehicle_id, updated_at_ms, client_updated_at_unix
           FROM vf_viewer_default_vehicles
           WHERE competition_type = ? AND viewer_user_id IN (${placeholders})`,
        )
        .bind(type, ...userIds)
        .all();

      const out = {};
      for (const uid of userIds) out[uid] = null;

      for (const r of Array.isArray(rs?.results) ? rs.results : []) {
        const uid = toStr(r?.viewer_user_id);
        if (!uid) continue;
        out[uid] = {
          vehicleId: toStr(r?.vehicle_id),
          updatedAt: isoFromMs(r?.updated_at_ms),
          clientUpdatedAtUnix: r?.client_updated_at_unix ?? null,
        };
      }

      return jsonResponse(request, {
        ok: true,
        vehicleType: type,
        values: out,
        meta: { count: userIds.length, source: "d1" },
      });
    }
  } catch {
    // fall back to KV
  }

  // KV fallback
  const kv = getKvForType(env, type);
  if (!kv) {
    return jsonResponse(
      request,
      { error: "storage_not_configured", message: "Neither D1 nor KV bindings are available." },
      500,
    );
  }

  const out = {};
  for (const uid of userIds) {
    out[uid] = (await kv.get(uid, { type: "json" })) || null;
  }

  return jsonResponse(request, {
    ok: true,
    vehicleType: type,
    values: out,
    meta: { count: userIds.length, source: "kv" },
  });
}
