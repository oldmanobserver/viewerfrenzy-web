// functions/_lib/twitchRoles.js

/**
 * Twitch "channel roles" we expose in Streamer Tools.
 *
 * Note: As of today, not all roles in the Twitch dashboard have a public Helix
 * endpoint for listing users. For MVP, we only sync roles that have official
 * Helix read endpoints.
 */
export const STREAMER_TWITCH_ROLE_DEFS = [
  // Order matches Twitch Roles Manager dropdown (as of Feb 2026 screenshot)
  { roleId: "moderator", roleName: "Moderator", supportedSync: true, requiredAnyScopes: ["moderation:read", "channel:manage:moderators"] },
  { roleId: "artist", roleName: "Artist", supportedSync: false, requiredAnyScopes: [] },
  { roleId: "vip", roleName: "VIP", supportedSync: true, requiredAnyScopes: ["channel:read:vips", "channel:manage:vips"] },
  { roleId: "editor", roleName: "Editor", supportedSync: true, requiredAnyScopes: ["channel:read:editors"] },
  { roleId: "lead_moderator", roleName: "Lead Moderator", supportedSync: false, requiredAnyScopes: [] },
  { roleId: "business_manager", roleName: "Business Manager", supportedSync: false, requiredAnyScopes: [] },
];

export const STREAMER_TWITCH_ROLE_ORDER = STREAMER_TWITCH_ROLE_DEFS.map((r) => r.roleId);

export function getStreamerTwitchRoleDef(roleId) {
  const rid = String(roleId || "").trim();
  if (!rid) return null;
  return STREAMER_TWITCH_ROLE_DEFS.find((r) => r.roleId === rid) || null;
}

export function getSupportedStreamerTwitchRoleDefs() {
  return STREAMER_TWITCH_ROLE_DEFS.filter((r) => r.supportedSync);
}
