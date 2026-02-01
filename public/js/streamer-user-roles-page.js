import * as session from "./session.js";
import * as api from "./api.js";
import { toast } from "./ui.js";

const elRoleNameInput = document.getElementById("vf-roleNameInput");
const elRoleIdInput = document.getElementById("vf-roleIdInput");
const elCreateRoleBtn = document.getElementById("vf-createRoleBtn");
const elRefreshRolesBtn = document.getElementById("vf-refreshRolesBtn");
const elRoleMsg = document.getElementById("vf-roleMsg");
const elRolesTbody = document.getElementById("vf-rolesTbody");

const elBulkRoleSelect = document.getElementById("vf-bulkRoleSelect");
const elBulkModeSelect = document.getElementById("vf-bulkModeSelect");
const elBulkRunBtn = document.getElementById("vf-bulkRunBtn");
const elBulkUsersTextarea = document.getElementById("vf-bulkUsersTextarea");
const elBulkMsg = document.getElementById("vf-bulkMsg");
const elBulkSummary = document.getElementById("vf-bulkSummary");

let _session = null;
let _roles = [];

function setMsg(el, text) {
  if (!el) return;
  const t = String(text || "").trim();
  el.textContent = t;
  el.hidden = !t;
}

function renderRolesTable() {
  if (!elRolesTbody) return;

  if (!_roles.length) {
    elRolesTbody.innerHTML = `<tr><td colspan="4" class="vf-muted">No custom roles yet.</td></tr>`;
    return;
  }

  elRolesTbody.innerHTML = _roles
    .map(
      (r) => `
      <tr data-roleid="${encodeURIComponent(r.roleId)}">
        <td>${escapeHtml(r.roleName)}</td>
        <td><code>${escapeHtml(r.roleId)}</code></td>
        <td>${Number(r.userCount || 0)}</td>
        <td style="white-space: nowrap">
          <button class="vf-btn vf-btnSecondary" data-action="rename" type="button">Rename</button>
          <button class="vf-btn vf-btnSecondary" data-action="delete" type="button">Delete</button>
        </td>
      </tr>`,
    )
    .join("");

  elRolesTbody.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", onRoleActionClick);
  });
}

function renderBulkRoleSelect() {
  if (!elBulkRoleSelect) return;
  const current = String(elBulkRoleSelect.value || "").trim();

  const opts = [
    `<option value="">Select a role…</option>`,
    ..._roles.map((r) => `<option value="${escapeHtml(r.roleId)}">${escapeHtml(r.roleName)} (${escapeHtml(r.roleId)})</option>`),
  ];

  elBulkRoleSelect.innerHTML = opts.join("");

  // Restore selection if possible
  if (current) {
    const has = _roles.some((r) => r.roleId === current);
    if (has) elBulkRoleSelect.value = current;
  }
}

async function loadRoles() {
  setMsg(elRoleMsg, "");
  try {
    const resp = await api.listStreamerVfRoles(_session.auth);
    _roles = Array.isArray(resp?.roles) ? resp.roles : [];
    renderRolesTable();
    renderBulkRoleSelect();
  } catch (err) {
    setMsg(elRoleMsg, err?.message || "Failed to load roles.");
    _roles = [];
    renderRolesTable();
    renderBulkRoleSelect();
  }
}

async function onCreateRole() {
  const roleName = String(elRoleNameInput?.value || "").trim();
  const roleId = String(elRoleIdInput?.value || "").trim();

  if (!roleName) {
    setMsg(elRoleMsg, "Role Name is required.");
    return;
  }

  setMsg(elRoleMsg, "");
  try {
    await api.createStreamerVfRole({ roleId, roleName }, _session.auth);
    toast("Role created");
    if (elRoleNameInput) elRoleNameInput.value = "";
    if (elRoleIdInput) elRoleIdInput.value = "";
    await loadRoles();
  } catch (err) {
    setMsg(elRoleMsg, err?.message || "Failed to create role.");
  }
}

