import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { nowMs, tableExists, toStr } from "../../../_lib/dbUtil.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";

const DEFAULT_BROADCASTER_LOGIN = "oldmanobserver";

function clampInt(v, { min, max, fallback }) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function coerceIsFollowerInt(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === null || v === undefined) return -1;
  // allow string/numeric values
  return clampInt(v, { min: -1, max: 1, fallback: -1 });
}

function coerceSubTier(v) {
  if (v === null || v === undefined) return -1;
  return clampInt(v, { min: -1, max: 3, fallback: -1 });
}

function shouldAllowBroadcasterOnly(env, authUser) {
  const configured = toStr(env?.VF_TWITCH_BROADCASTER_LOGIN || DEFAULT_BROADCASTER_LOGIN).trim();
  const isId = /^\d+$/.test(configured);
  const authLogin = toStr(authUser?.login).toLowerCase().trim();
  const authUserId = toStr(authUser?.userId).trim();

  if (isId) return authUserId === configured;
  return authLogin && authLogin === configured.toLowerCase().trim();
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth?.ok) return auth?.response || jsonResponse(request, { error: "unauthorized" }, 401);

  // Security: only allow the configured broadcaster to push follower/sub status updates.
  if (!shouldAllowBroadcasterOnly(env, auth.user)) {
    return jsonResponse(request, { error: "forbidden" }, 403);
  }

  const db = env?.VF_D1_STATS;
  if (!db) return jsonResponse(request, { error: "missing_d1_binding" }, 500);
  if (!(await tableExists(db, "vf_users"))) return jsonResponse(request, { error: "missing_table_vf_users" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(request, { error: "invalid_json" }, 400);
  }

  const incoming = Array.isArray(body?.updates) ? body.updates : body && typeof body === "object" ? [body] : [];
  if (!incoming.length) {
    return jsonResponse(request, { error: "missing_updates" }, 400);
  }

  const now = nowMs();

  // Upsert while only updating support fields when they are provided.
  const sql = `
    INSERT INTO vf_users (
      user_id,
      login,
      display_name,
      profile_image_url,
      last_seen_at_ms,
      created_at_ms,
      updated_at_ms,
      is_follower,
      sub_tier,
      support_updated_at_ms
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      CASE WHEN ? < 0 THEN 0 ELSE ? END,
      CASE WHEN ? < 0 THEN 0 ELSE ? END,
      CASE WHEN ? <= 0 THEN NULL ELSE ? END
    )
    ON CONFLICT(user_id) DO UPDATE SET
      login = CASE WHEN excluded.login != '' THEN excluded.login ELSE vf_users.login END,
      display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE vf_users.display_name END,
      profile_image_url = CASE WHEN excluded.profile_image_url != '' THEN excluded.profile_image_url ELSE vf_users.profile_image_url END,
      last_seen_at_ms = excluded.last_seen_at_ms,
      updated_at_ms = excluded.updated_at_ms,
      is_follower = CASE WHEN ? < 0 THEN vf_users.is_follower ELSE ? END,
      sub_tier = CASE WHEN ? < 0 THEN vf_users.sub_tier ELSE ? END,
      support_updated_at_ms = CASE WHEN ? <= 0 THEN vf_users.support_updated_at_ms ELSE ? END
  `;

  const stmts = [];
  const rejected = [];

  for (const u of incoming) {
    const userId = toStr(u?.userId || u?.user_id).trim();
    if (!userId) {
      rejected.push({ reason: "missing_userId" });
      continue;
    }

    const login = toStr(u?.login).trim();
    const displayName = toStr(u?.displayName || u?.display_name).trim();
    const profileImageUrl = toStr(u?.profileImageUrl || u?.profile_image_url).trim();

    const isFollowerInt = coerceIsFollowerInt(u?.isFollower ?? u?.is_follower);
    const subTier = coerceSubTier(u?.subTier ?? u?.sub_tier);

    const hasSupportUpdate = isFollowerInt >= 0 || subTier >= 0;
    const supportUpdatedAtMsRaw = clampInt(u?.supportUpdatedAtMs ?? u?.support_updated_at_ms, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 });
    const supportUpdatedAtMs = hasSupportUpdate ? (supportUpdatedAtMsRaw > 0 ? supportUpdatedAtMsRaw : now) : 0;

    const followerValue = isFollowerInt < 0 ? 0 : isFollowerInt;
    const subTierValue = subTier < 0 ? 0 : subTier;

    stmts.push(
      db
        .prepare(sql)
        .bind(
          userId,
          login,
          displayName,
          profileImageUrl,
          now, // last_seen_at_ms
          now, // created_at_ms
          now, // updated_at_ms
          isFollowerInt,
          followerValue,
          subTier,
          subTierValue,
          supportUpdatedAtMs,
          supportUpdatedAtMs,
          isFollowerInt,
          followerValue,
          subTier,
          subTierValue,
          supportUpdatedAtMs,
          supportUpdatedAtMs,
        ),
    );
  }

  if (!stmts.length) {
    return jsonResponse(request, { ok: false, updated: 0, rejected }, 400);
  }

  try {
    await db.batch(stmts);
  } catch (err) {
    return jsonResponse(request, { error: "db_error", message: String(err) }, 500);
  }

  return jsonResponse(request, { ok: true, updated: stmts.length, rejected }, 200);
}
