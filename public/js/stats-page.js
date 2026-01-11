import { requireSession } from "./session.js";
import * as api from "./api.js";
import { toast } from "./ui.js";

// Per-user column preferences live in localStorage.
// Versioned so we can migrate/ignore old formats safely later.
const COL_PREFS_VERSION = 1;

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

function formatNumber(n, digits = 2) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  const isInt = Math.abs(num - Math.round(num)) < 1e-9;
  if (isInt) return String(Math.round(num));
  return num.toFixed(digits);
}

function formatTimeMs(ms) {
  if (ms === null || ms === undefined) return "—";
  const n = Number(ms);
  if (!Number.isFinite(n)) return "—";
  if (n < 0) return "—";

  const totalMs = Math.round(n);
  const totalSeconds = Math.floor(totalMs / 1000);
  const milli = totalMs % 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  const pad2 = (x) => String(x).padStart(2, "0");
  const pad3 = (x) => String(x).padStart(3, "0");

  if (hours > 0) {
    return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad3(milli)}`;
  }
  return `${minutes}:${pad2(seconds)}.${pad3(milli)}`;
}

function toOption(label, value) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function normalizeId(s) {
  return String(s || "").trim();
}

function getColumnPrefsKey(userId) {
  const id = String(userId || "").trim() || "anonymous";
  return `vf_stats_cols_v${COL_PREFS_VERSION}:${id}`;
}

function loadColumnPrefs(userId, allKeys) {
  try {
    const raw = localStorage.getItem(getColumnPrefsKey(userId));
    if (!raw) return null;
    const data = JSON.parse(raw);
    const visible = Array.isArray(data?.visible) ? data.visible : null;
    if (!visible) return null;

    const allow = new Set(allKeys);
    const cleaned = visible.map((k) => String(k || "").trim()).filter((k) => allow.has(k));

    // Always keep viewer column.
    if (!cleaned.includes("viewer")) cleaned.unshift("viewer");
    return Array.from(new Set(cleaned));
  } catch {
    return null;
  }
}

function saveColumnPrefs(userId, visibleKeys) {
  try {
    const payload = {
      v: COL_PREFS_VERSION,
      visible: Array.from(new Set(visibleKeys || [])).map((k) => String(k || "").trim()),
      updatedAtMs: Date.now(),
    };
    localStorage.setItem(getColumnPrefsKey(userId), JSON.stringify(payload));
  } catch {
    // ignore (private mode / storage disabled)
  }
}

let _loadTimer = null;

async function fetchActiveSeasonId() {
  try {
    const res = await fetch("/api/v1/seasons/active", { headers: { Accept: "application/json" } });
    if (!res.ok) return "";
    const data = await res.json();
    return String(data?.season?.seasonId || "").trim();
  } catch {
    return "";
  }
}

function buildQuery(state) {
  const q = {
    seasonId: state.seasonId || "ALL",
    streamerId: state.streamerId || "ALL",
    mapId: state.mapId || "ALL",
    streamerSearch: state.streamerSearch || "",
    viewerSearch: state.viewerSearch || "",
    mapSearch: state.mapSearch || "",
    sortBy: state.sortBy || "wins",
    sortDir: state.sortDir || "desc",
    page: state.page,
    pageSize: state.pageSize,
  };
  return q;
}

// Column definitions
// - headerTop/headerBottom render as a 2-line header (compact but readable)
// - group is used for the optional grouped header row
const COLUMN_DEFS = [
  { key: "viewer", group: "Viewer", headerTop: "Viewer", title: "Viewer" , always: true },

  { key: "competitions", group: "Counts", headerTop: "#", headerBottom: "Races", title: "Number of competitions" },
  { key: "wins", group: "Counts", headerTop: "#1", headerBottom: "Wins", title: "Wins / 1st place" },
  { key: "seconds", group: "Counts", headerTop: "#2", headerBottom: "2nd", title: "2nd place finishes" },
  { key: "thirds", group: "Counts", headerTop: "#3", headerBottom: "3rd", title: "3rd place finishes" },
  { key: "finishedCount", group: "Counts", headerTop: "Fin", headerBottom: "#", title: "Finished count" },
  { key: "dnfCount", group: "Counts", headerTop: "DNF", headerBottom: "#", title: "DNF count" },

  { key: "bestFinishPos", group: "Finish position", headerTop: "Best", headerBottom: "Pos", title: "Best finish position" },
  { key: "avgFinishPos", group: "Finish position", headerTop: "Avg", headerBottom: "Pos", title: "Average finish position" },
  { key: "medianFinishPos", group: "Finish position", headerTop: "Med", headerBottom: "Pos", title: "Median finish position" },
  { key: "p10FinishPos", group: "Finish position", headerTop: "P10", headerBottom: "Pos", title: "10th percentile finish position" },
  { key: "p25FinishPos", group: "Finish position", headerTop: "P25", headerBottom: "Pos", title: "25th percentile finish position" },
  { key: "p75FinishPos", group: "Finish position", headerTop: "P75", headerBottom: "Pos", title: "75th percentile finish position" },
  { key: "p90FinishPos", group: "Finish position", headerTop: "P90", headerBottom: "Pos", title: "90th percentile finish position" },
  { key: "worstFinishPos", group: "Finish position", headerTop: "Worst", headerBottom: "Pos", title: "Worst finish position" },

  { key: "bestTimeMs", group: "Finish time", headerTop: "Best", headerBottom: "Time", title: "Best finish time" },
  { key: "avgTimeMs", group: "Finish time", headerTop: "Avg", headerBottom: "Time", title: "Average finish time" },
  { key: "medianTimeMs", group: "Finish time", headerTop: "Med", headerBottom: "Time", title: "Median finish time" },
  { key: "p10TimeMs", group: "Finish time", headerTop: "P10", headerBottom: "Time", title: "10th percentile finish time" },
  { key: "p25TimeMs", group: "Finish time", headerTop: "P25", headerBottom: "Time", title: "25th percentile finish time" },
  { key: "p75TimeMs", group: "Finish time", headerTop: "P75", headerBottom: "Time", title: "75th percentile finish time" },
  { key: "p90TimeMs", group: "Finish time", headerTop: "P90", headerBottom: "Time", title: "90th percentile finish time" },
  { key: "worstTimeMs", group: "Finish time", headerTop: "Worst", headerBottom: "Time", title: "Worst finish time" },
];

const ALL_COLUMN_KEYS = COLUMN_DEFS.map((c) => c.key);

// Make the default view much cleaner (users can enable more columns from the Columns popup).
const DEFAULT_VISIBLE_KEYS = [
  "viewer",
  "competitions",
  "wins",
  "seconds",
  "thirds",
  "finishedCount",
  "dnfCount",
  "bestFinishPos",
  "avgFinishPos",
  "medianFinishPos",
  "worstFinishPos",
  "bestTimeMs",
  "avgTimeMs",
  "medianTimeMs",
  "worstTimeMs",
];

function colLabelForModal(c) {
  if (c.key === "viewer") return "Viewer";
  const top = c.headerTop || c.key;
  const bottom = c.headerBottom ? ` ${c.headerBottom}` : "";
  return `${top}${bottom}`.trim();
}

function getVisibleColumns(state) {
  const visible = new Set(state.visibleKeys || []);
  // Always keep viewer.
  visible.add("viewer");
  return COLUMN_DEFS.filter((c) => c.always || visible.has(c.key));
}

function ensureSortKeyVisible(state) {
  const visible = new Set(getVisibleColumns(state).map((c) => c.key));
  if (!visible.has(state.sortBy)) {
    state.sortBy = "wins";
    state.sortDir = "desc";
  }
}

function groupColumnsForModal(cols) {
  const groups = new Map();
  for (const c of cols) {
    const g = c.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  // Keep a stable order based on appearance in COLUMN_DEFS.
  return Array.from(groups.entries()).map(([group, columns]) => ({ group, columns }));
}

function renderHeader(state, cols) {
  // Group row (optional): only show if 2+ groups are visible.
  const groups = [];
  for (const c of cols) {
    const g = c.group || "";
    const last = groups.length ? groups[groups.length - 1] : null;
    if (last && last.group === g) last.colspan += 1;
    else groups.push({ group: g, colspan: 1 });
  }

  const showGroupRow = groups.filter((g) => g.group).length >= 2;
  const groupRow = !showGroupRow
    ? ""
    : `
      <tr class="vf-thGroupRow">
        ${groups
          .map((g) => `<th colspan="${g.colspan}" class="vf-thGroup">${escapeHtml(g.group || "")}</th>`)
          .join("")}
      </tr>
    `;

  const colRow = `
    <tr>
      ${cols
        .map((c) => {
          const isActive = state.sortBy === c.key;
          const icon = !isActive ? "" : state.sortDir === "asc" ? " ▲" : " ▼";
          const sticky = c.key === "viewer" ? " vf-stickyCol" : "";

          const top = c.headerTop || c.key;
          const bottom = c.headerBottom || "";
          const twoLine = bottom
            ? `<div class="vf-thTop">${escapeHtml(top)}</div><div class="vf-thBottom">${escapeHtml(bottom)}</div>`
            : `<div class="vf-thTop">${escapeHtml(top)}</div>`;

          return `<th class="vf-th${sticky}" data-sort="${escapeHtml(c.key)}" title="${escapeHtml(c.title || top)}">${twoLine}<span class="vf-sortIcon">${escapeHtml(icon)}</span></th>`;
        })
        .join("")}
    </tr>
  `;

  return `${groupRow}${colRow}`;
}

function renderRow(item, cols) {
  const login = item?.viewerLogin || "";
  const display = item?.viewerDisplayName || login || item?.viewerUserId || "Viewer";
  const twitchUrl = login ? `https://twitch.tv/${encodeURIComponent(login)}` : "";

  const avatarUrl = item?.viewerProfileImageUrl || "";
  const avatarImg = avatarUrl
    ? `<img class="vf-avatar" src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" />`
    : `<div class="vf-avatar vf-avatarPlaceholder" aria-hidden="true">👤</div>`;

  const showLogin = login && String(display).toLowerCase() !== String(login).toLowerCase();
  const viewerInner = `
    <div class="vf-viewerCell">
      ${avatarImg}
      <div class="vf-viewerText">
        <div class="vf-viewerName">${escapeHtml(display)}</div>
        ${showLogin ? `<div class="vf-viewerSub">@${escapeHtml(login)}</div>` : ""}
      </div>
    </div>
  `;

  const viewerCell = twitchUrl
    ? `<a class="vf-link" href="${twitchUrl}" target="_blank" rel="noopener">${viewerInner}</a>`
    : viewerInner;

  const num = (k, digits = 2) => formatNumber(item?.[k], digits);
  const time = (k) => formatTimeMs(item?.[k]);

  const cells = {
    viewer: viewerCell,
    competitions: num("competitions", 0),
    wins: num("wins", 0),
    seconds: num("seconds", 0),
    thirds: num("thirds", 0),
    bestFinishPos: num("bestFinishPos", 0),
    worstFinishPos: num("worstFinishPos", 0),
    avgFinishPos: num("avgFinishPos", 2),
    medianFinishPos: num("medianFinishPos", 0),
    p10FinishPos: num("p10FinishPos", 0),
    p25FinishPos: num("p25FinishPos", 0),
    p75FinishPos: num("p75FinishPos", 0),
    p90FinishPos: num("p90FinishPos", 0),
    finishedCount: num("finishedCount", 0),
    dnfCount: num("dnfCount", 0),
    bestTimeMs: time("bestTimeMs"),
    worstTimeMs: time("worstTimeMs"),
    avgTimeMs: time("avgTimeMs"),
    medianTimeMs: time("medianTimeMs"),
    p10TimeMs: time("p10TimeMs"),
    p25TimeMs: time("p25TimeMs"),
    p75TimeMs: time("p75TimeMs"),
    p90TimeMs: time("p90TimeMs"),
  };

  return `
    <tr>
      ${cols
        .map((c) => {
          const v = cells[c.key] ?? "—";
          const sticky = c.key === "viewer" ? " vf-stickyCol" : "";
          const cls = c.key === "viewer" ? `vf-tdViewer${sticky}` : `vf-tdNum${sticky}`;
          return `<td class="${cls}">${v}</td>`;
        })
        .join("")}
    </tr>
  `;
}

