import * as api from "./api.js";
import * as auth from "./auth.js";
import * as session from "./session.js";
import { toast } from "./ui.js";

const elAddInput = document.getElementById("vf-addUserInput");
const elAddBtn = document.getElementById("vf-addUserBtn");
const elRefreshBtn = document.getElementById("vf-refreshBtn");
const elMsg = document.getElementById("vf-addUserMsg");
const elUserCount = document.getElementById("vf-userCount");
const elTbody = document.getElementById("vf-usersTbody");

const elRoleFilter = document.getElementById("vf-roleFilter");
const elSyncRolesBtn = document.getElementById("vf-syncRolesBtn");
const elRoleMsg = document.getElementById("vf-roleMsg");

// Selected user panel
const elClearSelectionBtn = document.getElementById("vf-clearSelectionBtn");
const elUserRolesMsg = document.getElementById("vf-userRolesMsg");
const elSelectedUserEmpty = document.getElementById("vf-selectedUserEmpty");
const elSelectedUserBody = document.getElementById("vf-selectedUserBody");
const elSelectedUserAvatar = document.getElementById("vf-selectedUserAvatar");
const elSelectedUserName = document.getElementById("vf-selectedUserName");
const elSelectedUserLogin = document.getElementById("vf-selectedUserLogin");
const elSelectedUserId = document.getElementById("vf-selectedUserId");
const elSelectedUserFirst = document.getElementById("vf-selectedUserFirst");
const elSelectedUserLast = document.getElementById("vf-selectedUserLast");
const elVfRolesWrap = document.getElementById("vf-vfRolesWrap");
const elNoVfRolesNote = document.getElementById("vf-noVfRolesNote");
const elSaveUserRolesBtn = document.getElementById("vf-saveUserRolesBtn");
const elTwitchRolesChips = document.getElementById("vf-twitchRolesChips");

let _session = null;
let _allUsers = [];
let _roleDefs = [];
let _roleById = new Map();

let _vfRoleDefs = [];
let _vfRoleById = new Map();

let _selectedUserId = "";
let _selectedDirty = false;

function setMsg(text, isError = false) {
  if (!elMsg) return;
  elMsg.hidden = !text;
  elMsg.textContent = text || "";
  elMsg.classList.toggle("vf-alertError", !!isError);
}

function setRoleMsg(text, isError = false) {
  if (!elRoleMsg) return;
  elRoleMsg.hidden = !text;
  elRoleMsg.textContent = text || "";
  elRoleMsg.classList.toggle("vf-alertError", !!isError);
}

function setUserRolesMsg(text, isError = false) {
  if (!elUserRolesMsg) return;
  elUserRolesMsg.hidden = !text;
  elUserRolesMsg.textContent = text || "";
  elUserRolesMsg.classList.toggle("vf-alertError", !!isError);
}

function setLoading() {
  if (elTbody) {
    elTbody.innerHTML = `<tr><td colspan="6" class="vf-muted">Loading…</td></tr>`;
  }
  if (elUserCount) {
    elUserCount.textContent = "Loading…";
  }
}

