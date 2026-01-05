// functions/_lib/twitchAuth.js
import { jsonResponse } from "./response.js";

/**
 * Extracts a Twitch user access token.
 * Supports:
 *  - Authorization: Bearer <token>
 *  - Authorization: OAuth <token>
 */
export function getAuthToken(request) {
  const h = request.headers.get("Authorization") || "";
  if (h.startsWith("Bearer ")) return h.slice("Bearer ".length).trim();
  if (h.startsWith("OAuth ")) return h.slice("OAuth ".length).trim();
  return "";
}

/**
 * Validates a Twitch token using:
 * GET https://id.twitch.tv/oauth2/validate
 *
 * Docs: returns { client_id, login, user_id, expires_in, scopes }
 */
export async function validateTwitchToken(token) {
  const resp = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` },
  });

  if (resp.status === 401) {
    return { ok: false, status: 401, error: "invalid_token" };
  }

  if (!resp.ok) {
    return { ok: false, status: 502, error: `twitch_validate_failed_${resp.status}` };
  }

  const data = await resp.json();
  if (!data?.user_id) {
    return { ok: false, status: 502, error: "twitch_validate_bad_response" };
  }

  return { ok: true, data };
}

/**
 * Best-effort: fetch extra Helix user data (display_name, profile_image_url, etc).
 *
 * This call does NOT require extra scopes for basic fields for the authenticated user.
 */
export async function tryGetHelixUser(token, clientId, userId) {
  try {
    const url = `https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`;
    const resp = await fetch(url, {
      headers: {
        "Client-ID": clientId,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!resp.ok) return null;

    const json = await resp.json();
    const u = json?.data?.[0];
    if (!u) return null;

    // Keep a small, stable subset for KV.
    return {
      id: u.id,
      login: u.login,
      display_name: u.display_name,
      broadcaster_type: u.broadcaster_type,
      description: u.description,
      profile_image_url: u.profile_image_url,
      offline_image_url: u.offline_image_url,
      created_at: u.created_at,
      view_count: u.view_count,
      type: u.type,
      // email is only present with the user:read:email scope; omit if missing
      email: u.email,
    };
  } catch {
    return null;
  }
}

/**
 * Validates the request and (best-effort) writes a user profile record to KV.
 *
 * Requires env.VF_KV_USERS to be bound.
 */
export async function requireTwitchUser(context) {
  const { request, env } = context;

  const token = getAuthToken(request);
  if (!token) {
    return { ok: false, response: jsonResponse(request, { error: "missing_authorization" }, 401) };
  }

  const validated = await validateTwitchToken(token);
  if (!validated.ok) {
    return { ok: false, response: jsonResponse(request, { error: validated.error }, validated.status) };
  }

  const v = validated.data;
  const nowIso = new Date().toISOString();

  const helixUser = await tryGetHelixUser(token, v.client_id, v.user_id);

  const record = {
    userId: v.user_id,
    login: v.login,
    clientId: v.client_id,
    scopes: v.scopes || [],
    expiresIn: v.expires_in,
    lastSeenAt: nowIso,
    helixUser,
  };

  // Best-effort KV write (don't fail the whole request if KV isn't bound yet).
  try {
    if (env?.VF_KV_USERS) {
      await env.VF_KV_USERS.put(v.user_id, JSON.stringify(record));
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    token,
    validated: v,
    user: record,
  };
}
// ---------------------------------------------------------------------------
// Website access gating (alpha/beta)
// Allow if:
//  - user is subscribed to the configured broadcaster (default: oldmanobserver), OR
//  - user's login appears in /public/assets/vips.txt
//
// IMPORTANT:
//  - We intentionally avoid requesting viewer permission to read subscriptions.
//    Instead, we check subscriptions using the broadcaster's own OAuth token with
//    the channel:read:subscriptions scope.
//
// Required env vars (Cloudflare Pages Functions):
//  - VF_TWITCH_CLIENT_ID
//  - VF_TWITCH_CLIENT_SECRET
//  - VF_TWITCH_BROADCASTER_ACCESS_TOKEN
//  - VF_TWITCH_BROADCASTER_REFRESH_TOKEN
// Optional:
//  - VF_TWITCH_BROADCASTER_LOGIN (default: oldmanobserver)
//  - VF_KV_TWITCH_AUTH (KV binding) to persist rotated tokens
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_BROADCASTER_LOGIN = "oldmanobserver";

let _vipCache = { fetchedAtMs: 0, set: null };
let _broadcasterCache = { fetchedAtMs: 0, login: "", id: "" };
let _broadcasterAuthCache = { fetchedAtMs: 0, accessToken: "", refreshToken: "" };

function getEnvString(env, key) {
  const v = env?.[key];
  return typeof v === "string" ? v.trim() : "";
}

async function readBroadcasterAuthFromKv(env) {
  try {
    if (!env?.VF_KV_TWITCH_AUTH) return null;
    const raw = await env.VF_KV_TWITCH_AUTH.get("broadcaster_auth");
    if (!raw) return null;
    const json = JSON.parse(raw);
    if (!json?.access_token || !json?.refresh_token) return null;
    return { accessToken: String(json.access_token), refreshToken: String(json.refresh_token) };
  } catch {
    return null;
  }
}

async function writeBroadcasterAuthToKv(env, { accessToken, refreshToken } = {}) {
  try {
    if (!env?.VF_KV_TWITCH_AUTH) return;
    await env.VF_KV_TWITCH_AUTH.put(
      "broadcaster_auth",
      JSON.stringify({
        access_token: accessToken,
        refresh_token: refreshToken,
        updated_at: new Date().toISOString(),
      }),
    );
  } catch {
    // ignore
  }
}

async function refreshBroadcasterToken(env, refreshToken) {
  const clientId = getEnvString(env, "VF_TWITCH_CLIENT_ID");
  const clientSecret = getEnvString(env, "VF_TWITCH_CLIENT_SECRET");

  if (!clientId || !clientSecret || !refreshToken) {
    return { ok: false, error: "broadcaster_auth_missing_env" };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!resp.ok) {
    let j = null;
    try {
      j = await resp.json();
    } catch {
      j = null;
    }
    return { ok: false, error: j?.message || j?.error || `broadcaster_token_refresh_failed_${resp.status}` };
  }

  const json = await resp.json();
  const accessToken = String(json?.access_token || "");
  const newRefreshToken = String(json?.refresh_token || refreshToken);
  if (!accessToken) return { ok: false, error: "broadcaster_token_refresh_bad_response" };

  _broadcasterAuthCache = {
    fetchedAtMs: Date.now(),
    accessToken,
    refreshToken: newRefreshToken,
  };

  // Persist rotated tokens if KV is configured
  await writeBroadcasterAuthToKv(env, { accessToken, refreshToken: newRefreshToken });

  return { ok: true, accessToken, refreshToken: newRefreshToken };
}

async function getBroadcasterAuth(env) {
  // Prefer KV if present (so refresh token rotation persists)
  const kvAuth = await readBroadcasterAuthFromKv(env);
  if (kvAuth?.accessToken && kvAuth?.refreshToken) {
    return kvAuth;
  }

  // Fall back to env secrets
  const accessToken = getEnvString(env, "VF_TWITCH_BROADCASTER_ACCESS_TOKEN");
  const refreshToken = getEnvString(env, "VF_TWITCH_BROADCASTER_REFRESH_TOKEN");
  if (accessToken && refreshToken) {
    // Warm the in-memory cache
    _broadcasterAuthCache = { fetchedAtMs: Date.now(), accessToken, refreshToken };
    return { accessToken, refreshToken };
  }

  // As a last resort, use any in-memory token from a prior refresh during this isolate lifetime
  if (_broadcasterAuthCache.accessToken && _broadcasterAuthCache.refreshToken) {
    return { accessToken: _broadcasterAuthCache.accessToken, refreshToken: _broadcasterAuthCache.refreshToken };
  }

  return null;
}

function parseVipText(text) {
  const set = new Set();
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    // allow inline comments
    const cleaned = line.split("#")[0].trim();
    if (!cleaned) continue;
    set.add(cleaned.toLowerCase());
  }
  return set;
}

async function loadVipSet(request) {
  const now = Date.now();
  if (_vipCache.set && now - _vipCache.fetchedAtMs < 60_000) return _vipCache.set;

  try {
    const url = new URL("/assets/vips.txt", request.url).toString();
    const resp = await fetch(url, {
      // cache at the edge for a short time
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (resp.ok) {
      const text = await resp.text();
      _vipCache = { fetchedAtMs: now, set: parseVipText(text) };
      return _vipCache.set;
    }
  } catch {
    // ignore
  }

  // fallback: empty set
  _vipCache = { fetchedAtMs: now, set: new Set() };
  return _vipCache.set;
}

async function getBroadcasterId({ request, broadcasterAccessToken, clientId, broadcasterLogin }) {
  const login = (broadcasterLogin || DEFAULT_ALLOWED_BROADCASTER_LOGIN).toLowerCase().trim();
  const now = Date.now();

  if (_broadcasterCache.id && _broadcasterCache.login === login && now - _broadcasterCache.fetchedAtMs < 10 * 60_000) {
    return _broadcasterCache.id;
  }

  const url = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`;
  const resp = await fetch(url, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${broadcasterAccessToken}`,
    },
  });
  if (!resp.ok) return "";

  const json = await resp.json();
  const u = json?.data?.[0];
  const id = u?.id || "";
  if (id) _broadcasterCache = { fetchedAtMs: now, login, id };
  return id;
}

async function checkUserSubscription({ broadcasterAccessToken, clientId, broadcasterId, userId }) {
  // Helix "Get Broadcaster Subscriptions" supports filtering by user_id.
  // Requires the broadcaster token to have channel:read:subscriptions.
  const url =
    "https://api.twitch.tv/helix/subscriptions" +
    `?broadcaster_id=${encodeURIComponent(broadcasterId)}` +
    `&user_id=${encodeURIComponent(userId)}`;

  const resp = await fetch(url, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${broadcasterAccessToken}`,
    },
  });

  if (resp.status === 200) {
    let j = null;
    try {
      j = await resp.json();
    } catch {
      j = null;
    }
    const total = Number(j?.total || 0);
    const has = total > 0 || (Array.isArray(j?.data) && j.data.length > 0);
    return { ok: true, subscribed: has };
  }

  // If the broadcaster token is invalid/expired, Twitch typically returns 401.
  if (resp.status === 401) {
    let j = null;
    try {
      j = await resp.json();
    } catch {
      j = null;
    }
    return { ok: false, subscribed: false, status: 401, error: j?.message || j?.error || "broadcaster_token_invalid" };
  }

  // Any other failure
  let body = null;
  try {
    body = await resp.json();
  } catch {
    body = null;
  }
  return {
    ok: false,
    subscribed: false,
    status: resp.status,
    error: body?.message || body?.error || `twitch_broadcaster_sub_check_failed_${resp.status}`,
  };
}

