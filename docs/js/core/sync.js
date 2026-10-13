// Sincronización opcional con GitHub: publica turnos.ics y turnos.json en la rama 'datos'.
import { buildICS } from './ics.js';
import { backupFingerprint, exportBackup } from './store.js';
import { base64ToUtf8, base64UrlDecode, base64UrlEncode, defaultFetch, hashString, isPlainObject, utf8ToBase64 } from './util.js';

export const API = 'https://api.github.com';
export const DATA_BRANCH = 'datos';
export const ICS_FILE = 'turnos.ics';
export const JSON_FILE = 'turnos.json';

// Error con mensaje para el usuario y código HTTP (0 = sin red)
export class SyncError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
  }
}

// Acepta fetchImpl directamente o un objeto de opciones { fetchImpl, now, force }
function opts(arg) {
  const o = typeof arg === 'function' ? { fetchImpl: arg } : { ...(arg || {}) };
  o.fetchImpl = o.fetchImpl || defaultFetch;
  return o;
}

const enc = encodeURIComponent;
const repoPath = (sync) => `/repos/${enc(sync.owner)}/${enc(sync.repo)}`;
const branchOf = (sync) => (sync.branch || DATA_BRANCH).trim();
const filePath = (p) => p.split('/').map(enc).join('/');

function checkConfig(sync) {
  if (!sync || !String(sync.owner || '').trim() || !String(sync.repo || '').trim()) {
    throw new SyncError('Falta el usuario o el repositorio de GitHub en Ajustes.');
  }
  if (!String(sync.token || '').trim()) throw new SyncError('Falta el token de GitHub en Ajustes.');
}

function errorMessage(status, sync, data, headers) {
  const repo = `${sync.owner}/${sync.repo}`;
  if (status === 401) return 'El token de GitHub no es válido o ha caducado. Crea uno nuevo y pégalo en Ajustes.';
  if (status === 403 || status === 429) {
    const remaining = headers?.get?.('x-ratelimit-remaining');
    if (status === 429 || remaining === '0' || /rate limit/i.test(data?.message || '')) {
      return 'GitHub ha limitado las peticiones por un rato. Inténtalo de nuevo en unos minutos.';
    }
    return `El token no tiene permiso para escribir en ${repo}. Necesita "Contents: Read and write" en ese repositorio.`;
  }
  if (status === 404) return `No se encontró el repositorio ${repo} (o el token no tiene acceso a él). Revisa el nombre y los permisos.`;
  if (status === 409 && /empty/i.test(data?.message || '')) return `El repositorio ${repo} está vacío: añade al menos un archivo primero.`;
  if (status >= 500) return 'GitHub no responde ahora mismo. Inténtalo más tarde.';
  return `GitHub respondió con un error (${status}${data?.message ? `: ${data.message}` : ''}).`;
}

const NETWORK_MSG = 'No hay conexión con GitHub. Comprueba internet e inténtalo de nuevo.';

