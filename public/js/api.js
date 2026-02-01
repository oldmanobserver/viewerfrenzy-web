function assertTypeSegment(type) {
  const t = (type || "").toLowerCase().trim();
  if (!t) throw new Error("Vehicle type required.");
  // basic allowlist (matches your server routes)
  const ok = ["ground", "resort", "space", "water", "trackfield", "winter"];
  if (!ok.includes(t)) throw new Error(`Unsupported vehicle type: ${type}`);
  return t;
}

async function apiFetch(path, { method = "GET", auth, body, preferTwitchToken = false } = {}) {
  const headers = {
    Accept: "application/json",
  };

  if (auth) {
    const token = (preferTwitchToken && auth.twitchAccessToken) ? auth.twitchAccessToken : auth.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  } else {
    // best-effort read text to include in thrown error
    try {
      data = await res.text();
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const err = new Error(
      typeof data === "string"
        ? data
        : data?.error || data?.message || `HTTP ${res.status}`,
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function getMe(auth) {
  return apiFetch("/api/v1/me", { method: "GET", auth });
}

export async function getVehicleDefault(type, auth) {
  const t = assertTypeSegment(type);
  return apiFetch(`/api/v1/vehicle-defaults/${t}`, { method: "GET", auth });
}

export async function putVehicleDefault(type, vehicleId, auth) {
  const t = assertTypeSegment(type);
  const now = Math.floor(Date.now() / 1000);

  return apiFetch(`/api/v1/vehicle-defaults/${t}`, {
    method: "PUT",
    auth,
    body: {
      vehicleId: vehicleId ?? "",
      clientUpdatedAtUnix: now,
    },
  });
}

// Public: Vehicle eligibility + default pools (role-based)
export async function getVehiclePools() {
  return apiFetch("/api/v1/vehicle-pools", { method: "GET" });
}


// Public: Seasons list
export async function getSeasons() {
  return apiFetch("/api/v1/seasons", { method: "GET" });
}

// Public: Stats meta (distinct streamers + maps)
export async function getStatsMeta(query = {}) {
  const u = new URL("/api/v1/stats/meta", window.location.origin);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    u.searchParams.set(k, s);
  }
  return apiFetch(u.pathname + (u.search ? u.search : ""), { method: "GET" });
}

// Public: Leaderboard / stats
// query example:
//   { seasonId, streamerId, mapId, streamerSearch, viewerSearch, mapSearch, sortBy, sortDir, page, pageSize }
export async function getLeaderboard(query = {}) {
  const u = new URL("/api/v1/stats/leaderboard", window.location.origin);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (!s) continue;
    u.searchParams.set(k, s);
  }
  return apiFetch(u.pathname + (u.search ? u.search : ""), { method: "GET" });
}

// Authenticated: Achievements + progress for current user
export async function getMyAchievementProgress(auth) {
  return apiFetch("/api/v1/me/achievement-progress", { method: "GET", auth });
}

// Authenticated: list achievements already unlocked by current user
export async function getMyUnlockedAchievements(auth) {
  return apiFetch("/api/v1/me/achievements", { method: "GET", auth });
}

// Public: list active (non-hidden) achievements.
export async function getAchievements() {
  return apiFetch("/api/v1/achievements", { method: "GET" });
}

// Authenticated: Streamer tools
export async function listStreamerUsers(auth) {
  return apiFetch("/api/v1/streamer/users", { method: "GET", auth });
}

export async function listStreamerTwitchRoles(auth) {
  return apiFetch("/api/v1/streamer/twitch-roles", { method: "GET", auth });
}

export async function syncStreamerTwitchRoles(roleId, auth) {
  const rid = String(roleId || "all").trim() || "all";
  return apiFetch("/api/v1/streamer/twitch-roles/sync", {
    method: "POST",
    auth,
    preferTwitchToken: true,
    body: { roleId: rid },
  });
}

export async function addStreamerUser(loginOrId, auth) {
  return apiFetch("/api/v1/streamer/users", {
    method: "POST",
    auth,
    body: { loginOrId: loginOrId ?? "" },
  });
}

export async function removeStreamerUser(viewerUserId, auth) {
  const id = String(viewerUserId || "").trim();
  if (!id) throw new Error("viewerUserId required");
  return apiFetch(`/api/v1/streamer/users/${encodeURIComponent(id)}`, { method: "DELETE", auth });
}

// ---------------------------------------------------------------------------
// Streamer tools: ViewerFrenzy custom roles (streamer-scoped)
// ---------------------------------------------------------------------------

export async function listStreamerVfRoles(auth) {
  return apiFetch("/api/v1/streamer/roles", { method: "GET", auth });
}

export async function createStreamerVfRole({ roleId = "", roleName = "" } = {}, auth) {
  return apiFetch("/api/v1/streamer/roles", {
    method: "POST",
    auth,
    body: {
      roleId,
      roleName,
    },
  });
}

export async function updateStreamerVfRole(roleId, { roleName = "" } = {}, auth) {
  const rid = String(roleId || "").trim();
  if (!rid) throw new Error("roleId required");
  return apiFetch(`/api/v1/streamer/roles/${encodeURIComponent(rid)}`, {
    method: "PUT",
    auth,
    body: { roleName },
  });
}

export async function deleteStreamerVfRole(roleId, auth) {
  const rid = String(roleId || "").trim();
  if (!rid) throw new Error("roleId required");
  return apiFetch(`/api/v1/streamer/roles/${encodeURIComponent(rid)}`, { method: "DELETE", auth });
}

export async function bulkUpdateStreamerVfRole(roleId, { mode = "add", usersRaw = "", dryRun = true } = {}, auth) {
  const rid = String(roleId || "").trim();
  if (!rid) throw new Error("roleId required");
  return apiFetch(`/api/v1/streamer/roles/${encodeURIComponent(rid)}/bulk`, {
    method: "POST",
    auth,
    body: { mode, usersRaw, dryRun: !!dryRun },
  });
}

export async function getStreamerUserVfRoles(viewerUserId, auth) {
  const id = String(viewerUserId || "").trim();
  if (!id) throw new Error("viewerUserId required");
  return apiFetch(`/api/v1/streamer/user-roles/${encodeURIComponent(id)}`, { method: "GET", auth });
}

export async function setStreamerUserVfRoles(viewerUserId, roleIds = [], auth) {
  const id = String(viewerUserId || "").trim();
  if (!id) throw new Error("viewerUserId required");
  return apiFetch(`/api/v1/streamer/user-roles/${encodeURIComponent(id)}`, {
    method: "PUT",
    auth,
    body: { roleIds },
  });
}
