// functions/api/v1/vehicle-defaults/[type].js
import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireTwitchUser } from "../../../_lib/twitchAuth.js";

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

  const auth = await requireTwitchUser(context);
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
