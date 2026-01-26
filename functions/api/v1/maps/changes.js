// functions/api/v1/maps/changes.js
//
// Public endpoint for getting map changes since a timestamp.
//
// GET /api/v1/maps/changes?since=0&includeJson=1&limit=200
//
// Optional filters:
// - source=official|community   (requires DB migration v0.14+)
// - mine=1                      (requires Authorization; returns only the caller's maps)
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
//       source: "official",         // if DB has vf_maps.source (v0.14+); otherwise defaults to "community"
//       createdByUserId: "123",
//       createdByLogin: "streamer",
//       createdAtMs: 1700000000000,
//       updatedAtMs: 1700000000000,
//       deleted: false,             // if DB has vf_maps.deleted (v0.15+); otherwise defaults to false
//       json: "{...}"               // only if includeJson=1 (deleted maps return json="")
//     }
//   ]
// }

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";
import { nowMs, tableExists, toStr, toBool } from "../../../_lib/dbUtil.js";

function toInt(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}

function isNoSuchColumnError(e, colName) {
  const msg = String(e?.message || e || "").toLowerCase();
  const c = String(colName || "").toLowerCase();
  return msg.includes("no such column") && (!c || msg.includes(c));
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") return jsonResponse(request, { ok: false, error: "method_not_allowed" }, 405);

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { ok: false, error: "missing_db", message: "VF_D1_STATS binding not configured." }, 500);
  }

  const okMaps = await tableExists(db, "vf_maps");
  if (!okMaps) {
    return jsonResponse(
      request,
      {
        ok: false,
        error: "missing_table",
        message: "vf_maps table is missing. Run DB migrations (viewerfrenzy-web-admin).",
      },
      500,
    );
  }

  const url = new URL(request.url);

  const since = toInt(url.searchParams.get("since"), 0);
  const includeJson = toBool(url.searchParams.get("includeJson"));
  const mine = toBool(url.searchParams.get("mine"));

  const sourceRaw = toStr(url.searchParams.get("source")).toLowerCase().trim();
  const sourceFilter = sourceRaw === "official" || sourceRaw === "community" ? sourceRaw : "";
  if (sourceRaw && !sourceFilter) {
    return jsonResponse(request, { ok: false, error: "bad_request", message: "source must be 'official' or 'community'." }, 400);
  }

  let limit = toInt(url.searchParams.get("limit"), 200);
  if (limit <= 0) limit = 200;
  limit = Math.min(limit, 500);

  // "mine" requires auth so callers can't enumerate other users' private maps.
  let mineUserId = "";
  if (mine) {
    const access = await requireWebsiteUser(context);
    if (!access.ok) return access.response;
    mineUserId = toStr(access?.user?.userId);
    if (!mineUserId) {
      return jsonResponse(request, { ok: false, error: "auth_error", message: "Missing userId in auth session." }, 401);
    }
  }

  // Back-compat flags (older DBs may not have these columns yet).
  let hasDeleted = true; // v0.15+
  let hasSource = true;  // v0.14+

  async function runQuery() {
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

    if (hasSource) cols.push("source");
    if (hasDeleted) cols.push("deleted");

    // If a map is deleted, we intentionally do not return JSON payloads (bandwidth + not needed).
    if (includeJson) {
      if (hasDeleted) cols.push("CASE WHEN deleted = 0 THEN map_json ELSE '' END AS json");
      else cols.push("map_json AS json");
    }

    const whereParts = [];
    const binds = [];

    if (since > 0) {
      whereParts.push("updated_at_ms > ?");
      binds.push(since);
    }

    if (mine) {
      whereParts.push("created_by_user_id = ?");
      binds.push(mineUserId);
    }

    if (sourceFilter && hasSource) {
      whereParts.push("source = ?");
      binds.push(sourceFilter);
    }

    const where = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
    const stmt = `SELECT ${cols.join(", ")} FROM vf_maps ${where} ORDER BY updated_at_ms ASC, id ASC LIMIT ?`;

    binds.push(limit);

    try {
      return await db.prepare(stmt).bind(...binds).all();
    } catch (e) {
      // Auto-fallback for DBs that haven't run the newest migrations yet.
      if (hasDeleted && isNoSuchColumnError(e, "deleted")) {
        hasDeleted = false;
        return await runQuery();
      }
      if (hasSource && isNoSuchColumnError(e, "source")) {
        hasSource = false;
        return await runQuery();
      }
      throw e;
    }
  }

  const rs = await runQuery();
  const rows = Array.isArray(rs?.results) ? rs.results : [];

  const out = rows.map((r) => ({
    id: Number(r?.id || 0) || 0,
    name: toStr(r?.name),
    version: Number(r?.map_version || 0) || 0,
    hashSha256: toStr(r?.map_hash_sha256),
    vehicleType: toStr(r?.vehicle_type),
    gameMode: toStr(r?.game_mode),
    source: hasSource ? toStr(r?.source) : "community",
    createdByUserId: toStr(r?.created_by_user_id),
    createdByLogin: toStr(r?.created_by_login),
    createdAtMs: Number(r?.created_at_ms || 0) || 0,
    updatedAtMs: Number(r?.updated_at_ms || 0) || 0,
    deleted: hasDeleted ? toBool(r?.deleted) : false,
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
