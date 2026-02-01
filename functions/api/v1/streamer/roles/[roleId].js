// functions/api/v1/streamer/roles/[roleId].js
//
// Streamer-only API for updating/deleting a single streamer-scoped (ViewerFrenzy) role.

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { isoFromMs, nowMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";

function isValidRoleId(id) {
  return /^[a-z0-9_-]{1,32}$/.test(String(id || "").trim());
}

function normalizeRoleRow(row) {
  const roleId = toStr(row?.roleId ?? row?.role_id).toLowerCase();
  const roleName = toStr(row?.roleName ?? row?.role_name) || roleId;
  const createdAtMs = Number(row?.createdAtMs ?? row?.created_at_ms ?? 0) || 0;
  const updatedAtMs = Number(row?.updatedAtMs ?? row?.updated_at_ms ?? 0) || 0;

  return {
    roleId,
    roleName,
    createdAtMs: createdAtMs || null,
    updatedAtMs: updatedAtMs || null,
    createdAt: createdAtMs ? isoFromMs(createdAtMs) : "",
    updatedAt: updatedAtMs ? isoFromMs(updatedAtMs) : "",
  };
}

async function hasStreamerViewers(env, streamerUserId) {
  try {
    const db = env?.VF_D1_STATS;
    if (!db) return false;
    const ok = await tableExists(db, "vf_user_streamers");
    if (!ok) return false;

    const row = await db
      .prepare(
        `SELECT COUNT(1) as c
         FROM vf_user_streamers
         WHERE streamer_user_id = ? AND user_id != ?`,
      )
      .bind(streamerUserId, streamerUserId)
      .first();

    return Number(row?.c || 0) > 0;
  } catch {
    return false;
  }
}

async function ensureTables(db) {
  const okRoles = await tableExists(db, "vf_streamer_roles");
  const okRoleUsers = await tableExists(db, "vf_streamer_role_users");
  const okUserStreamers = await tableExists(db, "vf_user_streamers");

  return {
    ok: okRoles && okRoleUsers && okUserStreamers,
    missing: {
      vf_streamer_roles: !okRoles,
      vf_streamer_role_users: !okRoleUsers,
      vf_user_streamers: !okUserStreamers,
    },
  };
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (![["GET"], ["PUT"], ["DELETE"]].flat().includes(request.method)) {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const streamerUserId = toStr(auth.user?.userId);
  const streamerLogin = toStr(auth.user?.login).toLowerCase();
  if (!streamerUserId) {
    return jsonResponse(request, { error: "missing_streamer_user" }, 401);
  }

  // Streamer tools gating (consistent with /streamer/users)
  const okStreamer = await hasStreamerViewers(env, streamerUserId);
  if (!okStreamer) {
    return jsonResponse(
      request,
      {
        error: "not_streamer",
        message: "Streamer tools are available after at least one viewer joins your competitions.",
      },
      403,
    );
  }

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { error: "db_not_bound", message: "Missing D1 binding: VF_D1_STATS" }, 500);
  }

  const tables = await ensureTables(db);
  if (!tables.ok) {
    return jsonResponse(
      request,
      {
        error: "db_migration_required",
        message: "Missing required tables. Run DB migration v0.22+ (streamer custom roles).",
        missing: tables.missing,
      },
      500,
    );
  }

  const roleIdRaw = toStr(params?.roleId).toLowerCase();
  if (!roleIdRaw) {
    return jsonResponse(request, { error: "missing_roleId" }, 400);
  }
  if (!isValidRoleId(roleIdRaw)) {
    return jsonResponse(request, { error: "invalid_role_id" }, 400);
  }

  // ---------------------------------------------------------------------------
  // GET: fetch role
  // ---------------------------------------------------------------------------
  if (request.method === "GET") {
    const row = await db
      .prepare(
        `SELECT role_id as roleId, role_name as roleName, created_at_ms as createdAtMs, updated_at_ms as updatedAtMs
         FROM vf_streamer_roles
         WHERE streamer_user_id = ? AND role_id = ?`,
      )
      .bind(streamerUserId, roleIdRaw)
      .first();

    if (!row) {
      return jsonResponse(request, { error: "role_not_found" }, 404);
    }

    return jsonResponse(request, {
      ok: true,
      streamer: { userId: streamerUserId, login: streamerLogin },
      role: normalizeRoleRow(row),
    });
  }

  // ---------------------------------------------------------------------------
  // PUT: update role name
  // ---------------------------------------------------------------------------
  if (request.method === "PUT") {
    let body = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    const roleName = toStr(body?.roleName || body?.name);
    if (!roleName) {
      return jsonResponse(request, { error: "role_name_required", message: "Role name is required." }, 400);
    }

    const ms = nowMs();
    const res = await db
      .prepare(
        `UPDATE vf_streamer_roles
         SET role_name = ?, updated_at_ms = ?
         WHERE streamer_user_id = ? AND role_id = ?`,
      )
      .bind(roleName, ms, streamerUserId, roleIdRaw)
      .run();

    if (Number(res?.changes || 0) <= 0) {
      return jsonResponse(request, { error: "role_not_found" }, 404);
    }

    const row = await db
      .prepare(
        `SELECT role_id as roleId, role_name as roleName, created_at_ms as createdAtMs, updated_at_ms as updatedAtMs
         FROM vf_streamer_roles
         WHERE streamer_user_id = ? AND role_id = ?`,
      )
      .bind(streamerUserId, roleIdRaw)
      .first();

    return jsonResponse(request, {
      ok: true,
      streamer: { userId: streamerUserId, login: streamerLogin },
      role: normalizeRoleRow(row),
    });
  }

  // ---------------------------------------------------------------------------
  // DELETE: delete role and its assignments
  // ---------------------------------------------------------------------------
  const existing = await db
    .prepare("SELECT 1 AS ok FROM vf_streamer_roles WHERE streamer_user_id = ? AND role_id = ? LIMIT 1")
    .bind(streamerUserId, roleIdRaw)
    .first();

  if (!existing) {
    return jsonResponse(request, { error: "role_not_found" }, 404);
  }

  await db.batch([
    db
      .prepare("DELETE FROM vf_streamer_role_users WHERE streamer_user_id = ? AND role_id = ?")
      .bind(streamerUserId, roleIdRaw),
    db
      .prepare("DELETE FROM vf_streamer_roles WHERE streamer_user_id = ? AND role_id = ?")
      .bind(streamerUserId, roleIdRaw),
  ]);

  return jsonResponse(request, {
    ok: true,
    streamer: { userId: streamerUserId, login: streamerLogin },
    deleted: true,
    roleId: roleIdRaw,
  });
}
