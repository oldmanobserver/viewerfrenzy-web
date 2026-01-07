import { requireSession, clearSession } from "./session.js";
import { loadVehicleCatalog, isRandomPlaceholderId } from "./catalog.js";
import * as api from "./api.js";
import { toast } from "./ui.js";
import { applyVehicleImage } from "./vehicle-images.js";

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

// --- Preview auto-centering ---
//
// The exported vehicle PNGs are square (e.g., 1024×1024) with transparency.
// Some models have uneven transparent padding, so the vehicle can *look* like
// it's sitting low in the preview viewport.
//
// We fix that by scanning the image's alpha channel, computing the bounding box
// of non-transparent pixels, and then applying a translateY to visually center it.
//
// Performance: We run this ONLY for the selected preview image (not every tile).
function autoCenterPreviewImage(imgEl) {
  if (!imgEl) return;

  // Reset each time so we don't keep stale offsets.
  imgEl.style.setProperty("--vf-previewShiftY", "0px");

  const w = imgEl.naturalWidth || 0;
  const h = imgEl.naturalHeight || 0;
  if (w <= 0 || h <= 0) return;

  // Avoid huge work if something unexpected happens.
  if (w > 4096 || h > 4096) return;

  // Canvas must be same-origin. Your images are served from the same domain.
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  try {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(imgEl, 0, 0);
  } catch {
    // If the canvas becomes tainted for any reason, just leave centered at 0.
    return;
  }

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch {
    return;
  }

  const data = imgData.data;
  const alphaThreshold = 8; // 0..255 (ignore near-transparent edges)

  let minY = h;
  let maxY = -1;

  // We only need Y bounds for vertical centering.
  // Scan rows; break early where possible.
  for (let y = 0; y < h; y++) {
    const rowStart = y * w * 4;
    for (let x = 0; x < w; x++) {
      const a = data[rowStart + x * 4 + 3];
      if (a > alphaThreshold) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        break;
      }
    }
  }

  if (maxY < 0 || minY >= h) {
    // Fully transparent image (shouldn't happen). Keep shift 0.
    return;
  }

  // Compute how far the content center is from the image center.
  const contentCenterY = (minY + maxY) * 0.5;
  const imageCenterY = h * 0.5;
  const dyImagePx = contentCenterY - imageCenterY; // + means content is below center

  // Convert image-space pixels into CSS pixels based on how big the <img> is rendered.
  const rect = imgEl.getBoundingClientRect();
  const renderedH = rect.height || 0;
  if (renderedH <= 0) return;

  const scaleY = renderedH / h;
  const shiftCssPx = -dyImagePx * scaleY;

  // Clamp to something sane so we don't shift wildly if a model has a bad mesh/bounds.
  const clamped = Math.max(-80, Math.min(80, shiftCssPx));
  imgEl.style.setProperty("--vf-previewShiftY", `${clamped.toFixed(2)}px`);
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
        cols: state.cols,
        rows: state.rows,
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
  const state = {
    type: uiSaved.type && availableTypes.includes(uiSaved.type) ? uiSaved.type : (availableTypes[0] || "ground"),
    search: typeof uiSaved.search === "string" ? uiSaved.search : "",
    cols: clamp(Number(uiSaved.cols || 4), 1, 8),
    rows: clamp(Number(uiSaved.rows || 3), 1, 8),
    offset: 0,           // index into filtered options
    selectedId: null,    // currently selected vehicle id
    rotY: 0,             // preview rotation in degrees
    serverDefaults: {},  // type -> record|null|undefined

    // Vehicle role pools (loaded from /api/v1/vehicle-pools)
    // Used to filter which vehicles appear in each mode.
    pools: null,         // response.pools
    disabledSet: new Set(),
    eligibleByType: new Map(),
  };

  // Load vehicle eligibility pools (public, no auth)
  try {
    const poolsResp = await api.getVehiclePools();
    if (poolsResp?.ok && poolsResp?.pools) {
      state.pools = poolsResp.pools;
      state.disabledSet = new Set(poolsResp.disabledIds || []);
      state.eligibleByType = new Map();
      for (const [t, v] of Object.entries(poolsResp.pools)) {
        const ids = Array.isArray(v?.eligibleIds) ? v.eligibleIds : [];
        state.eligibleByType.set(String(t).toLowerCase(), new Set(ids));
      }
    }
  } catch {
    // Non-fatal: fall back to showing the full catalog.
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
          </div>
        </div>

        <div id="vf-previewViewport" class="vf-previewViewport" title="Drag to rotate">
          <img id="vf-previewImg" class="vf-previewImg" alt="" draggable="false" />
        </div>

        <div class="vf-previewHint">Tip: drag the preview left/right to rotate.</div>

        <div class="vf-previewControls">
          <button id="vf-rotLeft" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">⟲ Rotate</button>
          <button id="vf-rotRight" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Rotate ⟳</button>
          <button id="vf-rotReset" class="vf-btn vf-btnSecondary vf-btnTiny" type="button">Reset</button>
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
  const elSearch = root.querySelector("#vf-search");
  const elCols = root.querySelector("#vf-cols");
  const elRows = root.querySelector("#vf-rows");
  const elTiles = root.querySelector("#vf-tiles");
  const elErr = root.querySelector("#vf-garageError");
  const elPageInfo = root.querySelector("#vf-pageInfo");
  const elGridSubtitle = root.querySelector("#vf-gridSubtitle");
  const elServerStatus = root.querySelector("#vf-serverStatus");
  const elSelectedLabel = root.querySelector("#vf-selectedLabel");
  const elPreviewViewport = root.querySelector("#vf-previewViewport");
  const elPreviewImg = root.querySelector("#vf-previewImg");
  const elSavedLabel = root.querySelector("#vf-savedDefaultLabel");

  const btnPageUp = root.querySelector("#vf-pageUp");
  const btnPageDown = root.querySelector("#vf-pageDown");
  const btnPrevCol = root.querySelector("#vf-prevCol");
  const btnNextCol = root.querySelector("#vf-nextCol");

  const btnRotLeft = root.querySelector("#vf-rotLeft");
  const btnRotRight = root.querySelector("#vf-rotRight");
  const btnRotReset = root.querySelector("#vf-rotReset");

  const btnSave = root.querySelector("#vf-saveDefaultBtn");
  const btnClear = root.querySelector("#vf-clearDefaultBtn");

  elSearch.value = state.search;
  elCols.value = String(state.cols);
  elRows.value = String(state.rows);

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

  function effectiveSelectedId() {
    if (state.selectedId && !isRandomPlaceholderId(state.selectedId)) return state.selectedId;

    const record = getServerRecord();
    if (record && record.vehicleId && !isRandomPlaceholderId(record.vehicleId)) return record.vehicleId;

    // No per-user default set: fall back to the first available option.
    const opts = filteredOptions();
    const first = opts.find((o) => o?.id && !isRandomPlaceholderId(o.id));
    return first?.id || null;
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

  function updateGridColumns() {
    // fixed column count (user controlled)
    elTiles.style.gridTemplateColumns = `repeat(${state.cols}, minmax(0, 1fr))`;
  }

  function renderPageInfo(total, shownStart, shownEnd) {
    const ps = pageSize();
    const colStep = state.rows;

    const info = [
      `Showing ${total ? shownStart + 1 : 0}-${shownEnd} of ${total}`,
      `• Page size ${ps} (${state.cols}×${state.rows})`,
      `• Column step ${colStep}`,
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

    // If selected item no longer exists (e.g. search changed), reset to default/random.
    const selId = effectiveSelectedId();
    const exists = opts.some((o) => (o.id || "") === selId);
    if (!exists) state.selectedId = null;

    const selectedId = effectiveSelectedId();

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

        const meta = optionMeta(state.type, o);
        const badge = isDefault
          ? `<div class="vf-tileBadge vf-tileBadgeStar">★ Default</div>`
          : "";

        return `
          <div class="vf-vehicleTile ${isSelected ? "is-selected" : ""}" data-id="${escapeHtml(id)}" role="button" tabindex="0">
            ${badge}
            <div class="vf-tileThumb">
              <img class="vf-tileImg" data-veh-type="${escapeHtml(state.type)}" data-veh-id="${escapeHtml(id)}" alt="" loading="lazy" />
            </div>
            <div class="vf-tileInfo">
              <div class="vf-tileTitle">${escapeHtml(o.displayName || id)}</div>
              ${meta ? `<div class="vf-tileMeta">${escapeHtml(meta)}</div>` : ""}
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

  function updatePreviewTransform() {
    if (!elPreviewImg) return;
    elPreviewImg.style.setProperty("--vf-rotY", `${state.rotY}deg`);
    elPreviewImg.style.setProperty("--vf-rotZ", `0deg`);
  }

  function renderPreview() {
    const entry = currentTypeEntry();
    const selId = effectiveSelectedId();
    const opt = findOption(entry, selId);

    const displayName = opt?.displayName || (selId ? selId : "(none)");
    elSelectedLabel.textContent = selId ? `Selected: ${displayName} (${selId})` : "Select a vehicle…";

    // When the preview image finishes loading, compute an alpha-bounds based
    // translateY so the visible vehicle is visually centered.
    elPreviewImg.onload = () => {
      // Wait one frame so layout is up-to-date.
      requestAnimationFrame(() => autoCenterPreviewImage(elPreviewImg));
    };

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

    updatePreviewTransform();
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

    const selectedId = effectiveSelectedId();
    if (!selectedId) {
      toast("No vehicle selected.");
      return;
    }

    // Server API convention: vehicleId is a non-empty string when setting a default.
    // (Empty string is reserved for 'cleared')
    const vehicleId = String(selectedId || "").trim();

    btnSave.disabled = true;
    btnClear.disabled = true;

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
      btnSave.disabled = false;
      btnClear.disabled = false;
    }
  }

  async function clearServerDefault() {
    const type = state.type;
    const entry = currentTypeEntry();

    btnSave.disabled = true;
    btnClear.disabled = true;

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
      btnSave.disabled = false;
      btnClear.disabled = false;
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
    state.rotY = 0;

    saveUiState(state);
    setError("");

    renderTypeChips();
    renderGrid();
    ensureServerDefaultLoaded();
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
    // Reset rotation when selecting a new vehicle (feels better)
    state.rotY = 0;
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

  // Preview rotate drag
  let dragging = false;
  let lastX = 0;
  function onPreviewDown(ev) {
    dragging = true;
    lastX = ev.clientX;
    elPreviewViewport.setPointerCapture?.(ev.pointerId);
  }
  function onPreviewMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    lastX = ev.clientX;
    state.rotY += dx * 0.6;
    updatePreviewTransform();
  }
  function onPreviewUp(ev) {
    dragging = false;
    elPreviewViewport.releasePointerCapture?.(ev.pointerId);
  }

  // Wire events
  elChips.addEventListener("click", onChipClick);
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

  btnRotLeft.addEventListener("click", () => { state.rotY -= 15; updatePreviewTransform(); });
  btnRotRight.addEventListener("click", () => { state.rotY += 15; updatePreviewTransform(); });
  btnRotReset.addEventListener("click", () => { state.rotY = 0; updatePreviewTransform(); });

  elPreviewViewport.addEventListener("pointerdown", onPreviewDown);
  elPreviewViewport.addEventListener("pointermove", onPreviewMove);
  elPreviewViewport.addEventListener("pointerup", onPreviewUp);
  elPreviewViewport.addEventListener("pointercancel", onPreviewUp);

  btnSave.addEventListener("click", () => saveSelectionAsDefault());
  btnClear.addEventListener("click", () => clearServerDefault());

  // Initial render
  renderTypeChips();
  updateGridColumns();
  renderGrid();
  ensureServerDefaultLoaded();
}

init().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
});
