import { jsonResponse } from "../../../../_lib/response.js";

// Public endpoint: returns a map's thumbnail PNG (if available).
//
// NOTE: This file intentionally does NOT import a shared `toInt()` helper because
// the viewerfrenzy-web repo does not expose one under functions/_lib.
function toInt(v, def = 0) {
  const n = Number.parseInt(String(v ?? "").trim(), 10);
  return Number.isFinite(n) ? n : def;
}

export async function onRequest(context) {
  const { request, env, params } = context;

  // Simple CORS preflight (safe for images + Unity WebGL fetches).
  if (request.method === "OPTIONS") {
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (request.method !== "GET") {
    return jsonResponse(request, { ok: false, error: "bad_method" }, 405);
  }

  const mapId = toInt(params?.mapId);
  if (!mapId || mapId <= 0) {
    return jsonResponse(request, { ok: false, error: "bad_id" }, 400);
  }

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(
      request,
      { ok: false, error: "missing_db", message: "VF_D1_STATS binding not configured." },
      500,
    );
  }

  let row = null;
  try {
    row = await db.prepare("SELECT thumb_png AS png FROM vf_maps WHERE id = ?").bind(mapId).first();
  } catch (e) {
    // Likely DB not migrated yet (no such column) or other DB error.
    return new Response("thumb_png_not_available", {
      status: 404,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const png = row?.png;
  if (!png) {
    return new Response("thumb_not_found", {
      status: 404,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  // D1 returns BLOB columns as ArrayBuffer.
  const bytes = png instanceof ArrayBuffer ? new Uint8Array(png) : new Uint8Array(png);

  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
