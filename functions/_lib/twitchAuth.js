// functions/_lib/twitchAuth.js
import { jsonResponse } from "./response.js";
import { verifyJwtHs256 } from "./vfJwt.js";

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

function nowIso() {
  return new Date().toISOString();
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizeArrayStrings(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || "").trim()).filter(Boolean);
}

async function tryAuthFromVfJwt(context, token) {
  const secret = String(context?.env?.VF_JWT_SECRET || "").trim();
  if (!secret) return null;

  const verified = await verifyJwtHs256(token, secret).catch(() => null);
  if (!verified?.ok) return null;

  const p = verified.payload || {};

  // Optional audience/issuer checks (won't break older tokens if omitted).
  if (p.iss && p.iss !== "viewerfrenzy") return null;
  if (p.aud && p.aud !== "viewerfrenzy-web") return null;

  const userId = String(p.userId || p.sub || "").trim();
  const login = String(p.login || "").trim();
  if (!userId) return null;

  const exp = Number(p.exp || 0);
  const expiresIn = exp ? Math.max(0, exp - nowUnix()) : 0;

  const record = {
    userId,
    login,
    clientId: String(p.clientId || "vf_jwt").trim(),
    scopes: normalizeArrayStrings(p.scopes),
    expiresIn,
    lastSeenAt: nowIso(),
    helixUser: p.helixUser || null,
  };

  return {
    ok: true,
    token,
    validated: {
      client_id: record.clientId,
      login: record.login,
      user_id: record.userId,
      expires_in: expiresIn,
      scopes: record.scopes,
    },
    user: record,
    access: p.access || { allowed: true, reason: "session" },
    vfSession: true,
  };
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

  // ViewerFrenzy session JWT (VF JWT) support
  // If the token is already a VF session, we can authenticate without calling Twitch.
  const vf = await tryAuthFromVfJwt(context, token);
  if (vf?.ok) {
    // Best-effort KV write for lastSeen/profile
    try {
      if (env?.VF_KV_USERS) {
        await env.VF_KV_USERS.put(vf.user.userId, JSON.stringify(vf.user));
      }
    } catch {
      // ignore
    }
    return vf;
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
//  - user has at least one assigned role whose definition has ANY of these flags:
//      - Admin
//      - MOD
//      - VIP
//
// Role definitions + assignments are managed on manage.viewerfrenzy.com.
//
// Implementation:
//  - The browser requests the viewer scope `user:read:subscriptions` during login.
//  - The server uses Helix "Check User Subscription" with the viewer's own token.
//
// Required env vars (Cloudflare Pages Functions):
//  - VF_TWITCH_BROADCASTER_LOGIN (e.g. "oldmanobserver")
// Optional:
//  - VF_TWITCH_CLIENT_ID (legacy; NOT needed for this viewer-token flow)
//
// Required KV bindings to support role-based VIP access:
//  - VF_KV_ROLES
//  - VF_KV_USER_ROLES
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWED_BROADCASTER_LOGIN = "oldmanobserver";
const REQUIRED_SUB_SCOPE = "user:read:subscriptions";

let _broadcasterCache = { fetchedAtMs: 0, login: "", id: "" };
let _roleDefCache = new Map(); // roleId -> { fetchedAtMs, role }

function getEnvString(env, key) {
  const v = env?.[key];
  return typeof v === "string" ? v.trim() : "";
}

function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "y" || s === "on") return true;
    if (s === "false" || s === "0" || s === "no" || s === "n" || s === "off") return false;
  }
  return false;
}

