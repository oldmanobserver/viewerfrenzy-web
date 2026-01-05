import * as auth from "./auth.js";
import * as api from "./api.js";
import { loadVehicleCatalog } from "./catalog.js";
import { $, closeMenu, focusMain, openMenu, setActiveNav, setScreen, toast } from "./ui.js";

import { renderHome } from "./pages/home.js";
import { renderGarage } from "./pages/garage.js";
import { renderCharacter } from "./pages/character.js";

const state = {
  garage: null,
};

function setLoginError(message) {
  const el = $("#vf-loginError");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

function updateUserUI(me) {
  const chip = $("#vf-userChip");
  const avatar = $("#vf-userAvatar");
  const name = $("#vf-userName");
  const sub = $("#vf-sidenavSub");

  if (!me) {
    if (chip) chip.hidden = true;
    if (sub) sub.textContent = "Not signed in";
    return;
  }

  if (chip) chip.hidden = false;
  if (avatar) {
    avatar.src = me.profileImageUrl || "";
    avatar.alt = me.displayName ? `${me.displayName} avatar` : "";
  }
  if (name) name.textContent = me.displayName || me.login || "Viewer";
  if (sub) sub.textContent = me.displayName ? `Signed in as ${me.displayName}` : "Signed in";
}

function parseRoute() {
  const raw = (window.location.hash || "").replace(/^#/, "").trim();
  return raw || "home";
}

function normalizeRoute(r) {
  const ok = ["home", "garage", "character"];
  return ok.includes(r) ? r : "home";
}

async function init() {
  // Wire menu + basic UI handlers (safe even when not logged in)
  $("#vf-menuBtn")?.addEventListener("click", openMenu);
  $("#vf-closeMenuBtn")?.addEventListener("click", closeMenu);
  $("#vf-backdrop")?.addEventListener("click", closeMenu);

  $("#vf-logoutBtn")?.addEventListener("click", () => {
    auth.logout();
    window.location.replace(window.location.origin + "/");
  });

  $("#vf-loginBtn")?.addEventListener("click", () => {
    try {
      setLoginError("");
      auth.beginLoginRedirect();
    } catch (e) {
      setLoginError(e?.message || String(e));
    }
  });

  // Determine auth
  let session = auth.getAuth();
  if (session && auth.isExpired(session)) {
    auth.logout();
    session = null;
  }

  if (!session) {
    setScreen("login");
    updateUserUI(null);
    return;
  }

  // Logged in: validate token with our API
  setScreen("app");
  toast("Signing you in…", 1200);

  let me = null;
  try {
    const resp = await api.getMe(session);
    me = resp?.user || null;
  } catch (e) {
    // Handle restricted alpha/beta access (403) separately from expired tokens.
    const status = Number(e?.status || 0);
    if (status === 403) {
      auth.logout();
      setScreen("login");
      updateUserUI(null);
      setLoginError(
        "Access is currently restricted during alpha/beta. " +
          "To use the website, please subscribe to oldmanobserver on Twitch.",
      );
      return;
    }

    // Invalid token / expired / revoked
    auth.logout();
    setScreen("login");
    updateUserUI(null);
    setLoginError("Your Twitch session expired. Please log in again.");
    return;
  }

  updateUserUI(me);

  // If the broadcaster logs in and subscriber checks aren't connected yet,
  // automatically run the one-time connect flow (stores tokens in KV).
  if ((me?.login || "").toLowerCase() === "oldmanobserver") {
    try {
      const resp = await fetch("/api/v1/admin/twitch/status", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (resp.ok) {
        const st = await resp.json();
        if (st?.connected === false) {
          // This redirects to Twitch consent for channel:read:subscriptions (broadcaster only).
          window.location.href = "/api/v1/admin/twitch/connect";
          return;
        }
      }
    } catch {
      // ignore
    }
  }


  // Load vehicle catalog (static file)
  let catalog = null;
  try {
    catalog = await loadVehicleCatalog();
  } catch {
    catalog = { version: 1, generatedUtc: new Date().toISOString(), types: {} };
  }

  const ctx = {
    auth: session,
    me,
    catalog,
    api,
    toast,
    state,
    onAuthInvalid: () => {
      toast("Session expired. Please log in again.");
      auth.logout();
      window.location.replace(window.location.origin + "/");
    },
  };

  const routes = {
    home: () => renderHome($("#vf-main"), ctx),
    garage: () => renderGarage($("#vf-main"), ctx),
    character: () => renderCharacter($("#vf-main"), ctx),
  };

  let cleanup = null;

  function render() {
    const r = normalizeRoute(parseRoute());
    setActiveNav(r);
    closeMenu();

    if (cleanup) {
      try { cleanup(); } catch { /* ignore */ }
      cleanup = null;
    }

    cleanup = routes[r]?.() || null;
    focusMain();
  }

  window.addEventListener("hashchange", render);

  // Initial navigation
  render();
}

// Start
init();