// functions/healthcheck.js

/** 
 * Pages Functions convention (v3+):
 * export an onRequest handler.
 * The file name (healthcheck.js) → URL path (/healthcheck).
 */
export async function onRequest(context) {
  return new Response("OK", {
    headers: { "Content-Type": "text/plain" }
  });
}
