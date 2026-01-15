// Vehicle image helper.
// ViewerFrenzy currently ships vehicle artwork as .png files.
// Tries to load: /assets/vehicles/<type>/<id>.png
// If not found, falls back to a generated SVG placeholder.

function hashHue(str) {
  let h = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) % 360;
  }
  return h;
}

function esc(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function iconSvg(type) {
  // Simple geometric icons (no external deps).
  switch ((type || "").toLowerCase()) {
    case "ground":
      // Car-ish
      return `
        <g fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
          <path d="M120 210 L160 150 H350 L390 210" />
          <path d="M110 210 H420" />
          <circle cx="170" cy="230" r="26" fill="rgba(255,255,255,0.92)"/>
          <circle cx="360" cy="230" r="26" fill="rgba(255,255,255,0.92)"/>
        </g>`;
    case "resort":
      // Tube ring
      return `
        <g fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="14">
          <circle cx="256" cy="180" r="78" />
          <circle cx="256" cy="180" r="40" stroke="rgba(0,0,0,0.35)" />
        </g>`;
    case "space":
    default:
      // Rocket-ish
      return `
        <g fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
          <path d="M256 92 C300 130 320 170 320 210 C320 250 292 280 256 300 C220 280 192 250 192 210 C192 170 212 130 256 92 Z" />
          <path d="M210 220 L170 250" />
          <path d="M302 220 L342 250" />
          <path d="M256 300 L256 332" />
          <circle cx="256" cy="190" r="22" />
        </g>`;
  }
}

export function buildPlaceholderDataUrl({ type, id, label, variant = "thumb" } = {}) {
  const hue = hashHue(`${type}:${id}`);
  const hue2 = (hue + 28) % 360;

  const title = label || id || "Vehicle";
  const subtitle = id ? String(id).slice(0, 42) : "";

  const w = variant === "preview" ? 900 : 320;
  const h = variant === "preview" ? 560 : 320;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 512 320" role="img" aria-label="${esc(title)}">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="hsl(${hue} 80% 55%)" stop-opacity="0.85"/>
          <stop offset="1" stop-color="hsl(${hue2} 80% 55%)" stop-opacity="0.85"/>
        </linearGradient>
        <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="10" result="b"/>
          <feMerge>
            <feMergeNode in="b"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
      </defs>

      <rect x="0" y="0" width="512" height="320" rx="26" fill="rgba(0,0,0,0.25)"/>
      <rect x="10" y="10" width="492" height="300" rx="22" fill="url(#g)"/>

      <g filter="url(#soft)">
        ${iconSvg(type)}
      </g>

      <g font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif">
        <text x="24" y="54" font-size="26" font-weight="900" fill="rgba(255,255,255,0.95)">${esc(title)}</text>
        <text x="24" y="82" font-size="16" font-weight="700" fill="rgba(255,255,255,0.78)">${esc(type || "")}</text>
        <text x="24" y="304" font-size="14" font-weight="700" fill="rgba(0,0,0,0.55)">${esc(subtitle)}</text>
      </g>
    </svg>
  `.trim();

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function encodeIdForPath(id) {
  // Keep it simple; your IDs appear to be safe (letters/numbers/_).
  return encodeURIComponent(String(id || ""));
}

export function buildCandidateUrls({ type, id } = {}) {
  const t = String(type || "").toLowerCase().trim();
  const encoded = encodeIdForPath(id);

  const base = `/assets/vehicles/${t}/${encoded}`;
  // We only ship .png vehicle artwork. Keep candidate list minimal.
  return [`${base}.png`];
}

/**
 * Applies vehicle image to an <img> element.
 * Tries candidate URLs first, then falls back to placeholder SVG.
 */
export function applyVehicleImage(imgEl, { type, id, label, variant = "thumb" } = {}) {
  if (!imgEl) return;

  // Allow the image to be used in a <canvas> (for alpha-based centering) even when
  // the admin site loads assets from viewerfrenzy.com (cross-origin).
  // Requires the static asset host to send Access-Control-Allow-Origin (see public/_headers).
  try {
    imgEl.crossOrigin = "anonymous";
  } catch {
    // ignore
  }

  const candidates = buildCandidateUrls({ type, id });
  let idx = 0;

  const setPlaceholder = () => {
    imgEl.onerror = null;
    imgEl.src = buildPlaceholderDataUrl({ type, id, label, variant });
  };

  const tryNext = () => {
    if (idx >= candidates.length) {
      setPlaceholder();
      return;
    }
    const url = candidates[idx++];
    imgEl.src = url;
  };

  imgEl.onerror = () => tryNext();
  tryNext();
}
