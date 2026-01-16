// functions/api/v1/seasons/active.js
// Public endpoint: returns the currently active season (or null).
//
// New storage (v0.6+): D1
// - vf_seasons
//
// Legacy fallback (pre-v0.6): KV
// - VF_KV_SEASONS

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { listAllJsonRecords } from "../../../_lib/kv.js";
import { isoFromMs, tableExists } from "../../../_lib/dbUtil.js";

let _cache = { fetchedAtMs: 0, season: null, nowIso: "", source: "" };
const CACHE_TTL_MS = 30_000;

function normalizeIso(iso) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString();
}

function isActiveSeason(season, nowMs) {
  const startMs = Date.parse(season?.startAt || "");
  const endMs = Date.parse(season?.endAt || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return nowMs >= startMs && nowMs <= endMs;
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
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const nowMs = Date.now();
  if (nowMs - _cache.fetchedAtMs < CACHE_TTL_MS) {
    return jsonResponse(request, { ok: true, now: _cache.nowIso, season: _cache.season, meta: { source: _cache.source } }, 200);
  }

  // Prefer D1
  try {
    const db = env?.VF_D1_STATS;
    if (db && (await tableExists(db, "vf_seasons"))) {
      const row = await db
        .prepare(
          "SELECT season_id, name, description, start_at_ms, end_at_ms, created_at_ms, updated_at_ms, updated_by_login, updated_by_user_id " +
            "FROM vf_seasons WHERE start_at_ms <= ? AND end_at_ms >= ? ORDER BY start_at_ms DESC LIMIT 1",
        )
        .bind(nowMs, nowMs)
        .first();

      const nowIso = new Date(nowMs).toISOString();
      const season = row ? safeSeasonFromDb(row) : null;
      _cache = { fetchedAtMs: nowMs, season, nowIso, source: "d1" };
      return jsonResponse(request, { ok: true, now: nowIso, season, meta: { source: "d1" } }, 200);
    }
  } catch {
    // fall back to KV
  }

  // KV fallback
  if (!env?.VF_KV_SEASONS) {
    return jsonResponse(request, { error: "kv_not_bound", message: "Missing KV binding: VF_KV_SEASONS" }, 500);
  }

  const seasons = await listAllJsonRecords(env.VF_KV_SEASONS);
  const nowIso = new Date(nowMs).toISOString();

  let active = null;
  for (const s of Array.isArray(seasons) ? seasons : []) {
    if (isActiveSeason(s, nowMs)) {
      if (!active) {
        active = s;
      } else {
        const aStart = Date.parse(active?.startAt || "");
        const bStart = Date.parse(s?.startAt || "");
        if (Number.isFinite(bStart) && (!Number.isFinite(aStart) || bStart > aStart)) {
          active = s;
        }
      }
    }
  }

  if (active) {
    active = {
      ...active,
      seasonId: String(active?.seasonId || "").trim(),
      name: String(active?.name || "").trim(),
      description: String(active?.description || "").trim(),
      startAt: normalizeIso(active?.startAt),
      endAt: normalizeIso(active?.endAt),
      createdAt: normalizeIso(active?.createdAt),
      updatedAt: normalizeIso(active?.updatedAt),
      updatedBy: String(active?.updatedBy || "").trim(),
      updatedById: String(active?.updatedById || "").trim(),
    };
  }

  _cache = { fetchedAtMs: nowMs, season: active, nowIso, source: "kv" };
  return jsonResponse(request, { ok: true, now: nowIso, season: active, meta: { source: "kv" } }, 200);
}
