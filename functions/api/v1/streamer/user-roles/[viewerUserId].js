// functions/api/v1/streamer/user-roles/[viewerUserId].js
//
// Streamer-only API to set ViewerFrenzy custom roles for a specific viewer.
//
// Route design note:
//   We intentionally keep this separate from /api/v1/streamer/users/[viewerUserId]
//   because that endpoint is used for deleting a viewer from the streamer list.
//   Cloudflare Pages Functions can't have both a [viewerUserId].js file AND a
//   [viewerUserId]/roles.js nested route.

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { nowMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";

function isValidRoleId(id) {
  return /^[a-z0-9_-]{1,32}$/.test(String(id || "").trim());
}

function uniqueRoleIds(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item || "").trim().toLowerCase();
    if (!id) continue;
    if (!isValidRoleId(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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

async function getStreamerRoleIdSet(db, streamerUserId) {
  const rs = await db
    .prepare("SELECT role_id as roleId FROM vf_streamer_roles WHERE streamer_user_id = ?")
    .bind(streamerUserId)
    .all();

  const set = new Set();
  for (const r of rs?.results || []) {
    const id = toStr(r?.roleId).toLowerCase();
    if (!id) continue;
    set.add(id);
  }
  return set;
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (!["GET", "PUT"].includes(request.method)) {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const streamerUserId = toStr(auth.user?.userId);
  const streamerLogin = toStr(auth.user?.login).toLowerCase();
  if (!streamerUserId) {
    return jsonResponse(request, { error: "missing_streamer_user" }, 401);
  }

  // Streamer tools gating
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

  const viewerUserId = toStr(params?.viewerUserId);
  if (!viewerUserId) {
    return jsonResponse(request, { error: "missing_viewerUserId" }, 400);
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
  // GET: list this viewer's role ids
  // ---------------------------------------------------------------------------
  if (request.method === "GET") {
    const rs = await db
      .prepare(
        `SELECT role_id as roleId
         FROM vf_streamer_role_users
         WHERE streamer_user_id = ? AND user_id = ?
         ORDER BY role_id`,
      )
      .bind(streamerUserId, viewerUserId)
      .all();

    const roleIds = (rs?.results || []).map((r) => toStr(r?.roleId).toLowerCase()).filter(Boolean);

    return jsonResponse(request, {
      ok: true,
      streamer: { userId: streamerUserId, login: streamerLogin },
      viewerUserId,
      roleIds,
    });
  }

  // ---------------------------------------------------------------------------
  // PUT: replace this viewer's roles with the provided roleIds
  // ---------------------------------------------------------------------------
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const requested = uniqueRoleIds(body?.roleIds || body?.roles || []);
  const validRoles = await getStreamerRoleIdSet(db, streamerUserId);
  const desired = requested.filter((id) => validRoles.has(id));

  // Current assignments for this viewer
  const cur = await db
    .prepare(
      `SELECT role_id as roleId
       FROM vf_streamer_role_users
       WHERE streamer_user_id = ? AND user_id = ?`,
    )
    .bind(streamerUserId, viewerUserId)
    .all();

  const current = new Set((cur?.results || []).map((r) => toStr(r?.roleId).toLowerCase()).filter(Boolean));

  const desiredSet = new Set(desired);
  const toAdd = [];
  const toRemove = [];
  let remainSame = 0;

  for (const id of desiredSet) {
    if (current.has(id)) remainSame++;
    else toAdd.push(id);
  }

  for (const id of current) {
    if (!desiredSet.has(id)) toRemove.push(id);
  }

  const ms = nowMs();
  const stmts = [];

  if (toRemove.length) {
    const qs = toRemove.map(() => "?").join(",");
    stmts.push(
      db
        .prepare(
          `DELETE FROM vf_streamer_role_users
           WHERE streamer_user_id = ? AND user_id = ? AND role_id IN (${qs})`,
        )
        .bind(streamerUserId, viewerUserId, ...toRemove),
    );
  }

  for (const id of toAdd) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO vf_streamer_role_users
           (streamer_user_id, role_id, user_id, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(streamerUserId, id, viewerUserId, ms, ms),
    );
  }

  if (stmts.length) {
    await db.batch(stmts);
  }

  return jsonResponse(request, {
    ok: true,
    streamer: { userId: streamerUserId, login: streamerLogin },
    viewerUserId,
    roleIds: desired,
    summary: {
      requestedCount: requested.length,
      validCount: desired.length,
      added: toAdd.length,
      removed: toRemove.length,
      remainedSame: remainSame,
    },
  });
}
