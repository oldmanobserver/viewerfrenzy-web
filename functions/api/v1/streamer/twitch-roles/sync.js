import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { nowMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";
import { getStreamerTwitchRoleDef, getSupportedStreamerTwitchRoleDefs, STREAMER_TWITCH_ROLE_DEFS } from "../../../../_lib/twitchRoles.js";

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

async function ensureStreamerRoleRows(db, streamerUserId) {
  const t = nowMs();
  const stmts = STREAMER_TWITCH_ROLE_DEFS.map((r) =>
    db
      .prepare(
        `INSERT INTO vf_streamer_twitch_roles (streamer_user_id, role_id, role_name, last_synced_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, NULL, ?, ?)
         ON CONFLICT(streamer_user_id, role_id) DO UPDATE SET
           role_name=excluded.role_name,
           updated_at_ms=excluded.updated_at_ms`,
      )
      .bind(streamerUserId, r.roleId, r.roleName, t, t),
  );
  await db.batch(stmts);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function toLowerSet(arr) {
  const s = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const x = String(v || "").trim().toLowerCase();
    if (x) s.add(x);
  }
  return s;
}

function hasAnyScope(scopesSet, anyOf) {
  const list = Array.isArray(anyOf) ? anyOf : [];
  if (!list.length) return true;
  for (const s of list) {
    const k = String(s || "").trim().toLowerCase();
    if (k && scopesSet.has(k)) return true;
  }
  return false;
}

async function helixJson(url, { accessToken, clientId }) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-ID": clientId,
    },
  });

  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const msg =
      data?.message ||
      data?.error ||
      `${res.status} ${res.statusText}` ||
      "Twitch API error";
    throw Object.assign(new Error(String(msg)), { status: res.status, data });
  }

  return data;
}

async function helixPaginated(endpoint, params, authCtx) {
  const out = [];
  let cursor = "";

  while (true) {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    if (cursor) url.searchParams.set("after", cursor);

    const json = await helixJson(url.toString(), authCtx);
    const items = Array.isArray(json?.data) ? json.data : [];
    out.push(...items);

    cursor = String(json?.pagination?.cursor || "").trim();
    if (!cursor) break;
  }

  return out;
}

async function fetchRoleUserIds(roleId, streamerUserId, authCtx) {
  if (roleId === "moderator") {
    const items = await helixPaginated(
      "https://api.twitch.tv/helix/moderation/moderators",
      { broadcaster_id: streamerUserId, first: 100 },
      authCtx,
    );
    return items.map((x) => String(x?.user_id || "").trim()).filter(Boolean);
  }

  if (roleId === "vip") {
    const items = await helixPaginated(
      "https://api.twitch.tv/helix/channels/vips",
      { broadcaster_id: streamerUserId, first: 100 },
      authCtx,
    );
    return items.map((x) => String(x?.user_id || "").trim()).filter(Boolean);
  }

  if (roleId === "editor") {
    const url = new URL("https://api.twitch.tv/helix/channels/editors");
    url.searchParams.set("broadcaster_id", streamerUserId);

    const json = await helixJson(url.toString(), authCtx);
    const items = Array.isArray(json?.data) ? json.data : [];
    return items.map((x) => String(x?.user_id || "").trim()).filter(Boolean);
  }

  return [];
}

async function fetchUsersByIds(userIds, authCtx) {
  const out = [];
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((x) => String(x || "").trim()).filter(Boolean)));

  const CHUNK = 100;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const url = new URL("https://api.twitch.tv/helix/users");
    for (const id of chunk) url.searchParams.append("id", id);

    const json = await helixJson(url.toString(), authCtx);
    const items = Array.isArray(json?.data) ? json.data : [];
    out.push(...items);
  }

  return out;
}

