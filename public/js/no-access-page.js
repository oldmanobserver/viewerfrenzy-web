import * as auth from "./auth.js";

const elMsg = document.getElementById("vf-noaccess-msg");
const elDetail = document.getElementById("vf-noaccess-detail");
const elErr = document.getElementById("vf-noaccess-error");
const btn = document.getElementById("vf-noaccess-login");

function setText(el, text) {
  if (!el) return;
  el.textContent = text || "";
}

function show(el, on) {
  if (!el) return;
  el.hidden = !on;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function safeDecode(v) {
  if (!v) return "";
  try { return decodeURIComponent(v); } catch { return v; }
}

function init() {
  // Ensure we do NOT keep a denied user "logged in" (avoids immediate re-check loops).
  try { auth.logout(); } catch {}

  const msg = safeDecode(getParam("msg"));
  const broadcaster = safeDecode(getParam("broadcaster"));

  if (msg) {
    setText(elMsg, msg);
  } else if (broadcaster) {
    setText(
      elMsg,
      `Access is currently restricted during alpha/beta. Please subscribe to ${broadcaster} on Twitch to get access.`
    );
  } else {
    setText(elMsg, "Access is currently restricted during alpha/beta. Please subscribe to the channel to get access.");
  }

  const detail = safeDecode(getParam("detail"));
  if (detail) {
    setText(elDetail, detail);
    show(elDetail, true);
  }

  btn?.addEventListener("click", () => {
    try { auth.logout(); } catch {}
    window.location.replace(`${window.location.origin}/index.html`);
  });
}

try {
  init();
} catch (e) {
  show(elErr, true);
  setText(elErr, e?.message || String(e));
}
