// functions/api/v1/streamer/roles/[roleId]/bulk.js
//
// Streamer-only bulk membership updates for a specific streamer role.
//
// Supports:
//  - add:    add the listed users to the role (idempotent)
//  - remove: remove the listed users from the role (idempotent)
//  - set:    make the role membership exactly match the listed users
//
// The UI is expected to call this twice:
//  1) dryRun=true  -> to preview counts before changing anything
//  2) dryRun=false -> apply the change after user confirmation

import { handleOptions } from "../../../../../_lib/cors.js";
import { jsonResponse } from "../../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../../_lib/twitchAuth.js";
import { nowMs, tableExists, toStr } from "../../../../../_lib/dbUtil.js";

function isValidRoleId(id) {
  return /^[a-z0-9_-]{1,32}$/.test(String(id || "").trim());
}

function isDigits(s) {
  return /^\d+$/.test(String(s || "").trim());
}

function isValidTwitchLogin(login) {
  return /^[a-z0-9_]{1,32}$/.test(String(login || "").trim());
}

function parseUserList(body) {
  // Accept either:
  // - { usersRaw: "a,b\nc" }
  // - { users: ["a", "b"] }
  const raw =
    typeof body?.usersRaw === "string"
      ? body.usersRaw
      : typeof body?.usersText === "string"
        ? body.usersText
        : Array.isArray(body?.users)
          ? body.users.join("\n")
          : "";

  const parts = String(raw)
    .split(/[\n\r,]+/g)
    .map((s) => String(s || "").trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
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
  const okUsers = await tableExists(db, "vf_users");
  const okUserStreamers = await tableExists(db, "vf_user_streamers");

  return {
    ok: okRoles && okRoleUsers && okUsers && okUserStreamers,
    missing: {
      vf_streamer_roles: !okRoles,
      vf_streamer_role_users: !okRoleUsers,
      vf_users: !okUsers,
      vf_user_streamers: !okUserStreamers,
    },
  };
}

async function resolveUserIds(db, tokens) {
  const resolved = [];
  const unknown = [];

  for (const t of tokens) {
    const s = String(t || "").trim();
    if (!s) continue;

    // Numeric user id
    if (isDigits(s)) {
      resolved.push(s);
      continue;
    }

    // Login -> user_id (requires vf_users row)
    const login = s.toLowerCase();
    if (!isValidTwitchLogin(login)) {
      unknown.push(s);
      continue;
    }

    const row = await db.prepare("SELECT user_id as userId FROM vf_users WHERE login = ?").bind(login).first();
    const userId = toStr(row?.userId);
    if (!userId) {
      unknown.push(s);
      continue;
    }

    resolved.push(userId);
  }

  // De-dupe resolved ids
  const uniq = [];
  const seen = new Set();
  for (const id of resolved) {
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(id);
  }

  return { userIds: uniq, unknown };
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "POST") {
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

  const roleId = toStr(params?.roleId).toLowerCase();
  if (!roleId) {
    return jsonResponse(request, { error: "missing_roleId" }, 400);
  }
  if (!isValidRoleId(roleId)) {
    return jsonResponse(request, { error: "invalid_role_id" }, 400);
  }

  // Ensure role exists and is owned by this streamer.
  const roleRow = await db
    .prepare("SELECT 1 AS ok FROM vf_streamer_roles WHERE streamer_user_id = ? AND role_id = ? LIMIT 1")
    .bind(streamerUserId, roleId)
    .first();
  if (!roleRow) {
    return jsonResponse(request, { error: "role_not_found" }, 404);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const modeRaw = toStr(body?.mode).toLowerCase();
  const mode = modeRaw === "delete" ? "remove" : modeRaw;
  if (!mode || !["add", "remove", "set"].includes(mode)) {
    return jsonResponse(
      request,
      { error: "invalid_mode", message: "mode must be one of: add, remove, set" },
      400,
    );
  }

  const dryRun = body?.dryRun === undefined ? true : !!body?.dryRun;

  const tokens = parseUserList(body);
  // Allow an EMPTY list for mode=set (this is the easiest way to clear the role).
  if (!tokens.length && mode !== "set") {
    return jsonResponse(
      request,
      { error: "no_users", message: "Provide at least one user (comma or newline delimited)." },
      400,
    );
  }

  const resolved = await resolveUserIds(db, tokens);
  const desiredUserIds = new Set(resolved.userIds);

  // Current membership
  const curRs = await db
    .prepare("SELECT user_id as userId FROM vf_streamer_role_users WHERE streamer_user_id = ? AND role_id = ?")
    .bind(streamerUserId, roleId)
    .all();
  const currentUserIds = new Set((curRs?.results || []).map((r) => toStr(r?.userId)).filter(Boolean));

  const toAdd = [];
  const toRemove = [];
  let remainSame = 0;

  if (mode === "add") {
    for (const id of desiredUserIds) {
      if (currentUserIds.has(id)) remainSame++;
      else toAdd.push(id);
    }
  } else if (mode === "remove") {
    for (const id of desiredUserIds) {
      if (currentUserIds.has(id)) toRemove.push(id);
      else remainSame++;
    }
  } else {
    // set
    for (const id of desiredUserIds) {
      if (currentUserIds.has(id)) remainSame++;
      else toAdd.push(id);
    }
    for (const id of currentUserIds) {
      if (!desiredUserIds.has(id)) toRemove.push(id);
    }
  }

  const summary = {
    mode,
    inputCount: tokens.length,
    resolvedCount: desiredUserIds.size,
    unknownCount: resolved.unknown.length,
    currentCount: currentUserIds.size,
    willAdd: toAdd.length,
    willRemove: toRemove.length,
    willRemainSame: remainSame,
    nextCount:
      mode === "add"
        ? currentUserIds.size + toAdd.length
        : mode === "remove"
          ? Math.max(0, currentUserIds.size - toRemove.length)
          : desiredUserIds.size,
  };

  if (dryRun) {
    return jsonResponse(request, {
      ok: true,
      dryRun: true,
      streamer: { userId: streamerUserId, login: streamerLogin },
      roleId,
      summary,
      unknown: resolved.unknown.slice(0, 50),
    });
  }

  const ms = nowMs();
  const stmts = [];

  if (toRemove.length) {
    // Chunk deletes to avoid hitting SQLite parameter limits.
    for (const group of chunk(toRemove, 80)) {
      const qs = group.map(() => "?").join(",");
      stmts.push(
        db
          .prepare(
            `DELETE FROM vf_streamer_role_users
             WHERE streamer_user_id = ? AND role_id = ? AND user_id IN (${qs})`,
          )
          .bind(streamerUserId, roleId, ...group),
      );
    }
  }

  if (toAdd.length) {
    for (const id of toAdd) {
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO vf_streamer_role_users
             (streamer_user_id, role_id, user_id, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(streamerUserId, roleId, id, ms, ms),
      );
    }
  }

  if (stmts.length) {
    await db.batch(stmts);
  }

  return jsonResponse(request, {
    ok: true,
    dryRun: false,
    applied: true,
    streamer: { userId: streamerUserId, login: streamerLogin },
    roleId,
    summary,
    unknown: resolved.unknown.slice(0, 50),
  });
}
