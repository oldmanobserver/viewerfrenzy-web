// functions/api/v1/track-components.js
//
// Public (no-auth) endpoint used by the Unity Track Editor to populate
// the "Placement Mode" component palette.
//
// Storage (v0.8+): D1
// - vf_components
// - vf_component_role_assignments
// - vf_component_role_competitions (v0.24+)
//
// Transitional fallback (pre-v0.24):
// - vf_vehicle_role_competitions (roles shared with vehicles)

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { tableExists } from "../../_lib/dbUtil.js";

const COMPETITION_TYPES = ["ground", "resort", "space", "trackfield", "water", "winter"];

function sanitizeCompetition(t) {
  const s = String(t || "").trim().toLowerCase();
  if (!s) return "";
  if (!COMPETITION_TYPES.includes(s)) return "";
  return s;
}

function toBoolInt(x) {
  return x ? 1 : 0;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method === "OPTIONS") return handleOptions(request);

  if (request.method !== "GET") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const url = new URL(request.url);
  const competition = sanitizeCompetition(url.searchParams.get("competition")) || "space";
  const includeDisabled = url.searchParams.get("includeDisabled") === "1";

  const db = env?.VF_D1_STATS;
  if (!db) {
    return jsonResponse(request, { ok: true, competition, components: [], meta: { source: "none", reason: "d1_not_bound" } });
  }

  const ok1 = await tableExists(db, "vf_components");
  const ok2 = await tableExists(db, "vf_component_role_assignments");
  const ok3a = await tableExists(db, "vf_component_role_competitions");
  const ok3b = await tableExists(db, "vf_vehicle_role_competitions");
  if (!ok1 || !ok2 || (!ok3a && !ok3b)) {
    return jsonResponse(request, { ok: true, competition, components: [], meta: { source: "none", reason: "tables_missing" } });
  }

  // v0.24 renamed assignment column: vehicle_role_id -> component_role_id
  let assignRoleCol = "component_role_id";
  try {
    const info = await db.prepare("PRAGMA table_info(vf_component_role_assignments)").all();
    const cols = new Set((info?.results || []).map((r) => String(r?.name || "").trim()));
    if (!cols.has("component_role_id") && cols.has("vehicle_role_id")) {
      assignRoleCol = "vehicle_role_id";
    }
  } catch {
    assignRoleCol = "vehicle_role_id";
  }

  // Prefer the new component-role competitions mapping when available.
  const roleCompTable = ok3a ? "vf_component_role_competitions" : "vf_vehicle_role_competitions";
  const roleCompIdCol = ok3a ? "component_role_id" : "vehicle_role_id";

  const disabledFilter = includeDisabled ? "" : "AND c.disabled = 0";

  const rs = await db
    .prepare(
      `SELECT DISTINCT
         c.component_id,
         c.display_name,
         c.description,
         c.resources_path,
         c.source_asset_path,
         c.prefab_name,
         c.category,
         c.pack,
         c.disabled,
         c.created_at_ms,
         c.updated_at_ms
       FROM vf_components c
       JOIN vf_component_role_assignments a ON a.component_id = c.component_id
       JOIN ${roleCompTable} rc ON rc.${roleCompIdCol} = a.${assignRoleCol}
       WHERE rc.competition_type = ?
       ${disabledFilter}
       ORDER BY c.pack, c.category, c.display_name`,
    )
    .bind(competition)
    .all();

  const components = (rs?.results || []).map((r) => ({
    componentId: String(r?.component_id || ""),
    displayName: String(r?.display_name || ""),
    description: String(r?.description || ""),
    resourcesPath: String(r?.resources_path || ""),
    sourceAssetPath: String(r?.source_asset_path || ""),
    prefabName: String(r?.prefab_name || ""),
    category: String(r?.category || ""),
    pack: String(r?.pack || ""),
    disabled: toBoolInt(r?.disabled) === 1,
    createdAtMs: Number(r?.created_at_ms || 0),
    updatedAtMs: Number(r?.updated_at_ms || 0),
  }));

  return jsonResponse(request, { ok: true, competition, components, meta: { source: "d1" } });
}
