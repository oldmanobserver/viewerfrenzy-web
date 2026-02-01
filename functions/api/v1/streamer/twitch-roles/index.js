import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { isoFromMs, nowMs, tableExists, toStr } from "../../../../_lib/dbUtil.js";
import { STREAMER_TWITCH_ROLE_DEFS, STREAMER_TWITCH_ROLE_ORDER } from "../../../../_lib/twitchRoles.js";

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

function orderCaseSql() {
  // CASE role_id WHEN 'moderator' THEN 0 ... ELSE 999 END
  const parts = STREAMER_TWITCH_ROLE_ORDER.map((id, i) => `WHEN '${id.replaceAll("'", "''")}' THEN ${i}`).join(" ");
  return `CASE r.role_id ${parts} ELSE 999 END`;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405);

  const auth = await requireWebsiteUser(context).catch((e) => ({ error: e }));
  if (auth?.error) return auth.error;

  // Streamer tools gating (consistent with /streamer/users)
  const okStreamer = await hasStreamerViewers(env, auth.user.userId);
  if (!okStreamer) {
    return jsonResponse(
      {
        error: "not_streamer",
        message: "Streamer tools are available after at least one viewer joins your competitions.",
      },
      403,
    );
  }

  const db = env?.VF_D1_STATS;
  if (!db) return jsonResponse({ error: "server_error", message: "Database not configured" }, 500);

  const okRoles = await tableExists(db, "vf_streamer_twitch_roles");
  const okRoleUsers = await tableExists(db, "vf_streamer_twitch_role_users");
  const okUserStreamers = await tableExists(db, "vf_user_streamers");

  if (!okRoles || !okRoleUsers || !okUserStreamers) {
    return jsonResponse(
      {
        error: "server_error",
        message:
          "Missing tables for streamer Twitch roles. Please run the latest database migrations in manage.viewerfrenzy.com.",
      },
      500,
    );
  }

  const streamerUserId = toStr(auth.user.userId);

  // Ensure the role rows exist for this streamer (so the dropdown always has the Twitch-ish set).
  await ensureStreamerRoleRows(db, streamerUserId);

  const rows = await db
    .prepare(
      `SELECT
         r.role_id as roleId,
         r.role_name as roleName,
         r.last_synced_at_ms as lastSyncedAtMs,
         COUNT(DISTINCT us.user_id) as userCount
       FROM vf_streamer_twitch_roles r
       LEFT JOIN vf_streamer_twitch_role_users ru
         ON ru.streamer_user_id = r.streamer_user_id AND ru.role_id = r.role_id
       LEFT JOIN vf_user_streamers us
         ON us.user_id = ru.user_id AND us.streamer_user_id = r.streamer_user_id
       WHERE r.streamer_user_id = ?
       GROUP BY r.role_id, r.role_name, r.last_synced_at_ms
       ORDER BY ${orderCaseSql()}`,
    )
    .bind(streamerUserId)
    .all();

  const roleDefMap = new Map(STREAMER_TWITCH_ROLE_DEFS.map((r) => [r.roleId, r]));

  const roles = (rows?.results || []).map((r) => {
    const roleId = toStr(r?.roleId);
    const def = roleDefMap.get(roleId);
    const lastSyncedAtMs = Number(r?.lastSyncedAtMs || 0);

    return {
      roleId,
      roleName: toStr(r?.roleName) || def?.roleName || roleId,
      supportedSync: def?.supportedSync !== false,
      userCount: Number(r?.userCount || 0),
      lastSyncedAtMs: lastSyncedAtMs || null,
      lastSyncedAt: lastSyncedAtMs ? isoFromMs(lastSyncedAtMs) : "",
    };
  });

  return jsonResponse({ roles }, 200);
}
