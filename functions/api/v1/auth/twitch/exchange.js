// functions/api/v1/auth/twitch/exchange.js
// Exchanges a Twitch user access token for a ViewerFrenzy session JWT (VF JWT).
//
// Client sends:
//   Authorization: Bearer <twitch_user_access_token>
//
// Server returns:
//   { ok: true, token: <vf_jwt>, expiresAtUnix, user, access }

import { handleOptions } from "../../../../_lib/cors.js";
import { jsonResponse } from "../../../../_lib/response.js";
import { getAuthToken, requireWebsiteUser } from "../../../../_lib/twitchAuth.js";
import { signJwtHs256, verifyJwtHs256 } from "../../../../_lib/vfJwt.js";

function toInt(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function normalizeUserForClient(authUser) {
  const helix = authUser?.helixUser || null;
  return {
    userId: authUser?.userId || "",
    login: authUser?.login || "",
    displayName: helix?.display_name || authUser?.login || "",
    profileImageUrl: helix?.profile_image_url || "",
  };
}

export async function onRequest(context) {
  const { request, env } = context;

  const opt = handleOptions(request);
  if (opt) return opt;

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "method_not_allowed" }, 405);
  }

  const secret = String(env?.VF_JWT_SECRET || "").trim();
  if (!secret) {
    return jsonResponse(
      request,
      {
        error: "server_misconfigured",
        message: "VF_JWT_SECRET is not set on the server.",
      },
      500,
    );
  }

  const token = getAuthToken(request);
  if (!token) {
    return jsonResponse(request, { error: "missing_authorization" }, 401);
  }

  // If the caller already has a VF JWT, just validate and return it.
  const already = await verifyJwtHs256(token, secret).catch(() => null);
  if (already?.ok) {
    const exp = Number(already.payload?.exp || 0);
    return jsonResponse(
      request,
      {
        ok: true,
        token,
        expiresAtUnix: exp || 0,
        user: {
          userId: already.payload?.userId || already.payload?.sub || "",
          login: already.payload?.login || "",
          displayName: already.payload?.displayName || already.payload?.login || "",
          profileImageUrl: already.payload?.profileImageUrl || "",
        },
        access: already.payload?.access || { allowed: true, reason: "session" },
      },
      200,
    );
  }

  // Otherwise treat it as a Twitch token and run the normal website access gate.
  const auth = await requireWebsiteUser(context);
  if (!auth.ok) return auth.response;

  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(300, toInt(env?.VF_JWT_TTL_SECONDS, 12 * 60 * 60)); // default 12h, min 5m
  const exp = now + ttl;

  const helix = auth.user?.helixUser || null;

  const payload = {
    iss: "viewerfrenzy",
    aud: "viewerfrenzy-web",
    sub: auth.user?.userId || auth.validated?.user_id || "",
    userId: auth.user?.userId || auth.validated?.user_id || "",
    login: auth.user?.login || auth.validated?.login || "",
    clientId: auth.user?.clientId || auth.validated?.client_id || "",
    scopes: auth.user?.scopes || auth.validated?.scopes || [],
    // Small subset of Helix profile data for UI convenience
    helixUser: helix
      ? {
          id: helix.id,
          login: helix.login,
          display_name: helix.display_name,
          profile_image_url: helix.profile_image_url,
          broadcaster_type: helix.broadcaster_type,
        }
      : null,
    displayName: helix?.display_name || auth.user?.login || "",
    profileImageUrl: helix?.profile_image_url || "",
    access: auth.access || { allowed: true, reason: "allowed" },
    iat: now,
    exp,
  };

  const jwt = await signJwtHs256(payload, secret);

  return jsonResponse(
    request,
    {
      ok: true,
      token: jwt,
      expiresAtUnix: exp,
      user: normalizeUserForClient(auth.user),
      access: auth.access || { allowed: true, reason: "allowed" },
    },
    200,
  );
}
