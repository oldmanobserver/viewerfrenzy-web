// functions/api/v1/competitions/submit.js
// Streamer-only endpoint: Unity posts a finished competition + per-viewer results.
//
// Storage:
// - Competitions + results are persisted to D1 (env.VF_D1_STATS).
// - Seasons are resolved from D1 (v0.6+) or KV (legacy) and stored alongside the competition.

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";
import { listAllJsonRecords } from "../../../_lib/kv.js";
import { awardAchievementsForViewers } from "../../../_lib/achievements.js";
import { isoFromMs, tableExists, toBool, toBoolInt } from "../../../_lib/dbUtil.js";

// Cached check: does D1 have competition_results.is_bot?
let __hasIsBotCol = null;
let __hasIsBotColCheckedAtMs = 0;

async function hasIsBotColumn(db) {
  if (!db) return false;
  const now = Date.now();
  if (__hasIsBotCol !== null && now - __hasIsBotColCheckedAtMs < 60_000) return __hasIsBotCol;

  try {
    const rs = await db.prepare("PRAGMA table_info('competition_results')").all();
    const cols = Array.isArray(rs?.results) ? rs.results : [];
    const has = cols.some((c) => String(c?.name || "").toLowerCase() === "is_bot");
    __hasIsBotCol = has;
    __hasIsBotColCheckedAtMs = now;
    return has;
  } catch {
    __hasIsBotCol = false;
    __hasIsBotColCheckedAtMs = now;
    return false;
  }
}

// Cached check: does D1 have vf_maps.finish_time_ms?
let __hasMapFinishTimeCol = null;
let __hasMapFinishTimeColCheckedAtMs = 0;

function isNoSuchColumnError(e, colName) {
  const msg = String(e?.message || e || "").toLowerCase();
  const c = String(colName || "").toLowerCase();
  return msg.includes("no such column") && (!c || msg.includes(c));
}

async function hasMapFinishTimeColumn(db) {
  if (!db) return false;
  const now = Date.now();
  if (__hasMapFinishTimeCol !== null && now - __hasMapFinishTimeColCheckedAtMs < 60_000) return __hasMapFinishTimeCol;

  try {
    const rs = await db.prepare("PRAGMA table_info('vf_maps')").all();
    const cols = Array.isArray(rs?.results) ? rs.results : [];
    const has = cols.some((c) => String(c?.name || "").toLowerCase() === "finish_time_ms");
    __hasMapFinishTimeCol = has;
    __hasMapFinishTimeColCheckedAtMs = now;
    return has;
  } catch {
    __hasMapFinishTimeCol = false;
    __hasMapFinishTimeColCheckedAtMs = now;
    return false;
  }
}

