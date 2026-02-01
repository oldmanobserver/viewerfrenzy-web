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

let _session = null;
let _allUsers = [];
let _roleDefs = [];
let _roleById = new Map();

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

function setLoading() {
  if (elTbody) {
    elTbody.innerHTML = `<tr><td colspan="6" class="vf-muted">Loading…</td></tr>`;
  }
  if (elUserCount) {
    elUserCount.textContent = "Loading…";
  }
}

function fmtDate(ms) {
  const n = Number(ms || 0);
  if (!n) return "";
  try {
    return new Date(n).toLocaleString();
  } catch {
    return String(n);
  }
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
      <tr>
        <td>${escapeHtml(u.displayName || "")}</td>
        <td>${escapeHtml(u.login || "")}</td>
        <td>${escapeHtml(u.userId || "")}</td>
        <td>${escapeHtml(fmtDate(u.firstJoinedAtMs))}</td>
        <td>${escapeHtml(fmtDate(u.lastJoinedAtMs))}</td>
        <td style="text-align: right">
          <button class="vf-btn vf-btnSecondary" data-remove="${escapeHtml(u.userId || "")}" type="button">Remove</button>
        </td>
      </tr>`,
    )
    .join("");

  for (const btn of elTbody.querySelectorAll("button[data-remove]")) {
    btn.addEventListener("click", async () => {
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
  }
}

async function loadUsers() {
  if (!_session?.auth) return;

  setLoading();

  try {
    const res = await api.listStreamerUsers(_session.auth);
    _allUsers = Array.isArray(res?.users) ? res.users : [];

    // Ensure roles is always an array to simplify filtering.
    for (const u of _allUsers) {
      if (!Array.isArray(u.roles)) u.roles = [];
    }

    applyFilterAndRender();
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
        await loadRoles({ preserveSelection: true });
        await loadUsers();
      });
    }

    // Initial load
    await loadRoles({ preserveSelection: false });
    await loadUsers();
  } catch (e) {
    console.error(e);
    const msg = e?.data?.message || e?.message || "Unable to load streamer tools.";
    toast(msg);
    setMsg(msg, true);
    setRoleMsg(msg, true);
  }
})();