function fmtDate(value) {
  if (value === undefined || value === null) return "";

  // Support number, numeric string, or ISO string
  const raw = typeof value === "string" ? value.trim() : value;

  // Numeric ms
  const asNum = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(asNum) && asNum > 0) {
    try {
      return new Date(asNum).toLocaleString();
    } catch {
      return String(asNum);
    }
  }

  // ISO-ish string
  if (typeof raw === "string" && raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) {
      try {
        return new Date(t).toLocaleString();
      } catch {
        return raw;
      }
    }
    return raw;
  }

  return "";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderRows(users) {
  if (!elTbody) return;

  const rows = Array.isArray(users) ? users : [];

  if (!rows.length) {
    elTbody.innerHTML = `<tr><td colspan="6" class="vf-muted">No users.</td></tr>`;
    return;
  }

  elTbody.innerHTML = rows
    .map(
      (u) => `
      <tr data-userid="${escapeHtml(u.userId || "")}" class="${u.userId === _selectedUserId ? "is-selected" : ""}" style="cursor: pointer">
        <td>${escapeHtml(u.displayName || "")}</td>
        <td>${escapeHtml(u.login || "")}</td>
        <td>${escapeHtml(u.userId || "")}</td>
        <td>${escapeHtml(fmtDate(u.firstJoinedAtMs ?? u.firstSeenAtMs ?? u.firstSeenAt ?? ""))}</td>
        <td>${escapeHtml(fmtDate(u.lastJoinedAtMs ?? u.lastSeenAtMs ?? u.lastSeenAt ?? ""))}</td>
        <td style="text-align: right">
          <button class="vf-btn vf-btnSecondary" data-remove="${escapeHtml(u.userId || "")}" type="button">Remove</button>
        </td>
      </tr>`,
    )
    .join("");

  // Row selection
  for (const tr of elTbody.querySelectorAll("tr[data-userid]")) {
    tr.addEventListener("click", () => {
      const id = tr.getAttribute("data-userid") || "";
      if (!id) return;
      selectUser(id);
    });
  }

  for (const btn of elTbody.querySelectorAll("button[data-remove]")) {
    btn.addEventListener("click", async (e) => {
      // Don't trigger row selection when clicking Remove
      try {
        e.stopPropagation();
      } catch {
        // ignore
      }
      const id = btn.getAttribute("data-remove") || "";
      if (!id) return;

      if (!confirm("Remove this user from your streamer list?")) return;

      btn.disabled = true;
      try {
        await api.removeStreamerUser(id, _session.auth);
        toast("Removed.");
        await loadUsers();
      } catch (e) {
        console.error(e);
        toast(e?.message || "Remove failed.");
      } finally {
        btn.disabled = false;
      }
    });
  }
}

function getSelectedRoleId() {
  const v = String(elRoleFilter?.value || "all").trim();
  return v || "all";
}

function applyFilterAndRender() {
  const roleId = getSelectedRoleId();
  const total = Array.isArray(_allUsers) ? _allUsers.length : 0;

  let filtered = Array.isArray(_allUsers) ? _allUsers : [];

  if (roleId && roleId !== "all") {
    filtered = filtered.filter((u) => Array.isArray(u.roles) && u.roles.includes(roleId));
  }

  renderRows(filtered);

  if (elUserCount) {
    const n = filtered.length;
    const noun = n === 1 ? "user" : "users";
    const base = `${n} ${noun}`;

    if (roleId && roleId !== "all") {
      const roleName = _roleById.get(roleId)?.roleName || roleId;
      elUserCount.textContent = `${base} (filtered: ${roleName})`;
    } else {
      elUserCount.textContent = `${base}${total !== n ? ` (of ${total})` : ""}`;
    }
  }
}

function getUserById(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return Array.isArray(_allUsers) ? _allUsers.find((u) => u?.userId === id) || null : null;
}

function clearSelection() {
  _selectedUserId = "";
  _selectedDirty = false;
  setUserRolesMsg("");
  renderSelectedUserPanel();
  applyFilterAndRender();
}

function selectUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return;
  _selectedUserId = id;
  _selectedDirty = false;
  setUserRolesMsg("");
  renderSelectedUserPanel();
  // Re-render to update row highlight
  applyFilterAndRender();
}

function updateSaveButton() {
  if (!elSaveUserRolesBtn) return;
  elSaveUserRolesBtn.disabled = !_selectedUserId || !_selectedDirty;
}

function renderTwitchRoleChips(user) {
  if (!elTwitchRolesChips) return;
  const ids = Array.isArray(user?.roles) ? user.roles : [];
  if (!ids.length) {
    elTwitchRolesChips.innerHTML = `<span class="vf-small vf-muted">None</span>`;
    return;
  }

  elTwitchRolesChips.innerHTML = ids
    .map((id) => {
      const roleName = _roleById.get(id)?.roleName || id;
      return `<span class="vf-chip">${escapeHtml(roleName)}</span>`;
    })
    .join("");
}

