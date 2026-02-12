// functions/_lib/vehiclePhysics.js
// Vehicle physics defaults + per-vehicle overrides (public API support).
//
// DB tables/columns (v0.28+):
// - vf_vehicle_physics_defaults
//     competition_type (PK)
//     linear_damping, angular_damping, friction, bounciness
//     lateral_grip, collision_impulse_mult, collision_spin_mult
// - vf_vehicle_assignments (nullable overrides)
//     physics_linear_damping, physics_angular_damping, physics_friction, physics_bounciness
//     physics_lateral_grip, physics_collision_impulse_mult, physics_collision_spin_mult

import { toStr } from "./dbUtil.js";

export const VEHICLE_PHYSICS_COMPETITION_TYPES = [
  "ground",
  "resort",
  "space",
  "trackfield",
  "water",
  "winter",
];

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function clamp01(n) {
  return clamp(n, 0, 1);
}

function boolFromDb(v) {
  // D1 stores booleans as 0/1 integers.
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  return n !== 0;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeCompetitionType(v) {
  return toStr(v).toLowerCase();
}

export function isKnownCompetitionType(v) {
  const t = normalizeCompetitionType(v);
  return VEHICLE_PHYSICS_COMPETITION_TYPES.includes(t);
}

// Code defaults (fallback if DB isn't migrated yet).
// NOTE: These are the recommended post-v0.29 "frenzy" defaults.
export function computeCodeDefaultVehiclePhysics(competitionType) {
  const t = normalizeCompetitionType(competitionType);

  // Baseline: ground-style arcade.
  let linearDamping = 0.0;
  let angularDamping = 2.0;
  let friction = 0.65;
  let bounciness = 0.08;
  let lateralGrip = 4.6;
  let collisionImpulseMult = 1.6;
  let collisionSpinMult = 1.5;

  if (t === "resort") {
    linearDamping = 0.08;
    angularDamping = 2.4;
    friction = 0.55;
    bounciness = 0.06;
    lateralGrip = 5.0;
    collisionImpulseMult = 1.35;
    collisionSpinMult = 1.25;
  } else if (t === "space") {
    linearDamping = 0.2;
    angularDamping = 4.5;
    friction = 0.24;
    bounciness = 0.08;
    lateralGrip = 5.0;
    collisionImpulseMult = 1.8;
    collisionSpinMult = 1.7;
  } else if (t === "trackfield") {
    linearDamping = 0.0;
    angularDamping = 2.0;
    friction = 0.70;
    bounciness = 0.07;
    lateralGrip = 4.8;
    collisionImpulseMult = 1.55;
    collisionSpinMult = 1.45;
  } else if (t === "water") {
    linearDamping = 0.12;
    angularDamping = 2.8;
    friction = 0.45;
    bounciness = 0.06;
    lateralGrip = 5.1;
    collisionImpulseMult = 1.45;
    collisionSpinMult = 1.35;
  } else if (t === "winter") {
    linearDamping = 0.02;
    angularDamping = 2.2;
    friction = 0.28;
    bounciness = 0.06;
    lateralGrip = 3.8;
    collisionImpulseMult = 1.65;
    collisionSpinMult = 1.6;
  }

  return {
    linearDamping: clamp(linearDamping, 0, 20),
    angularDamping: clamp(angularDamping, 0, 20),
    friction: clamp01(friction),
    bounciness: clamp01(bounciness),
    lateralGrip: clamp(lateralGrip, 0, 50),
    collisionImpulseMult: clamp(collisionImpulseMult, 0, 10),
    collisionSpinMult: clamp(collisionSpinMult, 0, 10),
  };
}

// Race excitement tuning for RaceManager.
// Returned alongside vehicle physics defaults so the Unity client can be tuned without rebuilds.
export function computeCodeDefaultRaceTuning(competitionType) {
  // Same defaults for all competition types (tune per-type in D1).
  return {
    enablePackBalancing: true,
    packBalancingStartDelaySeconds: 1.5,
    packBalancingUpdateInterval: 0.10,
    catchupDistanceForMaxBoost: 40,
    maxCatchupBoost: 0.65,
    leadGapForMaxDrag: 18,
    maxLeaderDrag: 0.25,
    smoothPackBalancingRampIn: true,
    packBalancingRampInSeconds: 4,

    enableSlipstream: true,
    slipstreamRangeMeters: 8,
    slipstreamMaxBoost: 0.18,
    slipstreamFrontDrag: 0.05,

    enableLeadSwapPressure: true,
    leadHoldGraceSeconds: 5,
    leadHoldRampSeconds: 8,
    maxLeadHoldDrag: 0.22,
    maxChallengerBoost: 0.12,
    leadSwapPressureMaxGapMeters: 24,
  };
}

export function computeEffectiveRaceTuning(defaults, tuningRow) {
  const d = defaults && typeof defaults === "object" ? defaults : computeCodeDefaultRaceTuning("ground");
  const r = tuningRow && typeof tuningRow === "object" ? tuningRow : {};

  const enablePackBalancing = (r.enable_pack_balancing === null || r.enable_pack_balancing === undefined)
    ? d.enablePackBalancing
    : boolFromDb(r.enable_pack_balancing);
  const packBalancingStartDelaySeconds = numOrNull(r.pack_balancing_start_delay_s);
  const packBalancingUpdateInterval = numOrNull(r.pack_balancing_update_interval_s);
  const catchupDistanceForMaxBoost = numOrNull(r.catchup_distance_for_max_boost_m);
  const maxCatchupBoost = numOrNull(r.max_catchup_boost);
  const leadGapForMaxDrag = numOrNull(r.lead_gap_for_max_drag_m);
  const maxLeaderDrag = numOrNull(r.max_leader_drag);
  const smoothPackBalancingRampIn = (r.smooth_pack_balancing_ramp_in === null || r.smooth_pack_balancing_ramp_in === undefined)
    ? d.smoothPackBalancingRampIn
    : boolFromDb(r.smooth_pack_balancing_ramp_in);
  const packBalancingRampInSeconds = numOrNull(r.pack_balancing_ramp_in_s);

  const enableSlipstream = (r.enable_slipstream === null || r.enable_slipstream === undefined)
    ? d.enableSlipstream
    : boolFromDb(r.enable_slipstream);
  const slipstreamRangeMeters = numOrNull(r.slipstream_range_m);
  const slipstreamMaxBoost = numOrNull(r.slipstream_max_boost);
  const slipstreamFrontDrag = numOrNull(r.slipstream_front_drag);

  const enableLeadSwapPressure = (r.enable_lead_swap_pressure === null || r.enable_lead_swap_pressure === undefined)
    ? d.enableLeadSwapPressure
    : boolFromDb(r.enable_lead_swap_pressure);
  const leadHoldGraceSeconds = numOrNull(r.lead_hold_grace_s);
  const leadHoldRampSeconds = numOrNull(r.lead_hold_ramp_s);
  const maxLeadHoldDrag = numOrNull(r.max_lead_hold_drag);
  const maxChallengerBoost = numOrNull(r.max_challenger_boost);
  const leadSwapPressureMaxGapMeters = numOrNull(r.lead_swap_pressure_max_gap_m);

  return {
    enablePackBalancing,
    packBalancingStartDelaySeconds: clamp(packBalancingStartDelaySeconds ?? d.packBalancingStartDelaySeconds, 0, 30),
    packBalancingUpdateInterval: clamp(packBalancingUpdateInterval ?? d.packBalancingUpdateInterval, 0.03, 2.0),
    catchupDistanceForMaxBoost: clamp(catchupDistanceForMaxBoost ?? d.catchupDistanceForMaxBoost, 1, 1000),
    maxCatchupBoost: clamp01(maxCatchupBoost ?? d.maxCatchupBoost),
    leadGapForMaxDrag: clamp(leadGapForMaxDrag ?? d.leadGapForMaxDrag, 1, 1000),
    maxLeaderDrag: clamp01(maxLeaderDrag ?? d.maxLeaderDrag),
    smoothPackBalancingRampIn,
    packBalancingRampInSeconds: clamp(packBalancingRampInSeconds ?? d.packBalancingRampInSeconds, 0, 60),

    enableSlipstream,
    slipstreamRangeMeters: clamp(slipstreamRangeMeters ?? d.slipstreamRangeMeters, 0, 100),
    slipstreamMaxBoost: clamp(slipstreamMaxBoost ?? d.slipstreamMaxBoost, 0, 0.5),
    slipstreamFrontDrag: clamp(slipstreamFrontDrag ?? d.slipstreamFrontDrag, 0, 0.25),

    enableLeadSwapPressure,
    leadHoldGraceSeconds: clamp(leadHoldGraceSeconds ?? d.leadHoldGraceSeconds, 0, 120),
    leadHoldRampSeconds: clamp(leadHoldRampSeconds ?? d.leadHoldRampSeconds, 0.1, 120),
    maxLeadHoldDrag: clamp(maxLeadHoldDrag ?? d.maxLeadHoldDrag, 0, 0.5),
    maxChallengerBoost: clamp(maxChallengerBoost ?? d.maxChallengerBoost, 0, 0.5),
    leadSwapPressureMaxGapMeters: clamp(leadSwapPressureMaxGapMeters ?? d.leadSwapPressureMaxGapMeters, 0, 1000),
  };
}

export function computeEffectiveVehiclePhysics(defaults, overrideRow) {
  const d = defaults && typeof defaults === "object" ? defaults : computeCodeDefaultVehiclePhysics("ground");
  const o = overrideRow && typeof overrideRow === "object" ? overrideRow : {};

  const ld = numOrNull(o.physics_linear_damping);
  const ad = numOrNull(o.physics_angular_damping);
  const fr = numOrNull(o.physics_friction);
  const bo = numOrNull(o.physics_bounciness);
  const lg = numOrNull(o.physics_lateral_grip);
  const cim = numOrNull(o.physics_collision_impulse_mult);
  const csm = numOrNull(o.physics_collision_spin_mult);

  return {
    linearDamping: clamp(ld ?? d.linearDamping, 0, 20),
    angularDamping: clamp(ad ?? d.angularDamping, 0, 20),
    friction: clamp01(fr ?? d.friction),
    bounciness: clamp01(bo ?? d.bounciness),
    lateralGrip: clamp(lg ?? d.lateralGrip, 0, 50),
    collisionImpulseMult: clamp(cim ?? d.collisionImpulseMult, 0, 10),
    collisionSpinMult: clamp(csm ?? d.collisionSpinMult, 0, 10),
  };
}


// Viewer zoom defaults (race viewer !zoom command).
export function computeCodeDefaultZoomSettings(_competitionType) {
  return {
    enabled: true,
    baseZoomCount: 1,
    lastPlaceExtraZoom: {
      enabled: false,
      minRacers: 10,
      useBottomPercent: true,
      bottomPercent: 10, // percent value (10 = 10%)
      unlimitedExtraZooms: true,
      maxExtraZooms: 1,
    },
  };
}
