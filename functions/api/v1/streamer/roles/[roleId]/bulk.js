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

async function runBatches(db, stmts, batchSize = 90) {
  if (!stmts || !stmts.length) return;
  for (const group of chunk(stmts, batchSize)) {
    await db.batch(group);
  }
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

async function helixLookupUsers({ accessToken, clientId, logins = [], ids = [] }) {
  const token = String(accessToken || "").trim();
  const cid = String(clientId || "").trim();

  if (!token || !cid) {
    return { ok: false, status: 401, error: "missing_twitch_token" };
  }

  const url = new URL("https://api.twitch.tv/helix/users");
  for (const id of Array.isArray(ids) ? ids : []) {
    const v = String(id || "").trim();
    if (v) url.searchParams.append("id", v);
  }
  for (const login of Array.isArray(logins) ? logins : []) {
    const v = String(login || "").trim().toLowerCase();
    if (v) url.searchParams.append("login", v);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Client-ID": cid,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: data?.message || data?.error || "twitch_error" };
  }

  return {
    ok: true,
    users: Array.isArray(data?.data) ? data.data : [],
  };
}

async function dbLookupUserIdsByLogin(db, logins) {
  const out = new Map();
  const uniq = Array.from(new Set((Array.isArray(logins) ? logins : []).map((l) => String(l || "").toLowerCase()).filter(Boolean)));
  for (const group of chunk(uniq, 80)) {
    const qs = group.map(() => "?").join(",");
    const rs = await db
      .prepare(`SELECT login, user_id as userId FROM vf_users WHERE login IN (${qs})`)
      .bind(...group)
      .all();

    for (const row of Array.isArray(rs?.results) ? rs.results : []) {
      const login = toStr(row?.login).toLowerCase();
      const userId = toStr(row?.userId);
      if (!login || !userId) continue;
      out.set(login, userId);
    }
  }
  return out;
}

async function dbLookupExistingUserIds(db, userIds) {
  const out = new Set();
  const uniq = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id || "").trim()).filter(Boolean)));
  for (const group of chunk(uniq, 80)) {
    const qs = group.map(() => "?").join(",");
    const rs = await db
      .prepare(`SELECT user_id as userId FROM vf_users WHERE user_id IN (${qs})`)
      .bind(...group)
      .all();

    for (const row of Array.isArray(rs?.results) ? rs.results : []) {
      const id = toStr(row?.userId);
      if (!id) continue;
      out.add(id);
    }
  }
  return out;
}

