// functions/_lib/dbUtil.js
// Small D1/SQLite helpers shared by config endpoints.

export function toStr(v) {
  return String(v ?? "").trim();
}

export function msFromIso(iso) {
  const t = Date.parse(String(iso || ""));
  return Number.isFinite(t) ? Math.trunc(t) : null;
}

export function isoFromMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(Math.trunc(n)).toISOString();
}

export function nowMs() {
  return Date.now();
}

export function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
  }
  return false;
}

export function toBoolInt(v) {
  return toBool(v) ? 1 : 0;
}

export async function tableExists(db, tableName) {
  if (!db) return false;
  const name = toStr(tableName);
  if (!name) return false;
  try {
    const row = await db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .bind(name)
      .first();
    return !!row;
  } catch {
    return false;
  }
}

export function isNoSuchTableError(e) {
  const msg = String(e?.message || e || "").toLowerCase();
  return msg.includes("no such table");
}
