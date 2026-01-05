(async () => {
  const session = window.VF_STORAGE?.getSession?.();
  if (!session?.accessToken) {
    // Not logged in
    window.location.href = "/index.html";
    return;
  }

  const token = session.accessToken;

  // Helper: parse JSON safely
  async function safeJson(resp) {
    const text = await resp.text();
    if (!text || !text.trim()) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  // 1) Fetch "me" (this also validates token)
  const meResp = await fetch("/api/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (meResp.status === 401) {
    window.VF_AUTH.logout();
    return;
  }

  // If /api/v1/me is gated and returns 403, we can use that directly
  if (meResp.status === 403) {
    window.location.href = "/no-access.html";
    return;
  }

  const meJson = await safeJson(meResp);
  const me = meJson?.user;

  if (!me?.login) {
    window.VF_AUTH.logout();
    return;
  }

  // 2) If broadcaster is logged in, ensure server has broadcaster subscription tokens
  // Use config broadcaster login (client-side) if available; fallback to server-side endpoint later
  const broadcasterLogin = (window.VF_CONFIG?.broadcasterLogin || "").toLowerCase();
  if (broadcasterLogin && me.login.toLowerCase() === broadcasterLogin) {
    const stResp = await fetch("/api/v1/admin/twitch/status", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    const st = await safeJson(stResp);
    if (stResp.ok && st?.connected === false) {
      // This will take you through Twitch consent and return to callback.
      window.location.href = "/api/v1/admin/twitch/connect";
      return;
    }
  }

  // 3) Decide access (call a dedicated endpoint)
  const accessResp = await fetch("/api/v1/access", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (accessResp.status === 200) {
    window.location.href = "/mainmenu";
    return;
  }

  if (accessResp.status === 403) {
    window.location.href = "/no-access.html";
    return;
  }

  // Anything unexpected
  window.location.href = "/no-access.html";
})();
