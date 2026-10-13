// Utilidades internas sin dependencias (clonado, hash, base64 UTF-8).

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Claves peligrosas en mezclas profundas (contaminación de prototipos)
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export function isSafeKey(k) {
  return typeof k === 'string' && !UNSAFE_KEYS.has(k);
}

// Copia profunda de datos JSON (el estado solo contiene datos JSON).
export function clone(v) {
  if (v === undefined) return undefined;
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

// Hash rápido no criptográfico (cyrb53) → 14 caracteres hex. Sirve para detectar cambios.
export function hashString(str) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

// JSON estable (claves ordenadas) para hashes reproducibles.
export function stableStringify(v) {
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  if (isPlainObject(v)) {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
  }
  return JSON.stringify(v ?? null);
}

function bytesToBinary(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

// Texto → base64 (UTF-8). Usa btoa si existe; si no, Buffer (Node).
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(bytesToBinary(bytes));
  return globalThis.Buffer.from(bytes).toString('base64');
}

// base64 (UTF-8, admite saltos de línea como en la API de GitHub) → texto.
export function base64ToUtf8(b64) {
  const clean = String(b64 || '').replace(/[\s]/g, '');
  let bytes;
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(clean);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new Uint8Array(globalThis.Buffer.from(clean, 'base64'));
  }
  return new TextDecoder().decode(bytes);
}

export function base64UrlEncode(str) {
  return utf8ToBase64(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return base64ToUtf8(s);
}

// Bytes ↔ base64url (sin relleno)
export function bytesToBase64Url(bytes) {
  const b64 = typeof globalThis.btoa === 'function'
    ? globalThis.btoa(bytesToBinary(bytes))
    : globalThis.Buffer.from(bytes).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  if (/[^A-Za-z0-9+/]/.test(s)) throw new Error('base64 no válido');
  while (s.length % 4) s += '=';
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(globalThis.Buffer.from(s, 'base64'));
}

// fetch por defecto enlazado a globalThis (evita "Illegal invocation" en navegadores).
export function defaultFetch(...args) {
  if (typeof globalThis.fetch !== 'function') throw new TypeError('fetch no disponible');
  return globalThis.fetch(...args);
}
