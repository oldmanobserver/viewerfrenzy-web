// Vehicle size helpers.
//
// The vehicle catalog can include sizeX/sizeY/sizeZ (+ optional maxSize) per vehicle.
// These are assumed to be measured in Unity units.
//
// This module converts those units to meters for display and filtering.
//
// Config:
//   window.VF_CONFIG.vehicleSizeUnitsPerMeter
//     - How many Unity units equal 1 meter.
//     - Unity convention: 1 unit = 1 meter.

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function getVehicleSizeUnitsPerMeter() {
  const raw = window?.VF_CONFIG?.vehicleSizeUnitsPerMeter;
  const n = toNumber(raw);
  // Safety: avoid divide-by-zero and nonsense.
  if (!n || n <= 0) return 1;
  return n;
}

function fmtMeters(n, decimals = 1) {
  if (!Number.isFinite(n) || n <= 0) return "";
  const s = n.toFixed(decimals);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function readUnitySize(obj) {
  if (!obj || typeof obj !== "object") return null;

  // Preferred names (from Unity export)
  const x = toNumber(obj.sizeX);
  const y = toNumber(obj.sizeY);
  const z = toNumber(obj.sizeZ);
  const maxSize = toNumber(obj.maxSize);

  // Alternate naming fallbacks
  const w2 = toNumber(obj.width);
  const h2 = toNumber(obj.height);
  const l2 = toNumber(obj.length);

  // Array fallback: [x,y,z]
  const arr = Array.isArray(obj.size) ? obj.size : (Array.isArray(obj.dimensions) ? obj.dimensions : null);

  const ax = x ?? w2 ?? (arr ? toNumber(arr[0]) : null);
  const ay = y ?? h2 ?? (arr ? toNumber(arr[1]) : null);
  const az = z ?? l2 ?? (arr ? toNumber(arr[2]) : null);

  if (!(ax > 0) || !(ay > 0) || !(az > 0)) {
    // Not enough info.
    return null;
  }

  const computedMax = Math.max(ax, ay, az);
  const m = maxSize && maxSize > 0 ? maxSize : computedMax;

  return {
    // Interpreting Unity export as:
    //  - sizeX => width
    //  - sizeY => height
    //  - sizeZ => length
    width: ax,
    height: ay,
    length: az,
    max: m,
  };
}

export function getVehicleSizeMeters(obj, unitsPerMeter = getVehicleSizeUnitsPerMeter()) {
  const u = readUnitySize(obj);
  if (!u) return null;

  const upm = Number(unitsPerMeter) || 1;
  if (!Number.isFinite(upm) || upm <= 0) return null;

  return {
    width: u.width / upm,
    height: u.height / upm,
    length: u.length / upm,
    max: u.max / upm,
  };
}

// Short tile-friendly format.
// Returns "" when no size is available.
export function formatVehicleSizeShort(obj, unitsPerMeter = getVehicleSizeUnitsPerMeter()) {
  const m = getVehicleSizeMeters(obj, unitsPerMeter);
  if (!m) return "";

  const L = fmtMeters(m.length);
  const W = fmtMeters(m.width);
  const H = fmtMeters(m.height);
  if (!L || !W || !H) return "";

  // Keep it compact: L×W×H m
  return `${L}×${W}×${H}m`;
}

// Selected-panel format (explicit labels).
// Returns "" when no size is available.
export function formatVehicleSizeDetail(obj, unitsPerMeter = getVehicleSizeUnitsPerMeter()) {
  const m = getVehicleSizeMeters(obj, unitsPerMeter);
  if (!m) return "";

  const l = fmtMeters(m.length);
  const w = fmtMeters(m.width);
  const h = fmtMeters(m.height);
  if (!l || !w || !h) return "";

  return `Length ${l}m • Width ${w}m • Height ${h}m`;
}

// Size buckets are based on the vehicle's max dimension in meters.
// These thresholds are intentionally simple for MVP.
export const SIZE_BUCKETS = [
  { key: "xs", label: "XS", maxMetersExclusive: 6 },
  { key: "s", label: "S", maxMetersExclusive: 10 },
  { key: "m", label: "M", maxMetersExclusive: 16 },
  { key: "l", label: "L", maxMetersExclusive: 22 },
  { key: "xl", label: "XL", maxMetersExclusive: 30 },
  { key: "xxl", label: "XXL", maxMetersExclusive: Infinity },
];

export const SIZE_FILTER_OPTIONS = [
  { key: "all", label: "All" },
  ...SIZE_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
  { key: "unknown", label: "Unknown" },
];

export function normalizeSizeFilterKey(key) {
  const k = String(key || "all").trim().toLowerCase();
  if (k === "all" || k === "unknown") return k;
  if (SIZE_BUCKETS.some((b) => b.key === k)) return k;
  return "all";
}

export function labelForSizeFilterKey(key) {
  const k = normalizeSizeFilterKey(key);
  if (k === "all") return "All";
  if (k === "unknown") return "Unknown";
  const b = SIZE_BUCKETS.find((x) => x.key === k);
  return b ? b.label : "All";
}

export function getSizeBucketKey(obj, unitsPerMeter = getVehicleSizeUnitsPerMeter()) {
  const m = getVehicleSizeMeters(obj, unitsPerMeter);
  const max = Number(m?.max);
  if (!Number.isFinite(max) || max <= 0) return "unknown";

  for (const b of SIZE_BUCKETS) {
    if (max < b.maxMetersExclusive) return b.key;
  }
  return "xxl";
}

export function matchesSizeFilter(obj, filterKey, unitsPerMeter = getVehicleSizeUnitsPerMeter()) {
  const k = normalizeSizeFilterKey(filterKey);
  if (k === "all") return true;

  const bucket = getSizeBucketKey(obj, unitsPerMeter);
  if (k === "unknown") return bucket === "unknown";
  return bucket === k;
}