/**
 * Like requireTwitchUser, but also enforces alpha/beta website access.
 * Returns 403 if the user is not subscribed (or missing the required scope) and not in vips.txt.
 */
export async function requireWebsiteUser(context, { broadcasterLogin } = {}) {
  const auth = await requireTwitchUser(context);
  if (!auth.ok) return auth;

  const { request } = context;
  const token = auth.token;
  const v = auth.validated;
  const user = auth.user;

  const loginLower = (user?.login || "").toLowerCase().trim();
  const envBroadcasterLogin = getEnvString(context.env, "VF_TWITCH_BROADCASTER_LOGIN");
  const allowedLogin = (broadcasterLogin || envBroadcasterLogin || "").toLowerCase().trim();

  if (!allowedLogin) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        { error: "server_misconfigured", message: "Missing VF_TWITCH_BROADCASTER_LOGIN env var." },
        500
      ),
    };
  }


  // Owner always allowed
  if (loginLower && loginLower === allowedLogin) {
    return { ...auth, access: { allowed: true, reason: "broadcaster" } };
  }

  // VIP allowlist
  const vipSet = await loadVipSet(request);
  if (loginLower && vipSet.has(loginLower)) {
    return { ...auth, access: { allowed: true, reason: "vip_allowlist" } };
  }

  // Subscription check (using broadcaster token; viewers are not asked for subscription scopes)
  const envClientId = getEnvString(context.env, "VF_TWITCH_CLIENT_ID") || v.client_id;
  const envBroadcasterLogin = getEnvString(context.env, "VF_TWITCH_BROADCASTER_LOGIN");
  const finalBroadcasterLogin = envBroadcasterLogin || allowedLogin;

  const broadcasterAuth = await getBroadcasterAuth(context.env);
  if (!broadcasterAuth?.accessToken || !broadcasterAuth?.refreshToken) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        {
          error: "access_gate_misconfigured",
          message: "broadcaster_auth_missing",
          requiredEnv: [
            "VF_TWITCH_CLIENT_ID",
            "VF_TWITCH_CLIENT_SECRET",
            "VF_TWITCH_BROADCASTER_ACCESS_TOKEN",
            "VF_TWITCH_BROADCASTER_REFRESH_TOKEN",
          ],
        },
        500,
      ),
    };
  }

  const broadcasterId = await getBroadcasterId({
    request,
    broadcasterAccessToken: broadcasterAuth.accessToken,
    clientId: envClientId,
    broadcasterLogin: finalBroadcasterLogin,
  });

  if (!broadcasterId) {
    return {
      ok: false,
      response: jsonResponse(request, { error: "access_gate_misconfigured", message: "broadcaster_not_found" }, 500),
    };
  }

  let sub = await checkUserSubscription({
    broadcasterAccessToken: broadcasterAuth.accessToken,
    clientId: envClientId,
    broadcasterId,
    userId: v.user_id,
  });

  // If the broadcaster token is expired/invalid, refresh and retry once.
  if (!sub.ok && sub.status === 401) {
    const refreshed = await refreshBroadcasterToken(context.env, broadcasterAuth.refreshToken);
    if (refreshed.ok) {
      sub = await checkUserSubscription({
        broadcasterAccessToken: refreshed.accessToken,
        clientId: envClientId,
        broadcasterId,
        userId: v.user_id,
      });
    }
  }

  if (sub.ok && sub.subscribed) {
    return { ...auth, access: { allowed: true, reason: "subscriber" } };
  }

  // Not subscribed (and not VIP)
  return {
    ok: false,
    response: jsonResponse(
      request,
      {
        error: "access_denied",
        message: `Access is currently restricted during alpha/beta. Please subscribe to ${allowedLogin} on Twitch to get access.`,
        details: sub.ok ? "not_subscribed" : sub.error,
        required: {
          broadcaster: finalBroadcasterLogin,
          broadcasterScope: "channel:read:subscriptions",
          vipFile: "/assets/vips.txt",
        },
      },
      403,
    ),
  };
}

