export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function setScreen(activeId) {
  const login = $("#vf-login");
  const app = $("#vf-app");

  const wantLogin = activeId === "login";
  const wantApp = activeId === "app";

  if (login) {
    login.classList.toggle("is-active", wantLogin);
    login.setAttribute("aria-hidden", wantLogin ? "false" : "true");
  }

  if (app) {
    app.classList.toggle("is-active", wantApp);
    app.setAttribute("aria-hidden", wantApp ? "false" : "true");
  }
}

let toastTimer = null;
export function toast(message, ms = 2400) {
  const el = $("#vf-toast");
  if (!el) return;
  el.textContent = message || "";
  el.hidden = !message;

  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.hidden = true;
    el.textContent = "";
  }, Math.max(800, ms));
}

export function openMenu() {
  const side = $("#vf-sidenav");
  const back = $("#vf-backdrop");
  if (side) {
    side.classList.add("is-open");
    side.setAttribute("aria-hidden", "false");
  }
  if (back) back.hidden = false;
}

export function closeMenu() {
  const side = $("#vf-sidenav");
  const back = $("#vf-backdrop");
  if (side) {
    side.classList.remove("is-open");
    side.setAttribute("aria-hidden", "true");
  }
  if (back) back.hidden = true;
}

export function setActiveNav(routeName) {
  document.querySelectorAll(".vf-navItem").forEach((a) => {
    const r = a.getAttribute("data-route");
    a.classList.toggle("is-active", r === routeName);
  });
}

export function focusMain() {
  const main = $("#vf-main");
  if (main) main.focus();
}
