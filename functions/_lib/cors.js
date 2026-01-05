// functions/_lib/cors.js
// Minimal CORS helper so Unity (WebGL) + a future web UI can call the API safely.

const ALLOWED_ORIGINS = new Set([
  "https://viewerfrenzy.com",
  "https://www.viewerfrenzy.com",
  "http://localhost:8788",
  "http://localhost:3000",
]);

export function buildCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  let allowOrigin = "*";

  // If an Origin header is present, only echo it back if it's allowed.
  // This keeps the API from being open to random browser origins.
  if (origin) {
    allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://viewerfrenzy.com";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function handleOptions(request) {
  if (request.method !== "OPTIONS") return null;

  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request),
  });
}
