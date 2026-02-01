// functions/api/v1/streamer/roles/index.js
//
// Streamer-only API for managing streamer-scoped (ViewerFrenzy) custom roles.
//
// Storage (v0.22+): D1
// - vf_streamer_roles
// - vf_streamer_role_users
//
// NOTE:
// These roles are UNIQUE PER STREAMER and are COMPLETELY SEPARATE from:
// - Twitch roles (moderator/vip/editor)
// - ViewerFrenzy admin roles (managed on manage.viewerfrenzy.com)

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { isoFromMs, nowMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
}

function isValidRoleId(id) {
  return /^[a-z0-9_-]{1,32}$/.test(String(id || "").trim());
}

function normalizeRoleRow(row) {
  const roleId = toStr(row?.roleId ?? row?.role_id).toLowerCase();
  const roleName = toStr(row?.roleName ?? row?.role_name) || roleId;
  const userCount = Number(row?.userCount ?? row?.user_count ?? 0) || 0;
  const createdAtMs = Number(row?.createdAtMs ?? row?.created_at_ms ?? 0) || 0;
  const updatedAtMs = Number(row?.updatedAtMs ?? row?.updated_at_ms ?? 0) || 0;

  return {
    roleId,
    roleName,
    userCount,
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

async function nextAvailableRoleId(db, streamerUserId, baseId) {
  // If it's unused, return it.
  const exists = await db
    .prepare("SELECT 1 AS ok FROM vf_streamer_roles WHERE streamer_user_id = ? AND role_id = ? LIMIT 1")
    .bind(streamerUserId, baseId)
    .first();
  if (!exists) return baseId;

  // Try suffixes: base-2, base-3, ...
  for (let i = 2; i <= 50; i++) {
    const candidate = `${baseId}-${i}`.slice(0, 32);
    const row = await db
      .prepare("SELECT 1 AS ok FROM vf_streamer_roles WHERE streamer_user_id = ? AND role_id = ? LIMIT 1")
      .bind(streamerUserId, candidate)
      .first();
    if (!row) return candidate;
  }

  // Last resort: base-<random>
  const rand = Math.random().toString(36).slice(2, 8);
  return `${baseId}-${rand}`.slice(0, 32);
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (!["GET", "POST"].includes(request.method)) {
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

  // ---------------------------------------------------------------------------
  // GET: list roles (with user counts)
  // ---------------------------------------------------------------------------
  if (request.method === "GET") {
    const rs = await db
      .prepare(
        `SELECT
           r.role_id as roleId,
           r.role_name as roleName,
           r.created_at_ms as createdAtMs,
           r.updated_at_ms as updatedAtMs,
           COUNT(DISTINCT us.user_id) as userCount
         FROM vf_streamer_roles r
         LEFT JOIN vf_streamer_role_users ru
           ON ru.streamer_user_id = r.streamer_user_id AND ru.role_id = r.role_id
         LEFT JOIN vf_user_streamers us
           ON us.user_id = ru.user_id AND us.streamer_user_id = r.streamer_user_id
         WHERE r.streamer_user_id = ?
         GROUP BY r.role_id, r.role_name, r.created_at_ms, r.updated_at_ms
         ORDER BY LOWER(r.role_name) ASC, r.role_id ASC`,
      )
      .bind(streamerUserId)
      .all();

    const roles = (Array.isArray(rs?.results) ? rs.results : []).map(normalizeRoleRow);

    return jsonResponse(request, {
      ok: true,
      streamer: {
        userId: streamerUserId,
        login: streamerLogin,
      },
      roles,
    });
  }

  // ---------------------------------------------------------------------------
  // POST: create role
  // ---------------------------------------------------------------------------
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const roleName = toStr(body?.roleName || body?.name);
  let requestedId = toStr(body?.roleId).toLowerCase();

  if (!roleName) {
    return jsonResponse(request, { error: "role_name_required", message: "Role name is required." }, 400);
  }

  if (!requestedId) {
    requestedId = slugify(roleName);
  }

  if (!requestedId) {
    return jsonResponse(request, { error: "role_id_required", message: "Role id is required." }, 400);
  }

  if (!isValidRoleId(requestedId)) {
    return jsonResponse(
      request,
      {
        error: "invalid_role_id",
        message: "Role id is invalid. Use only a-z, 0-9, underscore, or hyphen (max 32 chars).",
      },
      400,
    );
  }

  const roleId = await nextAvailableRoleId(db, streamerUserId, requestedId);
  const ms = nowMs();

  await db
    .prepare(
      `INSERT INTO vf_streamer_roles (streamer_user_id, role_id, role_name, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(streamerUserId, roleId, roleName, ms, ms)
    .run();

  const row = await db
    .prepare(
      `SELECT role_id as roleId, role_name as roleName, created_at_ms as createdAtMs, updated_at_ms as updatedAtMs
       FROM vf_streamer_roles
       WHERE streamer_user_id = ? AND role_id = ?`,
    )
    .bind(streamerUserId, roleId)
    .first();

  return jsonResponse(
    request,
    {
      ok: true,
      role: {
        ...normalizeRoleRow(row),
        userCount: 0,
      },
    },
    201,
  );
}