// Petición a la API; devuelve { status, data }. allow: códigos que no se tratan como error.
async function gh(sync, fetchImpl, method, path, body, allow = []) {
  let res;
  try {
    res = await fetchImpl(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${String(sync.token).trim()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new SyncError(NETWORK_MSG, 0);
  }
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch { data = null; }
  if (res.ok || allow.includes(res.status)) return { status: res.status, data };
  throw new SyncError(errorMessage(res.status, sync, data, res.headers), res.status);
}

// Comprueba token y repositorio → { ok, message }
export async function testConnection(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  try {
    checkConfig(sync);
    const { data } = await gh(sync, fetchImpl, 'GET', repoPath(sync));
    if (data?.permissions && data.permissions.push === false) {
      return { ok: false, message: `El token puede leer ${sync.owner}/${sync.repo} pero no escribir. Dale permiso "Contents: Read and write".` };
    }
    return { ok: true, message: `Conexión correcta con ${sync.owner}/${sync.repo}.`, private: Boolean(data?.private), defaultBranch: data?.default_branch ?? null };
  } catch (e) {
    return { ok: false, message: e instanceof SyncError ? e.message : NETWORK_MSG, status: e.status ?? 0 };
  }
}

// Crea la rama de datos desde la rama por defecto si no existe → { created, sha }
export async function ensureBranch(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  checkConfig(sync);
  const branch = branchOf(sync);
  const ref = await gh(sync, fetchImpl, 'GET', `${repoPath(sync)}/git/ref/heads/${filePath(branch)}`, null, [404]);
  if (ref.status === 200 && ref.data?.object?.sha) return { created: false, sha: ref.data.object.sha };
  const repo = await gh(sync, fetchImpl, 'GET', repoPath(sync));
  const def = repo.data?.default_branch || 'main';
  const head = await gh(sync, fetchImpl, 'GET', `${repoPath(sync)}/git/ref/heads/${filePath(def)}`);
  const sha = head.data?.object?.sha;
  if (!sha) throw new SyncError(`No se pudo leer la rama ${def} del repositorio.`);
  const made = await gh(sync, fetchImpl, 'POST', `${repoPath(sync)}/git/refs`, { ref: `refs/heads/${branch}`, sha }, [422]);
  if (made.status === 422) {
    // Ya existe (creada a la vez desde otro sitio)
    if (/exists/i.test(made.data?.message || '')) return { created: false, sha };
    throw new SyncError(errorMessage(422, sync, made.data), 422);
  }
  return { created: true, sha };
}

async function getFile(sync, fetchImpl, path) {
  const r = await gh(sync, fetchImpl, 'GET', `${repoPath(sync)}/contents/${filePath(path)}?ref=${enc(branchOf(sync))}`, null, [404]);
  return r.status === 404 ? null : r.data;
}

function fileText(sync, fetchImpl, data) {
  if (data?.content && data.encoding === 'base64') return Promise.resolve(base64ToUtf8(data.content));
  // Archivos > 1 MB: la API de contenidos no trae el contenido → blob
  if (data?.sha) {
    return gh(sync, fetchImpl, 'GET', `${repoPath(sync)}/git/blobs/${enc(data.sha)}`)
      .then((r) => base64ToUtf8(r.data?.content || ''));
  }
  return Promise.resolve('');
}

// Escribe un archivo en la rama de datos; reintenta una vez si el sha cambió entre medias
async function putFile(sync, fetchImpl, path, content, message) {
  const b64 = utf8ToBase64(content);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await getFile(sync, fetchImpl, path);
    if (current?.content && current.encoding === 'base64' && base64ToUtf8(current.content) === content) {
      return { changed: false, sha: current.sha };
    }
    const body = { message, content: b64, branch: branchOf(sync) };
    if (current?.sha) body.sha = current.sha;
    const r = await gh(sync, fetchImpl, 'PUT', `${repoPath(sync)}/contents/${filePath(path)}`, body, [409, 422]);
    if (r.status === 200 || r.status === 201) return { changed: true, sha: r.data?.content?.sha ?? null };
    if (attempt === 1) throw new SyncError(errorMessage(r.status, sync, r.data), r.status);
  }
  return { changed: false, sha: null };
}

// Hash del contenido publicado (sin marcas de tiempo)
const hashOf = (ics, state) => hashString(ics + '\u0000' + backupFingerprint(state, { publicCopy: true }));

export function contentHash(state, now = new Date()) {
  return hashOf(buildICS(state, { now }), state);
}

// Publica calendario y copia → { pushed, hash, sync } (sync: ajustes actualizados para guardar)
export async function pushData(state, fetchArg) {
  const { fetchImpl, now = new Date(), force = false } = opts(fetchArg);
  const sync = state?.settings?.sync || {};
  checkConfig(sync);
  const ics = buildICS(state, { now });
  const hash = hashOf(ics, state);
  if (!force && sync.lastPushHash === hash) {
    return { pushed: false, hash, sync: { ...sync } };
  }
  await ensureBranch(sync, fetchImpl);
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  const json = exportBackup(state, { now, publicCopy: true });
  const a = await putFile(sync, fetchImpl, ICS_FILE, ics, `Turnos: calendario (${stamp})`);
  const b = await putFile(sync, fetchImpl, JSON_FILE, json, `Turnos: copia de seguridad (${stamp})`);
  return {
    pushed: true,
    changed: a.changed || b.changed,
    hash,
    sync: { ...sync, lastPushAt: now.toISOString(), lastPushHash: hash, lastError: null },
  };
}

// Descarga turnos.json de la rama de datos (para restaurar con importBackup)
export async function pullBackup(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  checkConfig(sync);
  const data = await getFile(sync, fetchImpl, JSON_FILE);
  if (!data) throw new SyncError('Todavía no hay ninguna copia de seguridad en GitHub.', 404);
  return fileText(sync, fetchImpl, data);
}

// URLs del calendario para suscribirse (el repositorio debe ser público)
export function calendarUrls(sync) {
  const path = `raw.githubusercontent.com/${sync.owner}/${sync.repo}/${branchOf(sync)}/${ICS_FILE}`;
  return { webcal: `webcal://${path}`, https: `https://${path}` };
}

// '#setup=…' (o una URL completa) → ajustes de sync, o null si no es válido
export function parseSetupLink(hash) {
  const m = /(?:^|[#&?])setup=([A-Za-z0-9_\-+/=%]+)/.exec(String(hash || ''));
  if (!m) return null;
  try {
    const data = JSON.parse(base64UrlDecode(decodeURIComponent(m[1])));
    if (!isPlainObject(data)) return null;
    const owner = String(data.owner ?? data.o ?? '').trim();
    const repo = String(data.repo ?? data.r ?? '').trim();
    const token = String(data.token ?? data.t ?? '').trim();
    const branch = String(data.branch ?? data.b ?? DATA_BRANCH).trim() || DATA_BRANCH;
    if (!owner || !repo || !token) return null;
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
    return { enabled: true, owner, repo, branch, token };
  } catch {
    return null;
  }
}

// Enlace de configuración: base + '#setup=<base64url(JSON)>'
export function buildSetupLink(baseUrl, sync) {
  const base = String(baseUrl || '').split('#')[0];
  const payload = { v: 1, owner: sync.owner, repo: sync.repo, branch: branchOf(sync), token: sync.token };
  return `${base}#setup=${base64UrlEncode(JSON.stringify(payload))}`;
}
