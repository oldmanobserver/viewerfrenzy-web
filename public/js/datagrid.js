import { $ } from "./ui.js";

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v ?? "";
    else if (k === "html") node.innerHTML = v ?? "";
    else if (k in node) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function safeLower(v) {
  return toText(v).toLowerCase();
}

export function createDataGrid(container, {
  columns = [],
  getRowId = (row) => row?.id,
  onRowSelect = () => {},
  searchPlaceholder = "Search…",
  pageSizeOptions = [10, 25, 50, 100],
  initialPageSize = 25,
  emptyMessage = "No records.",
  // Optional UI toggles (defaults match existing behavior)
  showSearch = true,
  showPageSize = true,
  showCount = true,
} = {}) {
  if (!container) throw new Error("createDataGrid: container is required");

  // --- state
  let _rows = [];
  let _filtered = [];
  let _search = "";
  let _sortKey = "";
  let _sortDir = "asc"; // asc|desc
  let _pageSize = initialPageSize;
  let _page = 0;
  let _selectedId = null;

  // --- UI skeleton
  container.innerHTML = "";

  const toolChildren = [];

  const searchInput = showSearch
    ? el("input", {
      class: "vf-input",
      placeholder: searchPlaceholder,
      type: "search",
      autocomplete: "off",
    })
    : null;

  if (searchInput) toolChildren.push(searchInput);

  const pageSizeSel = showPageSize ? el("select", { class: "vf-select", title: "Rows per page" }) : null;
  if (pageSizeSel) {
    for (const n of pageSizeOptions) {
      pageSizeSel.appendChild(el("option", { value: String(n), text: `${n} rows` }));
    }
    pageSizeSel.value = String(initialPageSize);
    toolChildren.push(pageSizeSel);
  }

  const countLabel = showCount ? el("div", { class: "vf-small vf-muted" }) : null;

  // Always include spacer so count stays right-aligned when present.
  toolChildren.push(el("div", { class: "vf-spacer" }));
  if (countLabel) toolChildren.push(countLabel);

  const toolRow = el("div", { class: "vf-row", style: "margin-bottom: 10px;" }, toolChildren);

  const table = el("table", { class: "vf-table" });
  const thead = el("thead");
  const tbody = el("tbody");
  table.appendChild(thead);
  table.appendChild(tbody);

  const tableWrap = el("div", { class: "vf-tableWrap" }, [table]);

  const prevBtn = el("button", { class: "vf-btn vf-btnSecondary vf-btnTiny", type: "button", text: "Prev" });
  const nextBtn = el("button", { class: "vf-btn vf-btnSecondary vf-btnTiny", type: "button", text: "Next" });
  const pageInfo = el("div", { class: "vf-small vf-muted" });

  const footer = el("div", { class: "vf-row", style: "margin-top: 10px;" }, [
    el("div", { class: "vf-pager" }, [prevBtn, nextBtn]),
    el("div", { class: "vf-spacer" }),
    pageInfo,
  ]);

  container.appendChild(toolRow);
  container.appendChild(tableWrap);
  container.appendChild(footer);

  function visibleColumns() {
    return columns.filter((c) => !c.hidden);
  }

  function updateCountLabel() {
    if (!countLabel) return;
    countLabel.textContent = `${_filtered.length} shown`;
  }

  function applySearch() {
    const q = safeLower(_search).trim();
    if (!q) {
      _filtered = [..._rows];
      return;
    }

    const cols = visibleColumns();
    _filtered = _rows.filter((row) => {
      for (const c of cols) {
        const raw = typeof c.value === "function" ? c.value(row) : row?.[c.key];
        if (safeLower(raw).includes(q)) return true;
      }
      return false;
    });
  }

  function compare(a, b) {
    const av = a ?? "";
    const bv = b ?? "";
    // numeric compare when possible
    const an = Number(av);
    const bn = Number(bv);
    const bothNum = Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== "" && String(bv).trim() !== "";
    if (bothNum) return an - bn;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
  }

  function applySort() {
    if (!_sortKey) return;
    const col = columns.find((c) => c.key === _sortKey);
    if (!col) return;

    const dir = _sortDir === "desc" ? -1 : 1;
    _filtered.sort((ra, rb) => {
      const a = typeof col.value === "function" ? col.value(ra) : ra?.[col.key];
      const b = typeof col.value === "function" ? col.value(rb) : rb?.[col.key];
      return compare(a, b) * dir;
    });
  }

  function totalPages() {
    return Math.max(1, Math.ceil(_filtered.length / Math.max(1, _pageSize)));
  }

  function clampPage() {
    const pages = totalPages();
    if (_page < 0) _page = 0;
    if (_page > pages - 1) _page = pages - 1;
  }

  function renderHead() {
    thead.innerHTML = "";
    const tr = el("tr");

    for (const c of visibleColumns()) {
      const th = el("th", { "data-key": c.key, title: c.sortable === false ? "" : "Sort" });
      th.appendChild(document.createTextNode(c.label || c.key || ""));

      const showSort = _sortKey === c.key;
      if (showSort) {
        th.appendChild(el("span", { class: "vf-sort", text: _sortDir === "desc" ? "▼" : "▲" }));
      }

      if (c.sortable !== false) {
        th.addEventListener("click", () => {
          if (_sortKey !== c.key) {
            _sortKey = c.key;
            _sortDir = "asc";
          } else {
            _sortDir = _sortDir === "asc" ? "desc" : "asc";
          }
          _page = 0;
          refresh();
        });
      } else {
        th.style.cursor = "default";
      }

      if (c.width) th.style.width = c.width;
      tr.appendChild(th);
    }

    thead.appendChild(tr);
  }

  function renderBody() {
    tbody.innerHTML = "";

    if (!_filtered.length) {
      const tr = el("tr");
      const td = el("td", { text: emptyMessage });
      td.colSpan = Math.max(1, visibleColumns().length);
      td.style.color = "var(--muted)";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    const start = _page * _pageSize;
    const end = Math.min(_filtered.length, start + _pageSize);
    const slice = _filtered.slice(start, end);

    for (const row of slice) {
      const id = getRowId(row);
      const tr = el("tr");
      if (id != null && id === _selectedId) tr.classList.add("is-selected");

      tr.addEventListener("click", () => {
        _selectedId = id;
        refresh();
        onRowSelect(row);
      });

      for (const c of visibleColumns()) {
        const td = el("td");
        const v = typeof c.render === "function"
          ? c.render(row)
          : (typeof c.value === "function" ? c.value(row) : row?.[c.key]);

        if (v instanceof HTMLElement) td.appendChild(v);
        else td.textContent = toText(v);

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }
  }

  function renderPager() {
    const pages = totalPages();
    clampPage();

    prevBtn.disabled = _page <= 0;
    nextBtn.disabled = _page >= pages - 1;

    const start = _filtered.length ? _page * _pageSize + 1 : 0;
    const end = Math.min(_filtered.length, (_page + 1) * _pageSize);
    pageInfo.textContent = `Showing ${start}-${end} of ${_filtered.length}`;
  }

  function refresh() {
    applySearch();
    applySort();
    clampPage();
    updateCountLabel();
    renderHead();
    renderBody();
    renderPager();
  }

  // --- event handlers
  if (searchInput) {
    searchInput.addEventListener("input", () => {
      _search = searchInput.value || "";
      _page = 0;
      refresh();
    });
  }

  if (pageSizeSel) {
    pageSizeSel.addEventListener("change", () => {
      _pageSize = Number(pageSizeSel.value) || initialPageSize;
      _page = 0;
      refresh();
    });
  }

  prevBtn.addEventListener("click", () => {
    _page -= 1;
    refresh();
  });

  nextBtn.addEventListener("click", () => {
    _page += 1;
    refresh();
  });

  // --- public API
  function setRows(rows, { preserveSelection = true } = {}) {
    _rows = Array.isArray(rows) ? rows.slice() : [];
    if (!preserveSelection) _selectedId = null;
    _page = 0;
    refresh();
  }

  function selectById(id) {
    _selectedId = id;
    refresh();
    const row = _rows.find((r) => getRowId(r) === id) || null;
    if (row) onRowSelect(row);
  }

  function clearSelection() {
    _selectedId = null;
    refresh();
  }

  function setSearch(q) {
    _search = q || "";
    if (searchInput) searchInput.value = _search;
    _page = 0;
    refresh();
  }

  // initial render
  refresh();

  return {
    setRows,
    selectById,
    clearSelection,
    setSearch,
    get selectedId() {
      return _selectedId;
    },
    get rows() {
      return _rows.slice();
    },
  };
}