// ---------------------------------------------------------------------------
// Admin OAuth helpers (broadcaster connect)
// ---------------------------------------------------------------------------

function makeRandomState() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Returns whether broadcaster auth is already configured (via KV or env).
 * Only intended for the broadcaster/admin UI flow.
 */
export async function getBroadcasterAuthStatus(env) {
  const fromKv = await readBroadcasterAuthFromKv(env);
  const envAccess = getEnvString(env, "VF_TWITCH_BROADCASTER_ACCESS_TOKEN");
  const envRefresh = getEnvString(env, "VF_TWITCH_BROADCASTER_REFRESH_TOKEN");

  const connected = Boolean(fromKv?.accessToken && fromKv?.refreshToken) || (Boolean(envAccess) && Boolean(envRefresh));

  return {
    ok: true,
    connected,
    hasKv: Boolean(env?.VF_KV_TWITCH_AUTH),
    source: fromKv?.accessToken ? "kv" : envAccess ? "env" : "none",
  };
}

/**
 * Starts an OAuth connect flow for the broadcaster (admin).
 * Stores a short-lived CSRF state in KV and returns the Twitch authorize URL.
 */
export async function buildBroadcasterConnectUrl(env, { redirectUri, broadcasterLogin } = {}) {
  const clientId = getEnvString(env, "VF_TWITCH_CLIENT_ID");

  const envBroadcasterLogin = getEnvString(env, "VF_TWITCH_BROADCASTER_LOGIN");
  const finalBroadcasterLogin = (broadcasterLogin || envBroadcasterLogin || "").toLowerCase();

  if (!finalBroadcasterLogin) {
    return { ok: false, status: 500, error: "missing_broadcaster_login", message: "Missing VF_TWITCH_BROADCASTER_LOGIN env var." };
  }

  if (!clientId) return { ok: false, status: 500, error: "missing_client_id" };
  if (!redirectUri) return { ok: false, status: 500, error: "missing_redirect_uri" };

  if (!env?.VF_KV_TWITCH_AUTH) {
    return { ok: false, status: 500, error: "missing_kv_binding", message: "KV binding VF_KV_TWITCH_AUTH is required for automatic broadcaster connect." };
  }

  const state = makeRandomState();
  await env.VF_KV_TWITCH_AUTH.put(`oauth_state:${state}`, JSON.stringify({ broadcasterLogin: finalBroadcasterLogin, createdAtMs: Date.now() }), { expirationTtl: 600 });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "channel:read:subscriptions",
    state,
  });

  return { ok: true, url: `https://id.twitch.tv/oauth2/authorize?${params.toString()}` };
}

