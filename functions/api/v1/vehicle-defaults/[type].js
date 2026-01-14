// functions/api/v1/vehicle-defaults/[type].js
import { handleOptions } from "../../../_lib/cors.js";
import { jsonResponse } from "../../../_lib/response.js";
import { requireWebsiteUser } from "../../../_lib/twitchAuth.js";
import { recordViewerAction, awardAchievementsForViewers } from "../../../_lib/achievements.js";

const COMPETITIONS = ["ground", "resort", "space", "trackfield", "water", "winter"];

function normalizeAssignment(raw, vehicleId) {
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch { obj = null; }
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
    // Unlock rules (v0.5+)
    // - unlockIsFree: unlock without achievements
    // - unlockAchievementId: achievement id required to unlock (0 => locked)
    unlockIsFree: toBool(obj?.unlockIsFree ?? obj?.unlockFree ?? obj?.unlock_no_achievement),
    unlockAchievementId: Number(obj?.unlockAchievementId || obj?.unlockAchievement || obj?.achievementId || 0) || 0,
  };
}

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

async function isVehicleGameDefault(env, vehicleId) {
  if (!env?.VF_KV_GAME_DEFAULTS) return false;
  try {
    const rec = await env.VF_KV_GAME_DEFAULTS.get("defaults", { type: "json" });
    if (!rec || typeof rec !== "object") return false;
    for (const c of COMPETITIONS) {
      const vid = String(rec?.[c]?.vehicleId || "").trim();
      if (vid && vid === vehicleId) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function validateVehicleEligibility(vehicleId, type, env, viewerUserId) {
  const t = String(type || "").trim().toLowerCase();
  if (!vehicleId) return { ok: true }; // clearing default is always allowed
  if (!COMPETITIONS.includes(t)) return { ok: true }; // unknown type => don't block

  // If the vehicle system isn't configured, we can't reliably enforce eligibility
  // or unlock rules. For v0.5+ we fail "closed" (treat as locked), except for
  // GAME DEFAULT vehicles which must always work.
  if (!env.VF_KV_VEHICLE_ASSIGNMENTS || !env.VF_KV_VEHICLE_ROLES) {
    const isGameDefault = await isVehicleGameDefault(env, vehicleId);
    if (isGameDefault) return { ok: true, unlockedBy: "game_default" };
    return {
      ok: false,
      error: "vehicle_unlock_system_not_configured",
      message: "Vehicle unlock system is not configured (missing KV bindings).",
    };
  }

  // If the assignment record isn't present yet, treat it as locked.
  // (After running Seed on the admin site, every catalog vehicle should have a record.)
  const assignRaw = await env.VF_KV_VEHICLE_ASSIGNMENTS.get(vehicleId);
  const assignment = normalizeAssignment(assignRaw, vehicleId);
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

  // Check if any assigned role has the flag for this competition, and whether
  // this vehicle is a DEFAULT vehicle for any competition mode.
  for (const rid of roleIds) {
    const roleRaw = await env.VF_KV_VEHICLE_ROLES.get(rid);
    if (!roleRaw) continue;
    let role = null;
    try { role = JSON.parse(roleRaw); } catch { role = null; }
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

  // Unlock logic:
  // 1) Competition defaults are always unlocked
  if (isCompetitionDefault) return { ok: true, unlocked: true, unlockedBy: "competition_default" };

  // 2) Game defaults are always unlocked
  if (await isVehicleGameDefault(env, vehicleId)) return { ok: true, unlocked: true, unlockedBy: "game_default" };

  // 3) Explicitly free (no achievement required)
  if (assignment.unlockIsFree) return { ok: true, unlocked: true, unlockedBy: "free" };

  // 4) Achievement-gated
  const reqAchId = Number(assignment.unlockAchievementId || 0) || 0;
  if (reqAchId <= 0) {
    return { ok: false, error: "vehicle_locked", vehicleType: t, reason: "no_unlock_rule" };
  }

  if (!env?.VF_D1_STATS) {
    return { ok: false, error: "d1_not_bound", message: "Missing D1 binding: VF_D1_STATS" };
  }

  const viewerId = String(viewerUserId || "").trim();
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
      message: "Stats DB not initialized (achievements tables missing). Run the next migration on manage.viewerfrenzy.com → /db.html.",
      details: String(e?.message || e),
    };
  }

  return { ok: false, error: "vehicle_locked", vehicleType: t, requiredAchievementId: reqAchId };
}

function getKvForType(env, type) {
  const t = (type || "").toLowerCase();

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

export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method === "OPTIONS") return handleOptions(request);

  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const userId = auth.validated.user_id;
  const type = params.type;

  const kv = getKvForType(env, type);
  if (!kv) {
    return jsonResponse(request, {
      error: "unknown_vehicle_type_or_kv_not_bound",
      vehicleType: type,
    }, 400);
  }

  // ---------- GET ----------
  if (request.method === "GET") {
    let value = await kv.get(userId, { type: "json" });

    // If a legacy default points to a now-disabled / locked vehicle, clear it.
    // (This is a safety net in case the v0.5 KV reset wasn't applied, or if new
    // unlock rules were configured after the user previously saved a default.)
    try {
      const savedId = String(value?.vehicleId || "").trim();
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

    // Semantics:
    //  - value === null => no server record yet (client should not overwrite local preference)
    //  - value.vehicleId === "" => explicit Random
    return jsonResponse(request, {
      vehicleType: (type || "").toLowerCase(),
      userId,
      value: value || null,
    });
  }

  // ---------- PUT / POST ----------
  if (request.method === "PUT" || request.method === "POST") {
    let body = null;
    try { body = await request.json(); } catch { body = null; }

    const vehicleIdRaw = body?.vehicleId ?? body?.selectedVehicleId ?? body?.id ?? "";
    const vehicleId = (vehicleIdRaw ?? "").toString();

    // Enforce disabled / eligibility rules (role-based) when configured.
    const eligibility = await validateVehicleEligibility(vehicleId, type, env, userId);
    if (!eligibility.ok) {
      return jsonResponse(request, { ok: false, ...eligibility }, 400);
    }

    const nowIso = new Date().toISOString();

    // IMPORTANT: store a record even for Random (vehicleId === "")
    // so we can distinguish "never set" from "explicit random".
    const record = {
      vehicleId,
      updatedAt: nowIso,
      clientUpdatedAtUnix: body?.clientUpdatedAtUnix ?? null,
    };

    await kv.put(userId, JSON.stringify(record));

    // Achievements hook (best-effort):
    // Record that the user used the website to set a default vehicle.
    // This enables criteria like: defaultVehicleSets>=1
    let achievementsUnlocked = [];
    try {
      const t = (type || "").toLowerCase();
      await recordViewerAction(env, userId, "default_vehicle_set");
      if (t) await recordViewerAction(env, userId, `default_vehicle_set_${t}`);

      // Evaluate + award any achievements that depend on this action.
      achievementsUnlocked = await awardAchievementsForViewers(env, [userId], {
        source: "website",
        sourceRef: `vehicle_default:${t}`,
      });
    } catch {
      achievementsUnlocked = [];
    }

    return jsonResponse(request, { ok: true, vehicleType: (type || "").toLowerCase(), userId, value: record, achievementsUnlocked });
  }

  return jsonResponse(request, { error: "method_not_allowed" }, 405);
}
