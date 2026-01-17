// functions/api/v1/stats/leaderboard.js
// Public endpoint: aggregated per-viewer leaderboard + stats.
//
// Features:
// - Filters: seasonId, streamerId, mapId (trackId)
// - Searches: streamerSearch, viewerSearch, mapSearch
// - Sorting: allowlisted sortBy columns, sortDir (asc|desc)
// - Pagination: page + pageSize
// - Edge caching (short TTL) to keep it snappy and reduce D1 load

import { handleOptions, buildCorsHeaders } from "../../../_lib/cors.js";
import { toBool } from "../../../_lib/dbUtil.js";

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

const CACHE_TTL_SECONDS = 30;

function json(request, data, status = 200, cacheSeconds = 0) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    ...buildCorsHeaders(request),
  };
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function getCacheKey(request) {
  // Include Origin in cache key to avoid wrong allow-origin values.
  const u = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  u.searchParams.set("_o", origin);
  return new Request(u.toString(), request);
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normStr(v) {
  return String(v ?? "").trim();
}

function normSearch(v) {
  const s = normStr(v).toLowerCase();
  if (!s) return "";
  // Limit length to keep LIKE queries reasonable.
  return s.slice(0, 80);
}

function buildWhereAndParams(url, { includeBots = false, hasBotFlag = false } = {}) {
  const where = [];
  const params = [];

  const seasonId = normStr(url.searchParams.get("seasonId"));
  const streamerId = normStr(url.searchParams.get("streamerId"));
  const mapId = normStr(url.searchParams.get("mapId"));
  const vehicleType = normStr(url.searchParams.get("vehicleType"));

  if (seasonId && seasonId.toUpperCase() !== "ALL") {
    where.push("c.season_id = ?");
    params.push(seasonId);
  }

  if (streamerId && streamerId.toUpperCase() !== "ALL") {
    where.push("c.streamer_user_id = ?");
    params.push(streamerId);
  }

  if (mapId && mapId.toUpperCase() !== "ALL") {
    where.push("c.map_id = ?");
    params.push(mapId);
  }

  // Vehicle type / mode (ground | resort | space)
  if (vehicleType && vehicleType.toUpperCase() !== "ALL") {
    where.push("LOWER(TRIM(COALESCE(c.vehicle_type,''))) = ?");
    params.push(vehicleType.toLowerCase());
  }

  const streamerSearch = normSearch(url.searchParams.get("streamerSearch"));
  if (streamerSearch) {
    where.push(
      "(LOWER(COALESCE(c.streamer_login,'')) LIKE ? OR LOWER(COALESCE(c.streamer_user_id,'')) LIKE ?)",
    );
    params.push(`%${streamerSearch}%`, `%${streamerSearch}%`);
  }

  const viewerSearch = normSearch(url.searchParams.get("viewerSearch"));
  if (viewerSearch) {
    where.push(
      "(LOWER(COALESCE(r.viewer_login,'')) LIKE ? OR LOWER(COALESCE(r.viewer_display_name,'')) LIKE ? OR LOWER(COALESCE(r.viewer_user_id,'')) LIKE ?)",
    );
    params.push(`%${viewerSearch}%`, `%${viewerSearch}%`, `%${viewerSearch}%`);
  }

  const mapSearch = normSearch(url.searchParams.get("mapSearch"));
  if (mapSearch) {
    where.push(
      "(LOWER(COALESCE(c.map_id,'')) LIKE ? OR LOWER(COALESCE(c.map_name,'')) LIKE ?)",
    );
    params.push(`%${mapSearch}%`, `%${mapSearch}%`);
  }

  // Bots are excluded by default.
  // If the DB hasn't been upgraded yet (no is_bot column), we simply can't filter.
  if (!includeBots && hasBotFlag) {
    where.push("r.is_bot = 0");
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return { whereSql, params };
}

function buildOrderBy(sortBy, sortDir) {
  const dir = String(sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const key = String(sortBy || "wins").trim();

  // Allowlisted sort keys -> SQL expressions.
  // NOTE: Do NOT place user input directly into SQL.
  const map = {
    viewer: "LOWER(COALESCE(vb.viewer_display_name, vb.viewer_login, vb.viewer_user_id))",
    competitions: "vb.competitions",
    wins: "vb.firsts",
    firsts: "vb.firsts",
    seconds: "vb.seconds",
    thirds: "vb.thirds",
    bestFinishPos: "pa.best_finish_pos",
    worstFinishPos: "pa.worst_finish_pos",
    avgFinishPos: "pa.avg_finish_pos",
    medianFinishPos: "pq.median_finish_pos",
    p10FinishPos: "pq.p10_finish_pos",
    p25FinishPos: "pq.p25_finish_pos",
    p75FinishPos: "pq.p75_finish_pos",
    p90FinishPos: "pq.p90_finish_pos",
    finishedCount: "vb.finished_count",
    dnfCount: "(vb.competitions - vb.finished_count)",

    bestTimeMs: "tb.best_time_ms",
    worstTimeMs: "tb.worst_time_ms",
    avgTimeMs: "tb.avg_time_ms",
    medianTimeMs: "tq.median_time_ms",
    p10TimeMs: "tq.p10_time_ms",
    p25TimeMs: "tq.p25_time_ms",
    p75TimeMs: "tq.p75_time_ms",
    p90TimeMs: "tq.p90_time_ms",
  };

  const expr = map[key] || map.wins;

  // Nulls last for expressions that can be null (primarily time stats).
  const nullSensitive =
    key.toLowerCase().includes("time") ||
    key.toLowerCase().includes("median") ||
    key.toLowerCase().includes("p10") ||
    key.toLowerCase().includes("p25") ||
    key.toLowerCase().includes("p75") ||
    key.toLowerCase().includes("p90");

  if (nullSensitive) {
    return `ORDER BY (CASE WHEN ${expr} IS NULL THEN 1 ELSE 0 END) ASC, ${expr} ${dir}, LOWER(COALESCE(vb.viewer_login, vb.viewer_user_id)) ASC`;
  }

  return `ORDER BY ${expr} ${dir}, LOWER(COALESCE(vb.viewer_login, vb.viewer_user_id)) ASC`;
}

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return json(request, { error: "method_not_allowed" }, 405);
  }

  if (!env?.VF_D1_STATS) {
    return json(
      request,
      { error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" },
      500,
    );
  }

  const url = new URL(request.url);
  const page = clampInt(url.searchParams.get("page"), 1, 1, 1_000_000);
  const pageSize = clampInt(url.searchParams.get("pageSize"), 25, 5, 200);

  const sortBy = normStr(url.searchParams.get("sortBy")) || "wins";
  const sortDir = normStr(url.searchParams.get("sortDir")) || "desc";

  // Edge cache per full query string.
  const cache = caches.default;
  const cacheKey = getCacheKey(request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const includeBots = toBool(url.searchParams.get("showBots"));
  const hasBotFlag = await hasIsBotColumn(env.VF_D1_STATS);
  const { whereSql, params } = buildWhereAndParams(url, { includeBots, hasBotFlag });

  const filteredCte = `
    WITH filtered AS (
      SELECT
        c.id AS competition_id,
        c.season_id,
        c.streamer_user_id,
        c.streamer_login,
        c.map_id,
        c.map_name,
        r.viewer_user_id,
        r.viewer_login,
        r.viewer_display_name,
        r.viewer_profile_image_url,
        r.finish_position AS position,
        r.status,
        r.finish_time_ms
      FROM competitions c
      JOIN competition_results r ON r.competition_id = c.id
      ${whereSql}
    )
  `;

  // Total distinct viewers (for pagination)
  const countSql = `${filteredCte}
    SELECT COUNT(DISTINCT viewer_user_id) AS totalItems
    FROM filtered;
  `;

  let totalItems = 0;
  let safePage = 1;
  let totalPages = 1;
  let offset = 0;

  try {
    const totalRow = await env.VF_D1_STATS.prepare(countSql).bind(...params).first();
    totalItems = Number(totalRow?.totalItems || 0) || 0;
    totalPages = totalItems > 0 ? Math.ceil(totalItems / pageSize) : 1;
    safePage = Math.min(page, totalPages);
    offset = (safePage - 1) * pageSize;
  } catch (e) {
    return json(
      request,
      {
        error: "db_not_initialized",
        message:
          "Stats DB tables not found. Initialize/upgrade the stats database from manage.viewerfrenzy.com → DB Manager.",
        details: String(e?.message || e),
      },
      503,
    );
  }

  const orderBySql = buildOrderBy(sortBy, sortDir);

  const dataSql = `${filteredCte}
    , viewer_base AS (
      SELECT
        viewer_user_id,
        MAX(viewer_login) AS viewer_login,
        MAX(viewer_display_name) AS viewer_display_name,
        MAX(viewer_profile_image_url) AS viewer_profile_image_url,
        COUNT(*) AS competitions,
	        SUM(CASE WHEN status = 'FINISHED' THEN 1 ELSE 0 END) AS finished_count,
	        SUM(CASE WHEN status = 'FINISHED' AND position = 1 THEN 1 ELSE 0 END) AS firsts,
	        SUM(CASE WHEN status = 'FINISHED' AND position = 2 THEN 1 ELSE 0 END) AS seconds,
	        SUM(CASE WHEN status = 'FINISHED' AND position = 3 THEN 1 ELSE 0 END) AS thirds
      FROM filtered
      GROUP BY viewer_user_id
	    ), pos_only AS (
	      SELECT
	        viewer_user_id,
	        position
	      FROM filtered
	      WHERE status = 'FINISHED' AND position IS NOT NULL
	    ), pos_agg AS (
	      SELECT
	        viewer_user_id,
	        MIN(position) AS best_finish_pos,
	        MAX(position) AS worst_finish_pos,
	        AVG(position) AS avg_finish_pos
	      FROM pos_only
	      GROUP BY viewer_user_id
	    ), pos_ranked AS (
      SELECT
        viewer_user_id,
        position,
        COUNT(*) OVER (PARTITION BY viewer_user_id) AS n,
        ROW_NUMBER() OVER (PARTITION BY viewer_user_id ORDER BY position ASC) AS rn
	      FROM pos_only
    ), pos_quant AS (
      SELECT
        viewer_user_id,
        MAX(CASE WHEN rn = CAST((0.10 * n + 0.999999) AS INT) THEN position END) AS p10_finish_pos,
        MAX(CASE WHEN rn = CAST((0.25 * n + 0.999999) AS INT) THEN position END) AS p25_finish_pos,
        MAX(CASE WHEN rn = CAST((0.50 * n + 0.999999) AS INT) THEN position END) AS median_finish_pos,
        MAX(CASE WHEN rn = CAST((0.75 * n + 0.999999) AS INT) THEN position END) AS p75_finish_pos,
        MAX(CASE WHEN rn = CAST((0.90 * n + 0.999999) AS INT) THEN position END) AS p90_finish_pos
      FROM pos_ranked
      GROUP BY viewer_user_id
	    ), time_base AS (
	      SELECT
	        viewer_user_id,
	        MIN(finish_time_ms) AS best_time_ms,
	        MAX(finish_time_ms) AS worst_time_ms,
	        AVG(finish_time_ms) AS avg_time_ms
	      FROM filtered
	      WHERE status = 'FINISHED' AND finish_time_ms IS NOT NULL
	      GROUP BY viewer_user_id
    ), time_ranked AS (
      SELECT
        viewer_user_id,
        finish_time_ms AS time_ms,
        COUNT(*) OVER (PARTITION BY viewer_user_id) AS n,
        ROW_NUMBER() OVER (PARTITION BY viewer_user_id ORDER BY finish_time_ms ASC) AS rn
      FROM filtered
      WHERE status = 'FINISHED' AND finish_time_ms IS NOT NULL
    ), time_quant AS (
      SELECT
        viewer_user_id,
        MAX(CASE WHEN rn = CAST((0.10 * n + 0.999999) AS INT) THEN time_ms END) AS p10_time_ms,
        MAX(CASE WHEN rn = CAST((0.25 * n + 0.999999) AS INT) THEN time_ms END) AS p25_time_ms,
        MAX(CASE WHEN rn = CAST((0.50 * n + 0.999999) AS INT) THEN time_ms END) AS median_time_ms,
        MAX(CASE WHEN rn = CAST((0.75 * n + 0.999999) AS INT) THEN time_ms END) AS p75_time_ms,
        MAX(CASE WHEN rn = CAST((0.90 * n + 0.999999) AS INT) THEN time_ms END) AS p90_time_ms
      FROM time_ranked
      GROUP BY viewer_user_id
    )
    SELECT
      vb.viewer_user_id AS viewerUserId,
      vb.viewer_login AS viewerLogin,
      vb.viewer_display_name AS viewerDisplayName,
      vb.viewer_profile_image_url AS viewerProfileImageUrl,

      vb.competitions AS competitions,
      vb.firsts AS wins,
      vb.firsts AS firsts,
      vb.seconds AS seconds,
      vb.thirds AS thirds,

	      pa.best_finish_pos AS bestFinishPos,
	      pa.worst_finish_pos AS worstFinishPos,
	      pa.avg_finish_pos AS avgFinishPos,
      pq.median_finish_pos AS medianFinishPos,
      pq.p10_finish_pos AS p10FinishPos,
      pq.p25_finish_pos AS p25FinishPos,
      pq.p75_finish_pos AS p75FinishPos,
      pq.p90_finish_pos AS p90FinishPos,

	      vb.finished_count AS finishedCount,
	      (vb.competitions - vb.finished_count) AS dnfCount,

      tb.best_time_ms AS bestTimeMs,
      tb.worst_time_ms AS worstTimeMs,
      tb.avg_time_ms AS avgTimeMs,
      tq.median_time_ms AS medianTimeMs,
      tq.p10_time_ms AS p10TimeMs,
      tq.p25_time_ms AS p25TimeMs,
      tq.p75_time_ms AS p75TimeMs,
      tq.p90_time_ms AS p90TimeMs
	    FROM viewer_base vb
	    LEFT JOIN pos_agg pa ON pa.viewer_user_id = vb.viewer_user_id
	    LEFT JOIN pos_quant pq ON pq.viewer_user_id = vb.viewer_user_id
    LEFT JOIN time_base tb ON tb.viewer_user_id = vb.viewer_user_id
    LEFT JOIN time_quant tq ON tq.viewer_user_id = vb.viewer_user_id
    ${orderBySql}
    LIMIT ? OFFSET ?;
  `;

  let rows;
  try {
    rows = await env.VF_D1_STATS.prepare(dataSql)
      .bind(...params, pageSize, offset)
      .all();
  } catch (e) {
    return json(
      request,
      {
        error: "db_query_failed",
        message: "Failed to query leaderboard.",
        details: String(e?.message || e),
      },
      500,
    );
  }

  const items = rows?.results || [];

  const data = {
    ok: true,
    page: safePage,
    pageSize,
    totalItems,
    totalPages,
    sortBy,
    sortDir: String(sortDir || "desc").toLowerCase() === "asc" ? "asc" : "desc",
    items,
  };

  const response = json(request, data, 200, CACHE_TTL_SECONDS);
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
