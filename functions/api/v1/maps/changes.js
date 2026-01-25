// functions/api/v1/maps/changes.js
//
// Public endpoint for getting map changes since a timestamp.
//
// GET /api/v1/maps/changes?since=0&includeJson=1&limit=200
//
// Response:
// {
//   ok: true,
//   serverTimeMs: 1700000000000,
//   since: 0,
//   maps: [
//     {
//       id: 1,
//       name: "My Track",
//       version: 3,
//       hashSha256: "...",
//       vehicleType: "ground",
//       gameMode: "Race",
//       createdByUserId: "123",
//       createdByLogin: "streamer",
//       createdAtMs: 1700000000000,
//       updatedAtMs: 1700000000000,
//       json: "{...}" // only if includeJson=1
//     }
//   ]
// }

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { nowMs, tableExists, toStr, toBool } from "../../../_lib/dbUtil.js";

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS")
    return handleOptions(request);

  if (request.method !== "GET")
    return jsonResponse(request, { ok: false, error: "method_not_allowed" }, 405);

  const db = env?.VF_D1_STATS;
  if (!db)
    return jsonResponse(request, { ok: false, error: "missing_db", message: "VF_D1_STATS binding not configured." }, 500);

  const okMaps = await tableExists(db, "vf_maps");
  if (!okMaps)
    return jsonResponse(
      request,
      {
        ok: false,
        error: "missing_table",
        message: "vf_maps table is missing. Run DB migrations (viewerfrenzy-web-admin).",
      },
      500,
    );

  const url = new URL(request.url);
  const since = toInt(url.searchParams.get("since"), 0);
  const includeJson = toBool(url.searchParams.get("includeJson"));
  let limit = toInt(url.searchParams.get("limit"), 200);
  if (limit <= 0) limit = 200;
  limit = Math.min(limit, 500);

  const cols = [
    "id",
    "name",
    "map_version",
    "map_hash_sha256",
    "vehicle_type",
    "game_mode",
    "created_by_user_id",
    "created_by_login",
    "created_at_ms",
    "updated_at_ms",
  ];

  if (includeJson) cols.push("map_json AS json");

  const where = since > 0 ? "WHERE updated_at_ms > ?" : "";

  const stmt = `SELECT ${cols.join(", ")} FROM vf_maps ${where} ORDER BY updated_at_ms ASC, id ASC LIMIT ?`;

  const rs = since > 0
    ? await db.prepare(stmt).bind(since, limit).all()
    : await db.prepare(stmt).bind(limit).all();

  const rows = Array.isArray(rs?.results) ? rs.results : [];

  const out = rows.map((r) => ({
    id: Number(r?.id || 0) || 0,
    name: toStr(r?.name),
    version: Number(r?.map_version || 0) || 0,
    hashSha256: toStr(r?.map_hash_sha256),
    vehicleType: toStr(r?.vehicle_type),
    gameMode: toStr(r?.game_mode),
    createdByUserId: toStr(r?.created_by_user_id),
    createdByLogin: toStr(r?.created_by_login),
    createdAtMs: Number(r?.created_at_ms || 0) || 0,
    updatedAtMs: Number(r?.updated_at_ms || 0) || 0,
    json: includeJson ? (typeof r?.json === "string" ? r.json : "") : undefined,
  }));

  // Remove json key if not requested (keeps response tidy)
  if (!includeJson) {
    for (const o of out) delete o.json;
  }

  return jsonResponse(request, {
    ok: true,
    serverTimeMs: nowMs(),
    since,
    maps: out,
  });
}
