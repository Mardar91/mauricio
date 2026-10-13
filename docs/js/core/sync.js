// Sincronización segura con GitHub (SPEC §9). En el repo de datos solo hay dos archivos:
//  - backup.json: { format:'turnos-backup', v:2, meta:{rev,savedAt,deviceId,days}, enc:{alg,iv,data} }
//    con el estado completo cifrado (AES-GCM 256, clave settings.sync.key; sin token ni clave dentro).
//  - turnos.ics: el calendario (sin notas; lugares solo con publishPlaces).
// Antes de publicar siempre se lee el remoto y, si su rev no es la nuestra (baseRev), se descifra y
// se fusiona por día. Nunca se publica una copia vacía encima de una con datos.
import { decryptText, encryptText, generateSyncKey, isSyncKey, randomId } from './cipher.js';
import { buildICS } from './ics.js';
import { SCHEMA, dataFingerprint, mergeStates, migrateState, syncPayload, updateSettings } from './store.js';
import { base64ToUtf8, base64UrlDecode, base64UrlEncode, defaultFetch, hashString, isPlainObject, utf8ToBase64 } from './util.js';

export const API = 'https://api.github.com';
export const DEFAULT_REPO = 'mauricio-datos';
export const DATA_BRANCH = '';            // '' = rama por defecto del repo
export const ICS_FILE = 'turnos.ics';
export const BACKUP_FILE = 'backup.json';
export const LEGACY_JSON_FILE = 'turnos.json'; // copia en claro de versiones antiguas (solo lectura)
export const JSON_FILE = BACKUP_FILE;
export const BACKUP_FORMAT = 'turnos-backup';
export const BACKUP_VERSION = 2;
const MAX_ATTEMPTS = 3;

const HELP = 'Pide ayuda a quien te configuró la app.';
// Mensajes para Mauricio (sin jerga). El detalle técnico va aparte (error.detail / lastErrorDetail).
export const SYNC_MESSAGES = Object.freeze({
  CONFIG: `El calendario no está configurado del todo. ${HELP}`,
  NO_KEY: `Falta la clave para leer tus turnos guardados. No se ha enviado nada. ${HELP}`,
  AUTH: `La conexión del calendario ha caducado. ${HELP}`,
  FORBIDDEN: `No se pudo actualizar el calendario. ${HELP}`,
  NOT_FOUND: `No se pudo actualizar el calendario. ${HELP}`,
  INVALID: `No se pudo actualizar el calendario. ${HELP}`,
  UNKNOWN: `No se pudo actualizar el calendario. ${HELP}`,
  RATE_LIMIT: 'El servicio del calendario está ocupado ahora mismo. Se volverá a intentar en un rato.',
  SERVER: 'El servicio del calendario no responde ahora mismo. Se volverá a intentar más tarde.',
  NETWORK: 'Sin conexión a internet. El calendario se actualizará cuando vuelva la conexión.',
  CONFLICT: 'Otro dispositivo estaba guardando a la vez. Se volverá a intentar en un momento.',
  DECRYPT: `No se pudieron leer tus turnos guardados en internet (la clave no coincide). No se ha enviado nada. ${HELP}`,
  BAD_REMOTE: `Los turnos guardados en internet están dañados. No se ha enviado nada. ${HELP}`,
  NEWER_REMOTE: 'Tus turnos guardados en internet son de una versión más nueva de la app. Actualiza la app: ciérrala del todo y vuelve a abrirla.',
  NEWER_LOCAL: 'Esta copia de la app está desactualizada. Ciérrala del todo y vuelve a abrirla para actualizarla.',
  EMPTY_LOCAL: 'Este teléfono no tiene turnos y en internet sí. No se ha enviado nada para no borrarlos.',
  NO_REMOTE: 'Todavía no hay ninguna copia guardada en internet.',
});
// Errores pasajeros: se reintenta solo; el resto necesita ayuda
const RETRY_CODES = new Set(['RATE_LIMIT', 'SERVER', 'NETWORK', 'CONFLICT']);

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

