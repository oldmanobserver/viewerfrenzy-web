// functions/api/v1/seasons/index.js
// Public endpoint: returns all seasons.
//
// New storage (v0.6+): D1
// - vf_seasons
//
// Legacy fallback (pre-v0.6): KV
// - VF_KV_SEASONS

import { handleOptions, buildCorsHeaders } from "../../../_lib/cors.js";
import { listAllJsonRecords } from "../../../_lib/kv.js";
import { isoFromMs, tableExists } from "../../../_lib/dbUtil.js";

let _cache = { fetchedAtMs: 0, seasons: [], nowIso: "", source: "" };
const CACHE_TTL_MS = 30_000;

function normalizeIso(iso) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString();
}

function safeSeasonFromKv(s) {
  return {
    ...s,
    seasonId: String(s?.seasonId || "").trim(),
    name: String(s?.name || "").trim(),
    description: String(s?.description || "").trim(),
    startAt: normalizeIso(s?.startAt),
    endAt: normalizeIso(s?.endAt),
    createdAt: normalizeIso(s?.createdAt),
    updatedAt: normalizeIso(s?.updatedAt),
    updatedBy: String(s?.updatedBy || "").trim(),
    updatedById: String(s?.updatedById || "").trim(),
  };
}

function safeSeasonFromDb(r) {
  const seasonId = String(r?.season_id || "").trim();
  return {
    seasonId,
    name: String(r?.name || seasonId).trim(),
    description: String(r?.description || "").trim(),
    startAt: isoFromMs(r?.start_at_ms),
    endAt: isoFromMs(r?.end_at_ms),
    createdAt: isoFromMs(r?.created_at_ms),
    updatedAt: isoFromMs(r?.updated_at_ms),
    updatedBy: String(r?.updated_by_login || "").trim(),
    updatedById: String(r?.updated_by_user_id || "").trim(),
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }, null, 2), {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...buildCorsHeaders(request),
      },
    });
  }

  const nowMs = Date.now();
  if (nowMs - _cache.fetchedAtMs < CACHE_TTL_MS) {
    return new Response(
      JSON.stringify({ ok: true, now: _cache.nowIso, seasons: _cache.seasons, meta: { source: _cache.source } }, null, 2),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, max-age=30",
          ...buildCorsHeaders(request),
        },
      },
    );
  }

  // Prefer D1
  try {
    const db = env?.VF_D1_STATS;
    if (db && (await tableExists(db, "vf_seasons"))) {
      const rs = await db
        .prepare(
          "SELECT season_id, name, description, start_at_ms, end_at_ms, created_at_ms, updated_at_ms, updated_by_login, updated_by_user_id FROM vf_seasons",
        )
        .all();

      const seasons = (Array.isArray(rs?.results) ? rs.results : []).map(safeSeasonFromDb);

      seasons.sort((a, b) => {
        const ta = Date.parse(a?.startAt || "") || 0;
        const tb = Date.parse(b?.startAt || "") || 0;
        return tb - ta;
      });

      const nowIso = new Date(nowMs).toISOString();
      _cache = { fetchedAtMs: nowMs, seasons, nowIso, source: "d1" };

      return new Response(
        JSON.stringify({ ok: true, now: nowIso, seasons, meta: { source: "d1" } }, null, 2),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=30",
            ...buildCorsHeaders(request),
          },
        },
      );
    }
  } catch {
    // fall back to KV
  }

  // Legacy KV fallback
  if (!env?.VF_KV_SEASONS) {
    return new Response(
      JSON.stringify({ error: "kv_not_bound", message: "Missing KV binding: VF_KV_SEASONS" }, null, 2),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ...buildCorsHeaders(request),
        },
      },
    );
  }

  const seasonsRaw = await listAllJsonRecords(env.VF_KV_SEASONS);
  const seasons = (Array.isArray(seasonsRaw) ? seasonsRaw : []).map(safeSeasonFromKv);

  seasons.sort((a, b) => {
    const ta = Date.parse(a?.startAt || "") || 0;
    const tb = Date.parse(b?.startAt || "") || 0;
    return tb - ta;
  });

  const nowIso = new Date(nowMs).toISOString();
  _cache = { fetchedAtMs: nowMs, seasons, nowIso, source: "kv" };

  return new Response(
    JSON.stringify({ ok: true, now: nowIso, seasons, meta: { source: "kv" } }, null, 2),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30",
        ...buildCorsHeaders(request),
      },
    },
  );
}
