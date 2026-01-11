import { requireSession } from "./session.js";
import * as api from "./api.js";
import { toast } from "./ui.js";

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

const COLUMNS = [
  { key: "viewer", label: "Viewer", title: "Viewer", type: "text" },
  { key: "competitions", label: "#Comp", title: "Number of competitions" },
  { key: "wins", label: "#1", title: "Wins / 1st place" },
  { key: "seconds", label: "#2", title: "2nd place" },
  { key: "thirds", label: "#3", title: "3rd place" },
  { key: "bestFinishPos", label: "BestPos", title: "Best finish position" },
  { key: "worstFinishPos", label: "WorstPos", title: "Worst finish position" },
  { key: "avgFinishPos", label: "AvgPos", title: "Average finish position" },
  { key: "medianFinishPos", label: "MedPos", title: "Median finish position" },
  { key: "p10FinishPos", label: "P10Pos", title: "10th percentile finish position" },
  { key: "p25FinishPos", label: "P25Pos", title: "25th percentile finish position" },
  { key: "p75FinishPos", label: "P75Pos", title: "75th percentile finish position" },
  { key: "p90FinishPos", label: "P90Pos", title: "90th percentile finish position" },
  { key: "finishedCount", label: "Fin", title: "Finished count" },
  { key: "dnfCount", label: "DNF", title: "DNF count" },
  { key: "bestTimeMs", label: "BestT", title: "Best finish time" },
  { key: "worstTimeMs", label: "WorstT", title: "Worst finish time" },
  { key: "avgTimeMs", label: "AvgT", title: "Average finish time" },
  { key: "medianTimeMs", label: "MedT", title: "Median finish time" },
  { key: "p10TimeMs", label: "P10T", title: "10th percentile finish time" },
  { key: "p25TimeMs", label: "P25T", title: "25th percentile finish time" },
  { key: "p75TimeMs", label: "P75T", title: "75th percentile finish time" },
  { key: "p90TimeMs", label: "P90T", title: "90th percentile finish time" },
];

function renderHeader(state) {
  return `
    <tr>
      ${COLUMNS.map((c) => {
        const isActive = state.sortBy === c.key;
        const icon = !isActive ? "" : state.sortDir === "asc" ? " ▲" : " ▼";
        return `<th data-sort="${escapeHtml(c.key)}" title="${escapeHtml(c.title || c.label)}">${escapeHtml(c.label)}${icon}</th>`;
      }).join("")}
    </tr>
  `;
}

function renderRow(item) {
  const login = item?.viewerLogin || "";
  const display = item?.viewerDisplayName || login || item?.viewerUserId || "Viewer";
  const twitchUrl = login ? `https://twitch.tv/${encodeURIComponent(login)}` : "";
  const viewerCell = twitchUrl
    ? `<a class="vf-link" href="${twitchUrl}" target="_blank" rel="noopener">${escapeHtml(display)}</a>`
    : escapeHtml(display);

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
      ${COLUMNS.map((c) => {
        const v = cells[c.key] ?? "—";
        const cls = c.key === "viewer" ? "vf-tdViewer" : "vf-tdNum";
        return `<td class="${cls}">${v}</td>`;
      }).join("")}
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
    meta: {
      seasons: [],
      streamers: [],
      maps: [],
      activeSeasonId: "",
    },
    lastData: null,
    loading: false,
  };

  root.innerHTML = `
    <div class="vf-card">
      <div class="vf-row">
        <div>
          <div class="vf-h2">Leaderboard filters</div>
          <div class="vf-muted vf-small">Default: current season, sorted by # of wins (1st place).</div>
        </div>
        <div class="vf-spacer"></div>
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

      <div class="vf-tableWrap" style="margin-top: 12px">
        <table class="vf-table" id="vf-table">
          <thead id="vf-thead"></thead>
          <tbody id="vf-tbody"></tbody>
        </table>
      </div>

      <div class="vf-row" style="margin-top: 12px">
        <div class="vf-spacer"></div>
        <div id="vf-pagerBottom"></div>
      </div>
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

  async function loadLeaderboard() {
    if (state.loading) return;
    state.loading = true;
    if (summaryEl) summaryEl.textContent = "Loading…";

    try {
      const q = buildQuery(state);
      const resp = await api.getLeaderboard(q);
      state.lastData = resp;

      const total = resp?.totalItems || 0;
      const page = resp?.page || 1;
      const pages = resp?.totalPages || 1;
      if (summaryEl) {
        summaryEl.textContent = `Showing ${resp?.items?.length || 0} of ${total} viewers • Page ${page}/${pages}`;
      }

      if (theadEl) theadEl.innerHTML = renderHeader(state);
      if (tbodyEl) {
        const items = Array.isArray(resp?.items) ? resp.items : [];
        tbodyEl.innerHTML = items.length
          ? items.map(renderRow).join("")
          : `<tr><td colspan="${COLUMNS.length}" class="vf-muted" style="padding: 14px">No results found.</td></tr>`;
      }

      wireSortHandlers(state, tableEl, () => debounceLoad(loadLeaderboard, 10));

      renderPager(state, resp, pagerTop, (p) => {
        state.page = p;
        loadLeaderboard();
      });

      renderPager(state, resp, pagerBottom, (p) => {
        state.page = p;
        loadLeaderboard();
      });
    } catch (e) {
      console.error(e);
      if (summaryEl) summaryEl.textContent = "Failed to load leaderboard.";
      if (tbodyEl) {
        tbodyEl.innerHTML = `<tr><td colspan="${COLUMNS.length}" class="vf-alert vf-alertError">${escapeHtml(e?.message || "Error")}</td></tr>`;
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
