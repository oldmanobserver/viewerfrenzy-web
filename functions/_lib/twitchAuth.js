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
