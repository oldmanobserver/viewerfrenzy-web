// functions/_lib/kv.js
// Shared KV helpers (Cloudflare KV)

export async function listAllKeys(kv, { prefix = "", limit = 1000 } = {}) {
  const all = [];
  let cursor = undefined;
  for (;;) {
    const resp = await kv.list({ prefix, cursor, limit });
    for (const k of (resp.keys || [])) {
      all.push(k.name);
    }
    if (resp.list_complete) break;
    cursor = resp.cursor;
    if (!cursor) break;
  }
  return all;
}

export async function listAllJsonRecords(kv, { prefix = "", limit = 1000 } = {}) {
  const keys = await listAllKeys(kv, { prefix, limit });
  const totalKeys = keys.length;

  // IMPORTANT PERF NOTE:
  // Cloudflare KV `get()` calls are asynchronous and can be slow if awaited sequentially.
  // This helper fetches in parallel with a small concurrency cap.
  //
  // This endpoint is used by `/api/v1/vehicle-pools` which can be hit by every page load and
  // by Unity. Sequential KV reads were causing ~50s responses in production.
  const CONCURRENCY = 32;
  const out = [];
  let i = 0;

  // Guardrail: vehicle roles/assignments KV namespaces should be small.
  // If this triggers, it likely means the binding points at the wrong namespace.
  if (keys.length > 5000) {
    // Return a small sample rather than timing out and causing a full outage.
    // Callers will treat missing records as an empty pool and fall back.
    const sample = keys.slice(0, 5000);
    keys.length = 0;
    keys.push(...sample);
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, keys.length || 1) }, async () => {
    while (i < keys.length) {
      const key = keys[i++];
      let value = null;
      try {
        value = await kv.get(key, { type: "json" });
      } catch {
        value = null;
      }
      if (value != null) out.push(value);
    }
  });

  await Promise.all(workers);

  // Non-breaking metadata for callers that want to display diagnostics.
  // Arrays in JS can carry arbitrary properties.
  out._meta = {
    totalKeys,
    usedKeys: keys.length,
    truncated: keys.length !== totalKeys,
    prefix,
  };
  return out;
}
