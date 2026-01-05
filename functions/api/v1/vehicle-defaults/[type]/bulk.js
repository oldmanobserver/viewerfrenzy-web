// functions/api/v1/vehicle-defaults/[type]/bulk.js
import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";

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

  const type = params.type;
  const kv = getKvForType(env, type);
  if (!kv) {
    return jsonResponse(
      request,
      {
        error: "unknown_vehicle_type_or_kv_not_bound",
        vehicleType: type,
      },
      400,
    );
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

  const userIdsRaw = body?.userIds ?? body?.user_ids ?? body?.ids ?? null;
  if (!Array.isArray(userIdsRaw)) {
    return jsonResponse(request, { error: "missing_userIds_array" }, 400);
  }

  // Basic hygiene: limit batch size.
  const MAX = 200;
  const ids = userIdsRaw
    .map((x) => (x ?? "").toString().trim())
    .filter((x) => x.length > 0)
    .slice(0, MAX);

  // Deduplicate while preserving order.
  const seen = new Set();
  const userIds = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    userIds.push(id);
  }

  const records = await Promise.all(
    userIds.map(async (userId) => {
      const value = await kv.get(userId, { type: "json" });

      if (value === null) {
        return {
          userId,
          found: false,
          vehicleId: "",
          updatedAt: null,
        };
      }

      // Support older formats (string value) just in case.
      if (typeof value === "string") {
        return {
          userId,
          found: true,
          vehicleId: value,
          updatedAt: null,
        };
      }

      return {
        userId,
        found: true,
        vehicleId: (value?.vehicleId ?? "").toString(),
        updatedAt: value?.updatedAt ?? null,
      };
    }),
  );

  return jsonResponse(request, {
    ok: true,
    vehicleType: (type || "").toLowerCase(),
    requestedBy: auth.validated.user_id,
    records,
  });
}
