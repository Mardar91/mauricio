// Sincronización segura con GitHub (SPEC §9). En la carpeta de cada persona del repo de datos (raíz o
// settings.sync.dir, SPEC §11; cada carpeta con su clave y su dispositivo que publica) hay dos archivos:
//  - backup.json: { format:'turnos-backup', v:3, meta:{rev,savedAt,deviceId,days,publisher,publisherSince},
//    enc:{alg,iv,data} } con el estado completo cifrado (meta.name: nombre de pila en claro, para listar) (AES-GCM 256, clave settings.sync.key; sin token
//    ni clave dentro). Los metadatos van autenticados.
//  - turnos.ics: el calendario (sin notas; lugares solo con publishPlaces).
// UN SOLO EDITOR: solo el dispositivo meta.publisher escribe en GitHub. Los demás leen y fusionan en
// local, pero nunca escriben (readOnly). Para cambiar de editor: becomePublisher (tras confirmarlo).
// Siempre se lee, se descifra y se fusiona por día antes de publicar. Nunca se publica una copia
// vacía encima de una con datos (ni encima de un turnos.ics con eventos si backup.json desapareció).
// Sin backup.json, solo el dispositivo que escribió el turnos.ics publicado la vuelve a crear solo;
// los demás quedan en solo lectura (publisher '?') hasta «Usar este dispositivo».
// La UI hace TODAS las llamadas (syncNow, pullOnly, becomePublisher, trySetupConfig) desde una única
// cola (createSyncQueue) y aplica cada resultado con applySyncResult, que descarta los resultados viejos.
import { decryptText, encryptText, generateSyncKey, isSyncKey, randomId } from './cipher.js';
import { buildICS } from './ics.js';
import { SCHEMA, USER_SETTINGS, dataFingerprint, firstNameKey, mergeStates, migrateState, personSwitchState, syncPayload, updateSettings } from './store.js';
import { base64ToUtf8, base64UrlDecode, base64UrlEncode, defaultFetch, hashString, isPlainObject, stableStringify, utf8ToBase64 } from './util.js';

export const API = 'https://api.github.com';
export const DEFAULT_REPO = 'mauricio-datos';
export const DATA_BRANCH = '';            // '' = rama por defecto del repo
export const ICS_FILE = 'turnos.ics';
export const BACKUP_FILE = 'backup.json';
export const LEGACY_JSON_FILE = 'turnos.json'; // copia en claro de versiones antiguas (solo lectura)
export const JSON_FILE = BACKUP_FILE;
export const BACKUP_FORMAT = 'turnos-backup';
export const BACKUP_VERSION = 3;          // v3: meta.publisher (v2 se sigue leyendo)
const MAX_ATTEMPTS = 3;

const HELP = 'Pide ayuda a quien te configuró la app.';
// Mensajes para Mauricio (español neutro, sin jerga). El detalle técnico va aparte (error.detail / lastErrorDetail).
export const SYNC_MESSAGES = Object.freeze({
  CONFIG: `Falta terminar de configurar el calendario. ${HELP}`,
  NO_KEY: `Falta la clave para leer tus turnos guardados en internet. No se envió nada. ${HELP}`,
  AUTH: 'La conexión del calendario ya no funciona. Pide un enlace nuevo a quien te configuró la app.',
  FORBIDDEN: `No se pudo actualizar el calendario. ${HELP}`,
  NOT_FOUND: `No se pudo actualizar el calendario. ${HELP}`,
  INVALID: `No se pudo actualizar el calendario. ${HELP}`,
  UNKNOWN: `No se pudo actualizar el calendario. ${HELP}`,
  RATE_LIMIT: 'El calendario está ocupado en este momento. Se volverá a intentar en un rato.',
  SERVER: 'El calendario no responde en este momento. Se volverá a intentar más tarde.',
  NETWORK: 'Sin conexión a internet. El calendario se actualizará cuando vuelva la conexión.',
  CONFLICT: 'Otro dispositivo estaba guardando al mismo tiempo. Se volverá a intentar en un momento.',
  DECRYPT: `No se pudieron leer tus turnos guardados en internet (la clave no coincide). No se envió nada. ${HELP}`,
  BAD_REMOTE: `Los turnos guardados en internet están dañados. No se envió nada. ${HELP}`,
  NEWER_REMOTE: 'Tus turnos guardados en internet son de una versión más nueva de la app. Actualiza la app: ciérrala del todo y vuelve a abrirla.',
  NEWER_LOCAL: 'Esta app está desactualizada. Ciérrala del todo y vuelve a abrirla para actualizarla.',
  EMPTY_LOCAL: 'Aquí no hay turnos guardados, pero en internet sí. No se envió nada para no borrarlos.',
  NO_REMOTE: 'Todavía no hay ninguna copia guardada en internet.',
  RETRY: 'Preparando el calendario. Se volverá a intentar en un momento.',
  OTHER_PERSON: 'Este enlace es del calendario de otra persona. No se cambió nada.',
});
// Errores pasajeros: se reintenta solo; el resto necesita ayuda. RETRY: repetir en cuanto se guarde el
// resultado (la identidad recién creada ya está a salvo)
const RETRY_CODES = new Set(['RATE_LIMIT', 'SERVER', 'NETWORK', 'CONFLICT', 'RETRY']);

// Error con mensaje humano (message), código (code), detalle técnico (detail) y HTTP (status, 0 = sin red)
export class SyncError extends Error {
  constructor(message, status = 0, { code = 'UNKNOWN', detail = '', retry } = {}) {
    super(message);
    this.name = 'SyncError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retry = retry ?? RETRY_CODES.has(code);
  }
}

const syncError = (code, detail = '', status = 0) => new SyncError(SYNC_MESSAGES[code] || SYNC_MESSAGES.UNKNOWN, status, { code, detail });

// Acepta fetchImpl directamente o un objeto de opciones { fetchImpl, now, force, … }
function opts(arg) {
  const o = typeof arg === 'function' ? { fetchImpl: arg } : { ...(arg || {}) };
  o.fetchImpl = o.fetchImpl || defaultFetch;
  return o;
}

// ---------- Validación de la configuración (enlace #setup y formulario) ----------

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const TOKEN_RE = /^(?:ghp_[A-Za-z0-9]{30,251}|github_pat_[A-Za-z0-9_]{22,244})$/;

export const isValidOwner = (s) => typeof s === 'string' && OWNER_RE.test(s);
export const isValidRepo = (s) => typeof s === 'string' && REPO_RE.test(s) && !/^\.+$/.test(s) && !/\.git$/i.test(s);
export const isValidToken = (s) => typeof s === 'string' && TOKEN_RE.test(s);

// Carpeta de una persona: '' (raíz) o slug [a-z0-9-]{1,32}
export const MAX_DIR_LEN = 32;
const DIR_RE = /^[a-z0-9-]{1,32}$/;
export const isValidDir = (d) => d === '' || (typeof d === 'string' && DIR_RE.test(d));
const MAX_NAME = 60;

// Nombre de pila limpio (espacios normales, máx. 60) o ''
export function cleanPersonName(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim() : '';
}

// Nombre que se publica en claro (backup.json meta.name): solo la primera palabra, nunca apellidos
export function publicName(v) {
  return cleanPersonName(v).split(' ')[0] || '';
}

// Texto → slug para carpetas: sin acentos, minúsculas, [a-z0-9-], máx. 32 ('José Ana' → 'jose-ana')
export function slugify(text, max = MAX_DIR_LEN) {
  const s = String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss').replace(/[æÆ]/g, 'ae').replace(/[œŒ]/g, 'oe').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/[đĐ]/g, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '');
}

