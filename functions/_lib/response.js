// functions/_lib/response.js
import { buildCorsHeaders } from "./cors.js";

export function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...buildCorsHeaders(request),
    },
  });
}

export function textResponse(request, text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...buildCorsHeaders(request),
    },
  });
}
