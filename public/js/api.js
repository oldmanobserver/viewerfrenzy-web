function assertTypeSegment(type) {
  const t = (type || "").toLowerCase().trim();
  if (!t) throw new Error("Vehicle type required.");
  // basic allowlist (matches your server routes)
  const ok = ["ground", "resort", "space", "water", "trackfield", "winter"];
  if (!ok.includes(t)) throw new Error(`Unsupported vehicle type: ${type}`);
  return t;
}

async function apiFetch(path, { method = "GET", auth, body } = {}) {
  const headers = {
    Accept: "application/json",
  };

  if (auth && auth.accessToken) {
    headers.Authorization = `Bearer ${auth.accessToken}`;
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
