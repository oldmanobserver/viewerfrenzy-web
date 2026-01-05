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
