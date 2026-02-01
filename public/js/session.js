import * as auth from "./auth.js";
import * as api from "./api.js";

let _cached = null;
let _pending = null;

/**
 * Loads and validates the current session.
 * - Reads token from localStorage
 * - Checks expiry
 * - Calls /api/v1/me to validate the token
 *
 * Returns:
 *   { auth, me } or null
 */
export async function loadSession() {
  if (_cached) return _cached;
  if (_pending) return _pending;

  _pending = (async () => {
    const a = auth.getAuth();
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
    } catch {
      // Invalid / revoked token (or network error)
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
 *
 * Options:
 * - requireAuth: if true (default), missing/invalid sessions will logout + redirect
 * - requireStreamer: if true, non-streamer accounts will be redirected to /mainmenu.html
 * - redirectTo: optional override for the auth redirect target
 */
export async function requireSession(
  {
    requireAuth = true,
    requireStreamer = false,
    redirectTo = "/index.html",
  } = {},
) {
  const s = await loadSession();

  if (!s) {
    if (requireAuth) {
      try {
        auth.logout();
      } catch {
        // ignore
      }
      window.location.replace(`${window.location.origin}${redirectTo}`);
    }
    return null;
  }

  if (requireStreamer && !s?.me?.isStreamer) {
    window.location.replace(`${window.location.origin}/mainmenu.html`);
    return null;
  }

  return s;
}

export function clearSession() {
  _cached = null;
  _pending = null;
  auth.logout();
}
