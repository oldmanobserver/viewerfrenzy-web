// functions/api/v1/vehicle-defaults/[type].js
//
// Authenticated endpoint (viewer) for getting/setting a per-user default vehicle
// per competition type.
//
// New storage (v0.6+): D1
// - vf_viewer_default_vehicles
// - vehicle eligibility uses:
//    vf_vehicle_assignments + vf_vehicle_assignment_roles + vf_vehicle_role_competitions
//
// Legacy fallback (pre-v0.6): KV per competition type
// - VF_KV_GROUND | VF_KV_RESORT | VF_KV_SPACE | VF_KV_TRACKFIELD | VF_KV_WATER | VF_KV_WINTER
// - eligibility uses KV:
//    VF_KV_VEHICLE_ASSIGNMENTS + VF_KV_VEHICLE_ROLES

import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";
import { recordViewerAction, awardAchievementsForViewers } from "../../../_lib/achievements.js";
import { isoFromMs, msFromIso, nowMs, tableExists, toStr, toBoolInt } from "../../../_lib/dbUtil.js";

const COMPETITIONS = ["ground", "resort", "space", "trackfield", "water", "winter"];

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
  }
  return false;
}

function normalizeAssignmentFromKv(raw, vehicleId) {
  if (!raw) return null;
  let obj = null;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = null;
  }
  if (!obj || typeof obj !== "object") return null;
  const vid = String(obj.vehicleId || vehicleId || "").trim();
  if (!vid) return null;

  const roles = {};
  const r = obj.roles;
  if (Array.isArray(r)) {
    for (const it of r) {
      const rid = String(it?.roleId || "").trim().toLowerCase();
      if (!rid) continue;
      roles[rid] = { isDefault: Boolean(it?.isDefault) };
    }
  } else if (r && typeof r === "object") {
    for (const [ridRaw, v] of Object.entries(r)) {
      const rid = String(ridRaw || "").trim().toLowerCase();
      if (!rid) continue;
      roles[rid] = { isDefault: Boolean(v?.isDefault ?? v) };
    }
  }

  return {
    vehicleId: vid,
    disabled: Boolean(obj.disabled),
    roles,
    unlockIsFree: toBool(obj?.unlockIsFree ?? obj?.unlockFree ?? obj?.unlock_no_achievement),
    unlockAchievementId: Number(obj?.unlockAchievementId || obj?.unlockAchievement || obj?.achievementId || 0) || 0,
  };
}

async function loadAssignmentFromD1(env, vehicleId) {
  const db = env?.VF_D1_STATS;
  if (!db) return null;
  const okBase = await tableExists(db, "vf_vehicle_assignments");
  const okRoles = await tableExists(db, "vf_vehicle_assignment_roles");
  if (!okBase || !okRoles) return null;

  const base = await db
    .prepare(
      "SELECT vehicle_id, disabled, unlock_is_free, unlock_achievement_id FROM vf_vehicle_assignments WHERE vehicle_id = ? LIMIT 1",
    )
    .bind(vehicleId)
    .first();
  if (!base) return null;

  const roleRows = await db
    .prepare("SELECT vehicle_role_id, is_default FROM vf_vehicle_assignment_roles WHERE vehicle_id = ?")
    .bind(vehicleId)
    .all();

  const roles = {};
  for (const rr of Array.isArray(roleRows?.results) ? roleRows.results : []) {
    const rid = toStr(rr?.vehicle_role_id).toLowerCase();
    if (!rid) continue;
    roles[rid] = { isDefault: toBool(rr?.is_default) };
  }

  return {
    vehicleId: toStr(base?.vehicle_id) || toStr(vehicleId),
    disabled: toBool(base?.disabled),
    roles,
    unlockIsFree: toBool(base?.unlock_is_free),
    unlockAchievementId: Number(base?.unlock_achievement_id || 0) || 0,
  };
}

