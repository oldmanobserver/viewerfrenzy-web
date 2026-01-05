import * as auth from "./auth.js";

(function init() {
  try {
    auth.logout();
  } catch {
    // ignore
  }

  // Small delay so the user sees the page, then redirect.
  window.setTimeout(() => {
    window.location.replace(`${window.location.origin}/index.html`);
  }, 150);
})();