async function upsertUsers(db, helixUsers) {
  const t = nowMs();

  const stmts = [];
  for (const u of Array.isArray(helixUsers) ? helixUsers : []) {
    const userId = toStr(u?.id);
    const login = toStr(u?.login).toLowerCase();
    if (!userId || !login) continue;

    const displayName = toStr(u?.display_name);
    const profileImageUrl = toStr(u?.profile_image_url);

    stmts.push(
      db
        .prepare(
          `INSERT INTO vf_users (user_id, login, display_name, profile_image_url, last_seen_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             login=excluded.login,
             display_name=excluded.display_name,
             profile_image_url=excluded.profile_image_url,
             last_seen_at_ms=excluded.last_seen_at_ms,
             updated_at_ms=excluded.updated_at_ms`,
        )
        .bind(userId, login, displayName, profileImageUrl, t, t, t),
    );
  }

  if (stmts.length) await db.batch(stmts);
}

async function ensureUserStreamers(db, streamerUserId, streamerLogin, userIds) {
  const t = nowMs();
  const ids = Array.from(new Set((Array.isArray(userIds) ? userIds : []).map((x) => toStr(x)).filter(Boolean)));

  const stmts = ids
    .filter((id) => id && id !== streamerUserId)
    .map((userId) =>
      db
        .prepare(
          `INSERT INTO vf_user_streamers (user_id, streamer_user_id, streamer_login, first_seen_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, streamer_user_id) DO UPDATE SET
             streamer_login=excluded.streamer_login,
             first_seen_at_ms=MIN(vf_user_streamers.first_seen_at_ms, excluded.first_seen_at_ms),
             last_seen_at_ms=MAX(vf_user_streamers.last_seen_at_ms, excluded.last_seen_at_ms),
             updated_at_ms=excluded.updated_at_ms`,
        )
        .bind(userId, streamerUserId, streamerLogin, t, t, t, t),
    );

  if (stmts.length) await db.batch(stmts);
}

