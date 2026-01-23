import { requireSession, clearSession } from "./session.js";
import { loadVehicleCatalog, isRandomPlaceholderId } from "./catalog.js";
import * as api from "./api.js";
import { toast } from "./ui.js";
import { applyVehicleImage } from "./vehicle-images.js";
import {
  SIZE_FILTER_OPTIONS,
  normalizeSizeFilterKey,
  labelForSizeFilterKey,
  matchesSizeFilter,
  formatVehicleSizeShort,
  formatVehicleSizeDetail,
} from "./vehicle-size.js";

const PREFERRED_ORDER = ["ground", "resort", "space", "water", "trackfield", "winter"];
const UI_STATE_KEY = "vf_garage_ui_v1";

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    return obj;
  } catch {
    return null;
  }
}

function saveUiState(state) {
  try {
    localStorage.setItem(
      UI_STATE_KEY,
      JSON.stringify({
        type: state.type,
        search: state.search,
        sizeFilter: state.sizeFilter,
        cols: state.cols,
        rows: state.rows,
        showUnlocked: !!state.showUnlocked,
        showLocked: !!state.showLocked,
        // Achievement filters
        // Only one of these should be non-zero at a time.
        achievementUnlockedFilterId: Number(state.achievementUnlockedFilterId || 0) || 0,
        achievementLockedFilterId: Number(state.achievementLockedFilterId || 0) || 0,
      }),
    );
  } catch {
    // ignore
  }
}

function optionMeta(type, opt) {
  if (!opt) return "";

  if (type === "space") {
    const parts = [];
    if (opt.pack) parts.push(opt.pack);
    if (opt.category) parts.push(opt.category);
    return parts.join(" / ");
  }

  if (type === "resort") {
    if ((opt.id || "").startsWith("tube_")) return "Lazy river tube";
  }

  return opt.meta || "";
}

function findOption(typeEntry, id) {
  const opts = typeEntry?.options || [];
  return opts.find((o) => (o?.id || "") === id) || null;
}

function labelForServerRecord(type, record, typeEntry) {
  if (record === null) {
    return {
      label: "No default saved on server yet.",
      updatedAt: "",
      kind: "none",
    };
  }

  const vehicleId = record?.vehicleId ?? "";

  if (!vehicleId) {
    return {
      label: "Cleared (uses default pool)",
      updatedAt: record?.updatedAt || "",
      kind: "cleared",
    };
  }

  const opt = findOption(typeEntry, vehicleId);
  return {
    label: opt ? opt.displayName : `Unknown vehicle id: ${vehicleId}`,
    updatedAt: record?.updatedAt || "",
    kind: opt ? "known" : "unknown",
  };
}