function renderVfRoleToggles(user) {
  if (!elVfRolesWrap) return;

  elVfRolesWrap.classList.add("vf-toggleRow");
  elVfRolesWrap.innerHTML = "";

  const defs = Array.isArray(_vfRoleDefs) ? _vfRoleDefs : [];
  if (!defs.length) {
    if (elNoVfRolesNote) elNoVfRolesNote.hidden = false;
    updateSaveButton();
    return;
  }

  if (elNoVfRolesNote) elNoVfRolesNote.hidden = true;

  const assigned = new Set((Array.isArray(user?.vfRoles) ? user.vfRoles : []).map((r) => String(r || "").toLowerCase()));

  elVfRolesWrap.innerHTML = defs
    .slice()
    .sort((a, b) => String(a?.roleName || a?.roleId || "").localeCompare(String(b?.roleName || b?.roleId || "")))
    .map((r) => {
      const rid = String(r?.roleId || "").toLowerCase();
      const rn = r?.roleName || rid;
      const checked = assigned.has(rid) ? "checked" : "";
      return `
        <label class="vf-toggle" style="min-width: 220px">
          <input type="checkbox" data-roleid="${escapeHtml(rid)}" ${checked} />
          <span>${escapeHtml(rn)}</span>
        </label>`;
    })
    .join("");

  // Change tracking
  for (const cb of elVfRolesWrap.querySelectorAll("input[type=checkbox][data-roleid]")) {
    cb.addEventListener("change", () => {
      _selectedDirty = true;
      updateSaveButton();
    });
  }

  updateSaveButton();
}

function renderSelectedUserPanel() {
  const u = getUserById(_selectedUserId);
  const has = !!u;

  if (elClearSelectionBtn) elClearSelectionBtn.hidden = !has;

  if (!has) {
    if (elSelectedUserEmpty) elSelectedUserEmpty.hidden = false;
    if (elSelectedUserBody) elSelectedUserBody.hidden = true;
    if (elNoVfRolesNote) elNoVfRolesNote.hidden = true;
    if (elVfRolesWrap) elVfRolesWrap.innerHTML = "";
    if (elTwitchRolesChips) elTwitchRolesChips.innerHTML = "";
    _selectedDirty = false;
    updateSaveButton();
    return;
  }

  if (elSelectedUserEmpty) elSelectedUserEmpty.hidden = true;
  if (elSelectedUserBody) elSelectedUserBody.hidden = false;

  if (elSelectedUserName) elSelectedUserName.textContent = u.displayName || u.login || u.userId || "";
  if (elSelectedUserLogin) elSelectedUserLogin.textContent = u.login ? `@${u.login}` : "";
  if (elSelectedUserId) elSelectedUserId.textContent = u.userId || "";
  if (elSelectedUserFirst) elSelectedUserFirst.textContent = fmtDate(u.firstJoinedAtMs ?? u.firstSeenAtMs ?? u.firstSeenAt ?? "");
  if (elSelectedUserLast) elSelectedUserLast.textContent = fmtDate(u.lastJoinedAtMs ?? u.lastSeenAtMs ?? u.lastSeenAt ?? "");

  if (elSelectedUserAvatar) {
    const src = String(u.profileImageUrl || "").trim();
    if (src) {
      elSelectedUserAvatar.src = src;
      elSelectedUserAvatar.hidden = false;
    } else {
      elSelectedUserAvatar.removeAttribute("src");
      elSelectedUserAvatar.hidden = true;
    }
  }

  renderVfRoleToggles(u);
  renderTwitchRoleChips(u);
}

function getSelectedVfRoleIdsFromUI() {
  if (!elVfRolesWrap) return [];
  const out = [];
  for (const cb of elVfRolesWrap.querySelectorAll("input[type=checkbox][data-roleid]")) {
    if (!cb.checked) continue;
    const rid = String(cb.getAttribute("data-roleid") || "").trim();
    if (rid) out.push(rid);
  }
  return out;
}

async function saveSelectedUserRoles() {
  if (!_session?.auth) return;
  const u = getUserById(_selectedUserId);
  if (!u) return;

  setUserRolesMsg("");

  const roleIds = getSelectedVfRoleIdsFromUI();
  if (elSaveUserRolesBtn) elSaveUserRolesBtn.disabled = true;

  try {
    const res = await api.setStreamerUserVfRoles(u.userId, roleIds, _session.auth);
    const next = Array.isArray(res?.roleIds) ? res.roleIds : roleIds;
    u.vfRoles = next;

    _selectedDirty = false;
    updateSaveButton();

    const added = res?.summary?.added ?? 0;
    const removed = res?.summary?.removed ?? 0;
    toast(`Roles saved (+${added}, -${removed})`);
    setUserRolesMsg("Roles updated.");
  } catch (e) {
    console.error(e);
    const msg = e?.data?.message || e?.message || "Failed to update roles.";
    setUserRolesMsg(msg, true);
    toast(msg);
  } finally {
    updateSaveButton();
  }
}