async function loadRoleCompetitionsFromD1(env, roleIds) {
  const db = env?.VF_D1_STATS;
  if (!db) return new Map();
  const ok = await tableExists(db, "vf_vehicle_role_competitions");
  if (!ok) return new Map();

  const ids = Array.from(new Set((roleIds || []).map((x) => toStr(x).toLowerCase()).filter(Boolean)));
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => "?").join(",");
  const rs = await db
    .prepare(
      `SELECT vehicle_role_id, competition_type FROM vf_vehicle_role_competitions WHERE vehicle_role_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all();

  const out = new Map();
  for (const r of Array.isArray(rs?.results) ? rs.results : []) {
    const rid = toStr(r?.vehicle_role_id).toLowerCase();
    const ct = toStr(r?.competition_type).toLowerCase();
    if (!rid || !ct) continue;
    if (!out.has(rid)) out.set(rid, new Set());
    out.get(rid).add(ct);
  }
  return out;
}

async function validateVehicleEligibility(vehicleId, type, env, viewerUserId) {
  const t = toStr(type).toLowerCase();
  if (!vehicleId) return { ok: true }; // clearing default is always allowed
  if (!COMPETITIONS.includes(t)) return { ok: true }; // unknown type => don't block

  // Prefer D1-based vehicle unlock system (v0.6+)
  try {
    const db = env?.VF_D1_STATS;
    const okA = db && (await tableExists(db, "vf_vehicle_assignments")) && (await tableExists(db, "vf_vehicle_assignment_roles"));
    const okR = db && (await tableExists(db, "vf_vehicle_role_competitions"));
    if (okA && okR) {
      const assignment = await loadAssignmentFromD1(env, vehicleId);
      if (!assignment) {
        return { ok: false, error: "vehicle_not_configured" };
      }

      if (assignment.disabled) {
        return { ok: false, error: "vehicle_disabled" };
      }

      const roleIds = Object.keys(assignment.roles || {});
      if (roleIds.length === 0) {
        return { ok: false, error: "vehicle_not_assigned_to_any_role" };
      }

      const compByRole = await loadRoleCompetitionsFromD1(env, roleIds);

      let eligibleForType = false;
      let isCompetitionDefault = false;

      for (const rid of roleIds) {
        const comps = compByRole.get(toStr(rid).toLowerCase());
        if (comps && comps.has(t)) eligibleForType = true;

        if (assignment?.roles?.[rid]?.isDefault) {
          // Any competition flag at all => considered a competition default
          if (comps && comps.size > 0) {
            isCompetitionDefault = true;
          }
        }
      }

      if (!eligibleForType) {
        return { ok: false, error: "vehicle_not_eligible_for_type", vehicleType: t };
      }

      // Unlock logic (same as KV version)
      if (isCompetitionDefault) return { ok: true, unlocked: true, unlockedBy: "competition_default" };
      if (assignment.unlockIsFree) return { ok: true, unlocked: true, unlockedBy: "free" };

      const reqAchId = Number(assignment.unlockAchievementId || 0) || 0;
      if (reqAchId <= 0) {
        return { ok: false, error: "vehicle_locked", vehicleType: t, reason: "no_unlock_rule" };
      }

      if (!env?.VF_D1_STATS) {
        return { ok: false, error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" };
      }

      const viewerId = toStr(viewerUserId);
      if (!viewerId) {
        return { ok: false, error: "auth_missing_user_id" };
      }

      try {
        const row = await env.VF_D1_STATS.prepare(
          "SELECT 1 AS ok FROM viewer_achievements WHERE viewer_user_id = ? AND achievement_id = ? LIMIT 1",
        )
          .bind(viewerId, reqAchId)
          .first();

        if (row) return { ok: true, unlocked: true, unlockedBy: "achievement", requiredAchievementId: reqAchId };
      } catch (e) {
        return {
          ok: false,
          error: "db_not_initialized",
          message:
            "Stats DB not initialized (achievements tables missing). Run the next migration on manage.viewerfrenzy.com → /db.html.",
          details: String(e?.message || e),
        };
      }

      return { ok: false, error: "vehicle_locked", vehicleType: t, requiredAchievementId: reqAchId };
    }
  } catch {
    // fall back to KV
  }

  // Legacy KV-based vehicle unlock system
  if (!env.VF_KV_VEHICLE_ASSIGNMENTS || !env.VF_KV_VEHICLE_ROLES) {
    return {
      ok: false,
      error: "vehicle_unlock_system_not_configured",
      message: "Vehicle unlock system is not configured (missing bindings).",
    };
  }

  const assignRaw = await env.VF_KV_VEHICLE_ASSIGNMENTS.get(vehicleId);
  const assignment = normalizeAssignmentFromKv(assignRaw, vehicleId);
  if (!assignment) {
    return { ok: false, error: "vehicle_not_configured" };
  }

  if (assignment.disabled) {
    return { ok: false, error: "vehicle_disabled" };
  }

  const roleIds = Object.keys(assignment.roles || {});
  if (roleIds.length === 0) {
    return { ok: false, error: "vehicle_not_assigned_to_any_role" };
  }

  let eligibleForType = false;
  let isCompetitionDefault = false;

  for (const rid of roleIds) {
    const roleRaw = await env.VF_KV_VEHICLE_ROLES.get(rid);
    if (!roleRaw) continue;
    let role = null;
    try {
      role = JSON.parse(roleRaw);
    } catch {
      role = null;
    }
    if (!role || typeof role !== "object") continue;

    if (Boolean(role[t])) eligibleForType = true;

    if (assignment?.roles?.[rid]?.isDefault) {
      for (const c of COMPETITIONS) {
        if (Boolean(role[c])) {
          isCompetitionDefault = true;
          break;
        }
      }
    }
  }

  if (!eligibleForType) {
    return { ok: false, error: "vehicle_not_eligible_for_type", vehicleType: t };
  }

  if (isCompetitionDefault) return { ok: true, unlocked: true, unlockedBy: "competition_default" };
  if (assignment.unlockIsFree) return { ok: true, unlocked: true, unlockedBy: "free" };

  const reqAchId = Number(assignment.unlockAchievementId || 0) || 0;
  if (reqAchId <= 0) {
    return { ok: false, error: "vehicle_locked", vehicleType: t, reason: "no_unlock_rule" };
  }

  if (!env?.VF_D1_STATS) {
    return { ok: false, error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" };
  }

  const viewerId = toStr(viewerUserId);
  if (!viewerId) {
    return { ok: false, error: "auth_missing_user_id" };
  }

  try {
    const row = await env.VF_D1_STATS.prepare(
      "SELECT 1 AS ok FROM viewer_achievements WHERE viewer_user_id = ? AND achievement_id = ? LIMIT 1",
    )
      .bind(viewerId, reqAchId)
      .first();

    if (row) return { ok: true, unlocked: true, unlockedBy: "achievement", requiredAchievementId: reqAchId };
  } catch (e) {
    return {
      ok: false,
      error: "db_not_initialized",
      message:
        "Stats DB not initialized (achievements tables missing). Run the next migration on manage.viewerfrenzy.com → /db.html.",
      details: String(e?.message || e),
    };
  }

  return { ok: false, error: "vehicle_locked", vehicleType: t, requiredAchievementId: reqAchId };
}

function getKvForType(env, type) {
  const t = toStr(type).toLowerCase();
  const map = {
    ground: env.VF_KV_GROUND,
    resort: env.VF_KV_RESORT,
    space: env.VF_KV_SPACE,
    water: env.VF_KV_WATER,
    winter: env.VF_KV_WINTER,
    trackfield: env.VF_KV_TRACKFIELD,
  };
  return map[t] || null;
}

async function readViewerDefaultFromD1(env, userId, type) {
  const db = env?.VF_D1_STATS;
  if (!db) return { ok: false };
  const ok = await tableExists(db, "vf_viewer_default_vehicles");
  if (!ok) return { ok: false };

  const row = await db
    .prepare(
      "SELECT vehicle_id, updated_at_ms, client_updated_at_unix FROM vf_viewer_default_vehicles WHERE viewer_user_id = ? AND competition_type = ? LIMIT 1",
    )
    .bind(userId, type)
    .first();

  if (!row) return { ok: true, value: null };

  return {
    ok: true,
    value: {
      vehicleId: toStr(row?.vehicle_id),
      updatedAt: isoFromMs(row?.updated_at_ms),
      clientUpdatedAtUnix: row?.client_updated_at_unix ?? null,
    },
  };
}

async function upsertViewerDefaultToD1(env, userId, type, record) {
  const db = env?.VF_D1_STATS;
  if (!db) return false;
  const ok = await tableExists(db, "vf_viewer_default_vehicles");
  if (!ok) return false;

  const updatedAtMs = msFromIso(record?.updatedAt) ?? nowMs();
  const client = record?.clientUpdatedAtUnix ?? null;

  await db
    .prepare(
      "INSERT INTO vf_viewer_default_vehicles (viewer_user_id, competition_type, vehicle_id, updated_at_ms, client_updated_at_unix) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT(viewer_user_id, competition_type) DO UPDATE SET vehicle_id=excluded.vehicle_id, updated_at_ms=excluded.updated_at_ms, client_updated_at_unix=excluded.client_updated_at_unix",
    )
    .bind(userId, type, toStr(record?.vehicleId), updatedAtMs, client)
    .run();

  return true;
}

async function deleteViewerDefaultFromD1(env, userId, type) {
  try {
    const db = env?.VF_D1_STATS;
    if (!db) return false;
    const ok = await tableExists(db, "vf_viewer_default_vehicles");
    if (!ok) return false;
    await db
      .prepare("DELETE FROM vf_viewer_default_vehicles WHERE viewer_user_id = ? AND competition_type = ?")
      .bind(userId, type)
      .run();
    return true;
  } catch {
    return false;
  }
}

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const userId = auth.validated.user_id;
  const type = toStr(params?.type).toLowerCase();

  if (!COMPETITIONS.includes(type)) {
    return jsonResponse(
      request,
      {
        error: "unknown_vehicle_type",
        vehicleType: type,
      },
      400,
    );
  }

  // ---------- GET ----------
  if (request.method === "GET") {
    // Prefer D1
    try {
      const d1 = await readViewerDefaultFromD1(env, userId, type);
      if (d1.ok) {
        let value = d1.value;

        // Lazy-migrate from KV if D1 has no row but KV does
        if (value === null) {
          const kv = getKvForType(env, type);
          if (kv) {
            const kvRec = await kv.get(userId, { type: "json" });
            if (kvRec && typeof kvRec === "object") {
              const rec = {
                vehicleId: toStr(kvRec?.vehicleId),
                updatedAt: String(kvRec?.updatedAt || ""),
                clientUpdatedAtUnix: kvRec?.clientUpdatedAtUnix ?? null,
              };
              await upsertViewerDefaultToD1(env, userId, type, rec);
              // best-effort cleanup
              try {
                await kv.delete(userId);
              } catch {
                // ignore
              }
              value = rec;
            }
          }
        }

        // Safety: clear invalid defaults
        try {
          const savedId = toStr(value?.vehicleId);
          if (savedId) {
            const elig = await validateVehicleEligibility(savedId, type, env, userId);
            if (!elig.ok) {
              await deleteViewerDefaultFromD1(env, userId, type);
              value = null;
            }
          }
        } catch {
          // ignore
        }

        return jsonResponse(request, {
          vehicleType: type,
          userId,
          value: value || null,
          meta: { source: "d1" },
        });
      }
    } catch {
      // fall back to KV
    }

    // KV fallback
    const kv = getKvForType(env, type);
    if (!kv) {
      return jsonResponse(
        request,
        { error: "kv_not_bound", message: `Missing KV binding for type: ${type}` },
        500,
      );
    }

    let value = await kv.get(userId, { type: "json" });

    try {
      const savedId = toStr(value?.vehicleId);
      if (savedId) {
        const elig = await validateVehicleEligibility(savedId, type, env, userId);
        if (!elig.ok) {
          await kv.delete(userId);
          value = null;
        }
      }
    } catch {
      // ignore
    }

    return jsonResponse(request, {
      vehicleType: type,
      userId,
      value: value || null,
      meta: { source: "kv" },
    });
  }

  // ---------- PUT / POST ----------
  if (request.method === "PUT" || request.method === "POST") {
    let body = null;
    try {
      body = await request.json();
    } catch {
      body = null;
    }

    const vehicleIdRaw = body?.vehicleId ?? body?.selectedVehicleId ?? body?.id ?? "";
    const vehicleId = (vehicleIdRaw ?? "").toString();

    // Enforce disabled / eligibility rules
    const eligibility = await validateVehicleEligibility(vehicleId, type, env, userId);
    if (!eligibility.ok) {
      return jsonResponse(request, { ok: false, ...eligibility }, 400);
    }

    const nowIso = new Date().toISOString();

    const record = {
      vehicleId,
      updatedAt: nowIso,
      clientUpdatedAtUnix: body?.clientUpdatedAtUnix ?? null,
    };

    let stored = false;

    // Prefer D1
    try {
      stored = await upsertViewerDefaultToD1(env, userId, type, record);
      if (stored) {
        // Best-effort cleanup of legacy KV
        const kv = getKvForType(env, type);
        if (kv) {
          try {
            await kv.delete(userId);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      stored = false;
    }

    // KV fallback
    if (!stored) {
      const kv = getKvForType(env, type);
      if (!kv) {
        return jsonResponse(
          request,
          { error: "storage_not_configured", message: "Neither D1 nor KV bindings are available." },
          500,
        );
      }
      await kv.put(userId, JSON.stringify(record));
    }

    // Achievements hook (best-effort)
    let achievementsUnlocked = [];
    try {
      await recordViewerAction(env, userId, "default_vehicle_set");
      if (type) await recordViewerAction(env, userId, `default_vehicle_set_${type}`);

      achievementsUnlocked = await awardAchievementsForViewers(env, [userId], {
        source: "website",
        action: "default_vehicle_set",
        vehicleType: type,
        vehicleId,
      });
    } catch {
      // ignore
    }

    return jsonResponse(request, {
      ok: true,
      vehicleType: type,
      userId,
      value: record,
      eligibility,
      achievementsUnlocked,
      meta: { storedIn: stored ? "d1" : "kv" },
    });
  }

  return jsonResponse(request, { error: "method_not_allowed" }, 405);
}
