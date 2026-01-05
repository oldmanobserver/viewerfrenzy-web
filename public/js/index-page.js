import * as auth from "./auth.js";

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
  // IMPORTANT:
  // Do NOT hit the API or check permissions on first visit.
  // Only redirect to the permission-check page if we already have a stored, non-expired auth token.
  const a = auth.getAuth();

  if (a && auth.isExpired(a)) {
    auth.logout();
  }

  if (a && !auth.isExpired(a)) {
    setStatus("Already signed in. Checking permissions…");
    window.location.replace(`${window.location.origin}/checking.html`);
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
