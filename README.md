# viewerfrenzy-web

Static ViewerFrenzy website (Cloudflare Pages) + Pages Functions API.

## What’s in here

- `/public` — static HTML/CSS/JS (no build step)
- `/functions` — Cloudflare Pages Functions (API)

## MVP features in this build

- Twitch login (OAuth **Implicit Grant**)
- Mobile-friendly hamburger menu
- Post-login main menu:
  - Garage
  - Character Creator (placeholder)
  - Logout
- Web Garage can **GET + PUT** vehicle defaults using the same API endpoints Unity uses:
  - `GET /api/v1/vehicle-defaults/{type}`
  - `PUT /api/v1/vehicle-defaults/{type}`

## One-time setup

1) **Create/edit** `/public/config.js`

Copy:

- `/public/config.example.js` -> `/public/config.js`

Then set:

- `window.VF_CONFIG.twitchClientId`

Note:

- `window.VF_CONFIG.twitchScopes` should include `user:read:subscriptions` so the server can verify
  whether the viewer is subscribed to the configured broadcaster (alpha/beta access gate).

2) **Twitch Developer Console settings**

In your Twitch app settings, add these redirect URLs:

- `https://viewerfrenzy.com/callback.html`
- `https://www.viewerfrenzy.com/callback.html`

(Optional for local dev)

- `http://localhost:8788/callback.html`
- `http://localhost:3000/callback.html`

3) **Cloudflare Pages Functions environment**

Environment variables:

- `VF_TWITCH_BROADCASTER_LOGIN` *(optional)* — Twitch **login** (e.g. `oldmanobserver`) or numeric **broadcaster id**.
  - If omitted, defaults to `oldmanobserver`.

KV bindings (same as Unity):

Make sure these are bound (same as Unity):

- `VF_KV_USERS`
- `VF_KV_GROUND`
- `VF_KV_RESORT`
- `VF_KV_SPACE`

## Vehicle catalog

The web Garage reads `/public/data/vehicleCatalog.json`.

- Space options are generated from Unity’s `Resources/VF/SpaceShipCatalog.json` in this repo.
- Ground options are an MVP placeholder in this build — add your real ground vehicle prefab IDs so they match what Unity expects.

pushing a build