function renderPager(state, data, containerEl, onNavigate) {
  if (!containerEl) return;
  const totalPages = data?.totalPages || 1;
  const page = data?.page || 1;

  const disabledFirstPrev = page <= 1;
  const disabledNextLast = page >= totalPages;

  containerEl.innerHTML = `
    <div class="vf-pager">
      <button class="vf-btn vf-btnSecondary vf-btnTiny" data-act="first" ${disabledFirstPrev ? "disabled" : ""}>⏮ First</button>
      <button class="vf-btn vf-btnSecondary vf-btnTiny" data-act="prev" ${disabledFirstPrev ? "disabled" : ""}>◀ Prev</button>

      <div class="vf-small vf-muted" style="align-self:center; padding: 0 6px;">
        Page <span class="vf-code">${page}</span> of <span class="vf-code">${totalPages}</span>
      </div>

      <button class="vf-btn vf-btnSecondary vf-btnTiny" data-act="next" ${disabledNextLast ? "disabled" : ""}>Next ▶</button>
      <button class="vf-btn vf-btnSecondary vf-btnTiny" data-act="last" ${disabledNextLast ? "disabled" : ""}>Last ⏭</button>

      <label class="vf-field" style="margin-left: 8px;">
        <span class="vf-fieldLabel">Jump</span>
        <input class="vf-input vf-inputSmall" data-act="jumpInput" type="number" min="1" step="1" value="${page}" />
      </label>
      <button class="vf-btn vf-btnSecondary vf-btnTiny" data-act="jumpBtn">Go</button>
    </div>
  `;

  const btn = (act) => containerEl.querySelector(`[data-act="${act}"]`);
  btn("first")?.addEventListener("click", () => onNavigate(1));
  btn("prev")?.addEventListener("click", () => onNavigate(page - 1));
  btn("next")?.addEventListener("click", () => onNavigate(page + 1));
  btn("last")?.addEventListener("click", () => onNavigate(totalPages));

  const jumpInput = btn("jumpInput");
  const doJump = () => {
    const wanted = clamp(Number(jumpInput?.value || page), 1, totalPages);
    onNavigate(wanted);
  };
  btn("jumpBtn")?.addEventListener("click", doJump);
  jumpInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doJump();
  });
}

