import { jsonResponse } from "../../../../_lib/response.js";
import { toInt } from "../../../../_lib/toModel.js";

// Public endpoint: returns a map's large preview PNG (if available).
export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS")
    return new Response("", {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Max-Age": "86400",
      },
    });

  if (request.method !== "GET")
    return jsonResponse(request, { ok: false, error: "bad_method" }, 405);

  const mapId = toInt(params?.mapId);
  if (!mapId || mapId <= 0)
    return jsonResponse(request, { ok: false, error: "bad_id" }, 400);

  let row = null;
  try {
    row = await env.DB
      .prepare("SELECT image_png AS png FROM vf_maps WHERE id = ?")
      .bind(mapId)
      .first();
  } catch (e) {
    // Likely DB not migrated yet (no such column) or other DB error.
    return new Response("image_png_not_available", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const png = row?.png;
  if (!png)
    return new Response("image_not_found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });

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
