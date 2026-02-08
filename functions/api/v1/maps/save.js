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
import { nowMs, tableExists, toStr, toBool } from "../../../_lib/dbUtil.js";

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isNonEmptyString(s) {
  return typeof s === "string" && s.trim().length > 0;
}

function isNoSuchColumnError(e, colName) {
  const msg = String(e?.message || e || "").toLowerCase();
  const c = String(colName || "").toLowerCase();
  return msg.includes("no such column") && (!c || msg.includes(c));
}

function isUniqueConstraintError(e, indexName) {
  const msg = String(e?.message || e || "");
  const low = msg.toLowerCase();

  // D1 typically formats this as:
  // "D1_ERROR: UNIQUE constraint failed: index 'idx_vf_maps_name_active_ci': SQLITE_CONSTRAINT"
  const isUnique = low.includes("unique constraint failed") || low.includes("sqlite_constraint");
  if (!isUnique) return false;

  if (!indexName) return low.includes("unique constraint failed");
  return low.includes(String(indexName).toLowerCase());
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS")
    return handleOptions(request);

  if (request.method !== "POST")
    return jsonResponse(request, { ok: false, error: "method_not_allowed" }, 405);

  const access = await requireWebsiteUser(context);
  if (!access.ok) return access.response;
  const authUser = access.user;

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

  // Optional map preview images (PNG base64). Older clients won't send these.
  const thumbPngBase64 = toStr(map?.thumbPngBase64);
  const imagePngBase64 = toStr(map?.imagePngBase64);

  const thumbPngBytes = decodePngBase64(thumbPngBase64, 600_000);
  if (thumbPngBytes?.error)
    return jsonResponse(request, { ok: false, error: "bad_thumb", message: thumbPngBytes.error }, 400);

  const imagePngBytes = decodePngBase64(imagePngBase64, 3_000_000);
  if (imagePngBytes?.error)
    return jsonResponse(request, { ok: false, error: "bad_image", message: imagePngBytes.error }, 400);

  const now = nowMs();

  // Enforce unique name (case-insensitive)
  // For updates, allow keeping same name.
  if (id > 0) {
    let existing = null;
    try {
      existing = await db
        .prepare("SELECT id, name, created_by_user_id, created_by_login, created_at_ms, updated_at_ms, deleted FROM vf_maps WHERE id = ? LIMIT 1")
        .bind(id)
        .first();
    } catch (e) {
      // Back-compat: DB hasn't run migration v0.15 yet.
      if (!isNoSuchColumnError(e, "deleted")) throw e;
      existing = await db
        .prepare("SELECT id, name, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1")
        .bind(id)
        .first();
    }

    if (!existing)
      return jsonResponse(request, { ok: false, error: "not_found", message: `Map ${id} not found.` }, 404);

    // If soft-deleted, treat as gone (do not allow updates).
    if (toBool(existing?.deleted))
      return jsonResponse(request, { ok: false, error: "deleted", message: `Map ${id} has been deleted.` }, 410);

    if (toStr(existing?.created_by_user_id) !== toStr(authUser?.userId))
      return jsonResponse(request, { ok: false, error: "not_owner", message: "You do not own this map." }, 403);

    let clash = null;
    try {
      clash = await db
        .prepare("SELECT id FROM vf_maps WHERE lower(name) = lower(?) AND id <> ? AND deleted = 0 LIMIT 1")
        .bind(name, id)
        .first();
    } catch (e) {
      if (!isNoSuchColumnError(e, "deleted")) throw e;
      clash = await db
        .prepare("SELECT id FROM vf_maps WHERE lower(name) = lower(?) AND id <> ? LIMIT 1")
        .bind(name, id)
        .first();
    }

    if (clash)
      return jsonResponse(request, { ok: false, error: "name_taken", message: "A map with that name already exists." }, 409);

    try {
      await db
        .prepare(
          `UPDATE vf_maps
           SET name = ?, map_json = ?, map_version = ?, map_hash_sha256 = ?, vehicle_type = ?, game_mode = ?, updated_at_ms = ?
           WHERE id = ?`,
        )
        .bind(name, json, mapVersion, mapHash, vehicleType, gameMode, now, id)
        .run();
    } catch (e) {
      // Race safety: someone else could insert/rename between our clash check and the UPDATE.
      if (isUniqueConstraintError(e, "idx_vf_maps_name_active_ci")) {
        return jsonResponse(request, { ok: false, error: "name_taken", message: "A map with that name already exists." }, 409);
      }
      throw e;
    }

    // Map JSON changed -> reset cached finish time (it will be recomputed after new competitions are posted).
    await tryResetMapFinishTimeMs(db, id);

    // Save/replace preview images (if provided)
    await tryUpdateMapImages(db, id, thumbPngBytes?.bytes, imagePngBytes?.bytes);

    let updated = null;
    try {
      updated = await db
        .prepare(
          "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms, deleted FROM vf_maps WHERE id = ? LIMIT 1",
        )
        .bind(id)
        .first();
    } catch (e) {
      if (!isNoSuchColumnError(e, "deleted")) throw e;
      updated = await db
        .prepare(
          "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1",
        )
        .bind(id)
        .first();
    }

    const finishTimeMs = await safeSelectFinishTimeMs(db, id);

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
        finishTimeMs,
        deleted: toBool(updated?.deleted),
      },
    });
  }

  // Create
  let clash = null;
  try {
    clash = await db
      .prepare("SELECT id FROM vf_maps WHERE lower(name) = lower(?) AND deleted = 0 LIMIT 1")
      .bind(name)
      .first();
  } catch (e) {
    if (!isNoSuchColumnError(e, "deleted")) throw e;
    clash = await db
      .prepare("SELECT id FROM vf_maps WHERE lower(name) = lower(?) LIMIT 1")
      .bind(name)
      .first();
  }

  if (clash)
    return jsonResponse(request, { ok: false, error: "name_taken", message: "A map with that name already exists." }, 409);

  // NOTE: even with the clash check above, two parallel creates can still race:
  // both SELECTs may see no row, then one INSERT succeeds and the other hits the UNIQUE index.
  // We handle that here to avoid returning a 500.
  let ins = null;
  try {
    ins = await db
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
        toStr(authUser?.userId),
        toStr(authUser?.login),
        now,
        now,
      )
      .run();
  } catch (e) {
    if (!isUniqueConstraintError(e, "idx_vf_maps_name_active_ci")) throw e;

    // Another request likely created it first (double-click / pump overlap).
    // Fetch the existing map and:
    // - if it's owned by this user AND it was created very recently, treat this as an idempotent create/update
    // - otherwise return name_taken (409)
    let existing = null;
    try {
      existing = await db
        .prepare("SELECT id, created_by_user_id, created_by_login, created_at_ms, updated_at_ms, deleted FROM vf_maps WHERE lower(name) = lower(?) AND deleted = 0 LIMIT 1")
        .bind(name)
        .first();
    } catch (e2) {
      if (!isNoSuchColumnError(e2, "deleted")) throw e2;
      existing = await db
        .prepare("SELECT id, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE lower(name) = lower(?) LIMIT 1")
        .bind(name)
        .first();
    }

    const existingId = Number(existing?.id || 0) || 0;
    const existingCreatedAt = Number(existing?.created_at_ms || 0) || 0;
    const sameOwner = toStr(existing?.created_by_user_id) === toStr(authUser?.userId);

    // Only auto-heal if this looks like a duplicate request from the same user.
    // (Avoid silently overwriting an older map in the rare case the client lost its id.)
    const isRecentDuplicate = existingId > 0 && sameOwner && existingCreatedAt > 0 && (now - existingCreatedAt) <= 15_000;

    if (!isRecentDuplicate)
      return jsonResponse(request, { ok: false, error: "name_taken", message: "A map with that name already exists." }, 409);

    // Idempotent behaviour: update the row using the payload from this request.
    await db
      .prepare(
        `UPDATE vf_maps
         SET name = ?, map_json = ?, map_version = ?, map_hash_sha256 = ?, vehicle_type = ?, game_mode = ?, updated_at_ms = ?
         WHERE id = ?`,
      )
      .bind(name, json, mapVersion, mapHash, vehicleType, gameMode, now, existingId)
      .run();

    await tryResetMapFinishTimeMs(db, existingId);
    await tryUpdateMapImages(db, existingId, thumbPngBytes?.bytes, imagePngBytes?.bytes);

    let row = null;
    try {
      row = await db
        .prepare(
          "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms, deleted FROM vf_maps WHERE id = ? LIMIT 1",
        )
        .bind(existingId)
        .first();
    } catch (e3) {
      if (!isNoSuchColumnError(e3, "deleted")) throw e3;
      row = await db
        .prepare(
          "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1",
        )
        .bind(existingId)
        .first();
    }

    const finishTimeMs = await safeSelectFinishTimeMs(db, existingId);

    return jsonResponse(request, {
      ok: true,
      map: {
        id: Number(row?.id) || existingId,
        name: toStr(row?.name) || name,
        version: Number(row?.map_version || 0) || 0,
        hashSha256: toStr(row?.map_hash_sha256),
        vehicleType: toStr(row?.vehicle_type),
        gameMode: toStr(row?.game_mode),
        createdByUserId: toStr(row?.created_by_user_id),
        createdByLogin: toStr(row?.created_by_login),
        createdAtMs: Number(row?.created_at_ms || 0) || 0,
        updatedAtMs: Number(row?.updated_at_ms || 0) || 0,
        finishTimeMs,
        deleted: toBool(row?.deleted),
      },
    });
  }

  const newId = Number(ins?.meta?.last_row_id || 0) || 0;

  // Save preview images (if provided)
  await tryUpdateMapImages(db, newId, thumbPngBytes?.bytes, imagePngBytes?.bytes);

  let created = null;
  try {
    created = await db
      .prepare(
        "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms, deleted FROM vf_maps WHERE id = ? LIMIT 1",
      )
      .bind(newId)
      .first();
  } catch (e) {
    if (!isNoSuchColumnError(e, "deleted")) throw e;
    created = await db
      .prepare(
        "SELECT id, name, map_version, map_hash_sha256, vehicle_type, game_mode, created_by_user_id, created_by_login, created_at_ms, updated_at_ms FROM vf_maps WHERE id = ? LIMIT 1",
      )
      .bind(newId)
      .first();
  }

  const finishTimeMs = await safeSelectFinishTimeMs(db, newId);

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
      finishTimeMs,
      deleted: toBool(created?.deleted),
    },
  });
}

