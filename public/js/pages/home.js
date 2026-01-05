export function renderHome(root, ctx) {
  const me = ctx.me;

  root.innerHTML = `
    <div class="vf-container">
      <div class="vf-card">
        <h1 class="vf-h1">Welcome${me?.displayName ? `, ${escapeHtml(me.displayName)}` : ""}!</h1>
        <p class="vf-muted" style="margin: 10px 0 0">
          Use the Garage to set your default vehicle for each race mode.
          Your ViewerFrenzy Unity game will read these defaults from ViewerFrenzy.com.
        </p>
      </div>

      <div class="vf-card" style="margin-top: 12px">
        <div class="vf-row">
          <div>
            <div class="vf-h2">Quick links</div>
            <div class="vf-muted vf-small">Everything here is MVP-friendly and mobile-ready.</div>
          </div>
        </div>

        <div class="vf-row" style="margin-top: 12px">
          <a class="vf-btn vf-btnPrimary" style="text-decoration:none" href="#garage">Open Garage</a>
          <a class="vf-btn vf-btnSecondary" style="text-decoration:none" href="#character">Character Creator (soon)</a>
        </div>
      </div>

      <div class="vf-card" style="margin-top: 12px">
        <div class="vf-h2">How this works</div>
        <ul class="vf-muted" style="margin: 10px 0 0; padding-left: 20px">
          <li>You sign in with Twitch on this site.</li>
          <li>We store your default selection keyed to your Twitch user id.</li>
          <li>The Unity game reads it via the same <span class="vf-code">/api/v1/vehicle-defaults</span> endpoint.</li>
        </ul>
      </div>
    </div>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
