import { requireSession } from "./session.js";
import { toast } from "./ui.js";

function setNotice(message, { isError = false } = {}) {
  const el = document.getElementById("vf-streamerNotice");
  if (!el) return;

  el.textContent = message || "";
  el.hidden = !message;
  el.classList.toggle("vf-alertError", !!isError);
}

async function init() {
  const session = await requireSession();
  if (!session) return;

  const me = session.me || null;
  if (!me?.isStreamer) {
    toast("Streamer tools are not available for this account.");
    // Requirement: if a non-streamer tries to access /streamer, redirect them back home.
    window.location.replace(`${window.location.origin}/mainmenu.html`);
    return;
  }

  const statsLink = document.getElementById("vf-streamerStatsLink");
  if (statsLink) {
    const u = new URL("/stats.html", window.location.origin);
    u.searchParams.set("streamerId", String(me.userId || ""));
    statsLink.setAttribute("href", u.pathname + u.search);
  }
}

init();
