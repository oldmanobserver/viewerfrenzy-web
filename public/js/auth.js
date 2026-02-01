import { loadAuth, saveAuth, clearAuth } from "./storage.js";

const OAUTH_STATE_KEY = "vf_oauth_state_v1";

export function getConfig() {
  const cfg = window.VF_CONFIG || {};
  return {
    twitchClientId: (cfg.twitchClientId || "").trim(),
    twitchScopes: (cfg.twitchScopes || "").trim(),
  };
}

let _configPromise = null;

async function getConfigAsync() {
  const existing = window.VF_CONFIG || {};
  const twitchClientId = (existing.twitchClientId || "").trim();
  const twitchScopes = (existing.twitchScopes || "").trim();

  if (twitchClientId) {
    return { twitchClientId, twitchScopes };
  }

  if (_configPromise) return _configPromise;

  _configPromise = (async () => {
    const res = await fetch("/api/v1/public-config", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`Failed to load config from /api/v1/public-config: ${res.status} ${res.statusText}`);
    }

    const data = await res.json().catch(() => ({}));

    const cfg = {
      twitchClientId: (data.twitchClientId || "").trim(),
      twitchScopes: (data.twitchScopes || "").trim(),
    };

    // Cache it for the rest of this browser session
    window.VF_CONFIG = { ...(window.VF_CONFIG || {}), ...cfg };
    return cfg;
  })();

  return _configPromise;
}

export function getRedirectUri() {
  return `${window.location.origin}/callback.html`;
}

function randomState() {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  }
}

export async function buildAuthorizeUrl() {
  const cfg = await getConfigAsync();
  if (!cfg.twitchClientId || cfg.twitchClientId === "YOUR_TWITCH_CLIENT_ID") {
    throw new Error(
      "Twitch client id not set. Set TWITCH_CLIENT_ID in Cloudflare Pages environment variables (recommended) or set window.VF_CONFIG.twitchClientId in /public/config.js.",
    );
  }

  const state = randomState();
  sessionStorage.setItem(OAUTH_STATE_KEY, state);

  const params = new URLSearchParams({
    response_type: "token",
    client_id: cfg.twitchClientId,
    redirect_uri: getRedirectUri(),
    state,
  });

  // ViewerFrenzy requires this scope so the server can verify whether the user is
  // subscribed to the configured broadcaster (alpha/beta access gate).
  const REQUIRED = ["user:read:subscriptions"];

  const optional = String(cfg.twitchScopes || "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const merged = Array.from(new Set([...REQUIRED, ...optional]));
  if (merged.length) params.set("scope", merged.join(" "));

  return {
    url: `https://id.twitch.tv/oauth2/authorize?${params.toString()}`,
    state,
  };
}

export async function beginLoginRedirect() {
  const { url } = await buildAuthorizeUrl();
  window.location.assign(url);
}

export function readExpectedState() {
  try {
    return sessionStorage.getItem(OAUTH_STATE_KEY) || "";
  } catch {
    return "";
  }
}

export function clearExpectedState() {
  try {
    sessionStorage.removeItem(OAUTH_STATE_KEY);
  } catch {
    // ignore
  }
}

export function getAuth() {
  return loadAuth();
}

export function isExpired(auth, skewSeconds = 30) {
  if (!auth) return true;
  const exp = Number(auth.expiresAtUnix || 0);
  if (!exp) return false; // some flows might omit expires; treat as non-expiring
  const now = Math.floor(Date.now() / 1000);
  return now + Math.max(0, skewSeconds) >= exp;
}

export function setAuthFromCallback({ accessToken, tokenType, scope, expiresInSeconds }) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAtUnix = expiresInSeconds ? now + Number(expiresInSeconds) : 0;

  saveAuth({
    accessToken,
    tokenType: tokenType || "bearer",
    scope: scope || "",
    obtainedAtUnix: now,
    expiresAtUnix,
  });
}

// Preferred: after Twitch login, exchange Twitch token for a ViewerFrenzy session token (VF JWT)
// and store that instead of the Twitch token.
//
// We ALSO persist the original Twitch token (and its scopes/expiry) so streamer tools can
// call Twitch Helix endpoints that require broadcaster scopes (e.g., sync moderators/VIPs/editors).
export function setAuthFromVfSession({
  token,
  expiresAtUnix,
  twitchAccessToken,
  twitchTokenType,
  twitchScope,
  twitchExpiresAtUnix,
}) {
  const now = Math.floor(Date.now() / 1000);

  const existing = loadAuth() || {};

  const next = {
    ...existing,
    accessToken: token,
    tokenType: "vf",
    scope: "",
    obtainedAtUnix: now,
    expiresAtUnix: Number(expiresAtUnix || 0),
  };

  if (twitchAccessToken) {
    next.twitchAccessToken = twitchAccessToken;
    next.twitchTokenType = twitchTokenType || "bearer";
    next.twitchScope = twitchScope || "";
    next.twitchObtainedAtUnix = now;
    next.twitchExpiresAtUnix = Number(twitchExpiresAtUnix || 0);
  }

  saveAuth(next);
}

export function isTwitchExpired(auth, skewSeconds = 30) {
  if (!auth) return true;
  const exp = Number(auth.twitchExpiresAtUnix || 0);
  if (!exp) return false; // treat missing expiry as non-expiring
  const now = Math.floor(Date.now() / 1000);
  return now + Math.max(0, skewSeconds) >= exp;
}

export function logout() {
  clearAuth();
  clearExpectedState();
}
