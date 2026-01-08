// functions/_lib/vfJwt.js
// Minimal HS256 JWT utilities for Cloudflare Pages Functions (Workers runtime).
// No external dependencies.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes) {
  // bytes: ArrayBuffer | Uint8Array
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBytes(s) {
  const b64 = String(s || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(String(s || "").length / 4) * 4, "=");
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let _cachedKey = null;
let _cachedSecret = "";

async function importHmacKey(secret) {
  const s = String(secret || "");
  if (!s) return null;
  if (_cachedKey && _cachedSecret === s) return _cachedKey;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(s),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  _cachedKey = key;
  _cachedSecret = s;
  return key;
}

export async function signJwtHs256(payload, secret) {
  const key = await importHmacKey(secret);
  if (!key) throw new Error("VF_JWT_SECRET not configured");

  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const data = `${headerB64}.${payloadB64}`;

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  const sigB64 = base64UrlEncode(sig);
  return `${data}.${sigB64}`;
}

export async function verifyJwtHs256(token, secret, { clockSkewSeconds = 30 } = {}) {
  const raw = String(token || "").trim();
  const parts = raw.split(".");
  if (parts.length !== 3) return { ok: false, error: "not_jwt" };

  const [hB64, pB64, sB64] = parts;
  const key = await importHmacKey(secret);
  if (!key) return { ok: false, error: "missing_secret" };

  // Parse header/payload
  const header = safeJsonParse(decoder.decode(base64UrlDecodeToBytes(hB64)));
  if (!header || header.alg !== "HS256") return { ok: false, error: "bad_header" };

  const payload = safeJsonParse(decoder.decode(base64UrlDecodeToBytes(pB64)));
  if (!payload || typeof payload !== "object") return { ok: false, error: "bad_payload" };

  // Verify signature
  const data = `${hB64}.${pB64}`;
  const sigBytes = base64UrlDecodeToBytes(sB64);
  const validSig = await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(data));
  if (!validSig) return { ok: false, error: "bad_signature" };

  // Expiry check
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(payload.exp || 0);
  if (exp && now - Math.max(0, clockSkewSeconds) >= exp) {
    return { ok: false, error: "expired" };
  }

  return { ok: true, payload };
}
