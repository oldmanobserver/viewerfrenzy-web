// functions/api/v1/maps/[mapId].js
// Soft-delete a map (Track Editor) by id.
//
// NOTE:
// - This endpoint is for the Unity game / community users.
// - It does NOT permanently delete the vf_maps row.
// - It sets vf_maps.deleted=1 so the map is hidden from the game,
//   but remains visible in the admin UI for auditing / permanent deletion.

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { nowMs, tableExists, toStr } from "../../../_lib/dbUtil.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";

function toInt(v, def = 0) {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : def;
}

function isNoSuchColumnError(e, colName) {
  const msg = String(e?.message || e || "").toLowerCase();
  const c = String(colName || "").toLowerCase();
  return msg.includes("no such column") && (!c || msg.includes(c));
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // CORS preflight
  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "DELETE") {
    return jsonResponse(request, { ok: false, error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth?.ok) return auth.response;
  const userId = toStr(auth?.user?.userId);

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { ok: false, error: "missing_db" }, 500);
  }

  const ok = await tableExists(db, "vf_maps");
  if (!ok) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: "missing_table",
        message: "vf_maps table is missing. Run DB migrations in manage.viewerfrenzy.com → Database (/db.html).",
      },
      503,
    );
  }

  const id = toInt(params?.mapId);
  if (!id) {
    return jsonResponse(request, { ok: false, error: "invalid_id" }, 400);
  }

  // Fetch record (ownership check)
  let row = null;
  try {
    row = await db
      .prepare("SELECT id, created_by_user_id, deleted FROM vf_maps WHERE id = ? LIMIT 1")
      .bind(id)
      .first();
  } catch (e) {
    // If the 'deleted' column doesn't exist yet, we can still validate ownership,
    // but we must fail the delete with a clear upgrade message.
    if (!isNoSuchColumnError(e, "deleted")) {
      return jsonResponse(request, { ok: false, error: "db_error", message: String(e?.message || e) }, 500);
    }

    row = await db
      .prepare("SELECT id, created_by_user_id FROM vf_maps WHERE id = ? LIMIT 1")
      .bind(id)
      .first();

    return jsonResponse(
      request,
      {
        ok: false,
        error: "missing_deleted_column",
        message: "vf_maps.deleted is missing. Run the next DB migration (v0.15) in manage.viewerfrenzy.com → Database (/db.html).",
      },
      503,
    );
  }

  if (!row) {
    return jsonResponse(request, { ok: false, error: "not_found" }, 404);
  }

  const ownerId = toStr(row?.created_by_user_id);
  if (!ownerId || ownerId !== userId) {
    return jsonResponse(
      request,
      { ok: false, error: "not_owner", message: "Only the map creator can delete this map." },
      403,
    );
  }

  // Already deleted → idempotent success
  if (Number(row?.deleted || 0) !== 0) {
    return jsonResponse(request, { ok: true, mapId: id, deleted: true, message: "Map already deleted." }, 200);
  }

  // Soft-delete
  const ms = nowMs();
  try {
    await db.prepare("UPDATE vf_maps SET deleted = 1, updated_at_ms = ? WHERE id = ?").bind(ms, id).run();
  } catch (e) {
    return jsonResponse(request, { ok: false, error: "db_error", message: String(e?.message || e) }, 500);
  }

  return jsonResponse(request, { ok: true, mapId: id, deleted: true, updatedAtMs: ms }, 200);
}