function uniqueLower(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const v = String(item || "").trim().toLowerCase();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeRoleFlags(role, { roleId } = {}) {
  const id = String(role?.roleId || roleId || "").trim().toLowerCase();

  // Support legacy/alternate names too.
  const isAdmin = toBool(role?.isAdmin ?? role?.admin);
  const isMod = toBool(role?.isMod ?? role?.mod);
  const isVip = toBool(role?.isVip ?? role?.vip);

  // Back-compat: the built-in admin role is always admin.
  if (id === "admin") {
    return { isAdmin: true, isMod, isVip };
  }

  return { isAdmin, isMod, isVip };
}

async function getUserRoleIds(env, userId) {
  if (!env?.VF_KV_USER_ROLES) return [];
  try {
    const rec = await env.VF_KV_USER_ROLES.get(userId, { type: "json" });
    return uniqueLower(rec?.roles || []);
  } catch {
    return [];
  }
}

async function getRoleDef(env, roleId) {
  if (!env?.VF_KV_ROLES) return null;
  const id = String(roleId || "").trim().toLowerCase();
  if (!id) return null;

  const now = Date.now();
  const cached = _roleDefCache.get(id);
  if (cached && now - cached.fetchedAtMs < 60_000) {
    return cached.role;
  }

  try {
    const role = await env.VF_KV_ROLES.get(id, { type: "json" });
    _roleDefCache.set(id, { fetchedAtMs: now, role: role || null });
    return role || null;
  } catch {
    _roleDefCache.set(id, { fetchedAtMs: now, role: null });
    return null;
  }
}

async function isVipByRoleFlags(env, userId) {
  const roleIds = await getUserRoleIds(env, userId);
  if (!roleIds.length) return { ok: true, allowed: false, roleIds: [] };

  // Back-compat: if the user explicitly has the built-in admin role id, treat as VIP.
  if (roleIds.includes("admin")) {
    return { ok: true, allowed: true, roleIds, reason: "vip_role_admin" };
  }

  // If roles KV isn't bound, we can't evaluate flags.
  if (!env?.VF_KV_ROLES) {
    return { ok: true, allowed: false, roleIds };
  }

  const defs = await Promise.all(roleIds.map((id) => getRoleDef(env, id)));

  for (let i = 0; i < roleIds.length; i++) {
    const id = roleIds[i];
    const role = defs[i];
    const flags = normalizeRoleFlags(role, { roleId: id });
    if (flags.isAdmin || flags.isMod || flags.isVip) {
      return { ok: true, allowed: true, roleIds, reason: "vip_role" };
    }
  }

  return { ok: true, allowed: false, roleIds };
}

function isValidTwitchLogin(login) {
  // Twitch logins are lowercase, alphanumeric + underscore.
  // (Length rules can evolve; we keep this permissive but safe.)
  return /^[a-z0-9_]{1,32}$/.test(String(login || ""));
}

async function resolveBroadcasterId({ accessToken, clientId, broadcasterLogin }) {
  const loginRaw = (broadcasterLogin || DEFAULT_ALLOWED_BROADCASTER_LOGIN).toLowerCase().trim();
  const login = isValidTwitchLogin(loginRaw) ? loginRaw : DEFAULT_ALLOWED_BROADCASTER_LOGIN;
  const now = Date.now();

  if (
    _broadcasterCache.id &&
    _broadcasterCache.login === login &&
    now - _broadcasterCache.fetchedAtMs < 10 * 60_000
  ) {
    return { ok: true, id: _broadcasterCache.id, login };
  }

  const url = `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`;
  const resp = await fetch(url, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!resp.ok) {
    let body = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return {
      ok: false,
      id: "",
      login,
      status: resp.status,
      error: body?.message || body?.error || `twitch_users_lookup_failed_${resp.status}`,
    };
  }

  let json = null;
  try {
    json = await resp.json();
  } catch {
    json = null;
  }

  const u = json?.data?.[0];
  const id = u?.id || "";
  if (!id) {
    return { ok: false, id: "", login, status: 404, error: "broadcaster_login_not_found" };
  }

  _broadcasterCache = { fetchedAtMs: now, login, id };
  return { ok: true, id, login };
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
 * Returns 403 if the user is not subscribed (or missing the required scope) and not a VIP-by-role.
 */
export async function requireWebsiteUser(context, { broadcasterLogin } = {}) {
  const { request } = context;

  // Fast path: if the caller already has a ViewerFrenzy session JWT,
  // validate it locally and skip Twitch calls.
  const rawToken = getAuthToken(request);
  if (!rawToken) {
    return { ok: false, response: jsonResponse(request, { error: "missing_authorization" }, 401) };
  }

  const vf = await tryAuthFromVfJwt(context, rawToken);
  if (vf?.ok) {
    // Optional best-effort KV write (keeps the USERS KV warm for admin tools)
    try {
      if (context?.env?.VF_KV_USERS) {
        await context.env.VF_KV_USERS.put(vf.user.userId, JSON.stringify(vf.user));
      }
    } catch {
      // ignore
    }
    return vf;
  }

  // Otherwise fall back to Twitch user token validation + gating.
  const auth = await requireTwitchUser(context);
  if (!auth.ok) return auth;

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
  const configuredLoginOrId = (broadcasterLogin || envBroadcasterLoginOrId || DEFAULT_ALLOWED_BROADCASTER_LOGIN).trim();

  const allowedIsId = /^\d+$/.test(configuredLoginOrId);
  const normalizedBroadcasterLogin = allowedIsId
    ? ""
    : (isValidTwitchLogin(configuredLoginOrId.toLowerCase().trim())
        ? configuredLoginOrId.toLowerCase().trim()
        : DEFAULT_ALLOWED_BROADCASTER_LOGIN);

  const broadcasterDisplay = allowedIsId ? configuredLoginOrId : normalizedBroadcasterLogin;

  // Owner (the gated broadcaster) is always allowed
  if (
    (loginLower && !allowedIsId && loginLower === normalizedBroadcasterLogin) ||
    (allowedIsId && v.user_id === configuredLoginOrId)
  ) {
    return { ...auth, access: { allowed: true, reason: "broadcaster" } };
  }
  // VIP-by-role: if the user has any assigned role flagged as Admin, MOD, or VIP,
  // they bypass the subscriber-only gate.
  const vip = await isVipByRoleFlags(context.env, v.user_id);
  if (vip?.allowed) {
    return {
      ...auth,
      access: {
        allowed: true,
        reason: vip.reason || "vip_role",
      },
    };
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

  
  // IMPORTANT: For user-token calls, the Client-ID header MUST match the app that minted the token.
  // Using an env-provided Client-ID can accidentally mismatch (e.g., after creating a new Twitch app),
  // which causes Helix calls to fail with 401.
  const tokenClientId = String(v.client_id || "").trim();
  const fallbackEnvClientId = getEnvString(context.env, "VF_TWITCH_CLIENT_ID");
  const clientId = tokenClientId || fallbackEnvClientId;

  const finalBroadcasterLogin = normalizedBroadcasterLogin;

  // Resolve the broadcaster id for the subscription check.
  // If VF_TWITCH_BROADCASTER_LOGIN is already a numeric id, we can skip the Helix lookup.
  let broadcasterId = "";
  let broadcasterLookup = null;

  if (allowedIsId) {
    broadcasterId = configuredLoginOrId;
  } else {
    broadcasterLookup = await resolveBroadcasterId({
      accessToken: token,
      clientId,
      broadcasterLogin: finalBroadcasterLogin,
    });
    if (broadcasterLookup?.ok) broadcasterId = broadcasterLookup.id;
  }

  if (!broadcasterId) {
    return {
      ok: false,
      response: jsonResponse(
        request,
        {
          error: "access_gate_misconfigured",
          message: "broadcaster_not_found",
          details:
            broadcasterLookup && !broadcasterLookup.ok
              ? `lookup_failed_${broadcasterLookup.status || ""}:${broadcasterLookup.error || ""}`
              : "lookup_failed",
          required: {
            broadcaster: broadcasterDisplay,
            viewerScope: REQUIRED_SUB_SCOPE,
          },
          hint:
            "If you previously set VF_TWITCH_CLIENT_ID in Cloudflare Pages, it may not match your current Twitch app. This flow uses the token\u2019s client_id, so you can also remove VF_TWITCH_CLIENT_ID to avoid mismatches.",
        },
        500,
      ),
    };
  }

  const sub = await checkUserSubscription({
    accessToken: token,
    clientId,
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
          vipAccess: "Any assigned role flagged Admin, MOD, or VIP",
        },
      },
      403,
    ),
  };
}