async function recomputeAndUpdateMapFinishTimeMs(db, mapId) {
  if (!db || !mapId) return { ok: false, reason: "missing_args" };

  // If the column doesn't exist yet, skip quietly (older deployments).
  if (!(await hasMapFinishTimeColumn(db))) return { ok: false, reason: "no_finish_time_column" };

  // Fetch the current map version/hash so we only compute against the active map definition.
  let mapRow = null;
  try {
    mapRow = await db
      .prepare("SELECT map_version, map_hash_sha256 FROM vf_maps WHERE id = ? LIMIT 1")
      .bind(mapId)
      .first();
  } catch {
    return { ok: false, reason: "map_lookup_failed" };
  }

  if (!mapRow) return { ok: false, reason: "map_not_found" };

  const mapHash = toStr(mapRow?.map_hash_sha256);
  const mapVersion = toInt(mapRow?.map_version, { min: 0, max: 9999, fallback: 0 });

  // Prefer hash match when available; otherwise fall back to map_version.
  let versionWhere = "";
  const params = [mapId];
  if (mapHash) {
    versionWhere = "AND c.map_hash_sha256 = ?";
    params.push(mapHash);
  } else if (mapVersion > 0) {
    versionWhere = "AND c.map_version = ?";
    params.push(mapVersion);
  }

  const hasIsBot = await hasIsBotColumn(db);

  // We define a map's "finish time" as the average winning time per competition.
  // (Average of each competition's best FINISHED time.)
  //
  // Prefer *non-bot* results when they exist; if a map has only bot races so far,
  // fall back to including bots so new maps can still get a reasonable baseline.
  async function queryAgg({ excludeBots } = { excludeBots: true }) {
    const botWhere = excludeBots && hasIsBot ? "AND (r.is_bot IS NULL OR r.is_bot = 0)" : "";

    const sql = `
      WITH per_comp AS (
        SELECT c.id AS competition_id, MIN(r.finish_time_ms) AS best_time_ms
        FROM competitions c
        JOIN competition_results r ON r.competition_id = c.id
        WHERE c.map_id = ?
          ${versionWhere}
          AND r.status = 'FINISHED'
          AND r.finish_time_ms IS NOT NULL
          AND r.finish_time_ms > 0
          ${botWhere}
        GROUP BY c.id
      )
      SELECT AVG(best_time_ms) AS avg_best_time_ms, COUNT(*) AS sample_count
      FROM per_comp;
    `;

    return await db.prepare(sql).bind(...params).first();
  }

  let agg = null;
  let usedBots = false;

  try {
    // 1) Prefer non-bot data (real viewers)
    agg = await queryAgg({ excludeBots: true });
    let sc = Number(agg?.sample_count || 0) || 0;

    // 2) If there are no non-bot samples and the schema supports bots,
    //    fall back to including bots so we can still compute a baseline.
    if (sc === 0 && hasIsBot) {
      const aggAll = await queryAgg({ excludeBots: false });
      const scAll = Number(aggAll?.sample_count || 0) || 0;
      if (scAll > 0) {
        agg = aggAll;
        usedBots = true;
        sc = scAll;
      }
    }
  } catch {
    return { ok: false, reason: "aggregate_query_failed" };
  }

  const avg = Number(agg?.avg_best_time_ms);

  const avgMs = Number.isFinite(avg) ? Math.round(avg) : null;
  const sampleCount = Number(agg?.sample_count || 0) || 0;

  if (sampleCount <= 0 || avgMs === null) {
    // No usable samples (e.g., all DNF). On competition submit we avoid overwriting an existing
    // cached finish time with NULL/0. Admin can still explicitly reset via Recalculate.
    return { ok: false, reason: "no_samples" };
  }


  try {
    await db
      .prepare("UPDATE vf_maps SET finish_time_ms = ?, updated_at_ms = ? WHERE id = ?")
      .bind(avgMs, nowMs(), mapId)
      .run();
  } catch (e) {
    if (isNoSuchColumnError(e, "finish_time_ms")) return { ok: false, reason: "no_finish_time_column" };
    return { ok: false, reason: "update_failed" };
  }

  return { ok: true, finishTimeMs: avgMs || 0, sampleCount, usedBots };
}

function nowMs() {
  return Date.now();
}

function toStr(v) {
  return String(v ?? "").trim();
}

function toLower(v) {
  return toStr(v).toLowerCase();
}