function renderRoleOptions({ preserveSelection = true } = {}) {
  if (!elRoleFilter) return;

  const prev = preserveSelection ? getSelectedRoleId() : "all";

  elRoleFilter.innerHTML = "";

  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All Roles";
  elRoleFilter.appendChild(optAll);

  for (const r of _roleDefs) {
    const opt = document.createElement("option");
    opt.value = r.roleId;

    let label = r.roleName || r.roleId;
    const supported = r.supportedSync !== false;
    if (!supported) label += " (not supported yet)";

    const c = Number.isFinite(r.userCount) ? Number(r.userCount) : NaN;
    if (!Number.isNaN(c) && c > 0) label += ` (${c})`;

    opt.textContent = label;
    elRoleFilter.appendChild(opt);
  }

  // Restore selection if still present
  const values = new Set(Array.from(elRoleFilter.options).map((o) => o.value));
  elRoleFilter.value = values.has(prev) ? prev : "all";
}

async function loadRoles({ preserveSelection = true } = {}) {
  if (!_session?.auth) return;

  try {
    setRoleMsg("");

    const res = await api.listStreamerTwitchRoles(_session.auth);
    _roleDefs = Array.isArray(res?.roles) ? res.roles : [];
    _roleById = new Map(_roleDefs.map((r) => [r.roleId, r]));

    renderRoleOptions({ preserveSelection });

    if (elSyncRolesBtn) {
      elSyncRolesBtn.disabled = false;
    }
  } catch (e) {
    console.error(e);
    if (elSyncRolesBtn) elSyncRolesBtn.disabled = true;

    setRoleMsg(e?.data?.message || e?.message || "Failed to load Twitch roles.", true);

    // Still allow the table to load even if role list fails
    _roleDefs = [];
    _roleById = new Map();
  } finally {
    // Update the selected user panel (Twitch role chips)
    renderSelectedUserPanel();
  }
}

async function loadVfRoles() {
  if (!_session?.auth) return;

  try {
    // Keep custom-role errors separate from Twitch role errors
    setUserRolesMsg("");
    const res = await api.listStreamerVfRoles(_session.auth);
    _vfRoleDefs = Array.isArray(res?.roles) ? res.roles : [];
    _vfRoleById = new Map(_vfRoleDefs.map((r) => [String(r?.roleId || "").toLowerCase(), r]));
  } catch (e) {
    console.error(e);
    _vfRoleDefs = [];
    _vfRoleById = new Map();
    const msg = e?.data?.message || e?.message || "Failed to load ViewerFrenzy roles.";
    setUserRolesMsg(msg, true);
  } finally {
    // Update the selected user panel (checkbox list)
    renderSelectedUserPanel();
  }
}

async function loadUsers() {
  if (!_session?.auth) return;

  setLoading();

  try {
    const res = await api.listStreamerUsers(_session.auth);
    _allUsers = Array.isArray(res?.users) ? res.users : [];

    // Ensure arrays exist to simplify rendering/filtering.
    for (const u of _allUsers) {
      if (!Array.isArray(u.roles)) u.roles = [];
      if (!Array.isArray(u.vfRoles)) u.vfRoles = [];
    }

    // If the selected user disappeared (removed from streamer list), clear selection.
    if (_selectedUserId && !_allUsers.some((u) => u?.userId === _selectedUserId)) {
      _selectedUserId = "";
      _selectedDirty = false;
    }

    applyFilterAndRender();
    renderSelectedUserPanel();
  } catch (e) {
    console.error(e);

    const msg = e?.data?.message || e?.message || "Failed to load users.";

    if (elTbody) {
      elTbody.innerHTML = `<tr><td colspan="6" class="vf-muted">${escapeHtml(msg)}</td></tr>`;
    }

    if (elUserCount) {
      elUserCount.textContent = "0 users";
    }
  }
}

