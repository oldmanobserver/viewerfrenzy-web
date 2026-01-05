import { clearExpectedState, readExpectedState, setAuthFromCallback } from "./auth.js";

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

    setStatus("Saving session…");

    setAuthFromCallback({
      accessToken,
      tokenType,
      scope,
      expiresInSeconds: expiresIn ? Number(expiresIn) : 0,
    });

    setStatus("Redirecting…");

    // Go back to the main app.
    window.location.replace(`${window.location.origin}/checking.html`);
  } catch (e) {
    showError(e?.message || String(e));
    setStatus("");
  }
})();