async function syncOneRole(db, streamerUserId, streamerLogin, roleId, authCtx) {
  const def = getStreamerTwitchRoleDef(roleId);
  if (!def) {
    return { roleId, roleName: roleId, error: "unknown_role" };
  }
  if (def.supportedSync === false) {
    return { roleId, roleName: def.roleName, error: "unsupported" };
  }

  // 1) Snapshot existing assignments (for diff summary)
  const oldRows = await db
    .prepare(
      `SELECT user_id
       FROM vf_streamer_twitch_role_users
       WHERE streamer_user_id = ? AND role_id = ?`,
    )
    .bind(streamerUserId, roleId)
    .all();

  const oldSet = new Set((oldRows?.results || []).map((r) => toStr(r?.user_id)).filter(Boolean));

  // 2) Fetch current list from Twitch
  const newIds = await fetchRoleUserIds(roleId, streamerUserId, authCtx);
  const newSet = new Set(newIds);

  let added = 0;
  for (const id of newSet) if (!oldSet.has(id)) added++;

  let removed = 0;
  for (const id of oldSet) if (!newSet.has(id)) removed++;

  // 3) Upsert user profiles + ensure streamer link rows exist
  const helixUsers = await fetchUsersByIds(Array.from(newSet), authCtx);
  await upsertUsers(db, helixUsers);
  await ensureUserStreamers(db, streamerUserId, streamerLogin, Array.from(newSet));

  // 4) Replace role-user assignments
  const t = nowMs();
  await db
    .prepare(
      `DELETE FROM vf_streamer_twitch_role_users
       WHERE streamer_user_id = ? AND role_id = ?`,
    )
    .bind(streamerUserId, roleId)
    .run();

  const inserts = Array.from(newSet)
    .filter((id) => id && id !== streamerUserId)
    .map((userId) =>
      db
        .prepare(
          `INSERT INTO vf_streamer_twitch_role_users (streamer_user_id, role_id, user_id, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(streamer_user_id, role_id, user_id) DO UPDATE SET
             updated_at_ms=excluded.updated_at_ms`,
        )
        .bind(streamerUserId, roleId, userId, t, t),
    );

  if (inserts.length) await db.batch(inserts);

  // 5) Mark role last synced
  await db
    .prepare(
      `UPDATE vf_streamer_twitch_roles
       SET last_synced_at_ms = ?, updated_at_ms = ?
       WHERE streamer_user_id = ? AND role_id = ?`,
    )
    .bind(t, t, streamerUserId, roleId)
    .run();

  return {
    roleId,
    roleName: def.roleName,
    total: newSet.size,
    added,
    removed,
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "POST") return jsonResponse(request, { error: "method_not_allowed" }, 405);

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  // This endpoint MUST be called with a Twitch user access token (not the VF session JWT),
  // since we need to call Helix role endpoints.
  if (auth?.vfSession) {
    return jsonResponse(
      request,
      {
        error: "twitch_token_required",
        message:
          "Role sync requires a Twitch access token. Please log out and log back in, then try again.",
      },
      401,
    );
  }

  // Streamer tools gating (consistent with /streamer/users)
  const okStreamer = await hasStreamerViewers(env, auth.user.userId);
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
  if (!db) return jsonResponse(request, { error: "server_error", message: "Database not configured" }, 500);

  const okRoles = await tableExists(db, "vf_streamer_twitch_roles");
  const okRoleUsers = await tableExists(db, "vf_streamer_twitch_role_users");
  const okUsers = await tableExists(db, "vf_users");
  const okUserStreamers = await tableExists(db, "vf_user_streamers");

  if (!okRoles || !okRoleUsers || !okUsers || !okUserStreamers) {
    return jsonResponse(
      request,
      {
        error: "server_error",
        message:
          "Missing tables for streamer Twitch roles. Please run the latest database migrations in manage.viewerfrenzy.com.",
      },
      500,
    );
  }

  const body = await readJson(request);
  const requestedRoleId = toStr(body?.roleId || "all");

  const streamerUserId = toStr(auth.user.userId);
  const streamerLogin = toStr(auth.user.login).toLowerCase();

  const clientId =
    toStr(auth?.validated?.client_id) ||
    toStr(env?.TWITCH_CLIENT_ID) ||
    toStr(env?.VF_TWITCH_CLIENT_ID) ||
    "";

  if (!clientId) {
    return jsonResponse(
      request,
      { error: "server_error", message: "Missing Twitch client id (TWITCH_CLIENT_ID)" },
      500,
    );
  }

  const authCtx = {
    accessToken: toStr(auth.token),
    clientId,
  };

  // Ensure the role rows exist for this streamer.
  await ensureStreamerRoleRows(db, streamerUserId);

  const scopeSet = toLowerSet(auth?.validated?.scopes);

  let rolesToSync = [];
  if (requestedRoleId === "all") {
    rolesToSync = getSupportedStreamerTwitchRoleDefs().map((r) => r.roleId);
  } else {
    rolesToSync = [requestedRoleId];
  }

  // Validate request role id(s)
  for (const rid of rolesToSync) {
    const def = getStreamerTwitchRoleDef(rid);
    if (!def) {
      return jsonResponse(request, { error: "bad_request", message: `Unknown role: ${rid}` }, 400);
    }
    if (def.supportedSync === false) {
      return jsonResponse(
        request,
        {
          error: "unsupported",
          message: `Sync is not supported for Twitch role: ${def.roleName}`,
        },
        400,
      );
    }
  }

  const synced = [];
  const skipped = [];

  for (const rid of rolesToSync) {
    const def = getStreamerTwitchRoleDef(rid);

    if (!hasAnyScope(scopeSet, def.requiredAnyScopes)) {
      skipped.push({
        roleId: def.roleId,
        roleName: def.roleName,
        error: "missing_scope",
        requiredAnyScopes: def.requiredAnyScopes,
      });
      continue;
    }

    try {
      const r = await syncOneRole(db, streamerUserId, streamerLogin, rid, authCtx);
      synced.push(r);
    } catch (e) {
      skipped.push({
        roleId: def.roleId,
        roleName: def.roleName,
        error: "twitch_error",
        message: String(e?.message || "Twitch API error"),
        status: Number(e?.status || 0) || null,
      });
    }
  }

  if (!synced.length && skipped.length) {
    const first = skipped[0];
    if (first.error === "missing_scope") {
      return jsonResponse(
        request,
        {
          error: "missing_scope",
          message:
            "Your Twitch token is missing required scopes for role sync. Log out and log back in after adding these scopes to TWITCH_SCOPES.",
          skipped,
        },
        403,
      );
    }
  }

  return jsonResponse(request, { ok: true, synced, skipped }, 200);
}
