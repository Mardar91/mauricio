// Cifrado de la copia publicada: AES-GCM 256 con WebCrypto (globalThis.crypto.subtle).
import { base64UrlToBytes, bytesToBase64Url } from './util.js';

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;     // 32 bytes en base64url sin relleno
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function grvOf(getRandomValues) {
  if (getRandomValues) return getRandomValues;
  if (globalThis.crypto?.getRandomValues) return (a) => globalThis.crypto.getRandomValues(a);
  return null;
}

// Bytes aleatorios seguros (nunca Math.random)
export function randomBytes(n, getRandomValues) {
  const grv = grvOf(getRandomValues);
  if (!grv) throw new Error('Este navegador no tiene un generador aleatorio seguro.');
  const buf = new Uint8Array(n);
  grv(buf);
  return buf;
}

// Clave nueva para settings.sync.key (base64url, 43 caracteres)
export function generateSyncKey(getRandomValues) {
  return bytesToBase64Url(randomBytes(32, getRandomValues));
}

export function isSyncKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) return false;
  try { return base64UrlToBytes(key).length === 32; } catch { return false; }
}

// Identificador corto aleatorio (deviceId): letras minúsculas y números
export function randomId(length = 12, getRandomValues) {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(16, getRandomValues)) {
      if (b < 252 && out.length < length) out += ID_ALPHABET[b % 36]; // sin sesgo
    }
  }
  return out;
}

function subtle() {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Este navegador no permite cifrar (WebCrypto no disponible).');
  return s;
}

async function importKey(keyB64) {
  if (!isSyncKey(keyB64)) throw new Error('Clave de cifrado no válida.');
  return subtle().importKey('raw', base64UrlToBytes(keyB64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

const utf8 = (s) => new TextEncoder().encode(String(s ?? ''));

// Texto → { alg, iv, data } (base64url). aad: datos autenticados sin cifrar (p. ej. los metadatos).
export async function encryptText(text, keyB64, aad = '', getRandomValues) {
  const key = await importKey(keyB64);
  const iv = randomBytes(12, getRandomValues);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, utf8(text));
  return { alg: 'AES-GCM', iv: bytesToBase64Url(iv), data: bytesToBase64Url(new Uint8Array(ct)) };
}

// { alg, iv, data } → texto. Lanza si la clave no coincide o los datos se han alterado.
export async function decryptText(enc, keyB64, aad = '') {
  if (!enc || enc.alg !== 'AES-GCM') throw new Error('Formato de cifrado desconocido.');
  const key = await importKey(keyB64);
  const iv = base64UrlToBytes(enc.iv);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, key, base64UrlToBytes(enc.data));
  return new TextDecoder().decode(pt);
}
