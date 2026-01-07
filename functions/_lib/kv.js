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
  const out = [];
  for (const key of keys) {
    const raw = await kv.get(key);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // ignore invalid JSON
    }
  }
  return out;
}
