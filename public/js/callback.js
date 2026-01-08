import { clearExpectedState, readExpectedState, setAuthFromVfSession, logout } from "./auth.js";

const elStatus = document.getElementById("vf-cbStatus");
const elError = document.getElementById("vf-cbError");

function setStatus(msg) {
  if (elStatus) elStatus.textContent = msg || "";
}

function showError(msg) {
  if (!elError) return;
  elError.hidden = !msg;
  elError.textContent = msg || "";
}

function parseHashParams() {
  const raw = window.location.hash || "";
  const s = raw.startsWith("#") ? raw.substring(1) : raw;
  return new URLSearchParams(s);
}

(async function main() {
  try {
    const p = parseHashParams();

    const err = p.get("error");
    if (err) {
      const desc = p.get("error_description") || "";
      showError(`Twitch login failed: ${err}${desc ? ` – ${desc}` : ""}`);
      setStatus("");
      return;
    }

    const accessToken = p.get("access_token");
    const tokenType = p.get("token_type") || "bearer";
    const scope = p.get("scope") || "";
    const expiresIn = p.get("expires_in") || "";
    const state = p.get("state") || "";

    if (!accessToken) {
      showError("No access token returned from Twitch.");
      setStatus("");
      return;
    }

    const expected = readExpectedState();
    clearExpectedState();

    if (expected && state && expected !== state) {
      showError("State check failed. Please try logging in again.");
      setStatus("");
      return;
    }

    setStatus("Exchanging session…");

    const exRes = await fetch("/api/v1/auth/twitch/exchange", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    });

    const exBodyText = await exRes.text();
    let exBody = null;
    try { exBody = exBodyText ? JSON.parse(exBodyText) : null; } catch { exBody = null; }

    if (!exRes.ok) {
      // Access denied -> send to the friendly no-access page.
      if (exRes.status === 403) {
        const msg = exBody?.message || "Access is currently restricted during alpha/beta.";
        const broadcaster = exBody?.required?.broadcaster || "";
        const detail = exBody?.details || "";
        try { logout(); } catch {}
        const u =
          `${window.location.origin}/no-access.html?msg=${encodeURIComponent(msg)}` +
          (broadcaster ? `&broadcaster=${encodeURIComponent(broadcaster)}` : "") +
          (detail ? `&detail=${encodeURIComponent(detail)}` : "");
        window.location.replace(u);
        return;
      }

      const msg = exBody?.message || exBody?.error || exBodyText || `Exchange failed (${exRes.status})`;
      showError(msg);
      setStatus("");
      return;
    }

    const vfToken = exBody?.token || "";
    const expiresAtUnix = Number(exBody?.expiresAtUnix || 0);

    if (!vfToken) {
      showError("Exchange succeeded but no session token was returned.");
      setStatus("");
      return;
    }

    setAuthFromVfSession({ token: vfToken, expiresAtUnix });

    setStatus("Redirecting…");

    // Go back to the main app.
    window.location.replace(`${window.location.origin}/checking.html`);
  } catch (e) {
    showError(e?.message || String(e));
    setStatus("");
  }
})();