/**
 * Completes the broadcaster OAuth connect flow by exchanging the code for tokens.
 * Persists tokens to KV (required). Also updates in-memory cache.
 */
export async function storeBroadcasterAuthFromCallback(env, { code, state, redirectUri } = {}) {
  const clientId = getEnvString(env, "VF_TWITCH_CLIENT_ID");
  const clientSecret = getEnvString(env, "VF_TWITCH_CLIENT_SECRET");
  if (!clientId || !clientSecret) return { ok: false, status: 500, error: "missing_client_credentials" };
  if (!env?.VF_KV_TWITCH_AUTH) return { ok: false, status: 500, error: "missing_kv_binding" };
  if (!code) return { ok: false, status: 400, error: "missing_code" };
  if (!state) return { ok: false, status: 400, error: "missing_state" };
  if (!redirectUri) return { ok: false, status: 500, error: "missing_redirect_uri" };

  // Validate and consume state (CSRF protection)
  const raw = await env.VF_KV_TWITCH_AUTH.get(`oauth_state:${state}`);
  if (!raw) return { ok: false, status: 400, error: "invalid_state" };
  await env.VF_KV_TWITCH_AUTH.delete(`oauth_state:${state}`);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const resp = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }

  if (!resp.ok || !data?.access_token || !data?.refresh_token) {
    return { ok: false, status: 502, error: "oauth_exchange_failed", details: data || null };
  }

  const accessToken = String(data.access_token || "");
  const refreshToken = String(data.refresh_token || "");

  await writeBroadcasterAuthToKv(env, { accessToken, refreshToken });

  // Update in-memory cache immediately
  _broadcasterAuthCache = { fetchedAtMs: Date.now(), accessToken, refreshToken };

  return { ok: true };
}