// Slug que no está en taken: 'ana', 'ana-2', 'ana-3'… (máx. 32 caracteres)
export function uniqueDir(base, taken = []) {
  const used = new Set([...taken].map((d) => String(d ?? '').trim().toLowerCase()));
  const b = slugify(base) || 'persona';
  if (!used.has(b)) return b;
  for (let i = 2; i < 1000; i++) {
    const suffix = `-${i}`;
    const c = `${b.slice(0, MAX_DIR_LEN - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!used.has(c)) return c;
  }
  throw syncError('CONFIG', 'No hay nombres de carpeta libres.');
}

// Nombre de rama válido para git y seguro en URLs ('' = rama por defecto)
export function isValidBranch(b) {
  if (b === '') return true;
  if (typeof b !== 'string' || b.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(b)) return false;
  if (b === 'HEAD' || b.startsWith('-') || b.endsWith('.') || b.endsWith('.lock') || b.includes('..')) return false;
  return b.split('/').every((seg) => seg && !seg.startsWith('.'));
}

// Normaliza { owner, repo, branch, dir?, token, key, publishPlaces?, name? } → objeto válido o null.
// dir: carpeta de la persona ('' = raíz; se pasa a minúsculas). Sin dir (formulario que no lo tiene)
// el resultado no lo lleva y al aplicarlo se conserva la carpeta del dispositivo; en un enlace,
// parseSetupLink lo pone a '' (enlace antiguo = raíz). name: nombre de pila que sugiere el enlace.
export function normalizeSyncConfig(data) {
  if (!isPlainObject(data)) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : null);
  const owner = str(data.owner ?? data.o), repo = str(data.repo ?? data.r), token = str(data.token ?? data.t);
  const branch = str(data.branch ?? data.b), key = str(data.key ?? data.k);
  const hasDir = data.dir !== undefined || data.d !== undefined;
  const rawDir = str(data.dir ?? data.d);
  if ([owner, repo, token, branch, key, rawDir].some((v) => v === null)) return null;
  const dir = rawDir.toLowerCase();
  if (!isValidOwner(owner) || !isValidRepo(repo) || !isValidToken(token) || !isValidBranch(branch) || !isValidDir(dir)) return null;
  if (key && !isSyncKey(key)) return null;
  const out = { owner, repo, branch, token, key };
  if (hasDir) out.dir = dir;
  const places = data.publishPlaces ?? data.p;
  if (typeof places === 'boolean') out.publishPlaces = places;
  const name = cleanPersonName(data.name ?? data.n);
  if (name) out.name = name;
  return out;
}

const dirOf = (sync) => String(sync?.dir ?? '').trim().toLowerCase();
// cfg sin dir → la carpeta actual del dispositivo
const withDir = (cfg, cur) => (cfg && cfg.dir === undefined ? { ...cfg, dir: dirOf(cur) } : cfg);

// ¿Misma carpeta de datos (owner, repo y carpeta)? Solo entonces se reutiliza la clave guardada.
// GitHub no distingue mayúsculas en owner y repo.
const lower = (v) => String(v || '').trim().toLowerCase();
function sameFolder(a, b) {
  return Boolean(a && b) && lower(a.owner) === lower(b.owner) && lower(a.repo) === lower(b.repo) && dirOf(a) === dirOf(b);
}

// Parche para settings.sync al aplicar una configuración nueva (enlace o formulario): activa la sync
// y reinicia la contabilidad para que lo primero sea leer y fusionar el remoto.
// current (State, opcional): con el mismo repositorio y rama se recuerda quién publicaba (por si
// backup.json desaparece); si la clave cambia, la anterior queda en prevKey (red de seguridad).
// El publishPlaces del enlace NO va aquí: lo aplica applySyncConfig (solo si aquí nunca se eligió).
// Otra carpeta (otro owner, repo o dir) = otra persona: sin clave en cfg, la clave guardada NO se
// reutiliza (cada carpeta tiene la suya; se crea una nueva si no hay copia) y no queda en prevKey.
export function syncConfigPatch(config, current = null) {
  const cur = current?.settings?.sync ?? null;
  const cfg = withDir(config, cur);
  const branch = String(cfg.branch ?? '').trim();
  const dir = dirOf(cfg);
  const patch = {
    owner: cfg.owner, repo: cfg.repo, branch, dir, token: cfg.token, enabled: true,
    baseRev: 0, lastPushAt: null, lastPushHash: null, lastPullAt: null,
    lastError: null, lastErrorCode: null, lastErrorDetail: null, lastErrorSince: null, unpublished: 0,
  };
  const folder = sameFolder(cur, cfg);
  const same = folder && branchName(cur) === branch;
  if (!same) Object.assign(patch, { publisher: null, publisherSince: null });
  // Con el mismo destino se recuerda qué calendario publicó este dispositivo (si backup.json
  // desaparece, solo quien escribió el turnos.ics publicado lo vuelve a crear sin preguntar)
  if (cur && !same) patch.lastIcsHash = null;
  if (cfg.key) {
    patch.key = cfg.key;
    if (isSyncKey(cur?.key) && cur.key !== cfg.key) patch.prevKey = folder ? cur.key : '';
  } else if (cur && !folder) {
    Object.assign(patch, { key: '', prevKey: '' });
  }
  return patch;
}

// Sello mínimo: los lugares que sugiere un enlace pierden ante cualquier decisión real (con fecha)
export const LINK_PLACES_AT = '1970-01-01T00:00:00.001Z';
// Publisher desconocido: no hay backup.json y el turnos.ics publicado lo escribió otro dispositivo
export const UNKNOWN_PUBLISHER = '?';

// Crea lo que falte de la identidad (deviceId y clave) ANTES de la primera petición de red. Puro: para
// usarlo dentro de store.set al configurar. Devuelve el mismo estado si no falta nada.
// options: { getRandomValues, deviceId, key } — valores a usar en vez de aleatorios; key: false = no crear clave.
export function ensureSyncIdentity(state, { getRandomValues, deviceId, key } = {}) {
  const s = state?.settings?.sync || {};
  const patch = {};
  if (!s.deviceId) patch.deviceId = typeof deviceId === 'string' && deviceId.trim() ? deviceId.trim().slice(0, 40) : randomId(12, getRandomValues);
  if (!isSyncKey(s.key) && key !== false) patch.key = isSyncKey(key) ? key : generateSyncKey(getRandomValues);
  return Object.keys(patch).length ? updateSettings(state, { sync: patch }) : state;
}

// Aplica una configuración (enlace o formulario) a un estado. Puro: usar dentro de store.set.
// = syncConfigPatch(cfg, state) + publishPlaces del enlace (solo si este dispositivo nunca eligió, y con
// el sello mínimo para que gane cualquier decisión publicada) + ensureSyncIdentity. Lanza SyncError
// CONFIG si cfg no es válida. options: { now, getRandomValues, deviceId, key } (ver ensureSyncIdentity).
export function applySyncConfig(state, cfg, { now, getRandomValues, deviceId, key } = {}) {
  const c = withDir(normalizeSyncConfig(cfg), state?.settings?.sync);
  if (!c) throw syncError('CONFIG', 'Configuración de sincronización no válida.');
  const st = state?.settings || {};
  const patch = { sync: syncConfigPatch(c, state) };
  // Nombre que trae el enlace («Crear enlace para otra persona»): solo si aquí no hay ninguno
  if (c.name && !String(st.name ?? '').trim()) patch.name = c.name;
  const neverChose = !st.placesUpdatedAt && !st.sync?.lastPullAt && !st.sync?.lastPushAt;
  if (typeof c.publishPlaces === 'boolean' && neverChose) {
    patch.sync.publishPlaces = c.publishPlaces;
    patch.placesUpdatedAt = LINK_PLACES_AT;
    // Una sugerencia no cambia el sello del calendario (si no, la SEQUENCE saltaría al publicar)
    patch.calendarUpdatedAt = st.calendarUpdatedAt ?? null;
  }
  return ensureSyncIdentity(updateSettings(state, patch, { now }), { getRandomValues, deviceId, key });
}

const enc = encodeURIComponent;
const repoPath = (sync) => `/repos/${enc(sync.owner)}/${enc(sync.repo)}`;
const branchName = (sync) => String(sync?.branch ?? '').trim();
const filePath = (p) => p.split('/').map(enc).join('/');
// Ruta de un archivo dentro de la carpeta de la persona
const pathIn = (ctx, name) => (ctx.dir ? `${ctx.dir}/${name}` : name);

function checkConfig(sync) {
  const missing = ['owner', 'repo', 'token'].filter((k) => !String(sync?.[k] || '').trim());
  if (missing.length) throw syncError('CONFIG', `Falta en Ajustes: ${missing.join(', ')}.`);
  if (!isValidOwner(String(sync.owner).trim()) || !isValidRepo(String(sync.repo).trim()) || !isValidBranch(branchName(sync))) {
    throw syncError('CONFIG', 'Usuario, repositorio o rama con caracteres no válidos.');
  }
  if (!isValidDir(dirOf(sync))) throw syncError('CONFIG', `Carpeta no válida: «${String(sync.dir).slice(0, 40)}» (solo a-z, 0-9 y guiones).`);
}

function httpError(status, sync, data, headers, what = '') {
  const repo = `${sync.owner}/${sync.repo}`;
  const gh = data?.message ? ` (${String(data.message).slice(0, 200)})` : '';
  const at = what ? ` en ${what}` : '';
  if (status === 401) {
    return syncError('AUTH', `GitHub 401${gh}${at}: el token no es válido o caducó. Crea un token fine-grained nuevo (Contents: Read and write solo en ${repo}) y envía un enlace de configuración nuevo.`, status);
  }
  if (status === 403 || status === 429) {
    const remaining = headers?.get?.('x-ratelimit-remaining');
    if (status === 429 || remaining === '0' || /rate limit/i.test(data?.message || '')) {
      return syncError('RATE_LIMIT', `GitHub ${status}${gh}${at}: límite de peticiones.`, status);
    }
    return syncError('FORBIDDEN', `GitHub 403${gh}${at}: el token no tiene permiso "Contents: Read and write" en ${repo}.`, status);
  }
  if (status === 404) return syncError('NOT_FOUND', `GitHub 404${gh}${at}: no existe ${repo} (o la rama), o el token no tiene acceso.`, status);
  if (status === 409) return syncError('CONFLICT', `GitHub 409${gh}${at}.`, status);
  if (status === 422) return syncError('INVALID', `GitHub 422${gh}${at}.`, status);
  if (status >= 500) return syncError('SERVER', `GitHub ${status}${gh}${at}.`, status);
  return syncError('UNKNOWN', `GitHub ${status}${gh}${at}.`, status);
}

// Petición a la API → { status, data }. allow: códigos que no se tratan como error.
async function gh(ctx, method, path, body, allow = []) {
  const { sync, fetchImpl } = ctx;
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
  } catch (e) {
    throw syncError('NETWORK', `${method} ${path}: ${e?.message || 'sin red'}`, 0);
  }
  let data = null;
  try {
    const text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch { data = null; }
  if (res.ok || allow.includes(res.status)) return { status: res.status, data };
  throw httpError(res.status, sync, data, res.headers, `${method} ${path.split('?')[0]}`);
}

const ctxOf = (sync, fetchImpl) => ({ sync: { ...sync, owner: String(sync.owner).trim(), repo: String(sync.repo).trim() }, dir: dirOf(sync), fetchImpl });

// Comprueba token y repositorio → { ok, message, detail, code, private, defaultBranch, warning }
export async function testConnection(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  try {
    checkConfig(sync);
    const { data } = await gh(ctxOf(sync, fetchImpl), 'GET', repoPath(sync));
    if (data?.permissions && data.permissions.push === false) {
      return { ok: false, code: 'FORBIDDEN', message: SYNC_MESSAGES.FORBIDDEN, detail: `El token puede leer ${sync.owner}/${sync.repo} pero no escribir: necesita "Contents: Read and write".`, status: 200 };
    }
    const warning = data?.has_pages
      ? 'Este repositorio publica una web (GitHub Pages): usa un repositorio solo para datos, porque con este token se podría cambiar la web.'
      : null;
    return { ok: true, message: `Conexión correcta con ${sync.owner}/${sync.repo}.`, detail: null, private: Boolean(data?.private), defaultBranch: data?.default_branch ?? null, warning };
  } catch (e) {
    const err = e instanceof SyncError ? e : syncError('NETWORK', String(e?.message || e));
    return { ok: false, code: err.code, message: err.message, detail: err.detail, status: err.status ?? 0 };
  }
}

// Prepara la rama → { branch, created, empty }. branch '' = rama por defecto (no hace falta nada).
// Si la rama no existe se crea desde la rama por defecto; si el repo está vacío → empty: true.
export async function ensureBranch(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  checkConfig(sync);
  return branchInfo(ctxOf(sync, fetchImpl), true);
}

// create false (solo leer): una rama que no existe no se crea → { missing: true }
async function branchInfo(ctx, create) {
  const { sync } = ctx;
  const branch = branchName(sync);
  if (!branch) return { branch: '', created: false, empty: false };
  const ref = await gh(ctx, 'GET', `${repoPath(sync)}/git/ref/heads/${filePath(branch)}`, null, [404, 409]);
  if (ref.status === 200 && ref.data?.object?.sha) return { branch, created: false, empty: false, sha: ref.data.object.sha };
  if (ref.status === 409) return { branch, created: false, empty: true }; // repositorio sin commits
  if (!create) return { branch, created: false, empty: false, missing: true };
  const repo = await gh(ctx, 'GET', repoPath(sync));
  const def = repo.data?.default_branch || 'main';
  const head = await gh(ctx, 'GET', `${repoPath(sync)}/git/ref/heads/${filePath(def)}`, null, [404, 409]);
  const sha = head.data?.object?.sha;
  if (head.status !== 200 || !sha) return { branch, created: false, empty: true };
  const made = await gh(ctx, 'POST', `${repoPath(sync)}/git/refs`, { ref: `refs/heads/${branch}`, sha }, [422]);
  if (made.status === 422 && !/exists/i.test(made.data?.message || '')) throw httpError(422, sync, made.data, null, 'POST git/refs');
  return { branch, created: made.status !== 422, empty: false, sha };
}

// Ruta de contenidos con la rama (sin rama = la por defecto; en un repo vacío tampoco)
const refQuery = (ctx) => (ctx.branch && !ctx.empty ? `?ref=${enc(ctx.branch)}` : '');

// Archivo (nombre) de la carpeta de la persona → datos de la API o null
async function getFile(ctx, name) {
  const r = await gh(ctx, 'GET', `${repoPath(ctx.sync)}/contents/${filePath(pathIn(ctx, name))}${refQuery(ctx)}`, null, [404]);
  return r.status === 404 ? null : r.data;
}

async function fileText(ctx, data) {
  if (data?.content && data.encoding === 'base64') return base64ToUtf8(data.content);
  // Archivos > 1 MB: la API de contenidos no trae el contenido → blob
  if (data?.sha) {
    const r = await gh(ctx, 'GET', `${repoPath(ctx.sync)}/git/blobs/${enc(data.sha)}`);
    return base64ToUtf8(r.data?.content || '');
  }
  return '';
}

// PUT de un archivo (nombre, en la carpeta de la persona) con el sha esperado (null = nuevo)
// → { conflict } | { sha, commit }
async function putContents(ctx, name, content, message, sha) {
  const path = pathIn(ctx, name);
  const body = { message: ctx.dir ? message.replace(/^Turnos:/, `Turnos (${ctx.dir}):`) : message, content: utf8ToBase64(content) };
  if (ctx.branch && !ctx.empty) body.branch = ctx.branch;
  if (sha) body.sha = sha;
  const r = await gh(ctx, 'PUT', `${repoPath(ctx.sync)}/contents/${filePath(path)}`, body, [409, 422]);
  if (r.status === 409 || (r.status === 422 && /sha/i.test(r.data?.message || ''))) return { conflict: true };
  if (r.status === 422) throw httpError(422, ctx.sync, r.data, null, `PUT ${path}`);
  return { conflict: false, sha: r.data?.content?.sha ?? null, commit: r.data?.commit?.sha ?? null };
}

// Repo vacío con rama indicada: el primer archivo crea la rama por defecto; después se crea la rama
async function afterFirstWrite(ctx, commit) {
  if (!ctx.empty) return;
  ctx.empty = false;
  if (!ctx.branch || !commit) return;
  const made = await gh(ctx, 'POST', `${repoPath(ctx.sync)}/git/refs`, { ref: `refs/heads/${ctx.branch}`, sha: commit }, [422]);
  if (made.status === 422 && !/exists/i.test(made.data?.message || '')) throw httpError(422, ctx.sync, made.data, null, 'POST git/refs');
}

// Calendario: solo se escribe si cambió; reintenta una vez si otro lo cambió entre medias.
// backupSha: el backup.json que esta sincronización leyó o escribió. Si cambió (otro pasó a publicar
// mientras esta estaba congelada), no se pisa su calendario → CONFLICT (se reintenta y ya solo lee).
async function putIcs(ctx, content, message, backupSha) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getFile(ctx, ICS_FILE);
    if (cur && (await fileText(ctx, cur)) === content) return { changed: false };
    if (backupSha && (await getFile(ctx, BACKUP_FILE))?.sha !== backupSha) {
      throw syncError('CONFLICT', `${BACKUP_FILE} cambió antes de escribir ${ICS_FILE} (otro dispositivo publicó).`, 409);
    }
    const r = await putContents(ctx, ICS_FILE, content, message, cur?.sha ?? null);
    if (!r.conflict) {
      await afterFirstWrite(ctx, r.commit);
      return { changed: true };
    }
  }
  throw syncError('CONFLICT', `Conflicto al escribir ${ICS_FILE}.`, 409);
}

// ---------- Copia cifrada ----------

// Datos autenticados: los metadatos en claro no se pueden alterar sin que falle el descifrado
// (desde v3 también quién publica)
function aadOf(doc) {
  const m = doc.meta;
  const base = `${BACKUP_FORMAT}|${doc.v}|${m.rev}|${m.deviceId}|${m.days}|${m.savedAt}`;
  return Number(doc.v) >= 3 ? `${base}|${m.publisher}|${m.publisherSince}` : base;
}

// Estado → documento backup.json (objeto). publisher: dispositivo que publica (por defecto deviceId).
// meta.name: nombre de pila en claro (para «Calendarios de la familia»); no va en los datos autenticados
// (así las versiones anteriores de la app siguen leyendo la copia).
export async function encryptBackup(state, { rev, now = new Date(), deviceId = '', key, publisher, publisherSince, getRandomValues } = {}) {
  const payload = syncPayload(state);
  const savedAt = now.toISOString();
  const meta = {
    rev, savedAt, deviceId: String(deviceId || ''), days: Object.keys(payload.days).length,
    publisher: String(publisher || deviceId || ''), publisherSince: publisherSince ?? savedAt,
  };
  const name = publicName(state?.settings?.name);
  if (name) meta.name = name;
  const doc = { format: BACKUP_FORMAT, v: BACKUP_VERSION, meta };
  doc.enc = await encryptText(JSON.stringify(payload), key, aadOf(doc), getRandomValues);
  return doc;
}

// Documento backup.json → contenido en claro (objeto como un archivo de copia). Lanza SyncError.
export async function decryptBackup(doc, key) {
  if (!isPlainObject(doc) || doc.format !== BACKUP_FORMAT || !isPlainObject(doc.meta) || !isPlainObject(doc.enc)) {
    throw syncError('BAD_REMOTE', `${BACKUP_FILE} no tiene el formato esperado.`);
  }
  if (Number(doc.v) > BACKUP_VERSION) throw syncError('NEWER_REMOTE', `${BACKUP_FILE} v${doc.v} (esta app entiende v${BACKUP_VERSION}).`);
  if (!isSyncKey(key)) throw syncError('NO_KEY', 'Este dispositivo no tiene la clave (settings.sync.key) del backup cifrado: envía un enlace de configuración con clave.');
  let text;
  try {
    text = await decryptText(doc.enc, key, aadOf(doc));
  } catch (e) {
    throw syncError('DECRYPT', `No se pudo descifrar ${BACKUP_FILE} (rev ${doc.meta.rev}, dispositivo ${doc.meta.deviceId || '?'}) con la clave de este dispositivo (${e?.name || 'Error'}).`);
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!isPlainObject(data) || !isPlainObject(data.days)) throw syncError('BAD_REMOTE', `${BACKUP_FILE} descifrado pero sin datos válidos.`);
  return data;
}

// Quién publica según la copia → { deviceId, since } | null. v2 no lo guardaba: se toma quien la
// escribió por última vez (así ningún otro dispositivo escribe sin pasar por becomePublisher).
function publisherOf(doc) {
  const m = doc.meta;
  if (Number(doc.v) >= 3) {
    if (typeof m.publisher !== 'string' || !m.publisher || m.publisher.length > 40) {
      throw syncError('BAD_REMOTE', `${BACKUP_FILE}: falta quién publica (meta.publisher).`);
    }
    return { deviceId: m.publisher, since: typeof m.publisherSince === 'string' ? m.publisherSince : null };
  }
  return typeof m.deviceId === 'string' && m.deviceId ? { deviceId: m.deviceId, since: null } : null;
}

// Lee el remoto → null | { rev, days, sha, doc, legacy, publisher, plain? }
async function readRemote(ctx) {
  const file = await getFile(ctx, BACKUP_FILE);
  if (file) {
    let doc = null;
    try { doc = JSON.parse(await fileText(ctx, file)); } catch { doc = null; }
    if (!isPlainObject(doc) || doc.format !== BACKUP_FORMAT || !isPlainObject(doc.meta) || !isPlainObject(doc.enc)) {
      throw syncError('BAD_REMOTE', `${BACKUP_FILE} no tiene el formato esperado.`);
    }
    if (Number(doc.v) > BACKUP_VERSION) throw syncError('NEWER_REMOTE', `${BACKUP_FILE} v${doc.v}.`);
    const rev = Number(doc.meta.rev);
    if (!Number.isSafeInteger(rev) || rev < 0) throw syncError('BAD_REMOTE', `${BACKUP_FILE}: rev no válida.`);
    return { rev, days: Math.max(0, Number(doc.meta.days) || 0), sha: file.sha, doc, legacy: false, publisher: publisherOf(doc) };
  }
  // Compatibilidad: turnos.json en claro de versiones antiguas (se fusiona y se migra a backup.json)
  const old = await getFile(ctx, LEGACY_JSON_FILE);
  if (old) {
    try {
      const plain = JSON.parse(await fileText(ctx, old));
      if (isPlainObject(plain) && isPlainObject(plain.days)) {
        return { rev: 0, days: Object.keys(plain.days).length, sha: null, doc: null, legacy: true, publisher: null, plain };
      }
    } catch { /* se ignora */ }
  }
  return null;
}

// Turnos del turnos.ics publicado (0 si no hay). El aviso «Sube el plan» (UID plan-…) no cuenta.
export function icsEventCount(text) {
  return (String(text || '').match(/^UID:(?!plan-)/gm) || []).length;
}

async function publishedEvents(ctx) {
  if (ctx.missing) return 0;
  const f = await getFile(ctx, ICS_FILE);
  return f ? icsEventCount(await fileText(ctx, f)) : 0;
}

// Descifra la copia. Si la clave actual no vale pero la anterior (prevKey, de antes de un enlace) sí,
// el enlace traía una clave equivocada: se recupera la anterior (res.keyRestored)
async function decryptRemote(doc, sync, patch, res) {
  try {
    const data = await decryptBackup(doc, sync.key);
    if (sync.prevKey) patch.prevKey = ''; // la clave actual ya está comprobada
    return data;
  } catch (e) {
    if (e?.code !== 'DECRYPT' || !isSyncKey(sync.prevKey) || sync.prevKey === sync.key) throw e;
    let data;
    try { data = await decryptBackup(doc, sync.prevKey); } catch { throw e; }
    sync.key = patch.key = sync.prevKey;
    patch.prevKey = '';
    res.keyRestored = true;
    return data;
  }
}

const lastSyncOf = (sync) => [sync.lastPushAt, sync.lastPullAt].filter(Boolean).sort().at(-1) ?? null;
const daysIn = (state) => Object.keys(state?.days || {}).length;
const CLEAR_ERRORS = Object.freeze({ lastError: null, lastErrorCode: null, lastErrorDetail: null, lastErrorSince: null });

// Huella de lo que se publica: datos + ajustes compartidos (avisos, lugares…). Si cambia, hay copia nueva.
function publishHash(state) {
  const shared = { ...Object.fromEntries(USER_SETTINGS.map((k) => [k, state?.settings?.[k] ?? null])), publishPlaces: state?.settings?.sync?.publishPlaces === true };
  return hashString(dataFingerprint(state) + '\u0000' + stableStringify(shared));
}

// Lo que un dispositivo que solo lee tiene distinto de lo publicado: días (códigos, nota y horario especial),
// definiciones de códigos y ajustes del calendario (avisos, lugares)
function unpublishedOf(a, b) {
  const differing = (map, content) => [...new Set([...Object.keys(a?.[map] || {}), ...Object.keys(b?.[map] || {})])]
    .filter((k) => content(a?.[map]?.[k]) !== content(b?.[map]?.[k])).sort();
  const days = differing('days', (d) => (d ? stableStringify({ codes: d.codes, note: d.note ?? '', times: d.times ?? null }) : null));
  const codes = differing('codes', (c) => (c ? stableStringify({ ...c, updatedAt: null }) : null));
  const cal = (s) => stableStringify([s?.settings?.reminders ?? null, s?.settings?.sync?.publishPlaces === true]);
  return { days, codes, settings: cal(a) !== cal(b) };
}

// Marca (no secreta) de la clave con la que se sincronizó, para descartar errores ya caducados
const keyTag = (key) => (key ? hashString(`turnos-key|${key}`).slice(0, 8) : '');

const isoOr = (v, fallback) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : fallback);
const errorInfo = (err) => ({ code: err.code, message: err.message, detail: err.detail || '', status: err.status ?? 0, retry: err.retry });

// Resultado vacío (nada leído ni escrito) con el formato de syncNow
function newResult(state, now, patch = {}) {
  const sync = state?.settings?.sync || {};
  return {
    ok: false, readOnly: false, publisher: null, tookOver: false, keyRestored: false,
    state, merged: false, pulled: false, pushed: false, icsPushed: false, conflictCount: 0, pulledDays: [],
    unpublishedDays: [], unpublishedCodes: [], unpublishedSettings: false,
    rev: null, remote: null, sync: patch, error: null, startedAt: now.toISOString(),
    target: { owner: String(sync.owner || '').trim(), repo: String(sync.repo || '').trim(), branch: branchName(sync), dir: dirOf(sync), keyTag: keyTag(sync.key) },
  };
}

// Sincroniza: lee el remoto, lo descifra y fusiona, y, SOLO si este dispositivo es el que publica,
// publica backup.json (rev+1, si hay algo nuevo) y turnos.ics (si difiere del publicado).
// options: { fetchImpl, now, force, allowEmpty, pullOnly, takeover, getRandomValues }
//   force: volver a publicar aunque no haya cambios (solo el que publica); takeover: ver becomePublisher.
// Si tiene que crear el deviceId o la clave, no escribe nada en esta llamada: devuelve RETRY con la
// identidad en el parche (se publica en la siguiente, ya guardada). Mejor crearla antes (ensureSyncIdentity).
// Nunca lanza. → {
//   ok, readOnly (otro dispositivo publica: aquí solo se lee), publisher: {deviceId, since}|null,
//   tookOver, keyRestored, state (fusionado, o el mismo objeto si no cambió), merged, pulled, pushed,
//   icsPushed, conflictCount, pulledDays, unpublishedDays / unpublishedCodes / unpublishedSettings
//   (solo lectura: lo de aquí que no está publicado),
//   rev, remote: {rev,days,savedAt,deviceId,publisher,legacy}|null, startedAt (ISO = now),
//   sync: parche para settings.sync (aplicar con applySyncResult), error: {code,message,detail,status,retry}|null,
//   target: {owner,repo,branch,keyTag} }
export async function syncNow(state, fetchArg) {
  const o = opts(fetchArg);
  const { fetchImpl, now = new Date(), force = false, allowEmpty = false, pullOnly: onlyPull = false, takeover = false, getRandomValues } = o;
  const sync = { ...(state?.settings?.sync || {}) };
  const patch = {};
  const res = newResult(state, now, patch);
  let fresh = false; // deviceId o clave creados en esta llamada
  let claimSent = false; // se envió un backup.json que cambia quién publica y aún no hay respuesta
  try {
    checkConfig(sync);
    // Datos de una versión más nueva: publicarlos desde aquí los recortaría
    if (state?.__newerSchema) throw syncError('NEWER_LOCAL', `Estado con esquema ${state.schema} (esta app: ${SCHEMA}).`);
    if (sync.key && !isSyncKey(sync.key)) throw syncError('NO_KEY', 'La clave guardada no tiene el formato correcto (base64url de 32 bytes).');
    if (!sync.deviceId) { sync.deviceId = patch.deviceId = randomId(12, getRandomValues); fresh = true; }
    // Quién publicaba según la última lectura: vale si backup.json desaparece (no se adueña cualquiera)
    const remembered = sync.publisher && sync.publisher !== sync.deviceId
      ? { deviceId: sync.publisher, since: isoOr(sync.publisherSince, null) } : null;
    const base = ctxOf(sync, fetchImpl);
    // Una rama que no existe solo la crea quien puede publicar
    const ctx = { ...base, ...(await branchInfo(base, !onlyPull && (takeover || !remembered))) };
    const baseRev = Number(sync.baseRev) || 0;
    let local = state;
    let backupSha = null;
    for (let attempt = 1; ; attempt++) {
      const remote = ctx.missing ? null : await readRemote(ctx);
      res.remote = remote ? {
        rev: remote.rev, days: remote.days, legacy: remote.legacy, publisher: remote.publisher?.deviceId ?? null,
        savedAt: remote.doc?.meta?.savedAt ?? null, deviceId: remote.doc?.meta?.deviceId ?? null,
        name: cleanPersonName(remote.doc?.meta?.name) || null,
      } : null;
      let merged = local, remoteState = null;
      // 1) Si hay copia: siempre descifrar (comprueba la clave) y fusionar por día
      if (remote) {
        const plain = remote.legacy ? remote.plain : await decryptRemote(remote.doc, sync, patch, res);
        if (Number(plain.schema) > SCHEMA) throw syncError('NEWER_REMOTE', `Esquema ${plain.schema} (esta app: ${SCHEMA}).`);
        remoteState = migrateState(plain);
        const m = mergeStates(local, remoteState, { now, since: lastSyncOf(sync), adoptSettings: daysIn(local) === 0 });
        merged = m.state;
        res.pulled = true;
        res.conflictCount += m.conflictCount;
        res.pulledDays = [...new Set([...res.pulledDays, ...m.pulledDays])].sort();
        res.state = merged;
        res.merged = merged !== state;
        patch.lastPullAt = now.toISOString();
        if (!remote.legacy) Object.assign(patch, { baseRev: remote.rev, lastPushHash: publishHash(remoteState) });
        res.rev = remote.rev;
      }
      // 2) ¿Quién publica? Solo un dispositivo escribe; los demás solo leen
      // Sin copia (borrada): si otro publicaba, sigue publicando él (aquí solo se lee)
      let pub = remote?.publisher ?? remembered;
      // Sin copia pero con un turnos.ics que este dispositivo no escribió (otro publicó después, o este
      // nunca publicó): no se adueña solo; hace falta «Usar este dispositivo»
      if (!remote && !pub && !takeover && !ctx.missing) {
        const f = await getFile(ctx, ICS_FILE);
        if (f && hashString(await fileText(ctx, f)) !== sync.lastIcsHash) pub = { deviceId: UNKNOWN_PUBLISHER, since: null };
      }
      const mine = !pub || pub.deviceId === sync.deviceId;
      res.publisher = pub ? { ...pub } : null;
      res.readOnly = !mine;
      if (pub) Object.assign(patch, { publisher: pub.deviceId, publisherSince: pub.since });
      if (onlyPull || (!mine && !takeover)) {
        if (!mine && remoteState) {
          const u = unpublishedOf(merged, remoteState);
          Object.assign(res, { unpublishedDays: u.days, unpublishedCodes: u.codes, unpublishedSettings: u.settings });
        }
        const pending = res.unpublishedDays.length + res.unpublishedCodes.length + (res.unpublishedSettings ? 1 : 0);
        if (remoteState || mine) patch.unpublished = pending; // sin copia no se puede comparar
        Object.assign(patch, CLEAR_ERRORS);
        res.ok = true;
        return res;
      }

      // 3) Este dispositivo publica (o pasa a publicar con takeover)
      const claim = !pub || pub.deviceId !== sync.deviceId;
      const since = claim ? now.toISOString() : isoOr(pub.since, now.toISOString());
      // Primera copia (nada en el remoto): se genera la clave si falta
      if ((!remote || remote.legacy) && !sync.key) { sync.key = patch.key = generateSyncKey(getRandomValues); fresh = true; }
      const localHash = publishHash(merged);
      const remoteHash = remoteState ? publishHash(remoteState) : null;
      const oldFormat = Boolean(remote && !remote.legacy && Number(remote.doc.v) < BACKUP_VERSION);
      const needBackup = force || claim || oldFormat || !remote || remote.legacy || localHash !== remoteHash;
      const remoteDays = remoteState ? daysIn(remoteState) : 0;
      // 0 días encima de una copia con días: solo si cada día de la copia lo borró aquí alguien a
      // propósito (tombstone más nueva, que ganó al fusionar); si no, es una copia vacía
      const deliberate = remoteDays > 0 && Object.keys(remoteState.days).every((k) => merged.tombstones?.[k]);
      if (needBackup && daysIn(merged) === 0 && remoteDays > 0 && !allowEmpty && !deliberate) {
        throw syncError('EMPTY_LOCAL', `Publicar dejaría 0 días encima de ${remoteDays} días (rev ${remote.rev}).`);
      }
      // Sin copia pero con calendario publicado: una copia vacía no lo vacía
      if ((!remote || remote.legacy) && daysIn(merged) === 0 && !allowEmpty) {
        const events = await publishedEvents(ctx);
        if (events) throw syncError('EMPTY_LOCAL', `Sin ${BACKUP_FILE}: publicar dejaría 0 días encima de ${events} eventos de ${ICS_FILE}.`);
      }
      // Identidad creada en esta llamada: primero se guarda (applySyncResult); se publica en la siguiente.
      // Así nunca queda en GitHub una copia cifrada con una clave que ningún dispositivo guardó.
      if (fresh) throw syncError('RETRY', 'deviceId o clave creados ahora: se publica en la siguiente sincronización, ya guardados.');
      if (needBackup) {
        const rev = Math.max(remote && !remote.legacy ? remote.rev : 0, baseRev) + 1;
        if (!isSyncKey(sync.key)) throw syncError('NO_KEY', 'No hay clave para cifrar la copia.');
        const doc = await encryptBackup(merged, {
          rev, now, deviceId: sync.deviceId, key: sync.key, publisher: sync.deviceId, publisherSince: since, getRandomValues,
        });
        claimSent = claim;
        const put = await putContents(ctx, BACKUP_FILE, JSON.stringify(doc), `Turnos: copia cifrada (rev ${rev})`, remote && !remote.legacy ? remote.sha : null);
        claimSent = false;
        if (put.conflict) {
          // Otro escribió entre medias: volver a leer y fusionar (si ya no publicamos, solo se lee)
          if (attempt >= MAX_ATTEMPTS) throw syncError('CONFLICT', `${BACKUP_FILE} cambió ${attempt} veces mientras se guardaba.`, 409);
          local = merged;
          continue;
        }
        await afterFirstWrite(ctx, put.commit);
        backupSha = put.sha;
        Object.assign(patch, { baseRev: rev, lastPushHash: localHash, lastPushAt: now.toISOString() });
        res.pushed = true;
        res.rev = rev;
        res.tookOver = Boolean(pub) && pub.deviceId !== sync.deviceId;
      } else {
        backupSha = remote.sha;
        Object.assign(patch, { baseRev: remote.rev, lastPushHash: localHash });
        res.rev = remote.rev;
      }
      if (sync.prevKey) patch.prevKey = ''; // se publicó (o se leyó) con la clave actual
      res.publisher = { deviceId: sync.deviceId, since };
      res.readOnly = false;
      Object.assign(patch, { publisher: sync.deviceId, publisherSince: since, unpublished: 0 });
      // 4) Calendario (de los datos fusionados): se compara con el publicado y se escribe si difiere.
      // Así el que publica repara un calendario que otro dejó atrasado.
      const ics = buildICS(merged, { now, places: merged?.settings?.sync?.publishPlaces === true, notes: false });
      const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
      const r = await putIcs(ctx, ics, `Turnos: calendario (${stamp})`, backupSha);
      res.icsPushed = r.changed;
      patch.lastIcsHash = hashString(ics);
      Object.assign(patch, CLEAR_ERRORS);
      res.ok = true;
      return res;
    }
  } catch (e) {
    const err = e instanceof SyncError ? e : syncError('UNKNOWN', String(e?.message || e));
    res.error = errorInfo(err);
    // Conflicto (otro escribió entre medias) o una toma cuya respuesta se perdió (la escritura pudo
    // llegar): quién publica lo dirá la próxima lectura (no se presupone)
    if (err.code === 'CONFLICT' || claimSent) for (const k of ['publisher', 'publisherSince', 'unpublished']) delete patch[k];
    // RETRY no es un fallo (solo hay que guardar la identidad y repetir): no se anota como error
    if (err.code !== 'RETRY') {
      Object.assign(patch, {
        lastError: err.message, lastErrorCode: err.code, lastErrorDetail: err.detail || null,
        // Desde cuándo falla (se mantiene mientras dure el error; se borra al ir bien)
        lastErrorSince: (sync.lastError && isoOr(sync.lastErrorSince, null)) || now.toISOString(),
      });
    }
    return res;
  }
}

// Solo leer y fusionar (sin publicar nada): para «Restaurar desde GitHub» o al configurar.
// res.readOnly dice si otro dispositivo publica (la UI puede ofrecer «Usar este dispositivo»).
export function pullOnly(state, fetchArg) {
  return syncNow(state, { ...opts(fetchArg), pullOnly: true, takeover: false });
}
export const restoreFromRemote = pullOnly;

// Pasa a ser el dispositivo que publica: primero lee, descifra y fusiona; después publica
// (rev+1) con publisher = este dispositivo, y el calendario. Llamarlo SOLO tras confirmarlo el
// usuario («Usar este dispositivo»). Mismo resultado que syncNow (tookOver: true si cambió).
export function becomePublisher(state, fetchArg) {
  return syncNow(state, { ...opts(fetchArg), takeover: true, pullOnly: false });
}

// true si otro dispositivo publica (este solo lee), según la última lectura guardada en settings.sync
export function isReadOnlyDevice(sync) {
  return Boolean(sync?.enabled && sync.publisher && sync.publisher !== sync.deviceId);
}

// Campos que un resultado viejo no debe tocar (lo que dice quién publica y hasta dónde se llegó)
const STALE_FIELDS = ['baseRev', 'publisher', 'publisherSince', 'unpublished', 'lastPullAt', 'lastPushAt',
  'lastPushHash', 'lastIcsHash', 'lastError', 'lastErrorCode', 'lastErrorDetail', 'lastErrorSince', 'prevKey'];

// Aplica el resultado de syncNow/pullOnly/becomePublisher sobre el estado ACTUAL del store (puede
// haber cambiado mientras se sincronizaba): fusiona los datos traídos y guarda el parche de settings.sync.
// - Si la configuración cambió entre medias (otro repo), no aplica nada.
// - Resultado viejo (empezó antes que el último aplicado, sync.lastSyncStartedAt): solo fusiona los
//   datos; no toca quién publica, baseRev, unpublished ni errores (no deshace un «Usar este dispositivo»).
// - Un deviceId o clave del resultado solo rellenan los que falten (la clave anterior recuperada con
//   prevKey sí sustituye, si la sincronización empezó con la clave que sigue guardada).
export function applySyncResult(current, res, { now } = {}) {
  if (!res || !current) return current;
  const s = current.settings?.sync || {};
  const t = res.target;
  if (t && (String(s.owner || '').trim() !== t.owner || String(s.repo || '').trim() !== t.repo || branchName(s) !== t.branch
    || dirOf(s) !== (t.dir ?? ''))) return current;
  let next = current;
  if (res.merged && res.state && res.state !== current) {
    next = mergeStates(current, res.state, { now, adoptSettings: daysIn(current) === 0 }).state;
  }
  const p = { ...(res.sync || {}) };
  const sameKey = t?.keyTag === undefined || t.keyTag === keyTag(s.key);
  const started = Date.parse(res.startedAt), last = Date.parse(s.lastSyncStartedAt);
  // (una marca en el futuro, de un reloj que se adelantó, no cuenta: si no, todo parecería viejo)
  const nowTs = (now instanceof Date ? now : new Date()).getTime();
  const older = Number.isFinite(started) && Number.isFinite(last) && started < last && last <= nowTs + 60000;
  // Empezó antes, pero publicó una rev más nueva que la guardada (p. ej. «Usar este dispositivo»
  // mientras otra pestaña leía la copia anterior): lo suyo es lo último, no es viejo
  const wrote = Boolean(res.pushed || res.tookOver) && Number(res.rev) > (Number(s.baseRev) || 0);
  const stale = older && !wrote;
  if (p.deviceId && s.deviceId) delete p.deviceId;
  if (p.key && s.key && (stale || !sameKey || !res.keyRestored)) delete p.key;
  // Sincronización que empezó con otra clave (otra pestaña u otro enlace ya guardó una): sus errores
  // y su prevKey no valen
  if (!sameKey) for (const k of ['lastError', 'lastErrorCode', 'lastErrorDetail', 'lastErrorSince', 'prevKey']) delete p[k];
  if (stale) for (const k of STALE_FIELDS) delete p[k];
  else if (Number.isFinite(started) && !older) p.lastSyncStartedAt = res.startedAt; // nunca hacia atrás
  return updateSettings(next, { sync: p }, { now });
}

// Comprueba una configuración nueva (enlace #setup= o formulario) ANTES de guardarla: con una COPIA del
// estado lee y descifra el remoto (pullOnly: no escribe nada). Si la clave no descifra la copia, falta
// la clave, el token no vale… → { ok:false } y la configuración actual sigue intacta.
// Un fallo pasajero (sin red) solo se acepta en un dispositivo que aún no tenía una configuración que
// funcionara (se reintentará solo). options: { fetchImpl, now, getRandomValues }
// → { ok:true, res, readOnly, publisher, error (pasajero o null), apply(state) → state }
//   | { ok:false, error, res }
// apply: store.set((s) => t.apply(s)) guarda configuración + identidad (la probada) + lo leído.
// Otra persona (SPEC §11): si el enlace es del calendario de otra persona → { ok:false, error OTHER_PERSON,
// otherPerson } y no cambia nada. Con options.switchPerson: true (tras confirmarlo) el dispositivo pasa a
// ese calendario desde un estado limpio (personSwitchState): nada de la persona anterior se fusiona ni se
// publica allí (→ switched: true).
export async function trySetupConfig(state, cfg, options) {
  const o = opts(options);
  const now = o.now instanceof Date ? o.now : new Date();
  const cur = state?.settings?.sync || {};
  const c = withDir(normalizeSyncConfig(cfg), cur);
  if (!c) return { ok: false, error: errorInfo(syncError('CONFIG', 'Enlace o configuración no válidos.')), res: null };
  const deviceId = cur.deviceId || randomId(12, o.getRandomValues);
  const working = Boolean(cur.enabled && (cur.lastPullAt || cur.lastPushAt));
  // Lee el remoto con una copia de prueba de base (no escribe nada) → { res, key }
  const probe = async (base) => {
    const bs = base?.settings?.sync || {};
    // La clave guardada solo vale para su carpeta: otra persona (otro dir/repo) nunca la hereda
    const key = c.key || (isSyncKey(bs.key) && sameFolder(bs, c) ? bs.key : '');
    // Con la clave que se va a usar (sin la red de seguridad prevKey: se prueba ESTA); sin clave se
    // prueba sin ninguna (NO_KEY si ya hay copia cifrada)
    let trial = applySyncConfig(base, c, { now, getRandomValues: o.getRandomValues, deviceId, key: key || false });
    trial = updateSettings(trial, { sync: { prevKey: '', ...(key ? {} : { key: '' }) } });
    return { res: await pullOnly(trial, { ...o, now }), key };
  };
  const failedRead = (res) => res.error && (!res.error.retry || working);
  let { res, key } = await probe(state);
  if (failedRead(res)) return { ok: false, error: res.error, res };
  const other = otherPersonOf(state, c, res);
  if (other && o.switchPerson !== true) {
    const error = { ...errorInfo(syncError('OTHER_PERSON', other.detail)), message: otherPersonMessage(other.info) };
    return { ok: false, error, res, otherPerson: other.info };
  }
  const switched = Boolean(other);
  if (switched) {
    // Cambio de persona confirmado: se prueba (y luego se guarda) desde un estado limpio
    ({ res, key } = await probe(personSwitchState(state)));
    if (failedRead(res)) return { ok: false, error: res.error, res };
  }
  // Sin clave y sin copia remota: se crea ahora (antes de guardar nada y de publicar)
  const finalKey = key || (res.ok ? generateSyncKey(o.getRandomValues) : false);
  return {
    ok: true, res, readOnly: res.readOnly, publisher: res.publisher, error: res.error, switched,
    apply: (s) => applySyncResult(applySyncConfig(switched ? personSwitchState(s) : s, c, { now, getRandomValues: o.getRandomValues, deviceId, key: finalKey }), res, { now }),
  };
}

// Mensaje de OTHER_PERSON con los nombres que se conocen
function otherPersonMessage({ reason, name, current }) {
  const mine = current?.name;
  if (name && mine && firstNameKey(name) === firstNameKey(mine)) return 'Este enlace es de otro calendario, no del que usa este dispositivo. No se cambió nada.';
  if (!name) return SYNC_MESSAGES.OTHER_PERSON;
  if (reason === 'name') return `Este enlace es del calendario de ${name} y en este dispositivo hay turnos de ${mine}. No se cambió nada.`;
  return `Este enlace es del calendario de ${name}${mine ? ` y este dispositivo usa el de ${mine}` : ', no del que usa este dispositivo'}. No se cambió nada.`;
}

// ¿El enlace (c) es del calendario de otra persona? (SPEC §11) Lo es si:
//  - folder: este dispositivo ya funciona con otra carpeta (otro owner, repo o dir);
//  - name: aquí hay turnos y un nombre, y el del calendario del enlace (meta.name de la copia o, sin
//    ella, el del enlace) es otro.
// Un dispositivo sin conectar y sin nombre (o con el mismo) no se bloquea (p. ej. Ana escanea antes de
// tener su enlace). → null | { info: { reason, name, dir, current: { name, dir }, working }, detail }
function otherPersonOf(state, c, res) {
  const cur = state?.settings?.sync || {};
  const working = Boolean(cur.enabled && (cur.lastPullAt || cur.lastPushAt));
  const folder = sameFolder(cur, c);
  if (working && folder) return null; // la misma carpeta (otra clave, otro token…)
  const theirs = publicName(res?.remote?.name) || publicName(c.name);
  const mine = publicName(state?.settings?.name);
  let reason = null;
  if (working) reason = 'folder';
  else if (daysIn(state) > 0 && mine && theirs && firstNameKey(mine) !== firstNameKey(theirs)) reason = 'name';
  if (!reason) return null;
  const where = (s) => `${String(s.owner || '').trim()}/${String(s.repo || '').trim()}/${dirOf(s) || '(raíz)'}`;
  return {
    info: { reason, name: theirs || null, dir: dirOf(c), current: { name: mine || null, dir: dirOf(cur) }, working },
    detail: `${reason === 'folder' ? 'Otra carpeta' : 'Otro nombre'}: este dispositivo ${where(cur)}${mine ? ` (${mine})` : ''}; enlace ${where(c)}${theirs ? ` (${theirs})` : ''}.`,
  };
}

// Cola única para TODAS las llamadas de sincronización de la UI: una cada vez, y cada resultado se
// aplica al store en cuanto llega (applySyncResult). Un RETRY (identidad recién creada) se repite solo,
// salvo que la identidad no se haya podido guardar (almacenamiento lleno): mientras no se guarde, la
// cola no escribe en GitHub (una copia cifrada con una clave que solo está en memoria se perdería con
// ella) y devuelve RETRY sin conectarse. Leer (pull) sí se puede.
// store: { get, set, saveOk? } (createStore). options: { fetchImpl, clock: () => Date }
// → { sync(opts), pull(opts), becomePublisher(opts), setup(cfg, opts), idle() }  (promesas del resultado)
export function createSyncQueue(store, { fetchImpl, clock = () => new Date() } = {}) {
  let tail = Promise.resolve();
  let last = null;    // último trabajo encolado
  let waiting = null; // syncNow normal aún sin empezar: si es el último encolado, se reutiliza
  let unsaved = false; // identidad (deviceId/clave) en memoria que no se pudo guardar
  const enqueue = (job) => {
    const p = tail.then(job, job);
    tail = p.catch(() => {});
    last = p;
    return p;
  };
  const failed = () => store.saveOk?.() === false;
  const identityOf = (st) => `${st?.settings?.sync?.deviceId || ''}|${st?.settings?.sync?.key || ''}`;
  // store.set + ¿quedó sin guardar una identidad nueva?
  const save = (fn) => {
    const before = identityOf(store.get());
    store.set(fn);
    if (!failed()) unsaved = false;
    else if (identityOf(store.get()) !== before) unsaved = true;
  };
  // ¿Se puede escribir en GitHub? Con la identidad sin guardar, se intenta guardar otra vez
  const identitySaved = () => {
    if (unsaved && failed()) store.set((st) => st);
    if (unsaved && !failed()) unsaved = false;
    return !unsaved;
  };
  const call = (fn, extra = {}, writes = true) => async () => {
    let res;
    for (let i = 0; i < 3; i++) {
      const now = clock();
      if (writes && !identitySaved()) {
        return res ?? { ...newResult(store.get(), now), error: errorInfo(syncError('RETRY', 'No se pudo guardar el deviceId o la clave en este dispositivo: no se publica hasta poder guardarlos.')) };
      }
      res = await fn(store.get(), { ...extra, fetchImpl: extra.fetchImpl ?? fetchImpl, now });
      save((cur) => applySyncResult(cur, res, { now }));
      if (res.error?.code !== 'RETRY' || unsaved) break;
    }
    return res;
  };
  return {
    sync(extra) {
      if (!extra && waiting && waiting === last) return waiting;
      const job = call(syncNow, extra);
      const p = enqueue(() => { if (waiting === p) waiting = null; return job(); });
      if (!extra) waiting = p;
      return p;
    },
    pull: (extra) => enqueue(call(pullOnly, extra, false)),
    becomePublisher: (extra) => enqueue(call(becomePublisher, extra)),
    setup: (cfg, extra = {}) => enqueue(async () => {
      const t = await trySetupConfig(store.get(), cfg, { ...extra, fetchImpl: extra.fetchImpl ?? fetchImpl, now: clock() });
      if (t.ok) save((s) => t.apply(s));
      return t;
    }),
    idle: () => tail,
  };
}

// Descarga y descifra la copia del remoto (para restaurar reemplazando con importBackup)
// → { rev, meta, data } (data: objeto en claro como un archivo de copia). Lanza SyncError. No escribe.
export async function fetchRemoteBackup(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  checkConfig(sync);
  const base = ctxOf(sync, fetchImpl);
  const ctx = { ...base, ...(await branchInfo(base, false)) };
  const remote = ctx.missing ? null : await readRemote(ctx);
  if (!remote) throw syncError('NO_REMOTE', `No existe ${BACKUP_FILE}.`, 404);
  const data = remote.legacy ? remote.plain : await decryptBackup(remote.doc, sync.key);
  return { rev: remote.rev, meta: remote.doc?.meta ?? { rev: 0, days: remote.days }, data };
}

// Compatibilidad: JSON en claro de la copia remota (se puede pasar a importBackup)
export async function pullBackup(sync, fetchArg) {
  const { data } = await fetchRemoteBackup(sync, fetchArg);
  return JSON.stringify(data);
}

// Compatibilidad (obsoleto): como syncNow pero lanza SyncError; devuelve también state y sync completos.
// Sin clave o sin deviceId no hace nada: quien usa esta API antigua no los guarda.
export async function pushData(state, fetchArg) {
  if (!isSyncKey(state?.settings?.sync?.key)) throw syncError('NO_KEY', 'pushData (obsoleto) sin clave: usa syncNow + applySyncResult.');
  if (!state.settings.sync.deviceId) throw syncError('CONFIG', 'pushData (obsoleto) sin deviceId: usa ensureSyncIdentity + syncNow + applySyncResult.');
  const res = await syncNow(state, { ...opts(fetchArg), takeover: false, pullOnly: false });
  if (res.error) throw new SyncError(res.error.message, res.error.status, res.error);
  return { ...res, pushed: res.pushed || res.icsPushed, changed: res.pushed || res.icsPushed, hash: res.sync.lastPushHash ?? null, sync: { ...state.settings.sync, ...res.sync } };
}

// Hash del contenido publicable (datos + calendario)
export function contentHash(state, now = new Date()) {
  return hashString(buildICS(state, { now, places: state?.settings?.sync?.publishPlaces === true }) + '\u0000' + dataFingerprint(state));
}

export const ICSX5_PACKAGE = 'at.bitfire.icsdroid';
export const ICSX5_PLAY_URL = `https://play.google.com/store/apps/details?id=${ICSX5_PACKAGE}`;

// URLs del calendario para suscribirse (el repositorio debe ser público). Rama '' → HEAD (la por defecto).
// → { webcal (iPhone), https (copiar / Google Calendar «Desde URL»), webcals,
//     android: intent:// que abre ICSx⁵ (o su página de Google Play si no está instalada) }
export function calendarUrls(sync) {
  const branch = branchName(sync) || 'HEAD';
  const dir = dirOf(sync);
  const parts = [String(sync.owner).trim(), String(sync.repo).trim(), ...branch.split('/'), ...(dir ? [dir] : []), ICS_FILE];
  const path = ['raw.githubusercontent.com', ...parts.map(enc)].join('/');
  return {
    webcal: `webcal://${path}`,
    https: `https://${path}`,
    webcals: `webcals://${path}`,
    // Chrome en Android: abre ICSx⁵ en su pantalla de suscripción (webcals → https); sin la app, Google Play
    android: `intent://${path}#Intent;scheme=webcals;package=${ICSX5_PACKAGE};S.browser_fallback_url=${enc(ICSX5_PLAY_URL)};end`,
  };
}

// '#setup=…' (o una URL completa) → { enabled:true, owner, repo, branch, dir, token, key, publishPlaces?, name? }
// o null. Un enlace antiguo (sin dir) es la carpeta raíz.
export function parseSetupLink(hash) {
  const m = /(?:^|[#&?])setup=([A-Za-z0-9_\-+/=%]+)/.exec(String(hash || ''));
  if (!m || m[1].length > 4000) return null;
  try {
    const cfg = normalizeSyncConfig(JSON.parse(base64UrlDecode(decodeURIComponent(m[1]))));
    return cfg ? { enabled: true, ...cfg, dir: cfg.dir ?? '' } : null;
  } catch {
    return null;
  }
}

// Enlace de configuración: base + '#setup=<base64url(JSON)>' (incluye la clave de cifrado; dir y name
// solo si los hay, así el enlace de la raíz es igual que antes)
export function buildSetupLink(baseUrl, sync) {
  const base = String(baseUrl || '').split('#')[0];
  const payload = { v: 2, owner: sync.owner, repo: sync.repo, branch: branchName(sync), token: sync.token, key: sync.key || '' };
  const dir = dirOf(sync);
  if (dir) payload.dir = dir;
  if (sync.publishPlaces === true) payload.publishPlaces = true;
  const name = cleanPersonName(sync.name);
  if (name) payload.name = name;
  return `${base}#setup=${base64UrlEncode(JSON.stringify(payload))}`;
}

// «Crear enlace para otra persona» (SPEC §11): carpeta nueva (slug único del nombre entre
// existingDirs, la raíz y la carpeta de este dispositivo) + clave NUEVA + mismo owner/repo/rama/token.
// existingDirs: las carpetas que ya hay (listCalendars(sync).map((c) => c.dir)).
// → { link, dir, key, name, urls }. Lanza Error (code 'NAME') sin nombre y SyncError CONFIG si la
// conexión de este dispositivo no está completa.
export function buildPersonLink(baseUrl, sync, { name, existingDirs = [], getRandomValues } = {}) {
  const cfg = normalizeSyncConfig({ owner: sync?.owner, repo: sync?.repo, branch: sync?.branch ?? '', token: sync?.token, key: '', dir: '' });
  if (!cfg) throw syncError('CONFIG', 'Para crear el enlace, primero conecta este dispositivo con GitHub.');
  const clean = cleanPersonName(name);
  if (!clean) {
    const e = new Error('Escribe el nombre de la persona.');
    e.code = 'NAME';
    throw e;
  }
  const dir = uniqueDir(clean, ['', dirOf(sync), ...(Array.isArray(existingDirs) ? existingDirs : [])]);
  const key = generateSyncKey(getRandomValues);
  const target = { ...cfg, dir, key, name: clean };
  return { link: buildSetupLink(baseUrl, target), dir, key, name: clean, urls: calendarUrls(target) };
}

const MAX_CALENDARS = 30;

// Contenido de una carpeta del repo (API contents) → [{ type, name }] | null si no existe
async function listDir(ctx, path) {
  const r = await gh(ctx, 'GET', `${repoPath(ctx.sync)}/contents${path ? `/${filePath(path)}` : ''}${refQuery(ctx)}`, null, [404]);
  if (r.status === 404 || !Array.isArray(r.data)) return null;
  return r.data.filter((e) => isPlainObject(e) && typeof e.name === 'string').map((e) => ({ type: e.type, name: e.name }));
}

// Nombre desde X-WR-CALNAME («Turnos de Ana» → 'Ana'; «Mis turnos» → null)
function nameFromIcs(text) {
  const m = /^X-WR-CALNAME:(.*)$/m.exec(String(text || '').replace(/\r\n[ \t]/g, ''));
  if (!m) return null;
  const cal = m[1].replace(/\r$/, '').replace(/\\([\\;,])/g, '$1').replace(/\\n/gi, ' ');
  const n = /^Turnos de (.+)$/.exec(cal.trim());
  return n ? cleanPersonName(n[1]) || null : null;
}

// «Calendarios de la familia» (SPEC §11): carpetas del repo de datos con calendario (la raíz y las
// carpetas de primer nivel con backup.json o turnos.ics), con el nombre de pila (meta.name de
// backup.json en claro; si no, el de turnos.ics). Solo lee (necesita el token).
// → [{ dir, name|null, urls (calendarUrls), updatedAt|null, mine (es la de este dispositivo),
//      hasBackup, hasCalendar }] (la raíz primero). Repo vacío o rama inexistente → []. Lanza SyncError.
export async function listCalendars(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  checkConfig(sync);
  const base = ctxOf({ ...sync, dir: '' }, fetchImpl);
  const ctx = { ...base, ...(await branchInfo(base, false)) };
  if (ctx.missing || ctx.empty) return [];
  const root = await listDir(ctx, '');
  if (!root) return [];
  const files = (entries) => ({
    hasBackup: entries.some((e) => e.type === 'file' && e.name === BACKUP_FILE),
    hasCalendar: entries.some((e) => e.type === 'file' && e.name === ICS_FILE),
  });
  const found = [];
  const r = files(root);
  if (r.hasBackup || r.hasCalendar) found.push({ dir: '', ...r });
  const dirs = root.filter((e) => e.type === 'dir' && DIR_RE.test(e.name)).map((e) => e.name).sort().slice(0, MAX_CALENDARS);
  for (const d of dirs) {
    const entries = await listDir(ctx, d);
    if (!entries) continue;
    const f = files(entries);
    if (f.hasBackup || f.hasCalendar) found.push({ dir: d, ...f });
  }
  const mine = dirOf(sync);
  const out = [];
  for (const f of found) {
    const c = { ...ctx, dir: f.dir };
    let name = null, updatedAt = null;
    if (f.hasBackup) {
      const file = await getFile(c, BACKUP_FILE);
      let doc = null;
      try { doc = file ? JSON.parse(await fileText(c, file)) : null; } catch { doc = null; } // copia dañada: sin nombre
      name = cleanPersonName(doc?.meta?.name) || null;
      updatedAt = isoOr(doc?.meta?.savedAt, null);
    }
    if (!name && f.hasCalendar) {
      const file = await getFile(c, ICS_FILE);
      name = file ? nameFromIcs(await fileText(c, file)) : null;
    }
    out.push({ dir: f.dir, name, urls: calendarUrls({ ...sync, dir: f.dir }), updatedAt, mine: f.dir === mine, ...f });
  }
  return out;
}
