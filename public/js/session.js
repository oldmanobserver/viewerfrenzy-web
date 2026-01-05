import * as auth from "./auth.js";
import * as api from "./api.js";

let _cached = null;
let _pending = null;

/**
 * Loads and validates the current session.
 * - Reads token from localStorage
 * - Checks expiry
 * - Calls /api/v1/me to validate token
 *
 * Returns:
 *   { auth, me } or null
 */
export async function loadSession() {
  if (_cached) return _cached;
  if (_pending) return _pending;

  _pending = (async () => {
    let a = auth.getAuth();
    if (!a) return null;

    if (auth.isExpired(a)) {
      auth.logout();
      return null;
    }

    try {



      const resp = await api.getMe(a);
      const me = resp?.user || null;
      if (!me) {
        auth.logout();
        return null;
      }

      // --- DEBUG helper (enable with ?vfdebug=1 in the URL) ---
      const VF_DEBUG = new URLSearchParams(window.location.search).get("vfdebug") === "1";
      const dbg = (...args) => { if (VF_DEBUG) console.log("[VF admin-connect]", ...args); };

      // Don’t try to auto-connect on login/callback pages (avoids loops)
      const path = (window.location.pathname || "").toLowerCase();
      const isAuthPage = path.endsWith("/index.html") || path.endsWith("/callback.html");

      // If broadcaster is logged in, ensure subscriber-check tokens are connected (KV)
      if (!isAuthPage && (me.login || "").toLowerCase() === "oldmanobserver") {
        try {
          dbg("Broadcaster detected. Checking /api/v1/admin/twitch/status ...");

          const resp2 = await fetch("/api/v1/admin/twitch/status?vfdebug=" + (VF_DEBUG ? "1" : "0"), {
            headers: { Authorization: `Bearer ${a.accessToken}` }, // <-- IMPORTANT
            cache: "no-store",
          });

          dbg("status HTTP", resp2.status);

          const text = await resp2.text();
          dbg("status body", text);

          if (resp2.ok) {
            const st = JSON.parse(text);
            if (st?.connected === false) {
              dbg("Not connected -> redirecting to /api/v1/admin/twitch/connect");
              window.location.href = "/api/v1/admin/twitch/connect?vfdebug=" + (VF_DEBUG ? "1" : "0");
              return null; // stop normal flow because we’re redirecting
            }
          }
        } catch (e) {
          dbg("status check failed:", e);
        }
      }

      _cached = { auth: a, me };
      return _cached;



    } catch (e) {
      // Invalid / revoked token
      auth.logout();
      return null;
    } finally {
      _pending = null;
    }
  })();

  return _pending;
}

/**
 * Requires a session for the current page.
 * If missing/invalid, logs out and redirects to /index.html.
 */
export async function requireSession() {
  const s = await loadSession();
  if (!s) {
    try { auth.logout(); } catch { /* ignore */ }
    window.location.replace(`${window.location.origin}/index.html`);
    return null;
  }
  return s;
}

export function clearSession() {
  _cached = null;
  _pending = null;
  auth.logout();
}
