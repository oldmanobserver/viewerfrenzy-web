import { loadAuth, saveAuth, clearAuth } from "./storage.js";

const OAUTH_STATE_KEY = "vf_oauth_state_v1";

export function getConfig() {
  const cfg = window.VF_CONFIG || {};
  return {
    twitchClientId: (cfg.twitchClientId || "").trim(),
    twitchScopes: (cfg.twitchScopes || "").trim(),
  };
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

export function buildAuthorizeUrl() {
  const cfg = getConfig();
  if (!cfg.twitchClientId || cfg.twitchClientId === "YOUR_TWITCH_CLIENT_ID") {
    throw new Error(
      "Twitch client id not set. Edit /public/config.js and set window.VF_CONFIG.twitchClientId.",
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

export function beginLoginRedirect() {
  const { url } = buildAuthorizeUrl();
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

export function logout() {
  clearAuth();
  clearExpectedState();
}
