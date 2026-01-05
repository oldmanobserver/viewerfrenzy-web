export function renderCharacter(root) {
  root.innerHTML = `
    <div class="vf-container">
      <div class="vf-card">
        <h1 class="vf-h1">Character Creator</h1>
        <p class="vf-muted" style="margin-top: 10px">
          Placeholder for now.
        </p>
        <p class="vf-muted" style="margin-top: 10px">
          When you're ready, the plan is to reuse the same Twitch session token and add a
          <span class="vf-code">/api/v1/character</span> endpoint.
        </p>
      </div>
    </div>
  `;
}
