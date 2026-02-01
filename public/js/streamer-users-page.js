import { requireSession } from "./session.js";
import * as api from "./api.js";
import { toast } from "./ui.js";

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtIsoLocal(iso) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return "";
  try {
    return new Date(t).toLocaleString();
  } catch {
    return String(iso || "");
  }
}

function setMsg(text, { isError = false } = {}) {
  const el = document.getElementById("vf-addUserMsg");
  if (!el) return;
  el.textContent = text || "";
  el.hidden = !text;
  el.classList.toggle("vf-alertError", !!isError);
}

function setLoadingRow(text) {
  const tbody = document.getElementById("vf-usersTbody");
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="6" class="vf-muted">${escapeHtml(text || "Loading…")}</td></tr>`;
}

function renderRows(users) {
  const tbody = document.getElementById("vf-usersTbody");
  if (!tbody) return;

  const rows = Array.isArray(users) ? users : [];
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="vf-muted">No users yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((u) => {
      const userId = escapeHtml(u?.userId || "");
      const login = escapeHtml(u?.login || "");
      const display = escapeHtml(u?.displayName || u?.login || u?.userId || "Viewer");
      const first = escapeHtml(fmtIsoLocal(u?.firstSeenAt));
      const last = escapeHtml(fmtIsoLocal(u?.lastSeenAt));

      return `
        <tr data-userid="${userId}">
          <td>${display}</td>
          <td>${login}</td>
          <td>${userId}</td>
          <td>${first}</td>
          <td>${last}</td>
          <td style="text-align: right">
            <button class="vf-btn vf-btnSecondary" data-action="remove" data-userid="${userId}" type="button">Remove</button>
          </td>
        </tr>
      `;
    })
    .join("");
}

async function init() {
  const session = await requireSession();
  if (!session) return;

  const me = session.me || null;
  if (!me?.isStreamer) {
    toast("Streamer tools are not available for this account.");
    window.location.replace(`${window.location.origin}/mainmenu.html`);
    return;
  }

  const addInput = document.getElementById("vf-addUserInput");
  const addBtn = document.getElementById("vf-addUserBtn");
  const refreshBtn = document.getElementById("vf-refreshBtn");
  const countEl = document.getElementById("vf-userCount");

  let loading = false;

  async function loadUsers() {
    if (loading) return;
    loading = true;
    setMsg("");
    setLoadingRow("Loading…");
    if (countEl) countEl.textContent = "Loading…";

    try {
      const resp = await api.listStreamerUsers(session.auth);
      const users = Array.isArray(resp?.users) ? resp.users : [];
      renderRows(users);
      if (countEl) countEl.textContent = `${users.length} user${users.length === 1 ? "" : "s"}`;
    } catch (e) {
      console.error(e);
      setLoadingRow("Failed to load users.");
      if (countEl) countEl.textContent = "Failed to load";
      toast("Failed to load streamer users");
    } finally {
      loading = false;
    }
  }

  async function addUser() {
    const raw = String(addInput?.value || "").trim();
    if (!raw) {
      setMsg("Enter a Twitch login or numeric user id.", { isError: true });
      return;
    }

    if (loading) return;
    loading = true;
    setMsg("Adding user…");

    try {
      await api.addStreamerUser(raw, session.auth);
      setMsg("User added.");
      if (addInput) addInput.value = "";
      await loadUsers();
    } catch (e) {
      console.error(e);
      setMsg(e?.data?.message || e?.message || "Failed to add user.", { isError: true });
      toast("Failed to add user");
    } finally {
      loading = false;
    }
  }

  async function removeUser(viewerUserId) {
    const id = String(viewerUserId || "").trim();
    if (!id) return;

    if (!window.confirm("Remove this user from your streamer list?")) return;

    if (loading) return;
    loading = true;
    setMsg("Removing user…");

    try {
      await api.removeStreamerUser(id, session.auth);
      setMsg("User removed.");
      await loadUsers();
    } catch (e) {
      console.error(e);
      setMsg(e?.data?.message || e?.message || "Failed to remove user.", { isError: true });
      toast("Failed to remove user");
    } finally {
      loading = false;
    }
  }

  addBtn?.addEventListener("click", addUser);
  refreshBtn?.addEventListener("click", loadUsers);
  addInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addUser();
  });

  // Delegated remove buttons
  document.getElementById("vf-usersTbody")?.addEventListener("click", (e) => {
    const target = e.target;
    if (!target || typeof target !== "object") return;
    const btn = target.closest?.("button[data-action='remove']");
    if (!btn) return;
    const id = btn.getAttribute("data-userid") || "";
    removeUser(id);
  });

  await loadUsers();
}

init();
