// functions/api/v1/stats/meta.js
// Public endpoint: returns distinct streamers and maps present in the stats DB.
//
// Intended to power UI filters on viewerfrenzy.com.

import { handleOptions, buildCorsHeaders } from "../../../_lib/cors.js";

const CACHE_TTL_SECONDS = 300; // 5 minutes

function json(request, data, status = 200, cacheSeconds = 0) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    ...buildCorsHeaders(request),
  };
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

function getCacheKey(request) {
  // Include Origin in the cache key to avoid serving a cached response
  // with the wrong Access-Control-Allow-Origin value.
  const u = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  u.searchParams.set("_o", origin);
  return new Request(u.toString(), request);
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

  // Cache at the edge (low churn data)
  const cache = caches.default;
  const cacheKey = getCacheKey(request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let streamers;
  let maps;
  try {
    // Distinct streamers
    streamers = await env.VF_D1_STATS.prepare(
      `
        SELECT
          streamer_user_id AS userId,
          streamer_login AS login,
          streamer_login AS displayName,
          NULL AS profileImageUrl,
          COUNT(*) AS competitions
        FROM competitions
        GROUP BY streamer_user_id
        ORDER BY LOWER(COALESCE(streamer_login, streamer_user_id)) ASC;
      `,
    ).all();

    // Distinct maps (track_id). Keep the latest non-empty track_name if available.
    maps = await env.VF_D1_STATS.prepare(
      `
        SELECT
          map_id AS trackId,
          COALESCE(NULLIF(MAX(COALESCE(map_name, '')), ''), map_id) AS trackName,
          COUNT(*) AS competitions
        FROM competitions
        WHERE map_id IS NOT NULL AND TRIM(map_id) <> ''
        GROUP BY map_id
        ORDER BY LOWER(trackName) ASC;
      `,
    ).all();
  } catch (e) {
    // Most common cause: DB not initialized yet (missing tables).
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

  const data = {
    ok: true,
    streamers: streamers?.results || [],
    maps: maps?.results || [],
  };

  const response = json(request, data, 200, CACHE_TTL_SECONDS);
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
