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
//  - user is subscribed to the configured broadcaster (e.g. oldmanobserver), OR
//  - user's login appears in /public/assets/vips.txt
//
// Implementation:
//  - The browser requests the viewer scope `user:read:subscriptions` during login.
//  - The server uses Helix "Check User Subscription" with the viewer's own token.
//
// Required env vars (Cloudflare Pages Functions):
//  - VF_TWITCH_BROADCASTER_LOGIN (e.g. "oldmanobserver")
// Optional:
//  - VF_TWITCH_CLIENT_ID (if unset, we use the client_id returned by /oauth2/validate)
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_BROADCASTER_LOGIN = "oldmanobserver";
const REQUIRED_SUB_SCOPE = "user:read:subscriptions";

let _vipCache = { fetchedAtMs: 0, set: null };
let _broadcasterCache = { fetchedAtMs: 0, login: "", id: "" };

function getEnvString(env, key) {
  const v = env?.[key];
  return typeof v === "string" ? v.trim() : "";
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

async function getBroadcasterId({ accessToken, clientId, broadcasterLogin }) {
  const login = (broadcasterLogin || DEFAULT_ALLOWED_BROADCASTER_LOGIN).toLowerCase().trim();
  const now = Date.now();

  if (_broadcasterCache.id && _broadcasterCache.login === login && now - _broadcasterCache.fetchedAtMs < 10 * 60_000) {
    return _broadcasterCache.id;
  }

  const url = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`;
  const resp = await fetch(url, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!resp.ok) return "";

  const json = await resp.json();
  const u = json?.data?.[0];
  const id = u?.id || "";
  if (id) _broadcasterCache = { fetchedAtMs: now, login, id };
  return id;
}

async function checkUserSubscription({ accessToken, clientId, broadcasterId, userId }) {
  // Helix "Check User Subscription" (viewer token)
  // Docs: https://dev.twitch.tv/docs/api/reference/#check-user-subscription
  // Behavior:
  //  - 200 OK  => subscribed
  //  - 404 Not Found => not subscribed
  // Requires: user access token with user:read:subscriptions scope. (We enforce this earlier.)
  const url =
    "https://api.twitch.tv/helix/subscriptions/user" +
    `?broadcaster_id=${encodeURIComponent(broadcasterId)}` +
    `&user_id=${encodeURIComponent(userId)}`;

  const resp = await fetch(url, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (resp.status === 200) {
    return { ok: true, subscribed: true };
  }

  if (resp.status === 404) {
    return { ok: true, subscribed: false };
  }

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
    error: body?.message || body?.error || `twitch_sub_check_failed_${resp.status}`,
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

  // Broadcaster this website is gated against.
  // We DO NOT require a broadcaster token; we only need to know *which* broadcaster/channel to check subscriptions for.
  // Configure via:
  //   - optional function parameter: broadcasterLogin
  //   - optional env: VF_TWITCH_BROADCASTER_LOGIN (login *or* numeric id)
  // If neither is set, we fall back to DEFAULT_ALLOWED_BROADCASTER_LOGIN ("oldmanobserver").
  const envBroadcasterLoginOrId = getEnvString(context.env, "VF_TWITCH_BROADCASTER_LOGIN");
  const allowedLoginOrId = (broadcasterLogin || envBroadcasterLoginOrId || DEFAULT_ALLOWED_BROADCASTER_LOGIN).trim();

  if (!allowedLoginOrId) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        { error: "server_misconfigured", message: "Broadcaster login is not configured." },
        500
      ),
    };
  }

  const allowedLower = allowedLoginOrId.toLowerCase();
  const allowedIsId = /^\d+$/.test(allowedLoginOrId);
  const broadcasterDisplay = allowedIsId ? allowedLoginOrId : allowedLower;
// Owner (the gated broadcaster) is always allowed
  if ((loginLower && !allowedIsId && loginLower === allowedLower) || (allowedIsId && v.user_id === allowedLoginOrId)) {
    return { ...auth, access: { allowed: true, reason: "broadcaster" } };
  }
  // VIP allowlist
  const vipSet = await loadVipSet(request);
  if (loginLower && vipSet.has(loginLower)) {
    return { ...auth, access: { allowed: true, reason: "vip_allowlist" } };
  }

  // Subscription check (viewer token)
  // The viewer must grant user:read:subscriptions.
  const scopes = Array.isArray(v?.scopes) ? v.scopes.map((s) => String(s).toLowerCase()) : [];

  if (!scopes.includes(REQUIRED_SUB_SCOPE)) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        {
          error: "missing_required_scope",
          message: "Your Twitch session is missing a required permission. Please log out and log in again.",
          required: {
            viewerScope: REQUIRED_SUB_SCOPE,
            broadcaster: broadcasterDisplay,
          },
        },
        401,
      ),
    };
  }

  
  const envClientId = getEnvString(context.env, "VF_TWITCH_CLIENT_ID") || v.client_id;
  const finalBroadcasterLogin = broadcasterDisplay;

  // Resolve the broadcaster id for the subscription check.
  // If VF_TWITCH_BROADCASTER_LOGIN is already a numeric id, we can skip the Helix lookup.
  const broadcasterId = allowedIsId
    ? allowedLoginOrId
    : await getBroadcasterId({
        accessToken: token,
        clientId: envClientId,
        broadcasterLogin: finalBroadcasterLogin,
      });
if (!broadcasterId) {
    return {
      ok: false,
      response: jsonResponse(request, { error: "access_gate_misconfigured", message: "broadcaster_not_found" }, 500),
    };
  }

  const sub = await checkUserSubscription({
    accessToken: token,
    clientId: envClientId,
    broadcasterId,
    userId: v.user_id,
  });

  if (sub.ok && sub.subscribed) {
    return { ...auth, access: { allowed: true, reason: "subscriber" } };
  }

  // If Twitch returns 401 here, the token is invalid or missing the required scope.
  // We already checked the scope list above, but keep this as a safe fallback.
  if (!sub.ok && sub.status === 401) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        {
          error: "twitch_unauthorized",
          message: "Your Twitch session is no longer authorized. Please log out and log in again.",
          details: sub.error || "twitch_unauthorized",
          required: {
            viewerScope: REQUIRED_SUB_SCOPE,
            broadcaster: finalBroadcasterLogin,
          },
        },
        401,
      ),
    };
  }

  // Unexpected failures
  if (!sub.ok) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        {
          error: "twitch_sub_check_failed",
          message: "Unable to verify your subscription right now.",
          details: sub.error || null,
        },
        502,
      ),
    };
  }

  // Not subscribed (and not VIP)
  return {
    ok: false,
    response: jsonResponse(
      request,
      {
        error: "access_denied",
        message: `Access is currently restricted during alpha/beta. Please subscribe to ${broadcasterDisplay} on Twitch to get access.`,
        details: "not_subscribed",
        required: {
          broadcaster: finalBroadcasterLogin,
          viewerScope: REQUIRED_SUB_SCOPE,
          vipFile: "/assets/vips.txt",
        },
      },
      403,
    ),
  };
}