async function init() {
  const root = document.getElementById("vf-garageRoot");
  if (!root) return;

  const session = await requireSession();
  if (!session) return;

  const catalog = await loadVehicleCatalog();

  const typeNames = Object.keys(catalog?.types || {});
  const availableTypes = [...typeNames].sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a);
    const ib = PREFERRED_ORDER.indexOf(b);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  const uiSaved = loadUiState() || {};

  // Legacy support: older UI stored a single achievementFilterId.
  // New UI uses two dropdowns (unlocked vs locked). If we only have the legacy
  // value, treat it as a "locked achievement" filter (best effort).
  const legacyAchievementFilterId = Number(uiSaved.achievementFilterId || 0) || 0;
  const savedUnlockedAchFilterId = Number(uiSaved.achievementUnlockedFilterId || 0) || 0;
  const savedLockedAchFilterId = Number(uiSaved.achievementLockedFilterId || 0) || 0;

  const state = {
    type: uiSaved.type && availableTypes.includes(uiSaved.type) ? uiSaved.type : (availableTypes[0] || "ground"),
    search: typeof uiSaved.search === "string" ? uiSaved.search : "",
    sizeFilter: normalizeSizeFilterKey(typeof uiSaved.sizeFilter === "string" ? uiSaved.sizeFilter : "all"),
    cols: clamp(Number(uiSaved.cols || 4), 1, 8),
    rows: clamp(Number(uiSaved.rows || 3), 1, 8),

    // Filters
    // Default behavior: show only unlocked vehicles (most user-friendly)
    showUnlocked: uiSaved.showUnlocked === undefined ? true : !!uiSaved.showUnlocked,
    showLocked: uiSaved.showLocked === undefined ? false : !!uiSaved.showLocked,
    // Achievement filters (two dropdowns)
    // Only one of these should be non-zero at a time.
    achievementUnlockedFilterId: savedUnlockedAchFilterId,
    achievementLockedFilterId: savedLockedAchFilterId || (savedUnlockedAchFilterId ? 0 : legacyAchievementFilterId),

    offset: 0,           // index into filtered options
    selectedId: null,    // currently selected vehicle id
    serverDefaults: {},  // type -> record|null|undefined

    // Vehicle role pools (loaded from /api/v1/vehicle-pools)
    // Used to filter which vehicles appear in each mode.
    pools: null,         // response.pools
    disabledSet: new Set(),
    eligibleByType: new Map(),

    // Vehicle unlocks (v0.5+)
    // - unlockRules: vehicleId -> { free: boolean, achievementId: number }
    // - alwaysUnlockedSet: competition defaults (default pool vehicles)
    // - unlockedAchievementIds: achievements already unlocked by current user
    unlockRules: {},
    alwaysUnlockedSet: new Set(),
    unlockedAchievementIds: new Set(),

    // Achievement definitions (public, non-hidden)
    achievements: [],
    achievementMap: new Map(),
    achievementsLoaded: false,

    // UI busy flag (saving/clearing)
    actionBusy: false,
  };

  // Safety: never allow a state where both are false (would show nothing).
  if (!state.showUnlocked && !state.showLocked) state.showUnlocked = true;

  // Safety: only one achievement dropdown filter can be active.
  if (Number(state.achievementUnlockedFilterId || 0) !== 0 && Number(state.achievementLockedFilterId || 0) !== 0) {
    state.achievementLockedFilterId = 0;
  }

  // Load vehicle eligibility pools (public, no auth)
  try {
    const poolsResp = await api.getVehiclePools();
    if (poolsResp?.ok && poolsResp?.pools) {
      state.pools = poolsResp.pools;
      state.disabledSet = new Set(poolsResp.disabledIds || []);
      state.unlockRules = poolsResp.unlockRules && typeof poolsResp.unlockRules === "object" ? poolsResp.unlockRules : {};

      // "Competition defaults" (default pool vehicles) are always unlocked.
      state.alwaysUnlockedSet = new Set();
      for (const v of Object.values(poolsResp.pools || {})) {
        for (const id of Array.isArray(v?.defaultIds) ? v.defaultIds : []) {
          const s = String(id || "").trim();
          if (s) state.alwaysUnlockedSet.add(s);
        }
      }

      state.eligibleByType = new Map();
      for (const [t, v] of Object.entries(poolsResp.pools)) {
        const ids = Array.isArray(v?.eligibleIds) ? v.eligibleIds : [];
        state.eligibleByType.set(String(t).toLowerCase(), new Set(ids));
      }
    }
  } catch {
    // Non-fatal: fall back to showing the full catalog.
  }

  // Load viewer's unlocked achievements (auth required).
  try {
    const a = await api.getMyUnlockedAchievements(session.auth);
    const ids = (Array.isArray(a?.achievements) ? a.achievements : [])
      .map((x) => Number(x?.achievementId || 0) || 0)
      .filter((n) => n > 0);
    state.unlockedAchievementIds = new Set(ids);
  } catch {
    // ignore (will treat achievement-gated vehicles as locked)
  }

  // Load public achievement definitions (non-hidden). Used for:
  // - Achievement filter dropdown
  // - Showing which achievement unlocks a selected locked vehicle
  try {
    const defs = await api.getAchievements();
    const list = Array.isArray(defs?.achievements) ? defs.achievements : [];
    state.achievements = list;
    state.achievementMap = new Map();
    for (const a of list) {
      const id = Number(a?.id || 0) || 0;
      if (id <= 0) continue;
      state.achievementMap.set(id, {
        id,
        name: String(a?.name || "").trim(),
        description: String(a?.description || "").trim(),
      });
    }
    state.achievementsLoaded = true;
  } catch {
    state.achievements = [];
    state.achievementMap = new Map();
    state.achievementsLoaded = false;
  }

  // UI skeleton
  root.innerHTML = `
    <div class="vf-card">
      <div class="vf-row">
        <div>
          <div class="vf-h2">Vehicle type</div>
          <div class="vf-muted vf-small">Set a default for each mode.</div>
        </div>
        <div class="vf-spacer"></div>

        <div class="vf-controlsGrid">
          <label class="vf-field">
            <span class="vf-fieldLabel">Columns</span>
            <input id="vf-cols" class="vf-input vf-inputSmall" type="number" min="1" max="8" step="1" />
          </label>

          <label class="vf-field">
            <span class="vf-fieldLabel">Rows</span>
            <input id="vf-rows" class="vf-input vf-inputSmall" type="number" min="1" max="8" step="1" />
          </label>
        </div>
      </div>

      <div class="vf-row" style="margin-top: 10px">
        <input id="vf-search" class="vf-input" placeholder="Search vehicles…" />
        <div class="vf-spacer"></div>

        <div class="vf-pager">
          <button id="vf-pageUp" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Page Up</button>
          <button id="vf-pageDown" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Page Down</button>
          <button id="vf-prevCol" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Prev Column</button>
          <button id="vf-nextCol" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Next Column</button>
        </div>
      </div>

      <div class="vf-row" style="margin-top: 10px; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
        <div class="vf-field">
          <span class="vf-fieldLabel">Show</span>
          <div class="vf-toggleRow">
            <label class="vf-toggle">
              <input id="vf-showUnlocked" type="checkbox" />
              <span>Unlocked</span>
            </label>
            <label class="vf-toggle">
              <input id="vf-showLocked" type="checkbox" />
              <span>Locked</span>
            </label>
          </div>
        </div>

        <label class="vf-field" style="min-width: 240px;">
          <span class="vf-fieldLabel">Unlocked achievements</span>
          <select id="vf-achUnlockedFilter" class="vf-input vf-inputSmall"></select>
        </label>

        <label class="vf-field" style="min-width: 240px;">
          <span class="vf-fieldLabel">Locked achievements</span>
          <select id="vf-achLockedFilter" class="vf-input vf-inputSmall"></select>
        </label>

        <label class="vf-field" style="min-width: 160px;">
          <span class="vf-fieldLabel">Size</span>
          <select id="vf-sizeFilter" class="vf-input vf-inputSmall"></select>
        </label>
      </div>

      <div id="vf-typeChips" class="vf-chipRow" style="margin-top: 12px"></div>
      <div id="vf-pageInfo" class="vf-muted vf-small" style="margin-top: 10px"></div>
    </div>

    <div class="vf-garageLayout">
      <div class="vf-card">
        <div class="vf-row">
          <div>
            <div class="vf-h2">Vehicle grid</div>
            <div class="vf-muted vf-small" id="vf-gridSubtitle"></div>
          </div>
          <div class="vf-spacer"></div>
          <div class="vf-muted vf-small" id="vf-serverStatus"></div>
        </div>

        <div id="vf-tiles" class="vf-gridFixed"></div>

        <div id="vf-garageError" class="vf-alert vf-alertError" hidden></div>
      </div>

      <div class="vf-card">
        <div class="vf-row">
          <div>
            <div class="vf-h2">Selected vehicle</div>
            <div class="vf-muted vf-small" id="vf-selectedLabel">Select a vehicle…</div>
            <div class="vf-muted vf-small" id="vf-selectedSize" style="margin-top: 6px" hidden></div>
            <div class="vf-muted vf-small" id="vf-selectedUnlockInfo" style="margin-top: 6px" hidden></div>
          </div>
        </div>

        <div id="vf-previewViewport" class="vf-previewViewport">
          <img id="vf-previewImg" class="vf-previewImg" alt="" draggable="false" />
        </div>

        <div class="vf-previewControls">
          <button id="vf-saveDefaultBtn" class="vf-btn vf-btnPrimary" type="button" style="flex: 1">Save as Default</button>
          <button id="vf-clearDefaultBtn" class="vf-btn vf-btnSecondary" type="button" style="flex: 1">Clear Default (use default pool)</button>
        </div>

        <div id="vf-savedDefaultLabel" class="vf-muted vf-small" style="margin-top: 10px"></div>
      </div>
    </div>
  `;

  // Grab elements
  const elChips = root.querySelector("#vf-typeChips");
  const elShowUnlocked = root.querySelector("#vf-showUnlocked");
  const elShowLocked = root.querySelector("#vf-showLocked");
  const elAchUnlockedFilter = root.querySelector("#vf-achUnlockedFilter");
  const elAchLockedFilter = root.querySelector("#vf-achLockedFilter");
  const elSizeFilter = root.querySelector("#vf-sizeFilter");
  const elSearch = root.querySelector("#vf-search");
  const elCols = root.querySelector("#vf-cols");
  const elRows = root.querySelector("#vf-rows");
  const elTiles = root.querySelector("#vf-tiles");
  const elErr = root.querySelector("#vf-garageError");
  const elPageInfo = root.querySelector("#vf-pageInfo");
  const elGridSubtitle = root.querySelector("#vf-gridSubtitle");
  const elServerStatus = root.querySelector("#vf-serverStatus");
  const elSelectedLabel = root.querySelector("#vf-selectedLabel");
  const elSelectedSize = root.querySelector("#vf-selectedSize");
  const elSelectedUnlockInfo = root.querySelector("#vf-selectedUnlockInfo");
  const elPreviewViewport = root.querySelector("#vf-previewViewport");
  const elPreviewImg = root.querySelector("#vf-previewImg");
  const elSavedLabel = root.querySelector("#vf-savedDefaultLabel");

  const btnPageUp = root.querySelector("#vf-pageUp");
  const btnPageDown = root.querySelector("#vf-pageDown");
  const btnPrevCol = root.querySelector("#vf-prevCol");
  const btnNextCol = root.querySelector("#vf-nextCol");

  const btnSave = root.querySelector("#vf-saveDefaultBtn");
  const btnClear = root.querySelector("#vf-clearDefaultBtn");

  elSearch.value = state.search;
  elCols.value = String(state.cols);
  elRows.value = String(state.rows);

  if (elShowUnlocked) elShowUnlocked.checked = !!state.showUnlocked;
  if (elShowLocked) elShowLocked.checked = !!state.showLocked;

  function setError(message) {
    elErr.hidden = !message;
    elErr.textContent = message || "";
  }

  function currentTypeEntry() {
    return catalog?.types?.[state.type] || null;
  }

  function filteredOptions() {
    const entry = currentTypeEntry();
    let opts = entry?.options || [];

    // Role-based eligibility filter (if configured).
    const eligibleSet = state.eligibleByType?.get(String(state.type).toLowerCase());
    if (eligibleSet && eligibleSet.size > 0) {
      opts = opts.filter((o) => eligibleSet.has(String(o?.id || "")));
    }

    // Always hide disabled vehicles if we have the list.
    if (state.disabledSet && state.disabledSet.size > 0) {
      opts = opts.filter((o) => !state.disabledSet.has(String(o?.id || "")));
    }

    // Size bucket filter.
    const sizeKey = normalizeSizeFilterKey(state.sizeFilter);
    if (sizeKey !== "all") {
      opts = opts.filter((o) => matchesSizeFilter(o, sizeKey));
    }

    // Achievement filter (two dropdowns): show only vehicles that are unlocked by the selected achievement.
    // key:
    //   0  => no filter
    //  -1  => "hidden achievement" group (achievement id not present in public list)
    //  >0  => specific achievement id
    const { key: achFilterKey } = activeAchievementFilter();
    if (achFilterKey !== 0) {
      opts = opts.filter((o) => {
        const id = String(o?.id || "").trim();
        if (!id) return false;
        const rule = unlockRuleFor(id);
        const rid = Number(rule?.achievementId || 0) || 0;
        if (achFilterKey === -1) {
          // Hidden achievements: rid exists but we don't have its public definition.
          return rid > 0 && (state.achievementMap ? !state.achievementMap.has(rid) : true);
        }
        return rid === achFilterKey;
      });
    }

    // Locked/unlocked filters.
    // - Default: showUnlocked=true, showLocked=false
    // - If both are true: show all
    // - If both are false (shouldn't happen): fall back to unlocked
    const showUnlocked = !!state.showUnlocked;
    const showLocked = !!state.showLocked;
    if (showUnlocked !== showLocked) {
      opts = opts.filter((o) => {
        const unlocked = isVehicleUnlocked(o?.id || "");
        return showUnlocked ? unlocked : !unlocked;
      });
    } else if (!showUnlocked && !showLocked) {
      opts = opts.filter((o) => isVehicleUnlocked(o?.id || ""));
    }

    const filter = (state.search || "").trim().toLowerCase();

    if (!filter) return opts;

    return opts.filter((o) => {
      const hay = `${o.displayName || ""} ${o.id || ""} ${o.pack || ""} ${o.category || ""}`.toLowerCase();
      return hay.includes(filter);
    });
  }

  function pageSize() {
    return Math.max(1, state.cols * state.rows);
  }

  function clampOffset(total) {
    const maxStart = Math.max(0, total - 1);
    state.offset = clamp(state.offset, 0, maxStart);
  }

  function getServerRecord() {
    return state.serverDefaults[state.type];
  }

  function activeAchievementFilter() {
    const u = Number(state.achievementUnlockedFilterId || 0) || 0;
    const l = Number(state.achievementLockedFilterId || 0) || 0;
    if (u !== 0) return { key: u, source: "unlocked" };
    if (l !== 0) return { key: l, source: "locked" };
    return { key: 0, source: "" };
  }

  function unlockRuleFor(vehicleId) {
    const id = String(vehicleId || "").trim();
    if (!id) return null;
    const rule = state.unlockRules ? state.unlockRules[id] : null;
    return rule && typeof rule === "object" ? rule : null;
  }

  function isVehicleUnlocked(vehicleId) {
    const id = String(vehicleId || "").trim();
    if (!id) return false;
    if (isRandomPlaceholderId(id)) return true; // random uses default pools

    if (state.alwaysUnlockedSet && state.alwaysUnlockedSet.has(id)) return true;

    const rule = unlockRuleFor(id);
    if (rule) {
      if (Boolean(rule.free)) return true;
      const achId = Number(rule.achievementId || 0) || 0;
      if (achId > 0 && state.unlockedAchievementIds && state.unlockedAchievementIds.has(achId)) return true;
    }

    return false;
  }

  function achievementNameById(achievementId) {
    const id = Number(achievementId || 0) || 0;
    if (id <= 0) return "";
    const a = state.achievementMap?.get(id) || null;
    const name = String(a?.name || "").trim();
    return name;
  }

  function achievementLabelForViewer(achievementId) {
    const id = Number(achievementId || 0) || 0;
    if (id <= 0) return "";

    // If the achievement is hidden and the viewer hasn't unlocked it,
    // it will NOT appear in the public list, so we show a placeholder.
    const name = achievementNameById(id);
    if (name) return name;

    // If the public list failed to load, don't assume it's hidden.
    if (!state.achievementsLoaded) return `Achievement #${id}`;

    return "hidden achievement";
  }

  function lockReason(vehicleId) {
    if (isRandomPlaceholderId(vehicleId)) return "";
    if (state.alwaysUnlockedSet && state.alwaysUnlockedSet.has(String(vehicleId))) return "";
    const rule = unlockRuleFor(vehicleId);
    const achId = Number(rule?.achievementId || 0) || 0;
    if (rule && achId > 0) return `Requires: ${achievementLabelForViewer(achId)}`;
    return "Locked";
  }

  function selectedIdFromOptions(opts) {
    const list = Array.isArray(opts) ? opts : [];
    const idSet = new Set(list.map((o) => String(o?.id || "").trim()).filter(Boolean));

    // 1) User selection (even if locked) – but only if it exists under current filters.
    const sid = String(state.selectedId || "").trim();
    if (sid) {
      if (idSet.has(sid)) return sid;
      // Selection is no longer visible (filters/search/type changed)
      state.selectedId = null;
    }

    // 2) Server saved default (if present and visible)
    const record = getServerRecord();
    const rid = String(record?.vehicleId || "").trim();
    if (rid && idSet.has(rid)) return rid;

    // 3) First visible option
    const first = String(list?.[0]?.id || "").trim();
    return first || null;
  }

  function renderTypeChips() {
    elChips.innerHTML = availableTypes
      .map((t) => {
        const entry = catalog.types[t];
        const label = entry?.label || t;
        const emoji = entry?.emoji || "";
        const active = t === state.type ? "is-active" : "";
        return `
          <button class="vf-chip ${active}" type="button" data-type="${escapeHtml(t)}">
            ${emoji ? `${escapeHtml(emoji)} ` : ""}${escapeHtml(label)}
          </button>
        `;
      })
      .join("");
  }

  // Lock/unlock visibility controls are now toggles (checkboxes).
  function renderLockFilterChips() {
    if (elShowUnlocked) elShowUnlocked.checked = !!state.showUnlocked;
    if (elShowLocked) elShowLocked.checked = !!state.showLocked;
  }

  function baseOptionsForType() {
    const entry = currentTypeEntry();
    let opts = entry?.options || [];

    // Apply only the always-on filters (eligibility + disabled). No search / lock / achievement filters.
    const eligibleSet = state.eligibleByType?.get(String(state.type).toLowerCase());
    if (eligibleSet && eligibleSet.size > 0) {
      opts = opts.filter((o) => eligibleSet.has(String(o?.id || "")));
    }

    if (state.disabledSet && state.disabledSet.size > 0) {
      opts = opts.filter((o) => !state.disabledSet.has(String(o?.id || "")));
    }

    return opts;
  }

  function renderAchievementFilterSelect() {
    if (!elAchUnlockedFilter || !elAchLockedFilter) return;

    const all = (Array.isArray(state.achievements) ? state.achievements : [])
      .map((a) => {
        const id = Number(a?.id || 0) || 0;
        const name = String(a?.name || "").trim();
        return { id, name };
      })
      .filter((a) => a.id > 0)
      .sort((a, b) => (a.name || `#${a.id}`).localeCompare(b.name || `#${b.id}`, undefined, { sensitivity: "base" }));

    const unlocked = [];
    const locked = [];
    for (const a of all) {
      if (state.unlockedAchievementIds && state.unlockedAchievementIds.has(a.id)) unlocked.push(a);
      else locked.push(a);
    }

    // Hidden achievements: achievements referenced by unlock rules, but not present in the public list.
    // We only expose them as a generic "hidden achievement" entry.
    let hasHiddenUnlocked = false;
    let hasHiddenLocked = false;
    if (state.achievementsLoaded) {
      const hiddenIds = new Set();
      for (const o of baseOptionsForType()) {
        const vid = String(o?.id || "").trim();
        if (!vid) continue;
        const rule = unlockRuleFor(vid);
        const achId = Number(rule?.achievementId || 0) || 0;
        if (achId > 0 && state.achievementMap && !state.achievementMap.has(achId)) {
          hiddenIds.add(achId);
        }
      }
      for (const hid of hiddenIds) {
        if (state.unlockedAchievementIds && state.unlockedAchievementIds.has(hid)) hasHiddenUnlocked = true;
        else hasHiddenLocked = true;
      }
    }

    // Validate stored selections against the current unlocked/locked sets.
    const uSel = Number(state.achievementUnlockedFilterId || 0) || 0;
    const lSel = Number(state.achievementLockedFilterId || 0) || 0;

    const unlockedIds = new Set(unlocked.map((a) => a.id));
    const lockedIds = new Set(locked.map((a) => a.id));

    let changed = false;
    if (uSel !== 0) {
      const ok = (uSel === -1 && hasHiddenUnlocked) || (uSel > 0 && unlockedIds.has(uSel));
      if (!ok) {
        state.achievementUnlockedFilterId = 0;
        changed = true;
      }
    }
    if (lSel !== 0) {
      const ok = (lSel === -1 && hasHiddenLocked) || (lSel > 0 && lockedIds.has(lSel));
      if (!ok) {
        state.achievementLockedFilterId = 0;
        changed = true;
      }
    }
    if (changed) saveUiState(state);

    // Build dropdowns.
    const unlockedHtml = [
      `<option value="0">All</option>`,
      ...(hasHiddenUnlocked ? [`<option value="-1">hidden achievement</option>`] : []),
      ...unlocked.map((a) => `<option value="${a.id}">${escapeHtml(a.name || `Achievement #${a.id}`)}</option>`),
    ].join("");

    const lockedHtml = [
      `<option value="0">All</option>`,
      ...(hasHiddenLocked ? [`<option value="-1">hidden achievement</option>`] : []),
      ...locked.map((a) => `<option value="${a.id}">${escapeHtml(a.name || `Achievement #${a.id}`)}</option>`),
    ].join("");

    elAchUnlockedFilter.innerHTML = unlockedHtml;
    elAchLockedFilter.innerHTML = lockedHtml;

    elAchUnlockedFilter.value = String(Number(state.achievementUnlockedFilterId || 0) || 0);
    elAchLockedFilter.value = String(Number(state.achievementLockedFilterId || 0) || 0);

    elAchUnlockedFilter.disabled = unlocked.length === 0 && !hasHiddenUnlocked;
    elAchLockedFilter.disabled = locked.length === 0 && !hasHiddenLocked;
  }


  function renderSizeFilterSelect() {
    if (!elSizeFilter) return;

    elSizeFilter.innerHTML = SIZE_FILTER_OPTIONS
      .map((o) => `<option value="${escapeHtml(o.key)}">${escapeHtml(o.label)}</option>`)
      .join("");

    elSizeFilter.value = normalizeSizeFilterKey(state.sizeFilter);
  }

  function updateGridColumns() {
    // fixed column count (user controlled)
    elTiles.style.gridTemplateColumns = `repeat(${state.cols}, minmax(0, 1fr))`;
  }

  function renderPageInfo(total, shownStart, shownEnd) {
    const ps = pageSize();
    const colStep = state.rows;

    const lockFilterLabel = state.showUnlocked && state.showLocked
      ? "Unlocked + Locked"
      : state.showUnlocked
        ? "Unlocked"
        : "Locked";

    const { key: achKey, source: achSource } = activeAchievementFilter();
    const achLabel = achKey === -1
      ? "hidden achievement"
      : achKey !== 0
        ? achievementLabelForViewer(achKey)
        : "";
    const achInfo = achKey !== 0
      ? `• ${achSource === "unlocked" ? "Unlocked achievement" : "Locked achievement"}: ${achLabel}`
      : "";

    const sizeKey = normalizeSizeFilterKey(state.sizeFilter);
    const sizeInfo = sizeKey !== "all" ? `• Size: ${labelForSizeFilterKey(sizeKey)}` : "";

    const info = [
      `Showing ${total ? shownStart + 1 : 0}-${shownEnd} of ${total}`,
      `• Page size ${ps} (${state.cols}×${state.rows})`,
      `• Column step ${colStep}`,
      `• ${lockFilterLabel}`,
      achInfo,
      sizeInfo,
      state.search ? `• Filter: "${state.search}"` : "",
    ]
      .filter(Boolean)
      .join(" ");

    elPageInfo.textContent = info;
  }

  function renderGrid() {
    const entry = currentTypeEntry();
    const opts = filteredOptions();
    const total = opts.length;

    clampOffset(total);

    // Determine selection (user-selected > server default > first visible).
    const selectedId = selectedIdFromOptions(opts);

    const start = clamp(state.offset, 0, Math.max(0, total));
    const endExclusive = Math.min(total, start + pageSize());
    const slice = opts.slice(start, endExclusive);

    // Server default badge
    const record = getServerRecord();
    const serverVehicleId = record === null ? null : (record?.vehicleId ?? "");
    const defaultId = serverVehicleId ? serverVehicleId : "";

    // Subtitle + server status
    const entryLabel = entry?.label || state.type;
    elGridSubtitle.textContent = `${entryLabel} • ${total} vehicles`;

    if (record === undefined) elServerStatus.textContent = "Server: loading…";
    else if (record === null) elServerStatus.textContent = "Server: no saved default yet";
    else elServerStatus.textContent = "Server: loaded";

    // Page info
    renderPageInfo(total, start, endExclusive);

    // Render tiles
    elTiles.innerHTML = slice
      .map((o) => {
        const id = o.id || "";
        const isSelected = id === selectedId;
        const isDefault = id === defaultId;
        const locked = !isVehicleUnlocked(id);

        const meta = optionMeta(state.type, o);
        const sizeMeta = formatVehicleSizeShort(o);
        const defaultBadge = isDefault
          ? `<div class="vf-tileBadge vf-tileBadgeStar">★ Default</div>`
          : "";
        const lockedBadge = locked
          ? `<div class="vf-tileBadge vf-tileBadgeLock">🔒 Locked</div>`
          : "";

        const tileMeta = [...[meta, sizeMeta, locked ? lockReason(id) : ""].filter(Boolean)].join(" • ");

        return `
          <div class="vf-vehicleTile ${isSelected ? "is-selected" : ""} ${locked ? "is-locked" : ""}" data-id="${escapeHtml(id)}" ${locked ? 'data-locked="1"' : ""} role="button" tabindex="0">
            ${defaultBadge}${lockedBadge}
            <div class="vf-tileThumb">
              <img class="vf-tileImg" data-veh-type="${escapeHtml(state.type)}" data-veh-id="${escapeHtml(id)}" alt="" loading="lazy" />
            </div>
            <div class="vf-tileInfo">
              <div class="vf-tileTitle">${escapeHtml(o.displayName || id)}</div>
              ${tileMeta ? `<div class="vf-tileMeta">${escapeHtml(tileMeta)}</div>` : ""}
              <div class="vf-tileId">${escapeHtml(id)}</div>
            </div>
          </div>
        `;
      })
      .join("");

    // Apply images after DOM insertion
    elTiles.querySelectorAll("img.vf-tileImg").forEach((img) => {
      const t = img.getAttribute("data-veh-type") || "";
      const id = img.getAttribute("data-veh-id") || "";
      const label = img.closest(".vf-vehicleTile")?.querySelector(".vf-tileTitle")?.textContent || id;
      applyVehicleImage(img, { type: t, id, label, variant: "thumb" });
    });

    // Update preview
    renderPreview();
  }

  function updateActionButtons(selectedId) {
    const id = String(selectedId || "").trim();
    const isRandom = id && isRandomPlaceholderId(id);
    const unlocked = id ? isVehicleUnlocked(id) : false;
    const canSave = !!id && unlocked && !isRandom;

    btnSave.disabled = state.actionBusy || !canSave;
    btnClear.disabled = state.actionBusy;

    // Helpful hover text
    if (!id) {
      btnSave.title = "Select a vehicle first";
    } else if (isRandom) {
      btnSave.title = "Use 'Clear Default' to use the default pool";
    } else if (!unlocked) {
      btnSave.title = "Locked vehicles can't be set as your default";
    } else {
      btnSave.title = "Save this vehicle as your default";
    }
  }

  function renderPreview() {
    const entry = currentTypeEntry();
    const selId = selectedIdFromOptions(filteredOptions());
    const opt = findOption(entry, selId);

    const displayName = opt?.displayName || (selId ? selId : "(none)");
    elSelectedLabel.textContent = selId ? `Selected: ${displayName} (${selId})` : "Select a vehicle…";

    if (elSelectedSize) {
      const sizeTxt = opt ? formatVehicleSizeDetail(opt) : "";
      if (sizeTxt) {
        elSelectedSize.hidden = false;
        elSelectedSize.textContent = `Size: ${sizeTxt}`;
      } else {
        elSelectedSize.hidden = true;
        elSelectedSize.textContent = "";
      }
    }

    // Locked vehicle info (and what unlocks it)
    if (!elSelectedUnlockInfo) {
      // no-op
    } else if (!selId) {
      elSelectedUnlockInfo.hidden = true;
      elSelectedUnlockInfo.textContent = "";
    } else if (isRandomPlaceholderId(selId)) {
      elSelectedUnlockInfo.hidden = false;
      elSelectedUnlockInfo.textContent = "Default pool (Random). Use 'Clear Default' to set it.";
    } else if (!isVehicleUnlocked(selId)) {
      const rule = unlockRuleFor(selId);
      const achId = Number(rule?.achievementId || 0) || 0;
      const achLabel = achId > 0 ? achievementLabelForViewer(achId) : "No achievement assigned";
      elSelectedUnlockInfo.hidden = false;
      elSelectedUnlockInfo.textContent = `Locked • Unlocks via ${achLabel}`;
    } else {
      elSelectedUnlockInfo.hidden = true;
      elSelectedUnlockInfo.textContent = "";
    }

    applyVehicleImage(elPreviewImg, {
      type: state.type,
      id: selId,
      label: displayName,
      variant: "preview",
    });

    // Server saved label
    const record = getServerRecord();
    if (record === undefined) {
      elSavedLabel.textContent = "Loading saved default from server…";
    } else {
      const server = labelForServerRecord(state.type, record ?? null, entry);
      const when = server.updatedAt ? ` • Updated ${server.updatedAt}` : "";
      elSavedLabel.textContent = `Saved default on server: ${server.label}${when}`;
    }
    // Buttons depend on selection state
    updateActionButtons(selId);
  }

  async function ensureServerDefaultLoaded() {
    const type = state.type;

    if (state.serverDefaults[type] !== undefined) return;

    state.serverDefaults[type] = undefined;
    renderGrid();

    try {
      const resp = await api.getVehicleDefault(type, session.auth);
      state.serverDefaults[type] = resp?.value ?? null;
      setError("");
    } catch (e) {
      const msg = e?.message || "Failed to load saved default.";
      setError(msg);

      if (e?.status === 401 || e?.status === 403) {
        clearSession();
        window.location.replace(`${window.location.origin}/index.html`);
        return;
      }

      state.serverDefaults[type] = null;
    }

    renderGrid();
  }

  async function saveSelectionAsDefault() {
    const type = state.type;
    const entry = currentTypeEntry();

    const selectedId = selectedIdFromOptions(filteredOptions());
    if (!selectedId) {
      toast("No vehicle selected.");
      return;
    }

    if (isRandomPlaceholderId(selectedId)) {
      toast("Use 'Clear Default' to use the default pool (Random).");
      return;
    }

    if (!isVehicleUnlocked(selectedId)) {
      toast(`${lockReason(selectedId)}. You can't set a locked vehicle as your default.`);
      return;
    }

    // Server API convention: vehicleId is a non-empty string when setting a default.
    // (Empty string is reserved for 'cleared')
    const vehicleId = String(selectedId || "").trim();

    state.actionBusy = true;
    updateActionButtons(selectedId);

    try {
      const resp = await api.putVehicleDefault(type, vehicleId, session.auth);

      state.serverDefaults[type] = resp?.value ?? null;
      state.selectedId = selectedId;

      const serverLabel = labelForServerRecord(type, state.serverDefaults[type], entry);
      toast(`Saved: ${serverLabel.label}`);
      setError("");

      renderGrid();
    } catch (e) {
      const msg = e?.message || "Failed to save default.";
      setError(msg);

      if (e?.status === 401 || e?.status === 403) {
        clearSession();
        window.location.replace(`${window.location.origin}/index.html`);
      }
    } finally {
      state.actionBusy = false;
      updateActionButtons(selectedIdFromOptions(filteredOptions()));
    }
  }

  async function clearServerDefault() {
    const type = state.type;
    const entry = currentTypeEntry();

    state.actionBusy = true;
    updateActionButtons(selectedIdFromOptions(filteredOptions()));

    try {
      // Empty string in the API represents "cleared" (no per-user override).
      const resp = await api.putVehicleDefault(type, "", session.auth);
      state.serverDefaults[type] = resp?.value ?? null;

      const serverLabel = labelForServerRecord(type, state.serverDefaults[type], entry);
      toast(`Saved: ${serverLabel.label}`);
      setError("");

      renderGrid();
    } catch (e) {
      const msg = e?.message || "Failed to clear default.";
      setError(msg);

      if (e?.status === 401 || e?.status === 403) {
        clearSession();
        window.location.replace(`${window.location.origin}/index.html`);
      }
    } finally {
      state.actionBusy = false;
      updateActionButtons(selectedIdFromOptions(filteredOptions()));
    }
  }

  // -------- Events --------

  function onChipClick(ev) {
    const btn = ev.target.closest("button[data-type]");
    if (!btn) return;

    const type = btn.getAttribute("data-type");
    if (!type) return;

    state.type = type;
    state.selectedId = null;
    state.offset = 0;

    saveUiState(state);
    setError("");

    renderTypeChips();
    renderAchievementFilterSelect();
    renderSizeFilterSelect();
    renderGrid();
    ensureServerDefaultLoaded();
  }

  function onLockToggleChange(ev) {
    state.showUnlocked = !!elShowUnlocked?.checked;
    state.showLocked = !!elShowLocked?.checked;

    // Prevent "show nothing" state (auto-revert the toggle that was just turned off).
    if (!state.showUnlocked && !state.showLocked) {
      if (ev?.target === elShowUnlocked) {
        state.showUnlocked = true;
        if (elShowUnlocked) elShowUnlocked.checked = true;
      } else if (ev?.target === elShowLocked) {
        state.showLocked = true;
        if (elShowLocked) elShowLocked.checked = true;
      } else {
        state.showUnlocked = true;
        if (elShowUnlocked) elShowUnlocked.checked = true;
      }
    }

    state.offset = 0;
    saveUiState(state);
    renderGrid();
  }

  function onAchievementUnlockedFilterChange() {
    const id = Number(elAchUnlockedFilter?.value || 0) || 0;
    state.achievementUnlockedFilterId = id;
    if (id !== 0) {
      state.achievementLockedFilterId = 0;
      if (elAchLockedFilter) elAchLockedFilter.value = "0";
      // If they're filtering by an unlocked achievement, ensure unlocked is visible.
      if (!state.showUnlocked) {
        state.showUnlocked = true;
        if (elShowUnlocked) elShowUnlocked.checked = true;
      }
    }

    state.offset = 0;
    saveUiState(state);
    renderGrid();
  }

  function onAchievementLockedFilterChange() {
    const id = Number(elAchLockedFilter?.value || 0) || 0;
    state.achievementLockedFilterId = id;
    if (id !== 0) {
      state.achievementUnlockedFilterId = 0;
      if (elAchUnlockedFilter) elAchUnlockedFilter.value = "0";

      // If the user is filtering by a locked achievement, they almost always want
      // to see the locked vehicles that it will unlock.
      if (!state.showLocked) {
        state.showLocked = true;
        if (elShowLocked) elShowLocked.checked = true;
      }
    }

    state.offset = 0;
    saveUiState(state);
    renderGrid();
  }

  function onSizeFilterChange() {
    state.sizeFilter = normalizeSizeFilterKey(elSizeFilter?.value || "all");
    state.offset = 0;
    saveUiState(state);
    renderGrid();
  }

  function onSearchInput() {
    state.search = elSearch.value || "";
    state.offset = 0;
    saveUiState(state);
    renderGrid();
  }

  function onColsRowsChange() {
    state.cols = clamp(Number(elCols.value || 4), 1, 8);
    state.rows = clamp(Number(elRows.value || 3), 1, 8);
    elCols.value = String(state.cols);
    elRows.value = String(state.rows);

    state.offset = 0;
    saveUiState(state);

    updateGridColumns();
    renderGrid();
  }

  function stepOffset(delta) {
    const opts = filteredOptions();
    const total = opts.length;
    if (!total) return;

    const maxStart = Math.max(0, total - 1);
    state.offset = clamp(state.offset + delta, 0, maxStart);
    renderGrid();
  }

  function onTileActivate(tile) {
    const id = tile.getAttribute("data-id");
    if (!id) return;

    state.selectedId = id;
    renderGrid();
  }

  function onTilesClick(ev) {
    const tile = ev.target.closest(".vf-vehicleTile");
    if (!tile) return;
    onTileActivate(tile);
  }

  function onTilesKeydown(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const tile = ev.target.closest(".vf-vehicleTile");
    if (!tile) return;
    ev.preventDefault();
    onTileActivate(tile);
  }

  // Wire events
  elChips.addEventListener("click", onChipClick);
  elShowUnlocked?.addEventListener("change", onLockToggleChange);
  elShowLocked?.addEventListener("change", onLockToggleChange);
  elAchUnlockedFilter?.addEventListener("change", onAchievementUnlockedFilterChange);
  elAchLockedFilter?.addEventListener("change", onAchievementLockedFilterChange);
  elSizeFilter?.addEventListener("change", onSizeFilterChange);
  elSearch.addEventListener("input", onSearchInput);
  elCols.addEventListener("change", onColsRowsChange);
  elRows.addEventListener("change", onColsRowsChange);

  elTiles.addEventListener("click", onTilesClick);
  elTiles.addEventListener("keydown", onTilesKeydown);

  btnPageUp.addEventListener("click", () => stepOffset(-pageSize()));
  btnPageDown.addEventListener("click", () => stepOffset(+pageSize()));
  btnPrevCol.addEventListener("click", () => stepOffset(-Math.max(1, state.rows)));
  btnNextCol.addEventListener("click", () => stepOffset(+Math.max(1, state.rows)));

  // Keyboard PageUp/PageDown support on the whole document
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "PageUp") {
      ev.preventDefault();
      stepOffset(-pageSize());
    } else if (ev.key === "PageDown") {
      ev.preventDefault();
      stepOffset(+pageSize());
    }
  });

  btnSave.addEventListener("click", () => saveSelectionAsDefault());
  btnClear.addEventListener("click", () => clearServerDefault());

  // Initial render
  renderTypeChips();
  renderLockFilterChips();
  renderAchievementFilterSelect();
  renderSizeFilterSelect();
  updateGridColumns();
  renderGrid();
  ensureServerDefaultLoaded();
}

init().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
});
