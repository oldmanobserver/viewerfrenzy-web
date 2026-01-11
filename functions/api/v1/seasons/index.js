// functions/api/v1/seasons/index.js
// Public endpoint: returns all seasons defined in VF_KV_SEASONS (sorted by startAt desc).
//
// This is intentionally unauthenticated so the Unity game and public pages
// can populate season filters.

import { handleOptions, buildCorsHeaders } from "../../../_lib/cors.js";
import { listAllJsonRecords } from "../../../_lib/kv.js";

let _cache = { fetchedAtMs: 0, seasons: [], nowIso: "" };
const CACHE_TTL_MS = 30_000;

function normalizeIso(iso) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  return new Date(t).toISOString();
}

function safeSeason(s) {
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

  if (!env?.VF_KV_SEASONS) {
    return new Response(
      JSON.stringify(
        { error: "kv_not_bound", message: "Missing KV binding: VF_KV_SEASONS" },
        null,
        2,
      ),
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

  const nowMs = Date.now();
  if (nowMs - _cache.fetchedAtMs < CACHE_TTL_MS) {
    return new Response(JSON.stringify({ ok: true, now: _cache.nowIso, seasons: _cache.seasons }, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=30",
        ...buildCorsHeaders(request),
      },
    });
  }

  const seasonsRaw = await listAllJsonRecords(env.VF_KV_SEASONS);
  const seasons = (Array.isArray(seasonsRaw) ? seasonsRaw : []).map(safeSeason);

  // Sort newest first by startAt.
  seasons.sort((a, b) => {
    const ta = Date.parse(a?.startAt || "") || 0;
    const tb = Date.parse(b?.startAt || "") || 0;
    return tb - ta;
  });

  const nowIso = new Date(nowMs).toISOString();
  _cache = { fetchedAtMs: nowMs, seasons, nowIso };

  return new Response(JSON.stringify({ ok: true, now: nowIso, seasons }, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=30",
      ...buildCorsHeaders(request),
    },
  });
}
