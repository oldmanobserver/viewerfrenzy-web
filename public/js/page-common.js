import { requireSession } from "./session.js";
import { $, closeMenu, focusMain, openMenu } from "./ui.js";

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

function setActiveNav(routeName) {
  document.querySelectorAll(".vf-navItem").forEach((a) => {
    const r = a.getAttribute("data-route");
    a.classList.toggle("is-active", r === routeName);
  });
}

async function init() {
  // Wire menu + basic UI handlers
  $("#vf-menuBtn")?.addEventListener("click", openMenu);
  $("#vf-closeMenuBtn")?.addEventListener("click", closeMenu);
  $("#vf-backdrop")?.addEventListener("click", closeMenu);

  const session = await requireSession();
  if (!session) return;

  // Expose for page scripts (optional convenience)
  window.VF_SESSION = session;

  updateUserUI(session.me);

  const page = document.body?.dataset?.page || "";
  if (page) setActiveNav(page);

  // Close menu on navigation click (mobile)
  document.querySelectorAll(".vf-navItem").forEach((a) => {
    a.addEventListener("click", () => closeMenu());
  });

  focusMain();
}

init();