async function resolveUserIds(db, tokens, { twitchToken = "", clientId = "" } = {}) {
  const resolved = [];
  const unknown = [];
  const helixById = new Map(); // userId -> helix user (for optional upsert)

  const ids = [];
  const logins = [];
  const loginToOriginal = new Map();

  for (const t of Array.isArray(tokens) ? tokens : []) {
    const raw = String(t || "").trim();
    if (!raw) continue;

    // Numeric user id
    if (isDigits(raw)) {
      ids.push(raw);
      resolved.push(raw);
      continue;
    }

    // Twitch login
    const login = raw.toLowerCase();
    if (!isValidTwitchLogin(login)) {
      unknown.push(raw);
      continue;
    }

    logins.push(login);
    if (!loginToOriginal.has(login)) loginToOriginal.set(login, raw);
  }

  // Resolve logins via vf_users first.
  const loginToId = logins.length ? await dbLookupUserIdsByLogin(db, logins) : new Map();
  const missingLogins = [];
  for (const login of logins) {
    const id = loginToId.get(login);
    if (id) resolved.push(id);
    else missingLogins.push(login);
  }

  const canHelix = !!String(twitchToken || "").trim() && !!String(clientId || "").trim();
  if (canHelix) {
    // Only look up numeric ids that are not already in vf_users (we need login/display/avatar to create the user row).
    const existingIds = ids.length ? await dbLookupExistingUserIds(db, ids) : new Set();
    const missingIds = ids.filter((id) => !existingIds.has(id));

    // Fetch missing logins + missing ids from Twitch (best-effort).
    for (const loginGroup of chunk(missingLogins, 80)) {
      if (!loginGroup.length) continue;
      const h = await helixLookupUsers({ accessToken: twitchToken, clientId, logins: loginGroup, ids: [] });
      if (!h.ok) break;
      for (const u of h.users || []) {
        const uid = toStr(u?.id);
        if (!uid) continue;
        helixById.set(uid, u);
        const l = toStr(u?.login).toLowerCase();
        if (l) loginToId.set(l, uid);
      }
    }

    for (const idGroup of chunk(missingIds, 80)) {
      if (!idGroup.length) continue;
      const h = await helixLookupUsers({ accessToken: twitchToken, clientId, logins: [], ids: idGroup });
      if (!h.ok) break;
      for (const u of h.users || []) {
        const uid = toStr(u?.id);
        if (!uid) continue;
        helixById.set(uid, u);
      }
    }
  }

  // Any remaining missing logins are unknown.
  for (const login of missingLogins) {
    const id = loginToId.get(login);
    if (id) {
      resolved.push(id);
    } else {
      unknown.push(loginToOriginal.get(login) || login);
    }
  }

  // De-dupe resolved ids
  const uniq = [];
  const seen = new Set();
  for (const id of resolved) {
    const key = String(id);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(key);
  }

  return { userIds: uniq, unknown, helixById };
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

  const clientId = String(auth?.validated?.client_id || "").trim() || String(env?.VF_TWITCH_CLIENT_ID || "").trim();
  // Only use Twitch Helix resolution when the request is authenticated with a Twitch token.
  const twitchToken = auth?.vfSession ? "" : auth.token;

  const resolved = await resolveUserIds(db, tokens, { twitchToken, clientId });
  // Never allow assigning roles to the streamer themselves.
  const desiredUserIds = new Set(resolved.userIds.filter((id) => id && id !== streamerUserId));

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

  // If we're adding/setting members, ensure each resolved user has:
  //  - a vf_users row (when we have Helix info)
  //  - a vf_user_streamers row (so they show up in the Streamer Users page)
  //
  // Note: we intentionally do NOT create these links on mode=remove.
  const ensureUserIds = mode === "remove" ? [] : Array.from(desiredUserIds);
  const ensureUserIdSet = new Set(ensureUserIds);

  if (ensureUserIds.length) {
    // Upsert any Helix-resolved users (creates vf_users rows when they didn't already exist).
    for (const [uid, u] of resolved.helixById || []) {
      if (!ensureUserIdSet.has(uid)) continue;
      if (!uid || uid === streamerUserId) continue;

      const login = toStr(u?.login).toLowerCase();
      if (!login) continue;

      const displayName = toStr(u?.display_name) || login || uid;
      const profileImageUrl = toStr(u?.profile_image_url) || "";

      stmts.push(
        db
          .prepare(
            `INSERT INTO vf_users (user_id, login, display_name, profile_image_url, last_seen_at_ms, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET
               login = excluded.login,
               display_name = excluded.display_name,
               profile_image_url = excluded.profile_image_url,
               last_seen_at_ms = MAX(vf_users.last_seen_at_ms, excluded.last_seen_at_ms),
               updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(uid, login, displayName, profileImageUrl, ms, ms, ms),
      );
    }

    // Ensure the viewer->streamer link rows exist.
    for (const uid of ensureUserIds) {
      if (!uid || uid === streamerUserId) continue;
      stmts.push(
        db
          .prepare(
            `INSERT INTO vf_user_streamers (user_id, streamer_user_id, streamer_login, first_seen_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id, streamer_user_id) DO UPDATE SET
               streamer_login = excluded.streamer_login,
               last_seen_at_ms = MAX(vf_user_streamers.last_seen_at_ms, excluded.last_seen_at_ms),
               updated_at_ms = excluded.updated_at_ms`,
          )
          .bind(uid, streamerUserId, streamerLogin, ms, ms, ms, ms),
      );
    }
  }

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

  await runBatches(db, stmts);

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
