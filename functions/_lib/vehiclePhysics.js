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
// NOTE: These should stay in sync with the migration seed values.
export function computeCodeDefaultVehiclePhysics(competitionType) {
  const t = normalizeCompetitionType(competitionType);

  // Baseline: ground-style arcade.
  let linearDamping = 0.0;
  let angularDamping = 2.0;
  let friction = 0.8;
  let bounciness = 0.05;
  let lateralGrip = 5.0;
  let collisionImpulseMult = 1.0;
  let collisionSpinMult = 1.0;

  if (t === "resort") {
    linearDamping = 0.08;
    angularDamping = 2.4;
    friction = 0.6;
    bounciness = 0.04;
    lateralGrip = 5.5;
  } else if (t === "space") {
    linearDamping = 0.2;
    angularDamping = 4.5;
    friction = 0.3;
    bounciness = 0.05;
    lateralGrip = 5.0;
  } else if (t === "water") {
    linearDamping = 0.12;
    angularDamping = 2.8;
    friction = 0.55;
    bounciness = 0.04;
    lateralGrip = 5.5;
  } else if (t === "winter") {
    linearDamping = 0.02;
    angularDamping = 2.2;
    friction = 0.35;
    bounciness = 0.05;
    lateralGrip = 4.25;
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
