// functions/api/v1/track-component-physics.js
//
// Public endpoint used by Unity at race start:
// - Accepts a list of component IDs
// - Returns *effective* physics config for each component (defaults + optional DB overrides)
//
// Why this exists:
// - Lets you tune physics via the admin components page without rebuilding the game.

import { handleOptions } from "../../_lib/cors.js";
import { jsonResponse } from "../../_lib/response.js";
import { tableExists, columnExists } from "../../_lib/dbUtil.js";
import { computeEffectiveComponentPhysics } from "../../_lib/componentPhysics.js";

const MAX_IDS = 500;

function sanitizeIds(ids) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || "").trim();
    if (!id) continue;
    if (id.length > 128) continue;
    if (!/^[a-z0-9_-]+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }

  return out;
}

async function readJsonBody(request) {
  try {
    const text = await request.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchComponentsByIds(db, ids, hasPhysicsCols) {
  if (!ids.length) return [];

  const baseCols = [
    "component_id",
    "pack",
    "category",
    "resources_path",
  ];

  const physicsCols = hasPhysicsCols
    ? [
        "physics_rb_enabled",
        "physics_mass",
        "physics_linear_damping",
        "physics_angular_damping",
        "physics_bounciness",
        "physics_friction",
      ]
    : [];

  const cols = baseCols.concat(physicsCols).join(", ");

  // Chunk IN(...) to stay safely under SQLite limits.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));

  const rows = [];
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => "?").join(",");
    const sql = `SELECT ${cols} FROM vf_components WHERE component_id IN (${placeholders})`;
    const resp = await db.prepare(sql).bind(...chunk).all();
    if (Array.isArray(resp?.results)) rows.push(...resp.results);
  }

  return rows;
}

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (!env?.VF_D1_STATS) {
    return jsonResponse({ ok: false, error: "missing_binding", message: "VF_D1_STATS binding is missing" }, 500);
  }

  if (request.method !== "POST" && request.method !== "GET") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }

  const db = env.VF_D1_STATS;
  if (!(await tableExists(db, "vf_components"))) {
    return jsonResponse({ ok: false, error: "missing_tables", message: "vf_components table not found" }, 500);
  }

  // DB might not be migrated yet in some environments.
  const hasPhysicsCols = await columnExists(db, "vf_components", "physics_rb_enabled");

  // Read IDs
  let ids = [];
  if (request.method === "GET") {
    const url = new URL(request.url);
    const csv = url.searchParams.get("ids") || "";
    ids = sanitizeIds(csv.split(","));
  } else {
    const body = await readJsonBody(request);
    ids = sanitizeIds(body?.componentIds);
  }

  if (!ids.length) {
    return jsonResponse({ ok: true, components: [], missing: [] });
  }

  const rows = await fetchComponentsByIds(db, ids, hasPhysicsCols);
  const byId = new Map();
  for (const r of rows) byId.set(r.component_id, r);

  const components = [];
  const missing = [];

  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      missing.push(id);
      continue;
    }

    const physics = computeEffectiveComponentPhysics({
      componentId: r.component_id,
      pack: r.pack,
      category: r.category,
      resourcesPath: r.resources_path,
      physicsRbEnabled: hasPhysicsCols ? r.physics_rb_enabled : null,
      physicsMass: hasPhysicsCols ? r.physics_mass : null,
      physicsLinearDamping: hasPhysicsCols ? r.physics_linear_damping : null,
      physicsAngularDamping: hasPhysicsCols ? r.physics_angular_damping : null,
      physicsBounciness: hasPhysicsCols ? r.physics_bounciness : null,
      physicsFriction: hasPhysicsCols ? r.physics_friction : null,
    });

    components.push({ componentId: id, physics });
  }

  return jsonResponse({ ok: true, components, missing });
}
