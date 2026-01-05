import { isRandomPlaceholderId } from "../catalog.js";

const PREFERRED_ORDER = ["ground", "resort", "space", "water", "trackfield", "winter"];

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function preferredRandomId(type) {
  // Matches Unity's GarageUIController:
  // - resort random is "tube_palette"
  // - others use "__random__"
  return type === "resort" ? "tube_palette" : "__random__";
}

function findOption(typeEntry, id) {
  const opts = typeEntry?.options || [];
  return opts.find((o) => (o?.id || "") === id) || null;
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
    if ((opt.id || "").startsWith("tube_color_")) return "Lazy river tube";
    if (opt.id === "tube_palette") return "Lazy river tube";
  }

  return opt.meta || "";
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
    const rid = preferredRandomId(type);
    const opt = findOption(typeEntry, rid);
    return {
      label: opt ? opt.displayName : "Random (seeded)",
      updatedAt: record?.updatedAt || "",
      kind: "random",
    };
  }

  const opt = findOption(typeEntry, vehicleId);
  return {
    label: opt ? opt.displayName : `Unknown vehicle id: ${vehicleId}`,
    updatedAt: record?.updatedAt || "",
    kind: opt ? "known" : "unknown",
  };
}

export function renderGarage(root, ctx) {
  const garageState = (ctx.state.garage ||= {
    type: "ground",
    search: "",
    selectedId: null,
    serverDefaults: {}, // type -> record|null|undefined (undefined = not fetched yet)
  });

  const catalog = ctx.catalog;
  const typeNames = Object.keys(catalog?.types || {});

  const availableTypes = [...typeNames].sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a);
    const ib = PREFERRED_ORDER.indexOf(b);
    const ra = ia === -1 ? 999 : ia;
    const rb = ib === -1 ? 999 : ib;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  if (!availableTypes.includes(garageState.type)) {
    garageState.type = availableTypes[0] || "ground";
  }

  root.innerHTML = `
    <div class="vf-container">
      <div class="vf-row">
        <h1 class="vf-h1">Garage</h1>
        <div class="vf-spacer"></div>
        <div class="vf-muted vf-small" id="vf-garageServerInfo"></div>
      </div>

      <div class="vf-card" style="margin-top: 12px">
        <div class="vf-row">
          <div>
            <div class="vf-h2">Vehicle type</div>
            <div class="vf-muted vf-small">Set a default for each mode.</div>
          </div>
          <div class="vf-spacer"></div>
          <input id="vf-garageSearch" class="vf-input" placeholder="Search vehicles…" />
        </div>

        <div class="vf-chipRow" id="vf-typeChips" style="margin-top: 12px"></div>

        <div class="vf-muted vf-small" id="vf-typeNote" style="margin-top: 10px"></div>
      </div>

      <div class="vf-card" style="margin-top: 12px">
        <div class="vf-row">
          <div>
            <div class="vf-h2">Pick a vehicle</div>
            <div class="vf-muted vf-small" id="vf-currentSelectionLabel">Loading…</div>
          </div>
          <div class="vf-spacer"></div>
          <div class="vf-actions">
            <button id="vf-saveDefaultBtn" class="vf-btn vf-btnPrimary" type="button">Save as Default</button>
            <button id="vf-setRandomBtn" class="vf-btn vf-btnSecondary" type="button">Set Random (seeded)</button>
          </div>
        </div>

        <div id="vf-savedDefaultLabel" class="vf-muted vf-small" style="margin-top: 10px"></div>

        <div id="vf-tiles" class="vf-grid"></div>

        <div id="vf-garageError" class="vf-alert vf-alertError" hidden></div>
      </div>
    </div>
  `;

  const elSearch = root.querySelector("#vf-garageSearch");
  const elChips = root.querySelector("#vf-typeChips");
  const elTiles = root.querySelector("#vf-tiles");
  const elSel = root.querySelector("#vf-currentSelectionLabel");
  const elSaved = root.querySelector("#vf-savedDefaultLabel");
  const elErr = root.querySelector("#vf-garageError");
  const elTypeNote = root.querySelector("#vf-typeNote");
  const elServerInfo = root.querySelector("#vf-garageServerInfo");
  const btnSave = root.querySelector("#vf-saveDefaultBtn");
  const btnRandom = root.querySelector("#vf-setRandomBtn");

  elSearch.value = garageState.search || "";

  let disposed = false;

  function setError(message) {
    if (!elErr) return;
    elErr.hidden = !message;
    elErr.textContent = message || "";
  }

  function setServerInfo(message) {
    if (!elServerInfo) return;
    elServerInfo.textContent = message || "";
  }

  function currentTypeEntry() {
    return catalog?.types?.[garageState.type] || null;
  }

  function getServerRecord() {
    return garageState.serverDefaults[garageState.type];
  }

  function renderTypeChips() {
    elChips.innerHTML = availableTypes
      .map((t) => {
        const entry = catalog.types[t];
        const label = entry?.label || t;
        const emoji = entry?.emoji || "";
        const active = t === garageState.type ? "is-active" : "";
        return `
          <button class="vf-chip ${active}" type="button" data-type="${escapeHtml(t)}">
            ${emoji ? `${escapeHtml(emoji)} ` : ""}${escapeHtml(label)}
          </button>
        `;
      })
      .join("");
  }

  function effectiveSelectedId() {
    // If nothing selected yet, pick the server default (or random placeholder).
    if (garageState.selectedId) return garageState.selectedId;

    const record = getServerRecord();
    const t = garageState.type;

    if (record && record.vehicleId) {
      return record.vehicleId;
    }

    return preferredRandomId(t);
  }

  function renderTiles() {
    const type = garageState.type;
    const entry = currentTypeEntry();
    if (!entry) {
      elTiles.innerHTML = "";
      elSel.textContent = "No vehicles configured.";
      return;
    }

    const filter = (garageState.search || "").trim().toLowerCase();
    const selectedId = effectiveSelectedId();

    const record = getServerRecord();
    const serverVehicleId = record === null ? null : (record?.vehicleId ?? "");
    const defaultId = serverVehicleId ? serverVehicleId : preferredRandomId(type);

    const opts = (entry.options || []).filter((o) => {
      if (!filter) return true;
      const hay = `${o.displayName || ""} ${o.id || ""} ${o.pack || ""} ${o.category || ""}`.toLowerCase();
      return hay.includes(filter);
    });

    elTiles.innerHTML = opts
      .map((o) => {
        const id = o.id || "";
        const isSelected = id === selectedId;
        const isDefault = id === defaultId;

        const meta = optionMeta(type, o);
        const badge = isDefault
          ? `<div class="vf-tileBadge vf-tileBadgeStar">★ Default</div>`
          : isRandomPlaceholderId(id)
            ? `<div class="vf-tileBadge">Random</div>`
            : "";

        return `
          <div class="vf-tile ${isSelected ? "is-selected" : ""}" data-id="${escapeHtml(id)}" role="button" tabindex="0">
            ${badge}
            <div>
              <div class="vf-tileTitle">${escapeHtml(o.displayName || id)}</div>
              ${meta ? `<div class="vf-tileMeta">${escapeHtml(meta)}</div>` : ""}
            </div>
            <div class="vf-tileMeta">${escapeHtml(id)}</div>
          </div>
        `;
      })
      .join("");

    const selectedOpt = findOption(entry, selectedId);
    elSel.textContent = selectedOpt
      ? `Selected: ${selectedOpt.displayName} (${selectedOpt.id})`
      : `Selected: ${selectedId}`;

    const server = labelForServerRecord(type, record ?? null, entry);

    if (record === undefined) {
      elSaved.textContent = "Loading saved default from server…";
    } else {
      const when = server.updatedAt ? ` • Updated ${server.updatedAt}` : "";
      elSaved.textContent = `Saved default on server: ${server.label}${when}`;
    }

    if (entry.note) {
      elTypeNote.textContent = entry.note;
    } else {
      elTypeNote.textContent = "";
    }

    if (record === null) {
      setServerInfo("Server: no saved default yet");
    } else if (record === undefined) {
      setServerInfo("Server: loading…");
    } else {
      setServerInfo("Server: loaded");
    }
  }

  async function ensureServerDefaultLoaded() {
    const type = garageState.type;

    if (garageState.serverDefaults[type] !== undefined) {
      return;
    }

    garageState.serverDefaults[type] = undefined;
    renderTiles();

    try {
      const resp = await ctx.api.getVehicleDefault(type, ctx.auth);
      if (disposed) return;

      // resp.value is either null (no record) or a record object.
      garageState.serverDefaults[type] = resp?.value ?? null;
      setError("");
    } catch (e) {
      if (disposed) return;
      const msg = e?.message || "Failed to load saved default.";
      setError(msg);

      // If token is invalid, bubble up to app so it can log out.
      if (e?.status === 401 || e?.status === 403) {
        ctx.onAuthInvalid?.();
        return;
      }

      // keep undefined so user can retry by changing type or reloading
      garageState.serverDefaults[type] = null;
    }

    renderTiles();
  }

  async function saveSelectionAsDefault({ forceRandom = false } = {}) {
    const type = garageState.type;
    const entry = currentTypeEntry();

    const selectedId = forceRandom ? preferredRandomId(type) : effectiveSelectedId();

    let vehicleId = selectedId;
    if (forceRandom || isRandomPlaceholderId(selectedId)) {
      vehicleId = ""; // matches Unity: store explicit random as empty string
    }

    btnSave.disabled = true;
    btnRandom.disabled = true;

    try {
      const resp = await ctx.api.putVehicleDefault(type, vehicleId, ctx.auth);
      if (disposed) return;

      garageState.serverDefaults[type] = resp?.value ?? null;
      garageState.selectedId = forceRandom ? preferredRandomId(type) : selectedId;

      const serverLabel = labelForServerRecord(type, garageState.serverDefaults[type], entry);
      ctx.toast(`Saved: ${serverLabel.label}`);
      setError("");

      renderTiles();
    } catch (e) {
      if (disposed) return;

      const msg = e?.message || "Failed to save default.";
      setError(msg);

      if (e?.status === 401 || e?.status === 403) {
        ctx.onAuthInvalid?.();
      }
    } finally {
      btnSave.disabled = false;
      btnRandom.disabled = false;
    }
  }

  function onChipClick(ev) {
    const btn = ev.target.closest("button[data-type]");
    if (!btn) return;

    const type = btn.getAttribute("data-type");
    if (!type) return;

    garageState.type = type;
    garageState.selectedId = null;
    setError("");

    renderTypeChips();
    renderTiles();

    ensureServerDefaultLoaded();
  }

  function onSearchInput() {
    garageState.search = elSearch.value || "";
    renderTiles();
  }

  function onTileActivate(tile) {
    const id = tile.getAttribute("data-id");
    if (!id) return;
    garageState.selectedId = id;
    renderTiles();
  }

  function onTilesClick(ev) {
    const tile = ev.target.closest(".vf-tile");
    if (!tile) return;
    onTileActivate(tile);
  }

  function onTilesKeydown(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const tile = ev.target.closest(".vf-tile");
    if (!tile) return;
    ev.preventDefault();
    onTileActivate(tile);
  }

  // Wire events
  elChips.addEventListener("click", onChipClick);
  elSearch.addEventListener("input", onSearchInput);
  elTiles.addEventListener("click", onTilesClick);
  elTiles.addEventListener("keydown", onTilesKeydown);
  btnSave.addEventListener("click", () => saveSelectionAsDefault({ forceRandom: false }));
  btnRandom.addEventListener("click", () => saveSelectionAsDefault({ forceRandom: true }));

  // Initial render
  renderTypeChips();
  renderTiles();
  ensureServerDefaultLoaded();

  return () => {
    disposed = true;
    elChips.removeEventListener("click", onChipClick);
    elSearch.removeEventListener("input", onSearchInput);
    elTiles.removeEventListener("click", onTilesClick);
    elTiles.removeEventListener("keydown", onTilesKeydown);
  };
}