function toInt(v, { min = undefined, max = undefined, fallback = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  let x = Math.trunc(n);
  if (min !== undefined && x < min) x = min;
  if (max !== undefined && x > max) x = max;
  return x;
}

function toFloat(v, { min = undefined, max = undefined, fallback = 0 } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  let x = n;
  if (min !== undefined && x < min) x = min;
  if (max !== undefined && x > max) x = max;
  return x;
}

function isNonEmpty(s) {
  return !!toStr(s);
}

function parseIsoMs(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? t : NaN;
}

function normalizeIso(iso) {
  const t = parseIsoMs(iso);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString();
}

let _seasonCache = {
  fetchedAtMs: 0,
  seasons: [],
};

async function loadSeasonsCached(env) {
  const ttlMs = 60_000;
  const now = nowMs();

  if (_seasonCache.seasons.length > 0 && now - _seasonCache.fetchedAtMs < ttlMs) {
    return _seasonCache.seasons;
  }

  // Prefer D1 (v0.6+)
  try {
    const db = env?.VF_D1_STATS;
    if (db && (await tableExists(db, "vf_seasons"))) {
      const rs = await db
        .prepare("SELECT season_id, start_at_ms, end_at_ms, name FROM vf_seasons")
        .all();

      const seasons = (Array.isArray(rs?.results) ? rs.results : [])
        .map((r) => ({
          seasonId: toStr(r?.season_id).toLowerCase(),
          startAt: isoFromMs(r?.start_at_ms),
          endAt: isoFromMs(r?.end_at_ms),
          name: toStr(r?.name),
        }))
        .filter((s) => s.seasonId && s.startAt && s.endAt);

      _seasonCache = { fetchedAtMs: now, seasons };
      return seasons;
    }
  } catch {
    // fall back to KV
  }

  // Legacy KV fallback
  if (!env?.VF_KV_SEASONS) {
    _seasonCache = { fetchedAtMs: now, seasons: [] };
    return [];
  }

  const raw = await listAllJsonRecords(env.VF_KV_SEASONS).catch(() => []);

  // raw entries are the season objects (viewerfrenzy-web kv helper returns values only)
  const seasons = (Array.isArray(raw) ? raw : [])
    .filter(Boolean)
    .map((s) => ({
      seasonId: toStr(s?.seasonId).toLowerCase(),
      startAt: normalizeIso(s?.startAt),
      endAt: normalizeIso(s?.endAt),
      name: toStr(s?.name),
    }))
    .filter((s) => s.seasonId && s.startAt && s.endAt);

  _seasonCache = { fetchedAtMs: now, seasons };
  return seasons;
}

function resolveSeasonId(seasons, startedAtMs) {
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) return null;

  for (const s of Array.isArray(seasons) ? seasons : []) {
    const startMs = Date.parse(s.startAt);
    const endMs = Date.parse(s.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;

    // inclusive range
    if (startedAtMs >= startMs && startedAtMs <= endMs) {
      return s.seasonId;
    }
  }

  return null;
}

function clampResults(results, max = 400) {
  const arr = Array.isArray(results) ? results : [];
  if (arr.length <= max) return arr;
  return arr.slice(0, max);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "POST") {

  return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  // Streamer-only: the broadcaster account is allowed.
  // (This prevents viewers/subscribers from spamming competition submissions.)
  if (!auth?.access?.allowed || auth?.access?.reason !== "broadcaster") {
    return jsonResponse(
      request,
      { error: "forbidden", message: "Only the broadcaster can submit competition results." },
      403,
    );
  }

  if (!env?.VF_D1_STATS) {
    return jsonResponse(
      request,
      { error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" },
      500,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const competition = body?.competition || null;
  const resultsRaw = clampResults(body?.results, 600);

  const competitionUuid = toStr(competition?.competitionUuid);
  if (!competitionUuid) {

  return jsonResponse(request, { error: "competition_uuid_required" }, 400);
  }

  const startedAtMs = Number(competition?.startedAtMs);
  const endedAtMs = Number(competition?.endedAtMs);
  if (!Number.isFinite(startedAtMs) || startedAtMs <= 0) {

  return jsonResponse(request, { error: "started_at_required" }, 400);
  }
  if (!Number.isFinite(endedAtMs) || endedAtMs <= 0 || endedAtMs < startedAtMs) {

  return jsonResponse(request, { error: "ended_at_invalid" }, 400);
  }

  const vehicleType = toStr(competition?.vehicleType) || "";
  const gameMode = toStr(competition?.gameMode) || "";

  const trackIdRaw = toStr(competition?.trackId);
  // Track IDs are now auto-increment integers in vf_maps.
  // Older clients may still send legacy string IDs; keep those in `map_key`.
  const trackIdInt = (() => {
    if (!trackIdRaw) return null;
    const s = String(trackIdRaw).trim();
    if (!s) return null;
    if (!/^[0-9]+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : null;
  })();
  const trackKey = trackIdRaw && trackIdInt === null ? trackIdRaw : null;
  const trackName = toStr(competition?.trackName);
  const trackVersion = toInt(competition?.trackVersion, { min: 0, max: 9999, fallback: 0 });
  const trackHashSha256 = toStr(competition?.trackHashSha256);

  const raceSeed = toInt(competition?.raceSeed, { min: 0, max: 2_000_000_000, fallback: 0 });
  const trackLengthM = toFloat(competition?.trackLengthM, { min: 0, max: 1_000_000, fallback: 0 });

  const clientVersion = toStr(competition?.clientVersion);
  const unityVersion = toStr(competition?.unityVersion);

  // Winner (best-effort): first FINISHED with position 1.
  let winnerUserId = null;
  for (const r of resultsRaw) {
    if (!r) continue;
    const status = toStr(r.status).toUpperCase();
    const pos = toInt(r.position, { min: 1, max: 10_000, fallback: 0 });
    if (status === "FINISHED" && pos === 1) {
      const uid = toStr(r.userId) || toStr(r.login);
      if (uid) {
        winnerUserId = uid;
        break;
      }
    }
  }

  const seasons = await loadSeasonsCached(env);
  const seasonId = resolveSeasonId(seasons, startedAtMs);

  const streamerUserId = toStr(auth?.user?.userId);
  const streamerLogin = toStr(auth?.user?.login);

  if (!streamerUserId) {

  return jsonResponse(request, { error: "auth_missing_user_id" }, 401);
  }

  const createdAtMs = nowMs();
  const updatedAtMs = createdAtMs;

  // 1) Upsert competition
  // Back-compat: deployments may briefly run this code before the migration that adds competitions.map_key.
  const hasMapKeyCol = await (async () => {
    try {
      const cols = await env.VF_D1_STATS
        .prepare("PRAGMA table_info(competitions)")
        .all();
      return (cols?.results || []).some((r) => r?.name === "map_key");
    } catch {
      return false;
    }
  })();

  const upsertCompetitionSql = hasMapKeyCol
    ? `
    INSERT INTO competitions (
      competition_uuid,
      streamer_user_id,
      streamer_login,
      season_id,
      map_id,
      map_key,
      map_name,
      map_version,
      map_hash_sha256,
      vehicle_type,
      game_mode,
      race_seed,
      track_length_m,
      started_at_ms,
      ended_at_ms,
      winner_user_id,
      client_version,
      unity_version,
      created_at_ms,
      updated_at_ms
    ) VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    )
    ON CONFLICT(competition_uuid) DO UPDATE SET
      streamer_user_id=excluded.streamer_user_id,
      streamer_login=excluded.streamer_login,
      season_id=excluded.season_id,
      map_id=excluded.map_id,
      map_key=excluded.map_key,
      map_name=excluded.map_name,
      map_version=excluded.map_version,
      map_hash_sha256=excluded.map_hash_sha256,
      vehicle_type=excluded.vehicle_type,
      game_mode=excluded.game_mode,
      race_seed=excluded.race_seed,
      track_length_m=excluded.track_length_m,
      started_at_ms=excluded.started_at_ms,
      ended_at_ms=excluded.ended_at_ms,
      winner_user_id=excluded.winner_user_id,
      client_version=excluded.client_version,
      unity_version=excluded.unity_version,
      updated_at_ms=excluded.updated_at_ms
  `
    : `
    INSERT INTO competitions (
      competition_uuid,
      streamer_user_id,
      streamer_login,
      season_id,
      map_id,
      map_name,
      map_version,
      map_hash_sha256,
      vehicle_type,
      game_mode,
      race_seed,
      track_length_m,
      started_at_ms,
      ended_at_ms,
      winner_user_id,
      client_version,
      unity_version,
      created_at_ms,
      updated_at_ms
    ) VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    )
    ON CONFLICT(competition_uuid) DO UPDATE SET
      streamer_user_id=excluded.streamer_user_id,
      streamer_login=excluded.streamer_login,
      season_id=excluded.season_id,
      map_id=excluded.map_id,
      map_name=excluded.map_name,
      map_version=excluded.map_version,
      map_hash_sha256=excluded.map_hash_sha256,
      vehicle_type=excluded.vehicle_type,
      game_mode=excluded.game_mode,
      race_seed=excluded.race_seed,
      track_length_m=excluded.track_length_m,
      started_at_ms=excluded.started_at_ms,
      ended_at_ms=excluded.ended_at_ms,
      winner_user_id=excluded.winner_user_id,
      client_version=excluded.client_version,
      unity_version=excluded.unity_version,
      updated_at_ms=excluded.updated_at_ms
  `;

  const bindArgs = hasMapKeyCol
    ? [
        competitionUuid,
        streamerUserId,
        streamerLogin,
        seasonId,
        trackIdInt,
        trackKey,
        trackName,
        trackVersion,
        trackHashSha256,
        vehicleType,
        gameMode,
        raceSeed,
        trackLengthM,
        Math.trunc(startedAtMs),
        Math.trunc(endedAtMs),
        winnerUserId,
        clientVersion,
        unityVersion,
        createdAtMs,
        updatedAtMs,
      ]
    : [
        competitionUuid,
        streamerUserId,
        streamerLogin,
        seasonId,
        trackIdInt,
        trackName,
        trackVersion,
        trackHashSha256,
        vehicleType,
        gameMode,
        raceSeed,
        trackLengthM,
        Math.trunc(startedAtMs),
        Math.trunc(endedAtMs),
        winnerUserId,
        clientVersion,
        unityVersion,
        createdAtMs,
        updatedAtMs,
      ];

  await env.VF_D1_STATS.prepare(upsertCompetitionSql).bind(...bindArgs).run();

  const compRow = await env.VF_D1_STATS
    .prepare("SELECT id FROM competitions WHERE competition_uuid = ?")
    .bind(competitionUuid)
    .first();

  const competitionId = compRow?.id;
  if (!competitionId) {
    return jsonResponse(
      request,
      { error: "db_error", message: "Failed to read competition id after upsert." },
      500,
    );
  }

  // Detect whether the DB has the `competition_results.is_bot` column.
  // (This lets the API stay compatible if the code is deployed slightly before the migration is run.)
  const hasBotFlag = await hasIsBotColumn(env.VF_D1_STATS);

  // 2) Upsert results
  // NOTE: we conditionally include the `is_bot` field to avoid breaking if
  // the worker is deployed before the DB migration is applied.
  const upsertResultSql = hasBotFlag
    ? `
      INSERT INTO competition_results (
        competition_id,
        viewer_user_id,
        viewer_login,
        viewer_display_name,
        viewer_profile_image_url,
        is_bot,
        finish_position,
        status,
        finish_time_ms,
        vehicle_id,
        distance_m,
        progress01,
        created_at_ms,
        updated_at_ms
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?,?
      )
      ON CONFLICT(competition_id, viewer_user_id) DO UPDATE SET
        viewer_login=excluded.viewer_login,
        viewer_display_name=excluded.viewer_display_name,
        viewer_profile_image_url=excluded.viewer_profile_image_url,
        is_bot=excluded.is_bot,
        finish_position=excluded.finish_position,
        status=excluded.status,
        finish_time_ms=excluded.finish_time_ms,
        vehicle_id=excluded.vehicle_id,
        distance_m=excluded.distance_m,
        progress01=excluded.progress01,
        updated_at_ms=excluded.updated_at_ms
    `
    : `
      INSERT INTO competition_results (
        competition_id,
        viewer_user_id,
        viewer_login,
        viewer_display_name,
        viewer_profile_image_url,
        finish_position,
        status,
        finish_time_ms,
        vehicle_id,
        distance_m,
        progress01,
        created_at_ms,
        updated_at_ms
      ) VALUES (
        ?,?,?,?,?,?,?,?,?,?,?,?,?
      )
      ON CONFLICT(competition_id, viewer_user_id) DO UPDATE SET
        viewer_login=excluded.viewer_login,
        viewer_display_name=excluded.viewer_display_name,
        viewer_profile_image_url=excluded.viewer_profile_image_url,
        finish_position=excluded.finish_position,
        status=excluded.status,
        finish_time_ms=excluded.finish_time_ms,
        vehicle_id=excluded.vehicle_id,
        distance_m=excluded.distance_m,
        progress01=excluded.progress01,
        updated_at_ms=excluded.updated_at_ms
    `;

  const statements = [];
  const viewerIds = new Set();

  for (const r of resultsRaw) {
    if (!r) continue;

    const viewerUserId = toStr(r?.userId) || toStr(r?.login);
    if (!viewerUserId) continue;

    const viewerLogin = toLower(r?.login);

    // --- Bot detection -----------------------------------------------------
    // Prefer an explicit boolean from the client.
    // Fallbacks exist for older client builds so you can deploy server+DB first.
    let isBot = toBool(r?.isBot);
    if (!isBot) {
      const uid = viewerUserId;
      // New convention (recommended): "bot:0001" etc.
      if (/^bot[:_]/i.test(uid)) isBot = true;
      // Legacy convention: empty login + "Racer 1" display/user id.
      if (!viewerLogin && /^racer\s+\d+$/i.test(uid)) isBot = true;
    }

    // Only real viewers should earn achievements.
    if (!isBot) viewerIds.add(viewerUserId);
    const displayName = toStr(r?.displayName);
    const profileImageUrl = toStr(r?.profileImageUrl);

    const finishPosition = toInt(r?.position, { min: 1, max: 10_000, fallback: 9999 });

    const statusRaw = toStr(r?.status).toUpperCase();
    const status = statusRaw === "FINISHED" ? "FINISHED" : "DNF";

    const timeMsRaw = Number(r?.timeMs);
    const finishTimeMs = status === "FINISHED" && Number.isFinite(timeMsRaw) && timeMsRaw > 0 ? Math.trunc(timeMsRaw) : null;

    const vehicleId = toStr(r?.vehicleId);

    const distanceM = toFloat(r?.distanceM, { min: 0, max: 1_000_000, fallback: 0 });
    const progress01 = toFloat(r?.progress01, { min: 0, max: 1, fallback: 0 });

    const isBotInt = toBoolInt(isBot);

    statements.push(
      hasBotFlag
        ? env.VF_D1_STATS.prepare(upsertResultSql).bind(
          competitionId,
          viewerUserId,
          viewerLogin,
          displayName,
          profileImageUrl,
          isBotInt,
          finishPosition,
          status,
          finishTimeMs,
          vehicleId,
          distanceM,
          progress01,
          createdAtMs,
          updatedAtMs,
        )
        : env.VF_D1_STATS.prepare(upsertResultSql).bind(
          competitionId,
          viewerUserId,
          viewerLogin,
          displayName,
          profileImageUrl,
          finishPosition,
          status,
          finishTimeMs,
          vehicleId,
          distanceM,
          progress01,
          createdAtMs,
          updatedAtMs,
        ),
    );
  }

  // Avoid massive single-batch requests.
  const BATCH_SIZE = 100;
  for (const chunk of chunkArray(statements, BATCH_SIZE)) {
    // D1 returns an array of results; ignore it for MVP.
    await env.VF_D1_STATS.batch(chunk);
  }

  // Award achievements (best-effort). This is intentionally after results are written.
  let achievementsUnlocked = [];
  try {
    achievementsUnlocked = await awardAchievementsForViewers(env, Array.from(viewerIds), {
      source: "competition",
      sourceRef: String(competitionId || competitionUuid || ""),
    });
  } catch {
    achievementsUnlocked = [];
  }

  // Update cached map finish time on vf_maps (best-effort).
  // This allows Unity clients to display "Avg Finish Time" from the local map cache.
  try {
    if (trackIdInt !== null && trackIdInt > 0) {
      await recomputeAndUpdateMapFinishTimeMs(env.VF_D1_STATS, trackIdInt);
    }
  } catch {
    // Ignore failures to avoid breaking competition submissions.
  }



  return jsonResponse(request, {
    ok: true,
    competitionUuid,
    seasonId,
    competitionId,
    resultsReceived: resultsRaw.length,
    resultsWritten: statements.length,
    achievementsUnlocked,
  });
}