async function onRoleActionClick(e) {
  const btn = e?.currentTarget;
  const tr = btn?.closest("tr");
  const roleId = decodeURIComponent(tr?.getAttribute("data-roleid") || "");
  const action = btn?.getAttribute("data-action");
  const role = _roles.find((r) => r.roleId === roleId);

  if (!roleId || !role) return;

  if (action === "rename") {
    const next = window.prompt("New role name:", role.roleName || role.roleId);
    const roleName = String(next || "").trim();
    if (!roleName || roleName === role.roleName) return;

    setMsg(elRoleMsg, "");
    try {
      await api.updateStreamerVfRole(roleId, { roleName }, _session.auth);
      toast("Role updated");
      await loadRoles();
    } catch (err) {
      setMsg(elRoleMsg, err?.message || "Failed to update role.");
    }
    return;
  }

  if (action === "delete") {
    const ok = window.confirm(
      `Delete role "${role.roleName}"?\n\nThis will remove the role and all users assigned to it.`,
    );
    if (!ok) return;

    setMsg(elRoleMsg, "");
    try {
      await api.deleteStreamerVfRole(roleId, _session.auth);
      toast("Role deleted");
      await loadRoles();
    } catch (err) {
      setMsg(elRoleMsg, err?.message || "Failed to delete role.");
    }
  }
}

function formatBulkSummary(resp) {
  const s = resp?.summary || {};
  const lines = [];

  lines.push(`Mode: ${s.mode || ""}`);
  lines.push(`Input entries: ${s.inputCount ?? 0}`);
  lines.push(`Resolved users: ${s.resolvedCount ?? 0}`);
  if ((s.unknownCount ?? 0) > 0) lines.push(`Unknown: ${s.unknownCount}`);
  lines.push(`Current members: ${s.currentCount ?? 0}`);
  lines.push(`Will add: ${s.willAdd ?? 0}`);
  lines.push(`Will remove: ${s.willRemove ?? 0}`);
  lines.push(`Will remain same: ${s.willRemainSame ?? 0}`);
  lines.push(`After: ${s.nextCount ?? 0}`);

  return lines.join(" · ");
}

function buildBulkConfirmText(roleId, resp) {
  const s = resp?.summary || {};
  const lines = [];
  lines.push(`Role: ${roleId}`);
  lines.push(`Mode: ${s.mode || ""}`);
  lines.push("");
  lines.push(`Input entries: ${s.inputCount ?? 0}`);
  lines.push(`Resolved users: ${s.resolvedCount ?? 0}`);
  lines.push(`Unknown entries: ${s.unknownCount ?? 0}`);
  lines.push("");
  lines.push(`Current members: ${s.currentCount ?? 0}`);
  lines.push(`Will add: ${s.willAdd ?? 0}`);
  lines.push(`Will remove: ${s.willRemove ?? 0}`);
  lines.push(`Will remain same: ${s.willRemainSame ?? 0}`);
  lines.push(`After: ${s.nextCount ?? 0}`);

  const unknown = Array.isArray(resp?.unknown) ? resp.unknown : [];
  if (unknown.length) {
    lines.push("");
    lines.push(`Unknown (ignored): ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? " …" : ""}`);
  }

  lines.push("");
  lines.push("Proceed?");
  return lines.join("\n");
}

async function onRunBulkUpdate() {
  setMsg(elBulkMsg, "");
  setMsg(elBulkSummary, "");
  if (elBulkSummary) elBulkSummary.hidden = true;

  const roleId = String(elBulkRoleSelect?.value || "").trim();
  const mode = String(elBulkModeSelect?.value || "add").trim();
  const usersRaw = String(elBulkUsersTextarea?.value || "");

  if (!roleId) {
    setMsg(elBulkMsg, "Select a role first.");
    return;
  }

  try {
    // 1) Dry run (preview)
    const preview = await api.bulkUpdateStreamerVfRole(roleId, { mode, usersRaw, dryRun: true }, _session.auth);
    const summaryText = formatBulkSummary(preview);
    if (elBulkSummary) {
      elBulkSummary.textContent = summaryText;
      elBulkSummary.hidden = false;
    }

    // Confirm
    const ok = window.confirm(buildBulkConfirmText(roleId, preview));
    if (!ok) return;

    // 2) Apply
    const applied = await api.bulkUpdateStreamerVfRole(roleId, { mode, usersRaw, dryRun: false }, _session.auth);
    setMsg(elBulkMsg, `Bulk update complete. Added: ${applied?.summary?.willAdd ?? 0}, Removed: ${applied?.summary?.willRemove ?? 0}`);
    toast("Bulk update complete");
    await loadRoles();
  } catch (err) {
    setMsg(elBulkMsg, err?.message || "Bulk update failed.");
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

async function init() {
  _session = await session.requireSession({ requireAuth: true, requireStreamer: true });
  if (!_session) return;

  elCreateRoleBtn?.addEventListener("click", onCreateRole);
  elRefreshRolesBtn?.addEventListener("click", loadRoles);
  elBulkRunBtn?.addEventListener("click", onRunBulkUpdate);

  await loadRoles();
}

init();
