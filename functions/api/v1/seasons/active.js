// functions/api/v1/seasons/active.js
// Public endpoint: returns the currently active season (or null).
//
// NOTE: This endpoint is intentionally unauthenticated so the Unity game
// and website can read the current season ID without an admin session.

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { listAllJsonRecords } from "../../../_lib/kv.js";

let _cache = { fetchedAtMs: 0, season: null, nowIso: "" };
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
  // Inclusive end (matches admin validation). If you prefer end-exclusive,
  // change to: nowMs < endMs.
  return nowMs >= startMs && nowMs <= endMs;
}

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  if (!env?.VF_KV_SEASONS) {
    return jsonResponse(
      request,
      { error: "kv_not_bound", message: "Missing KV binding: VF_KV_SEASONS" },
      500,
    );
  }

  const nowMs = Date.now();
  if (nowMs - _cache.fetchedAtMs < CACHE_TTL_MS) {
    return jsonResponse(request, { ok: true, now: _cache.nowIso, season: _cache.season }, 200);
  }

  const seasons = await listAllJsonRecords(env.VF_KV_SEASONS);
  const nowIso = new Date(nowMs).toISOString();

  let active = null;
  for (const s of Array.isArray(seasons) ? seasons : []) {
    if (isActiveSeason(s, nowMs)) {
      // If multiple match (shouldn't happen), pick the one with the latest startAt.
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

  _cache = { fetchedAtMs: nowMs, season: active, nowIso };
  return jsonResponse(request, { ok: true, now: nowIso, season: active }, 200);
}