function wireSortHandlers(state, tableEl, onChange) {
  tableEl?.querySelectorAll("thead th[data-sort]")?.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-sort") || "";
      if (!key) return;
      if (state.sortBy === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortBy = key;
        // Most columns default to descending, but viewer name defaults asc
        state.sortDir = key === "viewer" ? "asc" : "desc";
      }
      state.page = 1;
      onChange();
    });
  });
}

function debounceLoad(fn, ms = 350) {
  if (_loadTimer) window.clearTimeout(_loadTimer);
  _loadTimer = window.setTimeout(fn, ms);
}

async function init() {
  const root = document.getElementById("vf-statsRoot");
  if (!root) return;

  // Keep consistent with the rest of the site (requires login).
  const session = await requireSession();
  if (!session) return;

  // Column preferences
  const userId = session?.me?.userId || "";
  const savedCols = loadColumnPrefs(userId, ALL_COLUMN_KEYS);
  const initialVisible = savedCols || DEFAULT_VISIBLE_KEYS;

  const state = {
    seasonId: "",
    streamerId: "ALL",
    mapId: "ALL",
    streamerSearch: "",
    viewerSearch: "",
    mapSearch: "",
    sortBy: "wins",
    sortDir: "desc",
    page: 1,
    pageSize: 25,
    userId,
    visibleKeys: initialVisible,
    meta: {
      seasons: [],
      streamers: [],
      maps: [],
      activeSeasonId: "",
    },
    lastData: null,
    loading: false,
  };

  // Ensure we don't start sorted by a hidden column.
  ensureSortKeyVisible(state);

  root.innerHTML = `
    <div class="vf-card">
      <div class="vf-row">
        <div>
          <div class="vf-h2">Leaderboard filters</div>
          <div class="vf-muted vf-small">Default: current season, sorted by # of wins (1st place). Use <span class="vf-code">Columns</span> to show/hide stats.</div>
        </div>
        <div class="vf-spacer"></div>
        <button id="vf-colsBtn" class="vf-btn vf-btnSecondary" type="button">Columns</button>
        <button id="vf-refreshBtn" class="vf-btn vf-btnSecondary" type="button">Refresh</button>
      </div>

      <div class="vf-controlsGrid" style="margin-top: 12px">
        <label class="vf-field">
          <span class="vf-fieldLabel">Season</span>
          <select id="vf-season" class="vf-input vf-inputSmall"></select>
        </label>

        <label class="vf-field">
          <span class="vf-fieldLabel">Streamer</span>
          <select id="vf-streamer" class="vf-input" style="max-width: 280px"></select>
        </label>

        <label class="vf-field">
          <span class="vf-fieldLabel">Map</span>
          <select id="vf-map" class="vf-input" style="max-width: 320px"></select>
        </label>

        <label class="vf-field">
          <span class="vf-fieldLabel">Search viewer</span>
          <input id="vf-viewerSearch" class="vf-input" placeholder="viewer login / display name" />
        </label>

        <label class="vf-field">
          <span class="vf-fieldLabel">Search streamer</span>
          <input id="vf-streamerSearch" class="vf-input" placeholder="streamer login / display name" />
        </label>

        <label class="vf-field">
          <span class="vf-fieldLabel">Search map</span>
          <input id="vf-mapSearch" class="vf-input" placeholder="track id / name" />
        </label>

        <label class="vf-field">
          <span class="vf-fieldLabel">Items / page</span>
          <select id="vf-pageSize" class="vf-input vf-inputSmall">
            <option value="10">10</option>
            <option value="25" selected>25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
        </label>
      </div>
    </div>

    <div class="vf-card" style="margin-top: 12px">
      <div class="vf-row">
        <div id="vf-summary" class="vf-muted vf-small">Loading…</div>
        <div class="vf-spacer"></div>
        <div id="vf-pagerTop"></div>
      </div>

      <div class="vf-tableWrap vf-tableWrapTall" style="margin-top: 12px">
        <table class="vf-table vf-tableStriped vf-tableSticky" id="vf-table">
          <thead id="vf-thead"></thead>
          <tbody id="vf-tbody"></tbody>
        </table>
      </div>

      <div class="vf-row" style="margin-top: 12px">
        <div class="vf-spacer"></div>
        <div id="vf-pagerBottom"></div>
      </div>
    </div>

    <div id="vf-colsBackdrop" class="vf-modalBackdrop" hidden></div>
    <div id="vf-colsModal" class="vf-modal" hidden role="dialog" aria-modal="true" aria-labelledby="vf-colsTitle">
      <div class="vf-row">
        <div>
          <div id="vf-colsTitle" class="vf-h2">Columns</div>
          <div class="vf-muted vf-small">Choose which columns to display. Saved per user.</div>
        </div>
        <div class="vf-spacer"></div>
        <button id="vf-colsCloseX" class="vf-iconBtn" type="button" aria-label="Close" title="Close">✕</button>
      </div>

      <div class="vf-row" style="margin-top: 10px; flex-wrap: wrap; gap: 8px;">
        <button id="vf-colsAll" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Show all</button>
        <button id="vf-colsDefault" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Default view</button>
        <div class="vf-spacer"></div>
        <button id="vf-colsDone" class="vf-btn vf-btnPrimary" type="button">Done</button>
      </div>

      <div id="vf-colsBody" class="vf-colsBody" style="margin-top: 12px"></div>
    </div>
  `;

  const seasonSel = document.getElementById("vf-season");
  const streamerSel = document.getElementById("vf-streamer");
  const mapSel = document.getElementById("vf-map");
  const viewerSearchEl = document.getElementById("vf-viewerSearch");
  const streamerSearchEl = document.getElementById("vf-streamerSearch");
  const mapSearchEl = document.getElementById("vf-mapSearch");
  const pageSizeEl = document.getElementById("vf-pageSize");

  const summaryEl = document.getElementById("vf-summary");
  const theadEl = document.getElementById("vf-thead");
  const tbodyEl = document.getElementById("vf-tbody");
  const tableEl = document.getElementById("vf-table");
  const pagerTop = document.getElementById("vf-pagerTop");
  const pagerBottom = document.getElementById("vf-pagerBottom");

  // Columns modal elements
  const colsBtn = document.getElementById("vf-colsBtn");
  const colsBackdrop = document.getElementById("vf-colsBackdrop");
  const colsModal = document.getElementById("vf-colsModal");
  const colsBody = document.getElementById("vf-colsBody");

  async function refreshMeta() {
    const [activeSeasonId, seasonsResp, metaResp] = await Promise.all([
      fetchActiveSeasonId(),
      api.getSeasons().catch(() => null),
      api.getStatsMeta().catch(() => null),
    ]);

    state.meta.activeSeasonId = activeSeasonId || "";
    state.meta.seasons = Array.isArray(seasonsResp?.seasons) ? seasonsResp.seasons : [];
    state.meta.streamers = Array.isArray(metaResp?.streamers) ? metaResp.streamers : [];
    state.meta.maps = Array.isArray(metaResp?.maps) ? metaResp.maps : [];

    // Default season = current season if available.
    if (!state.seasonId) {
      state.seasonId = state.meta.activeSeasonId || "ALL";
    }

    // Seasons dropdown
    if (seasonSel) {
      seasonSel.innerHTML = [
        toOption("All seasons", "ALL"),
        ...state.meta.seasons.map((s) => {
          const id = normalizeId(s?.seasonId);
          const name = normalizeId(s?.name) || id || "Season";
          return toOption(name ? `${name} (${id})` : id, id);
        }),
      ].join("");
      seasonSel.value = state.seasonId;
    }

    // Streamers dropdown
    if (streamerSel) {
      const sorted = [...state.meta.streamers].sort((a, b) => {
        const la = String(a?.displayName || a?.login || "").toLowerCase();
        const lb = String(b?.displayName || b?.login || "").toLowerCase();
        return la.localeCompare(lb);
      });
      streamerSel.innerHTML = [
        toOption("All streamers", "ALL"),
        ...sorted.map((s) => {
          const id = normalizeId(s?.userId);
          const label = normalizeId(s?.displayName) || normalizeId(s?.login) || id;
          return toOption(label, id);
        }),
      ].join("");
      streamerSel.value = state.streamerId;
    }

    // Maps dropdown
    if (mapSel) {
      const sorted = [...state.meta.maps].sort((a, b) => {
        const la = String(a?.trackName || a?.trackId || "").toLowerCase();
        const lb = String(b?.trackName || b?.trackId || "").toLowerCase();
        return la.localeCompare(lb);
      });
      mapSel.innerHTML = [
        toOption("All maps", "ALL"),
        ...sorted.map((m) => {
          const id = normalizeId(m?.trackId);
          const name = normalizeId(m?.trackName) || id;
          const label = id && name && name !== id ? `${name} (${id})` : (name || id);
          return toOption(label, id);
        }),
      ].join("");
      mapSel.value = state.mapId;
    }
  }

  function renderColumnsModal() {
    if (!colsBody) return;

    const visible = new Set(state.visibleKeys || []);
    visible.add("viewer");

    const grouped = groupColumnsForModal(COLUMN_DEFS);
    colsBody.innerHTML = grouped
      .map(({ group, columns }) => {
        const rows = columns
          .map((c) => {
            const checked = visible.has(c.key) || c.always;
            const disabled = !!c.always;
            return `
              <label class="vf-checkRow" title="${escapeHtml(c.title || "")}">
                <input type="checkbox" data-colkey="${escapeHtml(c.key)}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} />
                <span class="vf-checkLabel">${escapeHtml(colLabelForModal(c))}</span>
                <span class="vf-spacer"></span>
                <span class="vf-muted vf-small">${escapeHtml(c.key)}</span>
              </label>
            `;
          })
          .join("");

        return `
          <div class="vf-colsGroup">
            <div class="vf-colsGroupTitle">${escapeHtml(group)}</div>
            <div class="vf-colsGrid">${rows}</div>
          </div>
        `;
      })
      .join("");

    colsBody.querySelectorAll("input[data-colkey]")?.forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.getAttribute("data-colkey") || "";
        if (!key) return;

        const set = new Set(state.visibleKeys || []);
        if (input.checked) set.add(key);
        else set.delete(key);

        // Always keep viewer.
        set.add("viewer");
        state.visibleKeys = Array.from(set);
        saveColumnPrefs(state.userId, state.visibleKeys);
        ensureSortKeyVisible(state);

        // Re-render without refetching.
        if (state.lastData) {
          renderTable(state.lastData);
        } else {
          loadLeaderboard();
        }
      });
    });
  }

  function openColsModal() {
    if (!colsBackdrop || !colsModal) return;
    renderColumnsModal();
    colsBackdrop.hidden = false;
    colsModal.hidden = false;
    // Focus the modal for accessibility.
    colsModal.focus?.();
  }

  function closeColsModal() {
    if (!colsBackdrop || !colsModal) return;
    colsBackdrop.hidden = true;
    colsModal.hidden = true;
  }

  colsBtn?.addEventListener("click", openColsModal);
  colsBackdrop?.addEventListener("click", closeColsModal);
  document.getElementById("vf-colsDone")?.addEventListener("click", closeColsModal);
  document.getElementById("vf-colsCloseX")?.addEventListener("click", closeColsModal);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && colsModal && !colsModal.hidden) closeColsModal();
  });

  document.getElementById("vf-colsAll")?.addEventListener("click", () => {
    state.visibleKeys = [...ALL_COLUMN_KEYS];
    saveColumnPrefs(state.userId, state.visibleKeys);
    ensureSortKeyVisible(state);
    renderColumnsModal();
    if (state.lastData) renderTable(state.lastData);
  });

  document.getElementById("vf-colsDefault")?.addEventListener("click", () => {
    state.visibleKeys = [...DEFAULT_VISIBLE_KEYS];
    saveColumnPrefs(state.userId, state.visibleKeys);
    ensureSortKeyVisible(state);
    renderColumnsModal();
    if (state.lastData) renderTable(state.lastData);
  });

  function sortLabel() {
    const col = COLUMN_DEFS.find((c) => c.key === state.sortBy);
    return col ? colLabelForModal(col) : state.sortBy;
  }

  function renderTable(resp) {
    const cols = getVisibleColumns(state);
    const items = Array.isArray(resp?.items) ? resp.items : [];

    if (theadEl) theadEl.innerHTML = renderHeader(state, cols);
    if (tbodyEl) {
      tbodyEl.innerHTML = items.length
        ? items.map((it) => renderRow(it, cols)).join("")
        : `<tr><td colspan="${cols.length}" class="vf-muted" style="padding: 14px">No results found.</td></tr>`;
    }

    wireSortHandlers(state, tableEl, () => debounceLoad(loadLeaderboard, 10));

    const total = resp?.totalItems || 0;
    const page = resp?.page || 1;
    const pages = resp?.totalPages || 1;
    if (summaryEl) {
      summaryEl.textContent = `Showing ${items.length} of ${total} viewers • Page ${page}/${pages} • Sorted by ${sortLabel()} (${state.sortDir})`;
    }

    renderPager(state, resp, pagerTop, (p) => {
      state.page = p;
      loadLeaderboard();
    });

    renderPager(state, resp, pagerBottom, (p) => {
      state.page = p;
      loadLeaderboard();
    });
  }

  async function loadLeaderboard() {
    if (state.loading) return;
    state.loading = true;
    if (summaryEl) summaryEl.textContent = "Loading…";

    try {
      ensureSortKeyVisible(state);
      const q = buildQuery(state);
      const resp = await api.getLeaderboard(q);
      state.lastData = resp;

      renderTable(resp);
    } catch (e) {
      console.error(e);
      if (summaryEl) summaryEl.textContent = "Failed to load leaderboard.";
      if (tbodyEl) {
        const cols = getVisibleColumns(state);
        tbodyEl.innerHTML = `<tr><td colspan="${cols.length}" class="vf-alert vf-alertError">${escapeHtml(e?.message || "Error")}</td></tr>`;
      }
      toast("Failed to load stats");
    } finally {
      state.loading = false;
    }
  }

  function scheduleReload(resetPage = false) {
    if (resetPage) state.page = 1;
    debounceLoad(loadLeaderboard, 350);
  }

  // Wire controls
  document.getElementById("vf-refreshBtn")?.addEventListener("click", async () => {
    await refreshMeta();
    state.page = 1;
    loadLeaderboard();
  });

  seasonSel?.addEventListener("change", () => {
    state.seasonId = seasonSel.value || "ALL";
    scheduleReload(true);
  });

  streamerSel?.addEventListener("change", () => {
    state.streamerId = streamerSel.value || "ALL";
    scheduleReload(true);
  });

  mapSel?.addEventListener("change", () => {
    state.mapId = mapSel.value || "ALL";
    scheduleReload(true);
  });

  viewerSearchEl?.addEventListener("input", () => {
    state.viewerSearch = viewerSearchEl.value || "";
    scheduleReload(true);
  });

  streamerSearchEl?.addEventListener("input", () => {
    state.streamerSearch = streamerSearchEl.value || "";
    scheduleReload(true);
  });

  mapSearchEl?.addEventListener("input", () => {
    state.mapSearch = mapSearchEl.value || "";
    scheduleReload(true);
  });

  pageSizeEl?.addEventListener("change", () => {
    state.pageSize = clamp(Number(pageSizeEl.value || 25), 5, 200);
    state.page = 1;
    loadLeaderboard();
  });

  // Initial load
  await refreshMeta();
  await loadLeaderboard();
}

init();
