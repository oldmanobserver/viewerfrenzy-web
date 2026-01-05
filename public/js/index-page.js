import * as auth from "./auth.js";
import { loadSession } from "./session.js";

const elError = document.getElementById("vf-loginError");
const elStatus = document.getElementById("vf-loginStatus");
const btn = document.getElementById("vf-loginBtn");

function setError(msg) {
  if (!elError) return;
  elError.hidden = !msg;
  elError.textContent = msg || "";
}

function setStatus(msg) {
  if (!elStatus) return;
  elStatus.hidden = !msg;
  elStatus.textContent = msg || "";
}

async function init() {
  // If already logged in, go to main menu.
  setStatus("Checking session…");
  const session = await loadSession();
  if (session) {
    setStatus("Already signed in. Redirecting…");
    window.location.replace(`${window.location.origin}/mainmenu.html`);
    return;
  }

  setStatus("");

  btn?.addEventListener("click", () => {
    try {
      setError("");
      auth.beginLoginRedirect();
    } catch (e) {
      setError(e?.message || String(e));
    }
  });
}

init().catch((e) => setError(e?.message || String(e)));
