import * as auth from "./auth.js";

const elStatus = document.getElementById("vf-checkingStatus");
const elDetail = document.getElementById("vf-checkingDetail");
const elError = document.getElementById("vf-checkingError");

const VF_DEBUG = new URLSearchParams(window.location.search).get("vfdebug") === "1";
const dbg = (...args) => {
  if (VF_DEBUG) console.log("[VF checking]", ...args);
};

function setStatus(msg) {
  if (!elStatus) return;
  elStatus.textContent = msg || "";
}

function setDetail(msg) {
  if (!elDetail) return;
  elDetail.hidden = !msg;
  elDetail.textContent = msg || "";
}

function setError(msg) {
  if (!elError) return;
  elError.hidden = !msg;
  elError.textContent = msg || "";
}

async function readBody(resp) {
  const text = await resp.text();
  if (!text) return { text: "", json: null };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function withDebug(url) {
  if (!VF_DEBUG) return url;
  const u = new URL(url, window.location.origin);
  u.searchParams.set("vfdebug", "1");
  return u.toString();
}

function redirect(toPath) {
  window.location.replace(`${window.location.origin}${toPath}`);
}

function encode(v) {
  return encodeURIComponent(v ?? "");
}

async function init() {
  setError("");

  const a = auth.getAuth();
  if (!a) {
    dbg("No auth in storage -> go to login");
    redirect("/index.html");
    return;
  }

  if (auth.isExpired(a)) {
    dbg("Auth expired -> logout");
    auth.logout();
    redirect("/index.html");
    return;
  }

  // ---------------------------------------------------------------------------
  // 1) Broadcaster auto-connect (server-side env decides who is broadcaster)
  // ---------------------------------------------------------------------------
  setStatus("Checking permissions…");
  setDetail("Checking streamer setup…");

  try {
    const stResp = await fetch(withDebug("/api/v1/admin/twitch/status"), {
      headers: { Authorization: `Bearer ${a.accessToken}` },
      cache: "no-store",
    });

    const stBody = await readBody(stResp);
    dbg("admin/twitch/status", stResp.status, stBody.json || stBody.text);

    if (stResp.status === 401) {
      // Token invalid
      auth.logout();
      redirect("/index.html");
      return;
    }

    if (stResp.ok) {
      const st = stBody.json || {};
      if (st?.connected === false) {
        setDetail("Connecting streamer permissions (one-time)…");

        const cResp = await fetch(withDebug("/api/v1/admin/twitch/connect"), {
          headers: {
            Authorization: `Bearer ${a.accessToken}`,
            Accept: "application/json",
          },
          cache: "no-store",
        });

        const cBody = await readBody(cResp);
        dbg("admin/twitch/connect", cResp.status, cBody.json || cBody.text);

        if (cResp.ok && cBody.json?.url) {
          // Redirect the browser to Twitch consent
          window.location.href = cBody.json.url;
          return;
        }

        // If connect fails, continue to access check (it might still work for VIP-only mode),
        // but show helpful debug info.
        setDetail("Streamer setup could not be verified. Continuing…");
      }
    }
    // 403 means "not the broadcaster" -> ignore and continue.
  } catch (e) {
    dbg("status/connect flow failed:", e);
    // Continue to access check anyway.
  }

  // ---------------------------------------------------------------------------
  // 2) Website access check (subscriber OR VIP)
  // ---------------------------------------------------------------------------
  setDetail("Checking subscriber/VIP access…");

  const accessResp = await fetch(withDebug("/api/v1/access"), {
    headers: { Authorization: `Bearer ${a.accessToken}`, Accept: "application/json" },
    cache: "no-store",
  });

  const accessBody = await readBody(accessResp);
  dbg("access", accessResp.status, accessBody.json || accessBody.text);

  if (accessResp.status === 401) {
    auth.logout();
    redirect("/index.html");
    return;
  }

  if (accessResp.ok) {
    setDetail("Access granted. Redirecting…");
    redirect("/mainmenu.html");
    return;
  }

  // 403 = not subscribed / not VIP
  if (accessResp.status === 403) {
    const msg =
      accessBody.json?.message ||
      "Access is currently restricted during alpha/beta. Please subscribe on Twitch to get access.";

    const broadcaster = accessBody.json?.required?.broadcaster || "";
    const detail = accessBody.json?.details || "";

    // IMPORTANT: clear auth so the site doesn't immediately re-check and bounce on next visit
    auth.logout();

    const url =
      `/no-access.html?msg=${encode(msg)}` +
      (broadcaster ? `&broadcaster=${encode(broadcaster)}` : "") +
      (detail ? `&detail=${encode(detail)}` : "") +
      (VF_DEBUG ? `&vfdebug=1` : "");

    redirect(url);
    return;
  }

  // Other errors (misconfiguration, etc.)
  const fallback =
    accessBody.json?.message ||
    accessBody.json?.error ||
    accessBody.text ||
    `Unexpected response (${accessResp.status})`;

  setError(`Unable to verify access right now. ${fallback}`);
  setDetail("");
}

init().catch((e) => {
  dbg("fatal:", e);
  setError(e?.message || String(e));
  setDetail("");
});
