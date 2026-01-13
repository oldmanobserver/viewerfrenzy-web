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

function formatDate(ms) {
  const n = Number(ms) || 0;
  if (!n) return "";
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return "";
  // Friendly, local format
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function pct(p01) {
  const n = Number(p01);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

function classify(a) {
  const unlocked = Number(a?.unlockedAtMs || 0) > 0;
  const eligible = !unlocked && !!a?.eligibleNow;
  const hasAnyProgress = !!a?.hasAnyProgress || pct(a?.overallProgress01) > 0;

  if (unlocked) return "completed";
  if (eligible) return "eligible";
  if (hasAnyProgress) return "progress";
  return "none";
}

function buildCounts(list) {
  const counts = { total: 0, completed: 0, eligible: 0, progress: 0, none: 0 };
  const items = Array.isArray(list) ? list : [];
  counts.total = items.length;
  for (const a of items) {
    const c = classify(a);
    if (c in counts) counts[c] += 1;
  }
  return counts;
}

function matchesSearch(a, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return true;

  const name = String(a?.name || "").toLowerCase();
  const desc = String(a?.description || "").toLowerCase();
  if (name.includes(q) || desc.includes(q)) return true;

  // Also search requirement labels
  const reqs = Array.isArray(a?.requirements) ? a.requirements : [];
  for (const r of reqs) {
    const label = String(r?.metricLabel || r?.metric || "").toLowerCase();
    if (label.includes(q)) return true;
  }

  return false;
}

function filterList(list, state) {
  const items = Array.isArray(list) ? list : [];
  const filter = state.filter || "all";
  const search = state.search || "";

  return items.filter((a) => {
    if (!matchesSearch(a, search)) return false;

    const c = classify(a);

    if (filter === "all") return true;
    if (filter === "completed") return c === "completed";
    if (filter === "eligible") return c === "eligible";
    if (filter === "progress") return c === "progress";
    if (filter === "none") return c === "none";

    return true;
  });
}

function sortAchievements(list) {
  // Sort order:
  // 1) Eligible (ready to unlock) first
  // 2) In-progress next (higher progress first)
  // 3) No-progress
  // 4) Completed last (most recently unlocked first)
  const items = Array.isArray(list) ? [...list] : [];

  function groupRank(a) {
    const c = classify(a);
    if (c === "eligible") return 0;
    if (c === "progress") return 1;
    if (c === "none") return 2;
    if (c === "completed") return 3;
    return 9;
  }

  items.sort((a, b) => {
    const ga = groupRank(a);
    const gb = groupRank(b);
    if (ga !== gb) return ga - gb;

    // Within group
    if (ga === 0 || ga === 1 || ga === 2) {
      const pa = Number(a?.overallProgress01 || 0) || 0;
      const pb = Number(b?.overallProgress01 || 0) || 0;
      if (pb !== pa) return pb - pa;

      // More requirements satisfied first
      const sa = Number(a?.requirementsSatisfied || 0) || 0;
      const sb = Number(b?.requirementsSatisfied || 0) || 0;
      if (sb !== sa) return sb - sa;

      const ida = Number(a?.id || 0) || 0;
      const idb = Number(b?.id || 0) || 0;
      return ida - idb;
    }

    // Completed group: newest first
    const ua = Number(a?.unlockedAtMs || 0) || 0;
    const ub = Number(b?.unlockedAtMs || 0) || 0;
    if (ub !== ua) return ub - ua;

    const ida = Number(a?.id || 0) || 0;
    const idb = Number(b?.id || 0) || 0;
    return ida - idb;
  });

  return items;
}

function renderRequirement(r) {
  const label = escapeHtml(r?.metricLabel || r?.metric || "");
  const op = String(r?.op || "").trim();
  const current = Number(r?.current || 0) || 0;
  const target = Number(r?.target || 0) || 0;
  const satisfied = !!r?.satisfied;

  const icon = satisfied ? "✅" : "⬜";

  let valueText = "";
  if (op === ">=" || op === ">" || op === "==") {
    valueText = `${current} / ${target}`;
  } else if (op === "<=" || op === "<") {
    valueText = `${current} (must be ${escapeHtml(op)} ${target})`;
  } else if (op === "!=") {
    valueText = `${current} (must be != ${target})`;
  } else {
    valueText = `${current} ${escapeHtml(op)} ${target}`;
  }

  const p = pct(r?.progress01);

  return `
    <div class="vf-achReq">
      <div class="vf-achReqMain">
        <div class="vf-achReqLabel">${icon} ${label}</div>
        <div class="vf-achReqValue">${escapeHtml(valueText)}</div>
      </div>
      <div class="vf-achReqBar" role="progressbar" aria-label="${label} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}">
        <div class="vf-achReqBarFill" style="width: ${p}%;"></div>
      </div>
    </div>
  `;
}

function renderAchievementCard(a) {
  const name = escapeHtml(a?.name || "(Unnamed)");
  const desc = escapeHtml(a?.description || "");

  const unlockedAtMs = Number(a?.unlockedAtMs || 0) || 0;
  const unlocked = unlockedAtMs > 0;
  const eligible = !unlocked && !!a?.eligibleNow;

  const overall = pct(a?.overallProgress01);
  const sat = Number(a?.requirementsSatisfied || 0) || 0;
  const total = Number(a?.requirementsTotal || 0) || 0;

  let badge = "";
  if (unlocked) {
    badge = `<span class="vf-achBadge vf-achBadgeDone">Unlocked</span>`;
  } else if (eligible) {
    badge = `<span class="vf-achBadge vf-achBadgeEligible">Eligible</span>`;
  } else {
    badge = `<span class="vf-achBadge">${overall}%</span>`;
  }

  const meta = unlocked
    ? `<div class="vf-achMeta">Unlocked: ${escapeHtml(formatDate(unlockedAtMs))}</div>`
    : eligible
      ? `<div class="vf-achMeta">You meet the criteria. It will unlock next time the game submits results.</div>`
      : `<div class="vf-achMeta">${sat} / ${total} requirements complete</div>`;

  const reqs = Array.isArray(a?.requirements) ? a.requirements : [];

  const classes = ["vf-card", "vf-achCard"];
  if (unlocked) classes.push("is-unlocked");
  if (eligible) classes.push("is-eligible");

  return `
    <div class="${classes.join(" ")}">
      <div class="vf-achHeader">
        <div class="vf-achTitle">${name}</div>
        ${badge}
      </div>
      ${desc ? `<div class="vf-achDesc">${desc}</div>` : ""}

      <div class="vf-achOverall">
        <div class="vf-achOverallTop">
          <div class="vf-achOverallLabel">Overall progress</div>
          <div class="vf-achOverallPct">${unlocked ? "100%" : eligible ? "100%" : `${overall}%`}</div>
        </div>
        <div class="vf-progressBar" role="progressbar" aria-label="Overall achievement progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${unlocked ? 100 : eligible ? 100 : overall}">
          <div class="vf-progressFill" style="width: ${unlocked ? 100 : eligible ? 100 : overall}%;"></div>
        </div>
        ${meta}
      </div>

      <div class="vf-achReqs">
        ${reqs.length ? reqs.map(renderRequirement).join("") : `<div class="vf-muted">No requirements found.</div>`}
      </div>
    </div>
  `;
}

function renderShell(data, state) {
  const all = sortAchievements(Array.isArray(data?.achievements) ? data.achievements : []);
  const counts = buildCounts(all);
  const filtered = filterList(all, state);

  const filter = state.filter || "all";
  const search = state.search || "";

  // Chip helper
  function chip(label, value, count) {
    const active = filter === value;
    const cls = active ? "vf-chip is-active" : "vf-chip";
    return `<button class="${cls}" type="button" data-filter="${escapeHtml(value)}">${escapeHtml(label)} <span class="vf-muted">(${count})</span></button>`;
  }

  const summary = counts.total
    ? `${counts.completed} unlocked • ${counts.eligible} eligible • ${counts.progress} in progress • ${counts.none} not started`
    : "No achievements have been configured yet.";

  const listHtml = filtered.length
    ? `<div class="vf-achList">${filtered.map(renderAchievementCard).join("")}</div>`
    : `<div class="vf-card"><div class="vf-muted">No achievements match your filter/search.</div></div>`;

  return `
    <div class="vf-card vf-achFilters">
      <div class="vf-row" style="gap: 10px; align-items: flex-end;">
        <div style="min-width: 240px; flex: 1;">
          <div class="vf-fieldLabel">Search</div>
          <input id="vf-achSearch" class="vf-input" type="text" placeholder="Search achievements…" value="${escapeHtml(search)}" />
        </div>
        <div class="vf-spacer"></div>
        <button id="vf-achRefresh" class="vf-btn vf-btnSecondary" type="button" title="Refresh">Refresh</button>
      </div>

      <div class="vf-chipRow" style="margin-top: 12px;">
        ${chip("All", "all", counts.total)}
        ${chip("Unlocked", "completed", counts.completed)}
        ${chip("Eligible", "eligible", counts.eligible)}
        ${chip("In progress", "progress", counts.progress)}
        ${chip("Not started", "none", counts.none)}
      </div>

      <div class="vf-muted" style="margin-top: 10px;">${escapeHtml(summary)}</div>
    </div>

    ${listHtml}
  `;
}

async function init() {
  const root = document.getElementById("vf-achRoot");
  if (!root) return;

  root.innerHTML = `<div class="vf-card"><div class="vf-muted">Loading achievements…</div></div>`;

  const session = await requireSession();
  if (!session) return;

  const state = {
    filter: "all",
    search: "",
  };

  async function loadAndRender({ showToast = false } = {}) {
    try {
      const data = await api.getMyAchievementProgress(session.auth);
      if (!data?.ok) throw new Error("Bad response");

      root.innerHTML = renderShell(data, state);

      // Wire UI handlers (must re-bind after every re-render)
      function attachHandlers(latestData) {
        const searchEl = root.querySelector("#vf-achSearch");
        searchEl?.addEventListener("input", (e) => {
          state.search = String(e.target?.value || "");
          root.innerHTML = renderShell(latestData, state);
          attachHandlers(latestData);
        });

        // Filter chips
        root.querySelectorAll("[data-filter]").forEach((btn) => {
          btn.addEventListener("click", () => {
            state.filter = btn.getAttribute("data-filter") || "all";
            root.innerHTML = renderShell(latestData, state);
            attachHandlers(latestData);
          });
        });

        // Refresh
        root.querySelector("#vf-achRefresh")?.addEventListener("click", async () => {
          await loadAndRender({ showToast: true });
        });
      }

      attachHandlers(data);

      if (showToast) toast("Achievements refreshed");
    } catch (e) {
      root.innerHTML = `
        <div class="vf-card vf-alert vf-alertError">
          <div style="font-weight: 900;">Failed to load achievements</div>
          <div class="vf-muted" style="margin-top: 6px;">${escapeHtml(String(e?.message || e))}</div>
        </div>
      `;
    }
  }

  await loadAndRender();
}

init();