async function safeSelectFinishTimeMs(db, mapId) {
  if (!db || !mapId) return 0;
  try {
    const row = await db.prepare("SELECT finish_time_ms FROM vf_maps WHERE id = ? LIMIT 1").bind(mapId).first();
    return Number(row?.finish_time_ms || 0) || 0;
  } catch (e) {
    // Back-compat: DB hasn't run migration v0.17 yet.
    if (isNoSuchColumnError(e, "finish_time_ms")) return 0;
    throw e;
  }
}

async function tryResetMapFinishTimeMs(db, mapId) {
  if (!db || !mapId) return;
  try {
    await db.prepare("UPDATE vf_maps SET finish_time_ms = NULL WHERE id = ?").bind(mapId).run();
  } catch (e) {
    // Back-compat: DB hasn't run migration v0.17 yet.
    if (!isNoSuchColumnError(e, "finish_time_ms")) throw e;
  }
}

function decodePngBase64(value, maxBytes) {
  if (!value) return { bytes: null };

  // Allow either plain base64 or a data URL.
  let b64 = value.trim();
  const dataPrefix = "data:image/png;base64,";
  if (b64.toLowerCase().startsWith(dataPrefix))
    b64 = b64.slice(dataPrefix.length).trim();

  // Basic sanity check.
  if (b64.length < 16) return { bytes: null };

  let raw = null;
  try {
    raw = atob(b64);
  } catch {
    return { bytes: null, error: "Invalid base64 image data." };
  }

  const len = raw.length;
  if (maxBytes && len > maxBytes) return { bytes: null, error: `Image too large (${len} bytes).` };

  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = raw.charCodeAt(i);

  // PNG signature check (89 50 4E 47 0D 0A 1A 0A)
  if (len >= 8) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) return { bytes: null, error: "Image must be a PNG." };
    }
  }

  return { bytes };
}

async function tryUpdateMapImages(db, mapId, thumbBytes, imageBytes) {
  if (!mapId) return;
  const sets = [];
  const binds = [];

  if (thumbBytes && thumbBytes.byteLength > 0) {
    sets.push("thumb_png = ?");
    binds.push(thumbBytes);
  }

  if (imageBytes && imageBytes.byteLength > 0) {
    sets.push("image_png = ?");
    binds.push(imageBytes);
  }

  if (!sets.length) return;

  try {
    await db.prepare(`UPDATE vf_maps SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, mapId).run();
  } catch (e) {
    // DB not migrated yet (no columns) -> ignore for backward compatibility.
    if (!isNoSuchColumnError(e, "thumb_png") && !isNoSuchColumnError(e, "image_png")) throw e;
  }
}
