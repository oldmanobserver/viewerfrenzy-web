// functions/_lib/achievements.js
//
// Lightweight achievements engine for ViewerFrenzy.
//
// Goals (MVP):
// - Achievements are configured in D1 (table: achievements)
// - Unlocked achievements are stored in D1 (table: viewer_achievements)
// - Criteria is a very small, safe DSL (no arbitrary code):
//     metric op number
//   (one per line, or separated by ';')
//   Example: wins>=1
//
// Supported metrics (MVP):
// - wins: count of finishes where finish_position=1
// - races: count of all competition_results rows for the viewer
// - finished: count of rows with status='FINISHED'
// - dnf: count of rows where status!='FINISHED'
// - defaultVehicleSets: count of viewer_actions rows (action_key='default_vehicle_set')
//
// NOTE: This is intended to run inside Cloudflare Pages Functions.

function toStr(v) {
  return String(v ?? "").trim();
}

function uniqStrings(list) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(list) ? list : []) {
    const s = toStr(v);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function placeholders(n) {
  return Array.from({ length: Math.max(1, n) }, () => "?").join(",");
}

// ------------------------------
// Criteria parsing / evaluation
// ------------------------------

export function parseAchievementCriteria(criteriaRaw) {
  const text = toStr(criteriaRaw);
  if (!text) {
    return { ok: false, error: "criteria_required", message: "Criteria is required." };
  }

  const parts = text
    .replace(/\r/g, "")
    .split(/\n|;/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const re = /^([a-zA-Z_][a-zA-Z0-9_\.:-]*)\s*(>=|<=|==|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)$/;

  const clauses = [];
  for (const line of parts) {
    if (line.startsWith("#") || line.startsWith("//")) continue;

    const m = line.match(re);
    if (!m) {
      return {
        ok: false,
        error: "invalid_criteria",
        message: `Invalid criteria line: "${line}". Expected format like wins>=1`,
      };
    }

    const metric = toStr(m[1]).toLowerCase();
    const op = m[2] === "=" ? "==" : m[2];
    const value = Number(m[3]);

    if (!metric) {
      return { ok: false, error: "invalid_criteria", message: "Criteria metric is missing." };
    }
    if (!Number.isFinite(value)) {
      return { ok: false, error: "invalid_criteria", message: `Criteria value is not a number: ${m[3]}` };
    }

    clauses.push({ metric, op, value });
  }

  if (!clauses.length) {
    return { ok: false, error: "invalid_criteria", message: "Criteria contains no valid clauses." };
  }

  return { ok: true, clauses };
}

function normalizeMetricName(name) {
  const s = toStr(name).toLowerCase();
  if (!s) return "";

  // Direct action syntax: action:default_vehicle_set, action.default_vehicle_set, action_default_vehicle_set
  if (s.startsWith("action:")) return s;
  if (s.startsWith("action.")) return "action:" + s.slice("action.".length);
  if (s.startsWith("action_")) return "action:" + s.slice("action_".length);

  // Friendly aliases
  const aliases = {
    win: "wins",
    wins: "wins",

    race: "races",
    races: "races",
    competitions: "races",

    finish: "finished",
    finishes: "finished",
    finished: "finished",

    dnf: "dnf",
    dnfs: "dnf",

    defaultvehicleset: "action:default_vehicle_set",
    defaultvehiclesets: "action:default_vehicle_set",
    website_default_vehicle_set: "action:default_vehicle_set",
    webdefaultvehiclesets: "action:default_vehicle_set",
  };

  return aliases[s] || s;
}

function compareOp(left, op, right) {
  switch (op) {
    case ">":
      return left > right;
    case ">=":
      return left >= right;
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    default:
      return false;
  }
}

export function evaluateAchievementCriteria(clauses, metrics) {
  const m = metrics || {};
  const actions = m.actions || {};

  for (const c of Array.isArray(clauses) ? clauses : []) {
    const raw = normalizeMetricName(c?.metric);
    const op = toStr(c?.op);
    const target = Number(c?.value);

    let left = 0;

    if (raw.startsWith("action:")) {
      const key = raw.slice("action:".length);
      left = Number(actions?.[key] || 0) || 0;
    } else {
      left = Number(m?.[raw] || 0) || 0;
    }

    if (!compareOp(left, op, target)) return false;
  }

  return true;
}

// ------------------------------
// D1 queries
// ------------------------------

export async function listActiveAchievements(env) {
  if (!env?.VF_D1_STATS) return [];

  const res = await env.VF_D1_STATS.prepare(
    `SELECT id, name, description, disabled, criteria
     FROM achievements
     WHERE disabled = 0
     ORDER BY id ASC`,
  ).all();

  return Array.isArray(res?.results) ? res.results : [];
}

export async function recordViewerAction(env, viewerUserId, actionKey) {
  if (!env?.VF_D1_STATS) return { ok: false, skipped: true, reason: "d1_not_bound" };

  const uid = toStr(viewerUserId);
  const key = toStr(actionKey);
  if (!uid || !key) return { ok: false, skipped: true, reason: "missing_input" };

  const nowMs = Date.now();

  // Upsert counter.
  await env.VF_D1_STATS.prepare(
    `INSERT INTO viewer_actions (viewer_user_id, action_key, count, first_at_ms, last_at_ms)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(viewer_user_id, action_key) DO UPDATE SET
       count = count + 1,
       first_at_ms = COALESCE(first_at_ms, excluded.first_at_ms),
       last_at_ms = excluded.last_at_ms`,
  )
    .bind(uid, key, nowMs, nowMs)
    .run();

  return { ok: true, viewerUserId: uid, actionKey: key, atMs: nowMs };
}

async function loadViewerStats(env, viewerUserIds) {
  const ids = uniqStrings(viewerUserIds);
  if (!ids.length) return new Map();

  const sql = `
    SELECT
      viewer_user_id AS viewerUserId,
      COUNT(*) AS races,
      SUM(CASE WHEN status = 'FINISHED' THEN 1 ELSE 0 END) AS finished,
      SUM(CASE WHEN status = 'FINISHED' AND finish_position = 1 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status != 'FINISHED' THEN 1 ELSE 0 END) AS dnf
    FROM competition_results
    WHERE viewer_user_id IN (${placeholders(ids.length)})
    GROUP BY viewer_user_id
  `;

  const res = await env.VF_D1_STATS.prepare(sql).bind(...ids).all();
  const map = new Map();

  for (const r of Array.isArray(res?.results) ? res.results : []) {
    const uid = toStr(r?.viewerUserId);
    if (!uid) continue;
    map.set(uid, {
      races: Number(r?.races || 0) || 0,
      finished: Number(r?.finished || 0) || 0,
      wins: Number(r?.wins || 0) || 0,
      dnf: Number(r?.dnf || 0) || 0,
      actions: {},
    });
  }

  // Ensure every id has a row
  for (const uid of ids) {
    if (!map.has(uid)) {
      map.set(uid, { races: 0, finished: 0, wins: 0, dnf: 0, actions: {} });
    }
  }

  return map;
}

async function loadViewerActions(env, viewerUserIds, actionKeys) {
  const ids = uniqStrings(viewerUserIds);
  const keys = uniqStrings(actionKeys);

  if (!ids.length || !keys.length) return new Map();

  const sql = `
    SELECT viewer_user_id AS viewerUserId, action_key AS actionKey, count
    FROM viewer_actions
    WHERE viewer_user_id IN (${placeholders(ids.length)})
      AND action_key IN (${placeholders(keys.length)})
  `;

  const res = await env.VF_D1_STATS.prepare(sql).bind(...ids, ...keys).all();
  const map = new Map(); // uid -> { actionKey: count }

  for (const r of Array.isArray(res?.results) ? res.results : []) {
    const uid = toStr(r?.viewerUserId);
    const key = toStr(r?.actionKey);
    if (!uid || !key) continue;
    if (!map.has(uid)) map.set(uid, {});
    map.get(uid)[key] = Number(r?.count || 0) || 0;
  }

  return map;
}

async function loadExistingUnlocks(env, viewerUserIds, achievementIds) {
  const ids = uniqStrings(viewerUserIds);
  const ach = (Array.isArray(achievementIds) ? achievementIds : []).map((x) => Number(x) || 0).filter((x) => x > 0);

  if (!ids.length || !ach.length) return new Set();

  const sql = `
    SELECT viewer_user_id AS viewerUserId, achievement_id AS achievementId
    FROM viewer_achievements
    WHERE viewer_user_id IN (${placeholders(ids.length)})
      AND achievement_id IN (${placeholders(ach.length)})
  `;

  const res = await env.VF_D1_STATS.prepare(sql).bind(...ids, ...ach).all();
  const set = new Set();

  for (const r of Array.isArray(res?.results) ? res.results : []) {
    const uid = toStr(r?.viewerUserId);
    const aid = Number(r?.achievementId || 0) || 0;
    if (!uid || !aid) continue;
    set.add(`${uid}::${aid}`);
  }

  return set;
}

// ------------------------------
// Main entry: award
// ------------------------------

export async function awardAchievementsForViewers(env, viewerUserIds, {
  source = "",
  sourceRef = "",
} = {}) {
  if (!env?.VF_D1_STATS) return [];

  const viewerIds = uniqStrings(viewerUserIds);
  if (!viewerIds.length) return [];

  let achievements;
  try {
    achievements = await listActiveAchievements(env);
  } catch {
    // Tables might not exist yet.
    return [];
  }

  if (!achievements.length) return [];

  // Parse criteria and collect required action keys.
  const compiled = [];
  const actionKeys = new Set();

  for (const a of achievements) {
    const parsed = parseAchievementCriteria(a?.criteria);
    if (!parsed.ok) continue;

    // collect action keys in criteria
    for (const c of parsed.clauses) {
      const m = normalizeMetricName(c?.metric);
      if (m.startsWith("action:")) {
        const key = m.slice("action:".length);
        if (key) actionKeys.add(key);
      }
    }

    compiled.push({
      id: Number(a?.id || 0) || 0,
      name: toStr(a?.name),
      description: toStr(a?.description),
      criteria: toStr(a?.criteria),
      clauses: parsed.clauses,
    });
  }

  if (!compiled.length) return [];

  const achievementIds = compiled.map((a) => a.id);

  // Load stats + actions
  const statsMap = await loadViewerStats(env, viewerIds);
  const actMap = await loadViewerActions(env, viewerIds, Array.from(actionKeys));

  for (const uid of viewerIds) {
    const s = statsMap.get(uid) || { races: 0, finished: 0, wins: 0, dnf: 0, actions: {} };
    s.actions = actMap.get(uid) || {};
    statsMap.set(uid, s);
  }

  // Existing unlocks (avoid re-inserting)
  const existing = await loadExistingUnlocks(env, viewerIds, achievementIds);

  const nowMs = Date.now();
  const unlocked = [];

  // Insert per new unlock.
  // (Using INSERT OR IGNORE for safety; meta.changes tells us if the insert happened.)
  for (const uid of viewerIds) {
    const metrics = statsMap.get(uid) || { races: 0, finished: 0, wins: 0, dnf: 0, actions: {} };

    for (const a of compiled) {
      if (!a?.id) continue;

      const key = `${uid}::${a.id}`;
      if (existing.has(key)) continue;

      const ok = evaluateAchievementCriteria(a.clauses, metrics);
      if (!ok) continue;

      const res = await env.VF_D1_STATS.prepare(
        `INSERT OR IGNORE INTO viewer_achievements
           (viewer_user_id, achievement_id, unlocked_at_ms, source, source_ref)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(uid, a.id, nowMs, toStr(source), toStr(sourceRef))
        .run();

      const changes = Number(res?.meta?.changes || 0) || 0;
      if (changes > 0) {
        unlocked.push({
          viewerUserId: uid,
          achievementId: a.id,
          achievementName: a.name,
          unlockedAtMs: nowMs,
        });

        // Avoid duplicate inserts in this run.
        existing.add(key);
      }
    }
  }

  return unlocked;
}

// ------------------------------
// Progress (for website UI)
// ------------------------------

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clauseProgress01(currentRaw, opRaw, targetRaw) {
  const current = Number(currentRaw) || 0;
  const op = toStr(opRaw);
  const target = Number(targetRaw) || 0;

  // If the clause is already satisfied, progress is complete.
  if (compareOp(current, op, target)) return 1;

  // Otherwise estimate "how close" we are.
  // This is intentionally simple and tuned for count-like metrics.
  switch (op) {
    case ">=": {
      if (target === 0) return current > 0 ? 1 : 0;
      return clamp01(current / target);
    }
    case ">": {
      // For integer counters, "> N" becomes "N+1" as the practical target.
      const denom = target + 1;
      if (denom <= 0) return current > target ? 1 : 0;
      return clamp01(current / denom);
    }
    case "<=": {
      // If you exceeded a limit (e.g. dnf<=0), progress is basically 0.
      if (target <= 0) return 0;
      if (current <= 0) return 0;
      return clamp01(target / current);
    }
    case "<": {
      // Similar to <=, but treat as "target-1" for integer counters.
      const practical = target - 1;
      if (practical <= 0) return 0;
      if (current <= 0) return 0;
      return clamp01(practical / current);
    }
    case "==": {
      if (target === 0) return current === 0 ? 1 : 0;
      if (current < target) return clamp01(current / target);
      if (current > target) return clamp01(target / current);
      return 1;
    }
    case "!=": {
      return current !== target ? 1 : 0;
    }
    default:
      return 0;
  }
}

function metricLabel(normalizedMetric) {
  const m = toStr(normalizedMetric);
  if (!m) return "";

  if (m.startsWith("action:")) {
    const key = m.slice("action:".length);

    // Friendly known keys
    if (key === "default_vehicle_set") return "Default vehicle sets";
    if (key === "default_vehicle_set_ground") return "Default ground vehicle set";
    if (key === "default_vehicle_set_resort") return "Default resort vehicle set";
    if (key === "default_vehicle_set_space") return "Default space vehicle set";

    // Fallback: action key -> Title-ish case
    return key
      .split(/[_\-]/g)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
  }

  switch (m) {
    case "wins":
      return "Wins";
    case "races":
      return "Races";
    case "finished":
      return "Finished";
    case "dnf":
      return "DNF";
    default:
      return m;
  }
}

async function loadUnlockMap(env, viewerUserId) {
  const uid = toStr(viewerUserId);
  if (!uid) return new Map();

  const res = await env.VF_D1_STATS.prepare(
    `SELECT achievement_id AS achievementId, unlocked_at_ms AS unlockedAtMs
     FROM viewer_achievements
     WHERE viewer_user_id = ?`,
  )
    .bind(uid)
    .all();

  const map = new Map();
  for (const r of Array.isArray(res?.results) ? res.results : []) {
    const aid = Number(r?.achievementId || 0) || 0;
    const ts = Number(r?.unlockedAtMs || 0) || 0;
    if (aid > 0 && ts > 0) map.set(aid, ts);
  }
  return map;
}

/**
 * Returns all active achievements + completion + progress for a single viewer.
 *
 * Response format is tailored for the website Achievements page.
 */
export async function getAchievementProgressForViewer(env, viewerUserId) {
  if (!env?.VF_D1_STATS) {
    return { ok: false, error: "d1_not_bound", achievements: [] };
  }

  const uid = toStr(viewerUserId);
  if (!uid) {
    return { ok: false, error: "missing_viewer_user_id", achievements: [] };
  }

  let achievements;
  try {
    achievements = await listActiveAchievements(env);
  } catch (e) {
    return {
      ok: false,
      error: "db_not_initialized",
      message: "Stats DB not initialized (achievements tables missing).",
      details: String(e?.message || e),
      achievements: [],
    };
  }

  // Parse + compile criteria; collect action keys so we only query what we need.
  const compiled = [];
  const actionKeys = new Set();

  for (const a of Array.isArray(achievements) ? achievements : []) {
    const parsed = parseAchievementCriteria(a?.criteria);
    if (!parsed.ok) continue;

    const clauses = parsed.clauses.map((c) => {
      const metric = normalizeMetricName(c?.metric);
      if (metric.startsWith("action:")) {
        const key = metric.slice("action:".length);
        if (key) actionKeys.add(key);
      }
      return {
        metricRaw: toStr(c?.metric),
        metric,
        op: toStr(c?.op),
        target: Number(c?.value || 0) || 0,
      };
    });

    compiled.push({
      id: Number(a?.id || 0) || 0,
      name: toStr(a?.name),
      description: toStr(a?.description),
      criteria: toStr(a?.criteria),
      clauses,
    });
  }

  // Viewer metrics
  const statsMap = await loadViewerStats(env, [uid]);
  const actMap = await loadViewerActions(env, [uid], Array.from(actionKeys));

  const metrics = statsMap.get(uid) || { races: 0, finished: 0, wins: 0, dnf: 0, actions: {} };
  metrics.actions = actMap.get(uid) || {};

  // Unlock timestamps (if any)
  const unlockMap = await loadUnlockMap(env, uid);

  const out = [];

  for (const a of compiled) {
    if (!a?.id) continue;

    const unlockedAtMs = unlockMap.get(a.id) || 0;

    const eligibleNow = evaluateAchievementCriteria(
      a.clauses.map((x) => ({ metric: x.metricRaw, op: x.op, value: x.target })),
      metrics,
    );

    const reqs = [];
    let hasAnyProgress = false;
    let sumProgress = 0;
    let satisfiedCount = 0;

    for (const c of a.clauses) {
      let current = 0;
      if (c.metric.startsWith("action:")) {
        const key = c.metric.slice("action:".length);
        current = Number(metrics?.actions?.[key] || 0) || 0;
      } else {
        current = Number(metrics?.[c.metric] || 0) || 0;
      }

      const satisfied = compareOp(current, c.op, c.target);
      const p01 = clauseProgress01(current, c.op, c.target);

      if (p01 > 0) hasAnyProgress = true;
      sumProgress += p01;
      if (satisfied) satisfiedCount += 1;

      reqs.push({
        metric: c.metric,
        metricLabel: metricLabel(c.metric),
        op: c.op,
        target: c.target,
        current,
        satisfied,
        progress01: p01,
      });
    }

    const avgProgress = reqs.length ? sumProgress / reqs.length : 0;
    const overallProgress01 = unlockedAtMs > 0 ? 1 : eligibleNow ? 1 : clamp01(avgProgress);

    out.push({
      id: a.id,
      name: a.name,
      description: a.description,
      criteria: a.criteria,
      unlockedAtMs,
      eligibleNow,
      overallProgress01,
      hasAnyProgress,
      requirementsSatisfied: satisfiedCount,
      requirementsTotal: reqs.length,
      requirements: reqs,
    });
  }

  return {
    ok: true,
    viewerUserId: uid,
    metrics: {
      races: Number(metrics?.races || 0) || 0,
      finished: Number(metrics?.finished || 0) || 0,
      wins: Number(metrics?.wins || 0) || 0,
      dnf: Number(metrics?.dnf || 0) || 0,
      actions: metrics?.actions || {},
    },
    achievements: out,
  };
}
