// functions/api/v1/streamer/users/index.js
//
// Authenticated streamer endpoint for managing the streamer's viewer list.
//
// New storage (v0.20+): D1
// - vf_user_streamers (viewer <-> streamer join table)
// - vf_users (viewer identities)

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { isoFromMs, nowMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";

function normalizeViewerRow(row) {
  const userId = toStr(row?.user_id || row?.userId);
  const login = toStr(row?.login).toLowerCase();
  const displayName = toStr(row?.display_name) || login || userId;
  const profileImageUrl = toStr(row?.profile_image_url) || "";
  const firstSeenAt = row?.first_seen_at_ms ? isoFromMs(row.first_seen_at_ms) : "";
  const lastSeenAt = row?.last_seen_at_ms ? isoFromMs(row.last_seen_at_ms) : "";

  return {
    userId,
    login,
    displayName,
    profileImageUrl,
    firstSeenAt,
    lastSeenAt,
  };
}

async function hasStreamerViewers(env, userId) {
  const uid = toStr(userId);
  if (!uid) return false;

  const db = env?.VF_D1_STATS;
  if (!db) return false;

  // Prefer the materialized join table (v0.20+). This only tracks REAL viewers (bots excluded)
  // and intentionally does not include the streamer themselves.
  if (await tableExists(db, "vf_user_streamers")) {
    try {
      const row = await db
        .prepare("SELECT 1 AS ok FROM vf_user_streamers WHERE streamer_user_id = ? LIMIT 1")
        .bind(uid)
        .first();
      if (row) return true;
    } catch {
      // fall through
    }
  }

  // Fallback (older DBs): require that at least one non-streamer has a result row for one
  // of this streamer's competitions.
  const hasCompetitions = await tableExists(db, "competitions");
  const hasResults = await tableExists(db, "competition_results");
  if (!hasCompetitions || !hasResults) return false;

  try {
    const row = await db
      .prepare(
        `SELECT 1 AS ok
         FROM competitions c
         JOIN competition_results r ON r.competition_id = c.id
         WHERE c.streamer_user_id = ?
           AND r.viewer_user_id <> ?
           AND LOWER(r.viewer_user_id) NOT LIKE 'bot:%'
           AND LOWER(r.viewer_user_id) NOT LIKE 'bot_%'
           AND LOWER(r.viewer_user_id) NOT LIKE 'racer %'
         LIMIT 1`,
      )
      .bind(uid, uid)
      .first();
    return !!row;
  } catch {
    return false;
  }
}

async function helixLookupUser({ accessToken, clientId, loginOrId }) {
  const raw = String(loginOrId || "").trim();
  if (!raw) {
    return { ok: false, status: 400, error: "missing_loginOrId" };
  }

  const isId = /^\d+$/.test(raw);
  const url = new URL("https://api.twitch.tv/helix/users");
  url.searchParams.set(isId ? "id" : "login", raw);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Client-ID": String(clientId || "").trim(),
      Authorization: `Bearer ${accessToken}`,
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

  const user = Array.isArray(data?.data) ? data.data[0] : null;
  if (!user) {
    return { ok: false, status: 404, error: "user_not_found" };
  }

  return { ok: true, user };
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

  // Enforce requirement #1/#4: streamer tools are only available after at least one REAL viewer has joined
  // this streamer's competitions (i.e., there is a viewer list to manage).
  const isStreamer = await hasStreamerViewers(env, streamerUserId);
  if (!isStreamer) {
    return jsonResponse(
      request,
      {
        error: "not_streamer",
        message:
          "Streamer tools become available after at least one viewer joins your competition and the game submits results.",
      },
      403,
    );
  }

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { error: "db_not_bound", message: "Missing D1 binding: VF_D1_STATS" }, 500);
  }

  const hasUsers = await tableExists(db, "vf_users");
  const hasJoin = await tableExists(db, "vf_user_streamers");
  if (!hasUsers || !hasJoin) {
    return jsonResponse(
      request,
      {
        error: "db_migration_required",
        message: "Missing required tables. Run DB migration v0.20+ (vf_user_streamers).",
        missing: {
          vf_users: !hasUsers,
          vf_user_streamers: !hasJoin,
        },
      },
      500,
    );
  }

  if (request.method === "GET") {
    const rs = await db
      .prepare(
        `SELECT
          us.user_id,
          u.login,
          u.display_name,
          u.profile_image_url,
          us.first_seen_at_ms,
          us.last_seen_at_ms
        FROM vf_user_streamers us
        LEFT JOIN vf_users u ON u.user_id = us.user_id
        WHERE us.streamer_user_id = ?
        ORDER BY COALESCE(u.login, us.user_id) ASC`,
      )
      .bind(streamerUserId)
      .all();

    const users = (Array.isArray(rs?.results) ? rs.results : []).map(normalizeViewerRow);

    // Optional: attach cached Twitch role membership (per streamer) so the front-end can filter.
    const hasRoleUsers = await tableExists(db, "vf_streamer_twitch_role_users");
    if (hasRoleUsers && users.length) {
      const rr = await db
        .prepare(
          `SELECT user_id, role_id
           FROM vf_streamer_twitch_role_users
           WHERE streamer_user_id = ?`,
        )
        .bind(streamerUserId)
        .all();

      const roleMap = new Map();
      for (const row of Array.isArray(rr?.results) ? rr.results : []) {
        const uid = toStr(row?.user_id);
        const rid = toStr(row?.role_id);
        if (!uid || !rid) continue;
        if (!roleMap.has(uid)) roleMap.set(uid, []);
        roleMap.get(uid).push(rid);
      }

      for (const u of users) {
        u.roles = roleMap.get(u.userId) || [];
      }
    } else {
      for (const u of users) {
        u.roles = [];
      }
    }

    return jsonResponse(request, {
      ok: true,
      streamer: {
        userId: streamerUserId,
        login: streamerLogin,
      },
      users,
    });
  }

  // POST: add user to this streamer's list
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const loginOrId = String(body?.loginOrId || "").trim();
  if (!loginOrId) {
    return jsonResponse(request, { error: "missing_loginOrId", message: "loginOrId required" }, 400);
  }

  const clientId = String(auth?.validated?.client_id || "").trim() || String(env?.VF_TWITCH_CLIENT_ID || "").trim();
  if (!clientId) {
    return jsonResponse(request, { error: "missing_client_id" }, 500);
  }

  const lookup = await helixLookupUser({ accessToken: auth.token, clientId, loginOrId });
  if (!lookup.ok) {
    return jsonResponse(
      request,
      {
        error: lookup.error || "lookup_failed",
        message: lookup.error === "user_not_found" ? "User not found on Twitch." : "Failed to look up Twitch user.",
        status: lookup.status,
      },
      lookup.status || 500,
    );
  }

  const helixUser = lookup.user;
  const viewerUserId = toStr(helixUser?.id);
  const viewerLogin = toStr(helixUser?.login).toLowerCase();
  const viewerDisplayName = toStr(helixUser?.display_name) || viewerLogin || viewerUserId;
  const viewerProfileImageUrl = toStr(helixUser?.profile_image_url) || "";

  if (!viewerUserId) {
    return jsonResponse(request, { error: "invalid_twitch_user" }, 500);
  }

  if (viewerUserId === streamerUserId) {
    return jsonResponse(request, { error: "cannot_add_self", message: "You cannot add yourself." }, 400);
  }

  const t = nowMs();
  const stmts = [];

  // Ensure a vf_users row exists.
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
      .bind(viewerUserId, viewerLogin, viewerDisplayName, viewerProfileImageUrl, t, t, t),
  );

  // Add (or update) the viewer->streamer link.
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
      .bind(viewerUserId, streamerUserId, streamerLogin, t, t, t, t),
  );

  await db.batch(stmts);

  return jsonResponse(request, {
    ok: true,
    user: {
      userId: viewerUserId,
      login: viewerLogin,
      displayName: viewerDisplayName,
      profileImageUrl: viewerProfileImageUrl,
    },
  });
}