async function syncSelectedRole() {
  if (!_session?.auth) return;

  const roleId = getSelectedRoleId();

  if (roleId !== "all") {
    const role = _roleById.get(roleId);
    if (role && role.supportedSync === false) {
      setRoleMsg(`Sync is not supported for Twitch role: ${role.roleName || roleId}`, true);
      return;
    }
  }

  if (!_session.auth.twitchAccessToken || auth.isTwitchExpired(_session.auth)) {
    setRoleMsg(
      "Role sync requires a fresh Twitch login. Please log out and log back in, then try again.",
      true,
    );
    return;
  }

  if (elSyncRolesBtn) elSyncRolesBtn.disabled = true;
  setRoleMsg("");

  try {
    toast("Syncing…");

    const res = await api.syncStreamerTwitchRoles(roleId, _session.auth);

    const details = Array.isArray(res?.synced) ? res.synced : [];
    if (details.length) {
      const summary = details
        .map((d) => {
          const rn = d.roleName || d.roleId;
          const total = Number.isFinite(d.total) ? d.total : null;
          const added = Number.isFinite(d.added) ? d.added : null;
          const removed = Number.isFinite(d.removed) ? d.removed : null;

          const parts = [];
          if (total !== null) parts.push(`${total} total`);
          if (added !== null) parts.push(`+${added}`);
          if (removed !== null) parts.push(`-${removed}`);

          return `${rn}${parts.length ? ` (${parts.join(", ")})` : ""}`;
        })
        .join(" · ");

      setRoleMsg(`Sync complete: ${summary}`);
    } else {
      setRoleMsg("Sync complete.");
    }

    // Refresh role counts + user list (preserve selection)
    await loadRoles({ preserveSelection: true });
    await loadUsers();
  } catch (e) {
    console.error(e);
    setRoleMsg(e?.data?.message || e?.message || "Sync failed.", true);
  } finally {
    if (elSyncRolesBtn) elSyncRolesBtn.disabled = false;
  }
}

(async function init() {
  try {
    _session = await session.requireSession({ requireAuth: true, requireStreamer: true });

    // Selected user panel
    if (elClearSelectionBtn) {
      elClearSelectionBtn.addEventListener("click", clearSelection);
      elClearSelectionBtn.hidden = true;
    }
    if (elSaveUserRolesBtn) {
      elSaveUserRolesBtn.addEventListener("click", saveSelectedUserRoles);
      elSaveUserRolesBtn.disabled = true;
    }
    renderSelectedUserPanel();

    // Role UI
    if (elRoleFilter) {
      elRoleFilter.addEventListener("change", () => {
        setRoleMsg("");
        applyFilterAndRender();
      });
    }

    if (elSyncRolesBtn) {
      elSyncRolesBtn.addEventListener("click", syncSelectedRole);
      elSyncRolesBtn.disabled = true;
    }

    // Add user
    if (elAddBtn) {
      elAddBtn.addEventListener("click", async () => {
        const v = String(elAddInput?.value || "").trim();
        if (!v) return;

        setMsg("");
        elAddBtn.disabled = true;

        try {
          const res = await api.addStreamerUser(v, _session.auth);
          toast(res?.added ? "User added." : "Already in your list.");
          if (elAddInput) elAddInput.value = "";
          await loadUsers();
        } catch (e) {
          console.error(e);
          const msg = e?.data?.message || e?.message || "Add failed.";
          setMsg(msg, true);
          toast(msg);
        } finally {
          elAddBtn.disabled = false;
        }
      });
    }

    // Refresh
    if (elRefreshBtn) {
      elRefreshBtn.addEventListener("click", async () => {
        setMsg("");
        setRoleMsg("");
        setUserRolesMsg("");
        await loadRoles({ preserveSelection: true });
        await loadVfRoles();
        await loadUsers();
      });
    }

    // Initial load
    await loadRoles({ preserveSelection: false });
    await loadVfRoles();
    await loadUsers();
  } catch (e) {
    console.error(e);
    const msg = e?.data?.message || e?.message || "Unable to load streamer tools.";
    toast(msg);
    setMsg(msg, true);
    setRoleMsg(msg, true);
  }
})();