// Nombre de rama válido para git y seguro en URLs ('' = rama por defecto)
export function isValidBranch(b) {
  if (b === '') return true;
  if (typeof b !== 'string' || b.length > 100 || !/^[A-Za-z0-9._/-]+$/.test(b)) return false;
  if (b === 'HEAD' || b.startsWith('-') || b.endsWith('.') || b.endsWith('.lock') || b.includes('..')) return false;
  return b.split('/').every((seg) => seg && !seg.startsWith('.'));
}

// Normaliza { owner, repo, branch, token, key, publishPlaces? } → objeto válido o null
export function normalizeSyncConfig(data) {
  if (!isPlainObject(data)) return null;
  const str = (v) => (typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : null);
  const owner = str(data.owner ?? data.o), repo = str(data.repo ?? data.r), token = str(data.token ?? data.t);
  const branch = str(data.branch ?? data.b), key = str(data.key ?? data.k);
  if ([owner, repo, token, branch, key].some((v) => v === null)) return null;
  if (!isValidOwner(owner) || !isValidRepo(repo) || !isValidToken(token) || !isValidBranch(branch)) return null;
  if (key && !isSyncKey(key)) return null;
  const out = { owner, repo, branch, token, key };
  const places = data.publishPlaces ?? data.p;
  if (typeof places === 'boolean') out.publishPlaces = places;
  return out;
}

// Parche para settings.sync al aplicar una configuración nueva (enlace o formulario):
// activa la sync y reinicia la contabilidad para que lo primero sea leer y fusionar el remoto.
export function syncConfigPatch(cfg) {
  const patch = {
    owner: cfg.owner, repo: cfg.repo, branch: cfg.branch ?? '', token: cfg.token, enabled: true,
    baseRev: 0, lastPushAt: null, lastPushHash: null, lastIcsHash: null, lastPullAt: null,
    lastError: null, lastErrorCode: null, lastErrorDetail: null,
  };
  if (cfg.key) patch.key = cfg.key;
  if (typeof cfg.publishPlaces === 'boolean') patch.publishPlaces = cfg.publishPlaces;
  return patch;
}

const enc = encodeURIComponent;
const repoPath = (sync) => `/repos/${enc(sync.owner)}/${enc(sync.repo)}`;
const branchName = (sync) => String(sync?.branch ?? '').trim();
const filePath = (p) => p.split('/').map(enc).join('/');

function checkConfig(sync) {
  const missing = ['owner', 'repo', 'token'].filter((k) => !String(sync?.[k] || '').trim());
  if (missing.length) throw syncError('CONFIG', `Falta en Ajustes: ${missing.join(', ')}.`);
  if (!isValidOwner(String(sync.owner).trim()) || !isValidRepo(String(sync.repo).trim()) || !isValidBranch(branchName(sync))) {
    throw syncError('CONFIG', 'Usuario, repositorio o rama con caracteres no válidos.');
  }
}

