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
    setNotice(
      "The Streamer section becomes available after you host a competition and the game submits results.",
      { isError: true },
    );
    toast("Streamer tools are not available for this account.");
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
