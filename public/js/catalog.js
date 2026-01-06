let _cache = null;

export function isRandomPlaceholderId(id) {
  const s = (id || "").toLowerCase();
  return s === "__random__" || s === "tube_palette";
}

function normalizeCatalogShape(data) {
  if (!data || typeof data !== "object") return data;

  // Support both shapes:
  // 1) types: { ground: {...}, space: {...} }
  // 2) types: [ { key: "ground", ... }, { key: "space", ... } ] (Unity JsonUtility friendly)
  if (Array.isArray(data.types)) {
    const obj = {};
    for (const t of data.types) {
      if (!t || typeof t !== "object") continue;
      const key = (t.key || t.vehicleType || t.type || "").toLowerCase().trim();
      if (!key) continue;
      obj[key] = {
        label: t.label || key,
        emoji: t.emoji || "",
        note: t.note || "",
        options: Array.isArray(t.options) ? t.options : [],
      };
    }
    data.types = obj;
  }

  return data;
}

export async function loadVehicleCatalog() {
  if (_cache) return _cache;

  const res = await fetch("/data/vehicleCatalog.json", { cache: "no-store" });
  if (!res.ok) {
    // MVP fallback so the site still loads even if the catalog isn't present yet.
    _cache = {
      version: 1,
      generatedUtc: new Date().toISOString(),
      types: {
        ground: {
          label: "Ground",
          emoji: "🚗",
          options: [],
          note: "Add your ground vehicles to /public/data/vehicleCatalog.json",
        },
      },
    };
    return _cache;
  }

  const data = normalizeCatalogShape(await res.json());
  _cache = data;
  return data;
}

export function listTypes(catalog) {
  if (!catalog || !catalog.types) return [];
  return Object.keys(catalog.types);
}

export function getType(catalog, type) {
  if (!catalog || !catalog.types) return null;
  return catalog.types[type] || null;
}