function httpError(status, sync, data, headers, what = '') {
  const repo = `${sync.owner}/${sync.repo}`;
  const gh = data?.message ? ` (${String(data.message).slice(0, 200)})` : '';
  const at = what ? ` en ${what}` : '';
  if (status === 401) {
    return syncError('AUTH', `GitHub 401${gh}${at}: el token no es válido o ha caducado. Crea un token fine-grained nuevo (Contents: Read and write solo en ${repo}) y envía un enlace de configuración nuevo.`, status);
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

const ctxOf = (sync, fetchImpl) => ({ sync: { ...sync, owner: String(sync.owner).trim(), repo: String(sync.repo).trim() }, fetchImpl });

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
  const ctx = ctxOf(sync, fetchImpl);
  const branch = branchName(sync);
  if (!branch) return { branch: '', created: false, empty: false };
  const ref = await gh(ctx, 'GET', `${repoPath(sync)}/git/ref/heads/${filePath(branch)}`, null, [404, 409]);
  if (ref.status === 200 && ref.data?.object?.sha) return { branch, created: false, empty: false, sha: ref.data.object.sha };
  if (ref.status === 409) return { branch, created: false, empty: true }; // repositorio sin commits
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

async function getFile(ctx, path) {
  const r = await gh(ctx, 'GET', `${repoPath(ctx.sync)}/contents/${filePath(path)}${refQuery(ctx)}`, null, [404]);
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

// PUT de un archivo con el sha esperado (null = archivo nuevo) → { conflict } | { sha, commit }
async function putContents(ctx, path, content, message, sha) {
  const body = { message, content: utf8ToBase64(content) };
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

// Calendario: solo se escribe si cambió; reintenta una vez si otro lo cambió entre medias
async function putIcs(ctx, content, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await getFile(ctx, ICS_FILE);
    if (cur && (await fileText(ctx, cur)) === content) return { changed: false };
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
const aadOf = (doc) => `${BACKUP_FORMAT}|${doc.v}|${doc.meta.rev}|${doc.meta.deviceId}|${doc.meta.days}|${doc.meta.savedAt}`;

// Estado → documento backup.json (objeto)
export async function encryptBackup(state, { rev, now = new Date(), deviceId = '', key, getRandomValues } = {}) {
  const payload = syncPayload(state);
  const meta = { rev, savedAt: now.toISOString(), deviceId: String(deviceId || ''), days: Object.keys(payload.days).length };
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

// Lee el remoto → null | { rev, days, sha, doc, legacy, plain? }
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
    return { rev, days: Math.max(0, Number(doc.meta.days) || 0), sha: file.sha, doc, legacy: false };
  }
  // Compatibilidad: turnos.json en claro de versiones antiguas (se fusiona y se migra a backup.json)
  const old = await getFile(ctx, LEGACY_JSON_FILE);
  if (old) {
    try {
      const plain = JSON.parse(await fileText(ctx, old));
      if (isPlainObject(plain) && isPlainObject(plain.days)) return { rev: 0, days: Object.keys(plain.days).length, sha: null, doc: null, legacy: true, plain };
    } catch { /* se ignora */ }
  }
  return null;
}

const lastSyncOf = (sync) => [sync.lastPushAt, sync.lastPullAt].filter(Boolean).sort().at(-1) ?? null;
const dataHash = (state) => hashString(dataFingerprint(state));
const daysIn = (state) => Object.keys(state?.days || {}).length;

// Sincroniza: lee el remoto, fusiona si hace falta, y publica backup.json (rev+1) y turnos.ics.
// options: { fetchImpl, now, force, allowEmpty, pullOnly, getRandomValues }
// Nunca lanza. → {
//   ok, state (fusionado, o el mismo objeto si no cambió), merged, pulled, pushed, icsPushed,
//   conflictCount, pulledDays, rev, remote: {rev,days,savedAt,deviceId,legacy}|null,
//   sync: parche para settings.sync (aplicar con applySyncResult), error: {code,message,detail,status,retry}|null,
//   target: {owner,repo,branch} }
export async function syncNow(state, fetchArg) {
  const o = opts(fetchArg);
  const { fetchImpl, now = new Date(), force = false, allowEmpty = false, pullOnly: onlyPull = false, getRandomValues } = o;
  const sync = { ...(state?.settings?.sync || {}) };
  const patch = {};
  const res = {
    ok: false, state, merged: false, pulled: false, pushed: false, icsPushed: false, conflictCount: 0, pulledDays: [],
    rev: null, remote: null, sync: patch, error: null,
    target: { owner: String(sync.owner || '').trim(), repo: String(sync.repo || '').trim(), branch: branchName(sync) },
  };
  try {
    checkConfig(sync);
    // Datos de una versión más nueva: publicarlos desde aquí los recortaría
    if (state?.__newerSchema) throw syncError('NEWER_LOCAL', `Estado con esquema ${state.schema} (esta app: ${SCHEMA}).`);
    if (sync.key && !isSyncKey(sync.key)) throw syncError('NO_KEY', 'La clave guardada no tiene el formato correcto (base64url de 32 bytes).');
    if (!sync.deviceId) sync.deviceId = patch.deviceId = randomId(12, getRandomValues);
    const ctx = { ...ctxOf(sync, fetchImpl), ...(await ensureBranch(sync, fetchImpl)) };
    const baseRev = Number(sync.baseRev) || 0;
    let local = state;
    for (let attempt = 1; ; attempt++) {
      const remote = await readRemote(ctx);
      res.remote = remote ? {
        rev: remote.rev, days: remote.days, legacy: remote.legacy,
        savedAt: remote.doc?.meta?.savedAt ?? null, deviceId: remote.doc?.meta?.deviceId ?? null,
      } : null;
      let merged = local, remoteState = null;
      // 1) Si el remoto no es lo que publicamos o fusionamos la última vez: descifrar y fusionar
      if (remote && (remote.legacy || remote.rev !== baseRev || onlyPull)) {
        const plain = remote.legacy ? remote.plain : await decryptBackup(remote.doc, sync.key);
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
        if (!remote.legacy) Object.assign(patch, { baseRev: remote.rev, lastPushHash: dataHash(remoteState) });
        res.rev = remote.rev;
      }
      if (onlyPull) {
        Object.assign(patch, { lastError: null, lastErrorCode: null, lastErrorDetail: null });
        res.ok = true;
        return res;
      }
      // Primera copia (nada en el remoto): se genera la clave si falta
      if ((!remote || remote.legacy) && !sync.key) sync.key = patch.key = generateSyncKey(getRandomValues);

      // 2) ¿Hay algo nuevo que publicar?
      const localHash = dataHash(merged);
      const remoteHash = remoteState ? dataHash(remoteState) : remote ? (sync.lastPushHash || null) : null;
      const needBackup = force || !remote || remote.legacy || localHash !== remoteHash;
      const remoteDays = remoteState ? daysIn(remoteState) : remote ? remote.days : 0;
      if (needBackup && daysIn(merged) === 0 && remoteDays > 0 && !allowEmpty) {
        throw syncError('EMPTY_LOCAL', `Publicar dejaría 0 días encima de ${remoteDays} días (rev ${remote.rev}).`);
      }
      if (needBackup) {
        const rev = Math.max(remote && !remote.legacy ? remote.rev : 0, baseRev) + 1;
        if (!isSyncKey(sync.key)) throw syncError('NO_KEY', 'No hay clave para cifrar la copia.');
        const doc = await encryptBackup(merged, { rev, now, deviceId: sync.deviceId, key: sync.key, getRandomValues });
        const put = await putContents(ctx, BACKUP_FILE, JSON.stringify(doc), `Turnos: copia cifrada (rev ${rev})`, remote && !remote.legacy ? remote.sha : null);
        if (put.conflict) {
          // Otro dispositivo escribió entre medias: volver a leer y fusionar
          if (attempt >= MAX_ATTEMPTS) throw syncError('CONFLICT', `${BACKUP_FILE} cambió ${attempt} veces mientras se guardaba.`, 409);
          local = merged;
          continue;
        }
        await afterFirstWrite(ctx, put.commit);
        Object.assign(patch, { baseRev: rev, lastPushHash: localHash, lastPushAt: now.toISOString() });
        res.pushed = true;
        res.rev = rev;
      } else {
        Object.assign(patch, { baseRev: remote.rev, lastPushHash: localHash });
        res.rev = remote.rev;
      }
      // 3) Calendario (derivado de los datos fusionados)
      const ics = buildICS(merged, { now, places: sync.publishPlaces === true, notes: false });
      const icsHash = hashString(ics);
      if (force || res.pushed || res.pulled || icsHash !== sync.lastIcsHash) {
        const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
        const r = await putIcs(ctx, ics, `Turnos: calendario (${stamp})`);
        res.icsPushed = r.changed;
        patch.lastIcsHash = icsHash;
      }
      Object.assign(patch, { lastError: null, lastErrorCode: null, lastErrorDetail: null });
      res.ok = true;
      return res;
    }
  } catch (e) {
    const err = e instanceof SyncError ? e : syncError('UNKNOWN', String(e?.message || e));
    res.error = { code: err.code, message: err.message, detail: err.detail || '', status: err.status ?? 0, retry: err.retry };
    Object.assign(patch, { lastError: err.message, lastErrorCode: err.code, lastErrorDetail: err.detail || null });
    return res;
  }
}

// Solo leer y fusionar (sin publicar nada): para «Restaurar desde GitHub» o al configurar.
export function pullOnly(state, fetchArg) {
  return syncNow(state, { ...opts(fetchArg), pullOnly: true });
}
export const restoreFromRemote = pullOnly;

// Aplica el resultado de syncNow/pullOnly sobre el estado ACTUAL del store (puede haber cambiado
// mientras se sincronizaba): fusiona los datos traídos y guarda el parche de settings.sync.
// Si la configuración cambió entre medias (otro repo), no aplica nada.
export function applySyncResult(current, res, { now } = {}) {
  if (!res || !current) return current;
  const s = current.settings?.sync || {};
  const t = res.target;
  if (t && (String(s.owner || '').trim() !== t.owner || String(s.repo || '').trim() !== t.repo || branchName(s) !== t.branch)) return current;
  let next = current;
  if (res.merged && res.state && res.state !== current) {
    next = mergeStates(current, res.state, { now, adoptSettings: daysIn(current) === 0 }).state;
  }
  return updateSettings(next, { sync: res.sync }, { now });
}

// Descarga y descifra la copia del remoto (para restaurar reemplazando con importBackup)
// → { rev, meta, data } (data: objeto en claro como un archivo de copia). Lanza SyncError.
export async function fetchRemoteBackup(sync, fetchArg) {
  const { fetchImpl } = opts(fetchArg);
  checkConfig(sync);
  const ctx = { ...ctxOf(sync, fetchImpl), ...(await ensureBranch(sync, fetchImpl)) };
  const remote = await readRemote(ctx);
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
export async function pushData(state, fetchArg) {
  const res = await syncNow(state, fetchArg);
  if (res.error) throw new SyncError(res.error.message, res.error.status, res.error);
  return { ...res, pushed: res.pushed || res.icsPushed, changed: res.pushed || res.icsPushed, hash: res.sync.lastPushHash ?? null, sync: { ...state.settings.sync, ...res.sync } };
}

// Hash del contenido publicable (datos + calendario)
export function contentHash(state, now = new Date()) {
  return hashString(buildICS(state, { now, places: state?.settings?.sync?.publishPlaces === true }) + '\u0000' + dataFingerprint(state));
}

// URLs del calendario para suscribirse (el repositorio debe ser público). Rama '' → HEAD (la por defecto).
export function calendarUrls(sync) {
  const branch = branchName(sync) || 'HEAD';
  const path = ['raw.githubusercontent.com', ...[String(sync.owner).trim(), String(sync.repo).trim(), ...branch.split('/'), ICS_FILE].map(enc)].join('/');
  return { webcal: `webcal://${path}`, https: `https://${path}` };
}

// '#setup=…' (o una URL completa) → { enabled:true, owner, repo, branch, token, key, publishPlaces? } o null
export function parseSetupLink(hash) {
  const m = /(?:^|[#&?])setup=([A-Za-z0-9_\-+/=%]+)/.exec(String(hash || ''));
  if (!m || m[1].length > 4000) return null;
  try {
    const cfg = normalizeSyncConfig(JSON.parse(base64UrlDecode(decodeURIComponent(m[1]))));
    return cfg ? { enabled: true, ...cfg } : null;
  } catch {
    return null;
  }
}

// Enlace de configuración: base + '#setup=<base64url(JSON)>' (incluye la clave de cifrado)
export function buildSetupLink(baseUrl, sync) {
  const base = String(baseUrl || '').split('#')[0];
  const payload = { v: 2, owner: sync.owner, repo: sync.repo, branch: branchName(sync), token: sync.token, key: sync.key || '' };
  if (sync.publishPlaces === true) payload.publishPlaces = true;
  return `${base}#setup=${base64UrlEncode(JSON.stringify(payload))}`;
}
