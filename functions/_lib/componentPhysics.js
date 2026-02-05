// functions/_lib/componentPhysics.js
//
// Server-side defaults + per-component DB fields for track component physics.
//
// Used by:
// - Public API for Unity to fetch effective physics at race start
// - (Optionally) other endpoints that want to display physics settings
//
// DB columns (v0.27+ on vf_components):
// - physics_rb_enabled (INTEGER 0/1)
// - physics_mass (REAL)
// - physics_linear_damping (REAL)
// - physics_angular_damping (REAL)
// - physics_bounciness (REAL 0..1)
// - physics_friction (REAL 0..1)

import { toBool } from "./dbUtil.js";

function toStr(v) {
  return v === null || v === undefined ? "" : String(v);
}

function clamp(v, min, max) {
  const x = Number(v);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function asNumOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shouldEnableDynamicForLowPolyMegaCity(componentIdLower, categoryLower) {
  // Conservative defaults: enable Rigidbody only for obviously loose/knockable props.
  // Everything else stays static by default and can be enabled per-component in admin.

  if (categoryLower === "food") return true;

  // Keep big/static categories static.
  if (categoryLower === "buildings" || categoryLower === "floor" || categoryLower === "nature" || categoryLower === "fx") {
    return false;
  }

  // Industrial props can be either (fences, signs) or loose (barrels, wheels, boxes).
  if (categoryLower === "industrialprops" || categoryLower === "floorprops" || categoryLower === "props" || categoryLower === "buildingsdecor") {
    const id = componentIdLower;

    // Always static.
    if (id.includes("fence") || id.includes("wall") || id.includes("gate")) return false;
    if (id.includes("lamp") || id.includes("light")) return false;

    // Usually static/signage.
    if (id.includes("roadsign") || id.includes("sign")) return false;

    // Loose items.
    if (id.includes("wheel") || id.includes("tire") || id.includes("barrel")) return true;
    if (id.includes("garbage") || id.includes("trash")) return true;
    if (id.includes("box") || id.includes("crate")) return true;

    // Default conservative.
    return false;
  }

  return false;
}

export function computeDefaultComponentPhysics(component) {
  const pack = toStr(component?.pack);
  const category = toStr(component?.category);
  const idLower = toStr(component?.componentId).toLowerCase();
  const catLower = category.toLowerCase();

  // Baseline defaults (also used for static colliders):
  let rbEnabled = false;
  let mass = 1.0;
  let linearDamping = 0.0;
  let angularDamping = 0.05;
  let bounciness = 0.05;
  let friction = 0.8;

  if (pack === "KennyCarKit") {
    rbEnabled = true;

    // Match Unity defaults you already shipped for cones.
    if (idLower === "kck_props_cone" || idLower === "kck_props_cone_flat") {
      mass = 0.25;
      linearDamping = 0.05;
      angularDamping = 0.05;
      bounciness = 0.22;
      friction = 0.35;
    } else if (idLower === "kck_props_box") {
      mass = 0.5;
      linearDamping = 0.05;
      angularDamping = 0.05;
      bounciness = 0.08;
      friction = 0.6;
    } else if (catLower === "wheels" || idLower.includes("wheel") || idLower.includes("tire")) {
      mass = 0.65;
      linearDamping = 0.06;
      angularDamping = 0.06;
      bounciness = 0.08;
      friction = 0.8;
    } else if (catLower === "debris") {
      mass = 0.15;
      linearDamping = 0.08;
      angularDamping = 0.08;
      bounciness = 0.05;
      friction = 0.5;
    } else {
      mass = 0.35;
      linearDamping = 0.06;
      angularDamping = 0.06;
      bounciness = 0.08;
      friction = 0.6;
    }
  } else if (pack === "SpaceStationsCreator") {
    // Default: only debris/crates move.
    if (catLower === "debris") {
      rbEnabled = true;
      mass = 0.25;
      // Higher damping because these are usually used in "no gravity" environments.
      linearDamping = 0.35;
      angularDamping = 0.6;
      bounciness = 0.05;
      friction = 0.35;
    } else if (catLower === "crates") {
      rbEnabled = true;
      mass = 0.55;
      linearDamping = 0.25;
      angularDamping = 0.45;
      bounciness = 0.05;
      friction = 0.55;
    } else {
      rbEnabled = false;
      mass = 50.0; // big/structural; should not move even if enabled accidentally.
      linearDamping = 0.0;
      angularDamping = 0.05;
      bounciness = 0.05;
      friction = 0.7;
    }
  } else if (pack === "LowPolyMegaCity") {
    const dyn = shouldEnableDynamicForLowPolyMegaCity(idLower, catLower);
    rbEnabled = dyn;

    // Default collider material values for static environment.
    mass = dyn ? 0.7 : 25.0;
    linearDamping = dyn ? 0.06 : 0.0;
    angularDamping = dyn ? 0.08 : 0.05;
    bounciness = dyn ? 0.08 : 0.05;
    friction = dyn ? 0.6 : 0.8;

    if (catLower === "food") {
      // Lighter, slightly bouncier.
      mass = 0.2;
      linearDamping = 0.08;
      angularDamping = 0.08;
      bounciness = 0.15;
      friction = 0.35;
    }
  }

  // Clamp everything to safe ranges.
  return {
    rbEnabled: Boolean(rbEnabled),
    mass: clamp(mass, 0.01, 1000),
    linearDamping: clamp(linearDamping, 0, 20),
    angularDamping: clamp(angularDamping, 0, 20),
    bounciness: clamp01(bounciness),
    friction: clamp01(friction),
  };
}

export function computeEffectiveComponentPhysics(component) {
  const defaults = computeDefaultComponentPhysics(component);

  const rbEnabledRaw = component?.physicsRbEnabled ?? component?.physics_rb_enabled;
  const massRaw = component?.physicsMass ?? component?.physics_mass;
  const linRaw = component?.physicsLinearDamping ?? component?.physics_linear_damping;
  const angRaw = component?.physicsAngularDamping ?? component?.physics_angular_damping;
  const bounceRaw = component?.physicsBounciness ?? component?.physics_bounciness;
  const frictionRaw = component?.physicsFriction ?? component?.physics_friction;

  let rbEnabled = defaults.rbEnabled;
  if (rbEnabledRaw !== null && rbEnabledRaw !== undefined) rbEnabled = toBool(rbEnabledRaw);

  const mass = asNumOrNull(massRaw);
  const linearDamping = asNumOrNull(linRaw);
  const angularDamping = asNumOrNull(angRaw);
  const bounciness = asNumOrNull(bounceRaw);
  const friction = asNumOrNull(frictionRaw);

  return {
    rbEnabled: Boolean(rbEnabled),
    mass: clamp(mass ?? defaults.mass, 0.01, 1000),
    linearDamping: clamp(linearDamping ?? defaults.linearDamping, 0, 20),
    angularDamping: clamp(angularDamping ?? defaults.angularDamping, 0, 20),
    bounciness: clamp01(bounciness ?? defaults.bounciness),
    friction: clamp01(friction ?? defaults.friction),
  };
}
