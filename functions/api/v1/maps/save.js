// functions/api/v1/maps/save.js
//
// Authenticated endpoint (website user) for creating/updating Track Editor maps.
//
// POST body:
// {
//   "map": {
//     "id": 0,                 // optional; omit/0 for create
//     "name": "My Track",
//     "json": "{...}",        // required; MapData JSON string
//     "version": 3,            // optional
//     "hashSha256": "...",    // optional
//     "vehicleType": "ground",// optional
//     "gameMode": "Race"      // optional
//   }
// }
//
// Rules:
// - Create: id is auto-increment INTEGER starting at 1.
// - Update: only the creator (created_by_user_id) can update.
// - Name is globally unique (case-insensitive).

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";
import { nowMs, tableExists, toStr } from "../../../_lib/dbUtil.js";

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS")
    return handleOptions(request);

  if (request.method !== "POST")
    return jsonResponse(request, { ok: false, error: "method_not_allowed" }, 405);

  const access = await requireWebsiteUser(request, env);
  if (access instanceof Response) return access;

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

  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const map = body?.map;
  const id = toInt(map?.id || 0, 0);
  const name = toStr(map?.name);
  const json = typeof map?.json === "string" ? map.json : "";

  if (!name)
    return jsonResponse(request, { ok: false, error: "bad_request", message: "map.name is required." }, 400);

  if (name.length > 80)
    return jsonResponse(request, { ok: false, error: "bad_request", message: "map.name is too long (max 80)." }, 400);

  if (!isNonEmptyString(json))
    return jsonResponse(request, { ok: false, error: "bad_request", message: "map.json is required." }, 400);

  // Basic guard against accidental huge uploads. (Still allow big tracks.)
  if (json.length > 2_000_000)
    return jsonResponse(request, { ok: false, error: "bad_request", message: "map.json is too large." }, 400);

  const mapVersion = toInt(map?.version, null);
  const mapHash = toStr(map?.hashSha256);
  const vehicleType = toStr(map?.vehicleType);
  const gameMode = toStr(map?.gameMode);

  const now = nowMs();

  // Enforce unique name (case-insensitive)
  // For updates, allow keeping same name.
  if (id > 0) {
    const existing = await db
      .prepare("SELECT id, name, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1")
      .bind(id)
      .first();

    if (!existing)
      return jsonResponse(request, { ok: false, error: "not_found", message: `Map ${id} not found.` }, 404);

    if (toStr(existing?.created_by_user_id) !== toStr(access?.userId))
      return jsonResponse(request, { ok: false, error: "not_owner", message: "You do not own this map." }, 403);

    const clash = await db
      .prepare("SELECT id FROM vf_maps WHERE lower(name) = lower(?) AND id <> ? LIMIT 1")
      .bind(name, id)
      .first();

    if (clash)
      return jsonResponse(request, { ok: false, error: "name_taken", message: "A map with that name already exists." }, 409);

    await db
      .prepare(
        `UPDATE vf_maps
         SET name = ?, map_json = ?, map_version = ?, map_hash_sha256 = ?, vehicle_type = ?, game_mode = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .bind(name, json, mapVersion, mapHash, vehicleType, gameMode, now, id)
      .run();

    const updated = await db
      .prepare(
        "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1",
      )
      .bind(id)
      .first();

    return jsonResponse(request, {
      ok: true,
      map: {
        id: Number(updated?.id) || id,
        name: toStr(updated?.name),
        version: Number(updated?.map_version || 0) || 0,
        hashSha256: toStr(updated?.map_hash_sha256),
        vehicleType: toStr(updated?.vehicle_type),
        gameMode: toStr(updated?.game_mode),
        createdByUserId: toStr(updated?.created_by_user_id),
        createdByLogin: toStr(updated?.created_by_login),
        createdAtMs: Number(updated?.created_at_ms || 0) || 0,
        updatedAtMs: Number(updated?.updated_at_ms || 0) || 0,
      },
    });
  }

  // Create
  const clash = await db
    .prepare("SELECT id FROM vf_maps WHERE lower(name) = lower(?) LIMIT 1")
    .bind(name)
    .first();

  if (clash)
    return jsonResponse(request, { ok: false, error: "name_taken", message: "A map with that name already exists." }, 409);

  const ins = await db
    .prepare(
      `INSERT INTO vf_maps (
        name, map_json, map_version, map_hash_sha256, vehicle_type, game_mode,
        created_by_user_id, created_by_login, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      name,
      json,
      mapVersion,
      mapHash,
      vehicleType,
      gameMode,
      toStr(access?.userId),
      toStr(access?.login),
      now,
      now,
    )
    .run();

  const newId = Number(ins?.meta?.last_row_id || 0) || 0;

  const created = await db
    .prepare(
      "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1",
    )
    .bind(newId)
    .first();

  return jsonResponse(request, {
    ok: true,
    map: {
      id: Number(created?.id) || newId,
      name: toStr(created?.name),
      version: Number(created?.map_version || 0) || 0,
      hashSha256: toStr(created?.map_hash_sha256),
      vehicleType: toStr(created?.vehicle_type),
      gameMode: toStr(created?.game_mode),
      createdByUserId: toStr(created?.created_by_user_id),
      createdByLogin: toStr(created?.created_by_login),
      createdAtMs: Number(created?.created_at_ms || 0) || 0,
      updatedAtMs: Number(created?.updated_at_ms || 0) || 0,
    },
  });
}
