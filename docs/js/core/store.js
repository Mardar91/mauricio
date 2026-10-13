// Estado de la app en localStorage: carga/migración, mutaciones puras, copias de seguridad y fusión
// entre dispositivos (días y códigos con updatedAt + tombstones, ver SPEC §9).
import { DEFAULT_CODES, KINDS, SHAPES, baseCode, cleanCode, guessCode, nominalMinutes, normalizeDayCodes } from './codes.js';
import { isKey, parseHHMM } from './dates.js';
import { scanToDays } from './diff.js';
import { clone, isPlainObject, isSafeKey, stableStringify } from './util.js';

export const STORAGE_KEY = 'turnos-mauricio:v1';
export const CORRUPT_PREFIX = 'turnos-mauricio:corrupt:';
export const BEFORE_IMPORT_PREFIX = 'turnos-mauricio:before-import:';
export const NEWER_SCHEMA_KEY = 'turnos-mauricio:newer-schema';
export const SCHEMA = 1;
export const MAX_SCANS = 30;
export const MAX_CHANGES = 300;
export const MAX_CORRUPT_COPIES = 3;
export const MAX_IMPORT_COPIES = 3;
export const TOMBSTONE_DAYS = 120;
export const MAX_CODE_LEN = 12;
export const MAX_NOTE_LEN = 1000;
const MAX_CODES_PER_DAY = 12;
const SOURCES = ['scan', 'manual', 'import'];
const LAYOUTS = ['phone-list', 'pc-grid', 'unknown'];
const DEFAULT_BREAK = 30;

export const DEFAULT_SETTINGS = Object.freeze({
  name: 'Mauricio',
  weeklyHours: 35,
  workDaysPerWeek: 5,
  holidaysReduceSoll: true,
  reminders: { eveningBefore: true, eveningTime: '20:00', beforeStart: true, minutesBefore: 60 },
  // Última vez que cambió algo que afecta al calendario publicado (recordatorios, lugares)
  calendarUpdatedAt: null,
  sync: {
    enabled: false, owner: 'Mardar91', repo: 'mauricio-datos', branch: '', token: '', key: '', deviceId: '',
    baseRev: 0, lastPushAt: null, lastPushHash: null, lastIcsHash: null, lastPullAt: null,
    lastError: null, lastErrorCode: null, lastErrorDetail: null, publishPlaces: false,
  },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', scheduled: {}, lastRunAt: null, lastError: null },
  onboardingDone: false,
});

// Ajustes del usuario que viajan en las copias y en la sincronización (sync/ntfy son del dispositivo)
export const USER_SETTINGS = ['name', 'weeklyHours', 'workDaysPerWeek', 'holidaysReduceSoll', 'reminders', 'calendarUpdatedAt'];

export function createDefaultState() {
  return {
    schema: SCHEMA,
    settings: clone(DEFAULT_SETTINGS),
    codes: clone({ ...DEFAULT_CODES }),
    days: {},
    tombstones: {},
    codeTombstones: {},
    scans: [],
    changes: [],
  };
}

const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString();
const tsOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
const count = (map) => Object.keys(map || {}).length;
const capStr = (v, n) => String(v ?? '').slice(0, n);

// ISO válido (corto) o null
function isoOrNull(v) {
  return typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null;
}

const validCode = (c) => typeof c === 'string' && c.length > 0 && c.length <= MAX_CODE_LEN && isSafeKey(c);

// Mezcla profunda de ajustes. El mapa ntfy.scheduled se reemplaza entero; los valores de tipo
// incorrecto y las claves peligrosas (__proto__…) se ignoran.
function mergeSettings(base, patch) {
  const out = clone(base);
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (!isSafeKey(k) || v === undefined) continue;
    const cur = out[k];
    if (k === 'scheduled') {
      if (isPlainObject(v)) out[k] = sanitizeScheduled(v);
    } else if (isPlainObject(cur)) {
      if (isPlainObject(v)) out[k] = mergeSettings(cur, v);
    } else if (cur === null || cur === undefined || typeof cur === typeof v) {
      if (!isPlainObject(v) || cur === null || cur === undefined) out[k] = clone(v);
    }
  }
  return out;
}

function sanitizeScheduled(map) {
  const out = {};
  for (const [seq, e] of Object.entries(map || {})) {
    if (!isSafeKey(seq) || !/^[A-Za-z0-9_-]{1,64}$/.test(seq) || !isPlainObject(e)) continue;
    const entry = {};
    for (const f of ['at', 'hash', 'topic', 'server']) if (typeof e[f] === 'string') entry[f] = e[f].slice(0, 300);
    if (entry.at) out[seq] = entry;
  }
  return out;
}

// Corrige tipos y longitudes de los ajustes (nunca lanza)
function fixSettings(st) {
  st.name = capStr(st.name, 60);
  for (const k of ['weeklyHours', 'workDaysPerWeek']) {
    const n = Number(st[k]);
    st[k] = Number.isFinite(n) && n > 0 ? Math.min(n, 168) : DEFAULT_SETTINGS[k];
  }
  st.workDaysPerWeek = Math.min(7, Math.max(1, Math.round(st.workDaysPerWeek)));
  const r = st.reminders;
  if (parseHHMM(r.eveningTime) === null) r.eveningTime = DEFAULT_SETTINGS.reminders.eveningTime;
  r.minutesBefore = Math.min(1440, Math.max(0, Math.round(Number(r.minutesBefore) || 0)));
  st.calendarUpdatedAt = isoOrNull(st.calendarUpdatedAt);
  const s = st.sync;
  for (const [k, n] of [['owner', 39], ['repo', 100], ['branch', 100], ['token', 300], ['key', 64], ['deviceId', 40]]) s[k] = capStr(s[k], n).trim();
  s.baseRev = Number.isSafeInteger(s.baseRev) && s.baseRev > 0 ? s.baseRev : 0;
  s.publishPlaces = s.publishPlaces === true;
  if (!isPlainObject(st.ntfy.scheduled)) st.ntfy.scheduled = {};
  st.ntfy.server = capStr(st.ntfy.server, 200);
  st.ntfy.topic = capStr(st.ntfy.topic, 64);
  return st;
}

// Color CSS seguro: solo #RGB / #RRGGBB (nada de url(), var()…)
export function safeColor(c, fallback) {
  const s = typeof c === 'string' ? c.trim() : '';
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${[...s.slice(1)].map((x) => x + x).join('')}`.toUpperCase();
  return fallback;
}

// Completa los campos de un CodeDef y corrige valores inválidos
export function sanitizeCodeDef(def, code) {
  const c = cleanCode(code ?? def?.code);
  const template = DEFAULT_CODES[c] ? { ...DEFAULT_CODES[c] } : guessCode(c);
  const src = {};
  if (isPlainObject(def)) for (const [k, v] of Object.entries(def)) if (isSafeKey(k)) src[k] = v;
  const out = { ...baseCode(c), ...template, ...src, code: c };
  if (!KINDS.includes(out.kind)) out.kind = template.kind;
  if (!SHAPES.includes(out.shape)) out.shape = template.shape;
  out.start = parseHHMM(out.start) === null ? null : normHHMM(out.start);
  out.end = parseHHMM(out.end) === null ? null : normHHMM(out.end);
  out.breakMin = Math.min(720, Math.max(0, Math.round(Number(out.breakMin) || 0)));
  out.countsHours = Boolean(out.countsHours);
  const credit = Number(out.creditHours);
  out.creditHours = out.creditHours === null || out.creditHours === '' || out.creditHours === undefined
    || !Number.isFinite(credit) ? null : Math.min(24, Math.max(0, credit));
  out.name = capStr(out.name ?? c, 40) || c;
  out.place = capStr(out.place, 200);
  out.color = safeColor(out.color, template.color);
  out.textColor = safeColor(out.textColor, template.textColor);
  out.confirmed = out.confirmed !== false;
  out.builtin = Boolean(DEFAULT_CODES[c]);
  out.updatedAt = isoOrNull(out.updatedAt);
  return out;
}

function normHHMM(s) {
  const m = parseHHMM(s);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function cleanCodes(list) {
  return list.filter((c) => typeof c === 'string').map(cleanCode)
    .filter((c) => c && c.length <= MAX_CODE_LEN).slice(0, MAX_CODES_PER_DAY);
}

function sanitizeDay(entry) {
  if (Array.isArray(entry)) entry = { codes: entry };
  if (!isPlainObject(entry) || !Array.isArray(entry.codes)) return null;
  return {
    codes: cleanCodes(entry.codes),
    note: typeof entry.note === 'string' ? entry.note.slice(0, MAX_NOTE_LEN) : '',
    source: SOURCES.includes(entry.source) ? entry.source : 'manual',
    updatedAt: isoOrNull(entry.updatedAt),
  };
}

function sanitizeChange(c) {
  if (!isPlainObject(c) || !isKey(c.dayKey) || !Array.isArray(c.before) || !Array.isArray(c.after)) return null;
  const at = isoOrNull(c.at);
  if (!at) return null;
  return { at, dayKey: c.dayKey, before: cleanCodes(c.before), after: cleanCodes(c.after), source: SOURCES.includes(c.source) ? c.source : 'manual' };
}

function sanitizeScan(s) {
  if (!isPlainObject(s)) return null;
  const at = isoOrNull(s.at);
  if (!at) return null;
  const month = Number.isInteger(s.month) && s.month >= 1 && s.month <= 12 ? s.month : null;
  const year = Number.isInteger(s.year) && s.year >= 2000 && s.year <= 2100 ? s.year : null;
  const daysFound = Number.isInteger(s.daysFound) && s.daysFound >= 0 && s.daysFound <= 62 ? s.daysFound : 0;
  return { at, layout: LAYOUTS.includes(s.layout) ? s.layout : 'unknown', month, year, daysFound };
}

// Mapa clave → ISO válido
function sanitizeStamps(map, validKey) {
  const out = {};
  if (!isPlainObject(map)) return out;
  for (const [k, v] of Object.entries(map)) {
    const at = isoOrNull(v);
    if (isSafeKey(k) && validKey(k) && at) out[k] = at;
  }
  return out;
}

// Copia los campos que esta versión no conoce (datos de una versión más nueva)
function overlayUnknown(raw, known) {
  if (!isPlainObject(raw) || !isPlainObject(known)) return;
  for (const [k, v] of Object.entries(raw)) {
    if (!isSafeKey(k)) continue;
    if (!(k in known)) known[k] = clone(v);
    else if (isPlainObject(known[k]) && isPlainObject(v) && k !== 'scheduled') overlayUnknown(v, known[k]);
  }
}

// Rellena lo que falte y descarta lo inválido. Nunca lanza con objetos.
// Si los datos son de un esquema más nuevo, conserva lo desconocido y marca state.__newerSchema.
export function migrateState(raw) {
  const state = createDefaultState();
  if (!isPlainObject(raw)) return state;
  const newer = Number(raw.schema) > SCHEMA;
  state.settings = fixSettings(mergeSettings(state.settings, raw.settings));
  if (isPlainObject(raw.codes)) {
    for (const [code, def] of Object.entries(raw.codes)) {
      const c = isSafeKey(code) ? cleanCode(code) : '';
      if (validCode(c) && isPlainObject(def)) state.codes[c] = sanitizeCodeDef(def, c);
    }
  }
  if (isPlainObject(raw.days)) {
    for (const [key, entry] of Object.entries(raw.days)) {
      const day = isKey(key) ? sanitizeDay(entry) : null;
      if (day) {
        state.days[key] = { ...day, codes: normalizeDayCodes(state, day.codes) };
        ensureCodes(state, state.days[key].codes);
      }
    }
  }
  state.tombstones = sanitizeStamps(raw.tombstones, isKey);
  state.codeTombstones = sanitizeStamps(raw.codeTombstones, validCode);
  if (Array.isArray(raw.scans)) state.scans = raw.scans.map(sanitizeScan).filter(Boolean).slice(-MAX_SCANS);
  if (Array.isArray(raw.changes)) state.changes = raw.changes.map(sanitizeChange).filter(Boolean).slice(-MAX_CHANGES);
  if (newer) {
    for (const [k, v] of Object.entries(raw)) if (isSafeKey(k) && !(k in state) && !k.startsWith('__')) state[k] = clone(v);
    overlayUnknown(raw.settings, state.settings);
    for (const map of ['days', 'codes']) {
      for (const k of Object.keys(state[map])) overlayUnknown(raw[map]?.[k], state[map][k]);
    }
    state.schema = Number(raw.schema);
    state.__newerSchema = true;
  }
  return state;
}

// Claves del almacenamiento con un prefijo, de la más antigua a la más nueva
function keysWithPrefix(storage, prefix) {
  const out = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (typeof k === 'string' && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* almacenamiento sin enumeración */ }
  return out.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)) || (a < b ? -1 : 1));
}

function removeKey(storage, k) {
  try { storage.removeItem(k); } catch { /* nada */ }
}

// Guarda una copia con marca de tiempo y deja como mucho `max`
function keepCopy(storage, prefix, text, max, now = Date.now()) {
  // Siempre después de la copia más nueva (aunque el reloj no haya avanzado)
  const newest = keysWithPrefix(storage, prefix).map((k) => Number(k.slice(prefix.length))).filter(Number.isFinite);
  const ts = Math.max(now, ...newest.map((n) => n + 1));
  const key = prefix + ts;
  try { storage.setItem(key, text); } catch { return null; }
  const keys = keysWithPrefix(storage, prefix);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) removeKey(storage, k);
  return key;
}

// Copia del JSON ilegible (una sola vez por contenido; máximo MAX_CORRUPT_COPIES)
function saveCorruptCopy(storage, raw) {
  const keys = keysWithPrefix(storage, CORRUPT_PREFIX);
  try { if (keys.some((k) => storage.getItem(k) === raw)) return; } catch { return; }
  keepCopy(storage, CORRUPT_PREFIX, raw, MAX_CORRUPT_COPIES);
}

function parseStored(raw) {
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? migrateState(parsed) : null;
  } catch {
    return null;
  }
}

export function loadState(storage = globalThis.localStorage) {
  if (!storage) return createDefaultState();
  let raw = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return createDefaultState();
  }
  if (raw === null || raw === undefined || raw === '') return createDefaultState();
  const state = parseStored(raw);
  if (state) {
    // Datos de una versión más nueva: se guarda una copia intacta (solo la primera vez)
    if (state.__newerSchema) {
      try { if (storage.getItem(NEWER_SCHEMA_KEY) === null) storage.setItem(NEWER_SCHEMA_KEY, raw); } catch { /* nada */ }
    }
    return state;
  }
  saveCorruptCopy(storage, raw);
  return createDefaultState();
}

// Estado para guardar: sin campos internos (__…)
function persistable(state) {
  const out = {};
  for (const [k, v] of Object.entries(state || {})) if (!k.startsWith('__')) out[k] = v;
  return out;
}

// Quita tombstones de más de TOMBSTONE_DAYS días (devuelve el mismo estado si no hay nada que quitar)
export function pruneTombstones(state, now = new Date(), maxDays = TOMBSTONE_DAYS) {
  const limit = (now instanceof Date ? now : new Date(now)).getTime() - maxDays * 86400000;
  const keep = (map) => Object.fromEntries(Object.entries(map || {}).filter(([, at]) => tsOf(at) >= limit));
  const old = (map) => Object.values(map || {}).some((at) => tsOf(at) < limit);
  if (!old(state?.tombstones) && !old(state?.codeTombstones)) return state;
  return { ...state, tombstones: keep(state.tombstones), codeTombstones: keep(state.codeTombstones) };
}

function writeState(state, storage, now) {
  if (!storage) return { ok: false, error: { code: 'NO_STORAGE', message: SAVE_ERROR, detail: 'Sin almacenamiento' } };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(persistable(pruneTombstones(state, now))));
    return { ok: true, error: null };
  } catch (e) {
    const quota = /quota/i.test(`${e?.name} ${e?.message}`);
    return { ok: false, error: { code: quota ? 'QUOTA' : 'BLOCKED', message: SAVE_ERROR, detail: `${e?.name || 'Error'}: ${e?.message || ''}`.trim() } };
  }
}

export const SAVE_ERROR = 'No se pudo guardar en este teléfono. Exporta una copia de seguridad (Ajustes → Copia de seguridad) y pide ayuda.';

// Devuelve true si se pudo guardar
export function saveState(state, storage = globalThis.localStorage, { now } = {}) {
  return writeState(state, storage, now ?? new Date()).ok;
}

// Libera espacio: copias corruptas y copias de antes de importar (salvo la más nueva)
function freeSpace(storage) {
  for (const k of keysWithPrefix(storage, CORRUPT_PREFIX)) removeKey(storage, k);
  const imports = keysWithPrefix(storage, BEFORE_IMPORT_PREFIX);
  for (const k of imports.slice(0, -1)) removeKey(storage, k);
}

// Store reactivo para la UI. mutatorFn(draft) puede modificar el borrador o devolver un estado nuevo.
// - Escucha el evento 'storage' (otra pestaña guardó) y recarga; cada escritura parte de lo último guardado.
// - Los fallos al guardar se avisan con onError(fn) y quedan en lastSave() / saveOk().
// options: { target (para el evento 'storage', por defecto globalThis), onError, now }
export function createStore(storage = globalThis.localStorage, options = {}) {
  const target = 'target' in options ? options.target : globalThis;
  const clock = options.now || (() => new Date());
  const readRaw = () => {
    if (!storage) return undefined;
    try { return storage.getItem(STORAGE_KEY); } catch { return undefined; }
  };
  let raw = readRaw();
  let state = loadState(storage);
  let lastSave = { ok: true, error: null, at: null };
  const subs = new Set();
  const errorSubs = new Set();
  if (typeof options.onError === 'function') errorSubs.add(options.onError);

  const notify = () => {
    for (const fn of [...subs]) {
      try { fn(state); } catch (e) { console.error(e); }
    }
  };

  // Si otra pestaña guardó algo distinto, se adopta (sin perder lo nuestro si su JSON es ilegible)
  const syncFromStorage = () => {
    const cur = readRaw();
    if (cur === undefined || cur === raw) return false;
    raw = cur;
    if (cur === null || cur === '') return false;
    const fresh = parseStored(cur);
    if (!fresh) return false;
    state = fresh;
    return true;
  };

  const persist = () => {
    if (!storage) return lastSave;
    let r = writeState(state, storage, clock());
    if (!r.ok) {
      freeSpace(storage);
      r = writeState(state, storage, clock());
    }
    lastSave = { ok: r.ok, error: r.error, at: clock().toISOString() };
    if (r.ok) raw = readRaw();
    else {
      for (const fn of [...errorSubs]) {
        try { fn({ type: 'save', ...r.error }); } catch (e) { console.error(e); }
      }
    }
    return lastSave;
  };

  const onStorage = (e) => {
    if (e && e.storageArea && e.storageArea !== storage) return;
    if (e && e.key !== null && e.key !== undefined && e.key !== STORAGE_KEY) return;
    if (syncFromStorage()) notify();
  };
  const canListen = target && typeof target.addEventListener === 'function';
  if (canListen) target.addEventListener('storage', onStorage);

  return {
    get: () => state,
    set(mutatorFn) {
      syncFromStorage(); // partir del último estado guardado (otra pestaña)
      const draft = clone(state);
      const result = mutatorFn(draft);
      state = pruneTombstones(isPlainObject(result) ? result : draft, clock());
      persist();
      notify();
      return state;
    },
    // Vuelve a leer el almacenamiento (p. ej. al volver a la app); true si cambió
    refresh() {
      const changed = syncFromStorage();
      if (changed) notify();
      return changed;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    onError(fn) {
      errorSubs.add(fn);
      return () => errorSubs.delete(fn);
    },
    lastSave: () => lastSave,
    saveOk: () => lastSave.ok,
    destroy() {
      if (canListen && typeof target.removeEventListener === 'function') target.removeEventListener('storage', onStorage);
      subs.clear();
      errorSubs.clear();
    },
  };
}

function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
}

function logChange(state, change) {
  state.changes = [...(state.changes || []), change].slice(-MAX_CHANGES);
}

// Crea definiciones para códigos desconocidos (por analogía)
function ensureCodes(state, codes) {
  for (const c of codes) {
    if (validCode(c) && !state.codes[c]) state.codes[c] = sanitizeCodeDef(guessCode(c), c);
  }
}

function ensureMaps(state) {
  if (!isPlainObject(state.tombstones)) state.tombstones = {};
  if (!isPlainObject(state.codeTombstones)) state.codeTombstones = {};
  return state;
}

// Guarda los códigos de un día (devuelve un estado nuevo; si nada cambia, el mismo)
export function setDay(state, key, codes, { note, source = 'manual', now } = {}) {
  if (!isKey(key)) throw new Error(`Fecha no válida: ${key}`);
  const prev = state.days?.[key] ?? null;
  const after = normalizeDayCodes(state, cleanCodes((codes || []).filter((c) => typeof c === 'string')));
  const nextNote = (note === undefined ? (prev?.note ?? '') : String(note ?? '')).slice(0, MAX_NOTE_LEN);
  if (prev && sameList(prev.codes, after) && prev.note === nextNote) return state;
  const next = ensureMaps(clone(state));
  ensureCodes(next, after);
  const at = nowIso(now);
  next.days[key] = { codes: after, note: nextNote, source: SOURCES.includes(source) ? source : 'manual', updatedAt: at };
  delete next.tombstones[key];
  if (!prev || !sameList(prev.codes, after)) {
    logChange(next, { at, dayKey: key, before: prev ? [...prev.codes] : [], after: [...after], source: next.days[key].source });
  }
  return next;
}

// Borra un día y deja una tombstone para que el borrado llegue a los otros dispositivos
export function clearDay(state, key, { source = 'manual', now } = {}) {
  const prev = state.days?.[key];
  if (!prev) return state;
  const next = ensureMaps(clone(state));
  const at = nowIso(now);
  delete next.days[key];
  next.tombstones[key] = at;
  logChange(next, { at, dayKey: key, before: [...prev.codes], after: [], source: SOURCES.includes(source) ? source : 'manual' });
  return next;
}

// Aplica un escaneo revisado. acceptedKeys: claves a guardar (por defecto, todas las que cambian).
export function applyScan(state, scanResult, { acceptedKeys, year, month, now } = {}) {
  const days = scanToDays(scanResult, { year, month });
  const accepted = acceptedKeys ? new Set(acceptedKeys) : null;
  let next = state;
  for (const d of days) {
    if (accepted && !accepted.has(d.key)) continue;
    next = setDay(next, d.key, d.codes, { source: 'scan', now });
  }
  next = next === state ? clone(state) : next;
  const scan = sanitizeScan({
    at: nowIso(now),
    layout: scanResult?.layout ?? 'unknown',
    month: Number(month ?? scanResult?.month) || null,
    year: Number(year ?? scanResult?.year) || null,
    daysFound: Array.isArray(scanResult?.days) ? scanResult.days.length : 0,
  });
  next.scans = [...(next.scans || []), scan].slice(-MAX_SCANS);
  return next;
}

// Crea o edita un código. Guardar un horario cuenta como confirmarlo (salvo confirmed explícito).
// Lanza Error (en español) si los datos no son válidos.
export function upsertCode(state, def, { now } = {}) {
  const c = cleanCode(def?.code);
  if (!c) throw new Error('El código no puede estar vacío.');
  if (!validCode(c)) throw new Error(`El código es demasiado largo (máximo ${MAX_CODE_LEN} caracteres).`);
  if (def.start && parseHHMM(def.start) === null) throw new Error(`Hora de inicio no válida: ${def.start}`);
  if (def.end && parseHHMM(def.end) === null) throw new Error(`Hora de fin no válida: ${def.end}`);
  const prev = state.codes?.[c] ? sanitizeCodeDef(state.codes[c], c) : sanitizeCodeDef(guessCode(c), c);
  const patch = { ...def, code: c };
  delete patch.updatedAt;
  if (patch.confirmed === undefined && (def.start !== undefined || def.end !== undefined)) patch.confirmed = true;
  const merged = sanitizeCodeDef({ ...prev, ...patch }, c);
  if (merged.end && !merged.start) throw new Error('Pon también la hora de inicio, o borra la de fin.');
  // La pausa de 30 min por defecto solo se aplica a turnos de más de 6 h (SPEC §2)
  const timesChanged = merged.start !== prev.start || merged.end !== prev.end;
  const nominal = nominalMinutes(merged);
  if (timesChanged && nominal !== null && nominal <= 360 && prev.breakMin === DEFAULT_BREAK && merged.breakMin === DEFAULT_BREAK) {
    merged.breakMin = 0;
  }
  merged.updatedAt = nowIso(now);
  const next = ensureMaps(clone(state));
  next.codes[c] = merged;
  delete next.codeTombstones[c];
  return next;
}

// Borra un código propio (queda una tombstone); uno de fábrica vuelve a su definición original.
// Si algún día lo usa, se queda con una definición supuesta (sin confirmar).
export function deleteCode(state, code, { now } = {}) {
  const c = cleanCode(code);
  const next = ensureMaps(clone(state));
  const at = nowIso(now);
  if (DEFAULT_CODES[c]) {
    next.codes[c] = { ...clone({ ...DEFAULT_CODES[c] }), updatedAt: at };
    return next;
  }
  if (!state.codes?.[c]) return state;
  delete next.codes[c];
  next.codeTombstones[c] = at;
  if (Object.values(next.days).some((d) => d.codes.includes(c))) ensureCodes(next, [c]);
  return next;
}

// Mezcla profunda de ajustes. Si cambian los recordatorios o publishPlaces, anota calendarUpdatedAt.
export function updateSettings(state, patch, { now } = {}) {
  const next = clone(state);
  next.settings = fixSettings(mergeSettings(state.settings, patch));
  const before = state.settings || {};
  const calendarChanged = stableStringify(before.reminders) !== stableStringify(next.settings.reminders)
    || Boolean(before.sync?.publishPlaces) !== next.settings.sync.publishPlaces;
  if (calendarChanged) next.settings.calendarUpdatedAt = nowIso(now);
  return next;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = clone(obj[k]);
  return out;
}

// Contenido que se comparte entre dispositivos (cifrado en backup.json). Sin token, clave,
// ni ajustes del dispositivo (sync, ntfy, onboarding).
export function syncPayload(state) {
  return {
    app: 'turnos-mauricio',
    schema: SCHEMA,
    settings: pick(state.settings, USER_SETTINGS),
    codes: clone(state.codes || {}),
    days: clone(state.days || {}),
    tombstones: clone(state.tombstones || {}),
    codeTombstones: clone(state.codeTombstones || {}),
    scans: clone(state.scans || []),
    changes: clone(state.changes || []),
  };
}

// Huella de los datos que importan para publicar (días, códigos y borrados)
export function dataFingerprint(state) {
  return stableStringify({
    codes: state?.codes || {}, days: state?.days || {},
    tombstones: state?.tombstones || {}, codeTombstones: state?.codeTombstones || {},
  });
}

// Compatibilidad: JSON de la copia sin la parte que cambia en cada exportación
export function backupFingerprint(state) {
  return stableStringify(syncPayload(state));
}

// Copia de seguridad en JSON para un archivo (sin token, clave ni ajustes del dispositivo)
export function exportBackup(state, { now } = {}) {
  const data = syncPayload(state);
  data.settings.onboardingDone = Boolean(state.settings?.onboardingDone);
  return JSON.stringify({ app: data.app, schema: data.schema, exportedAt: nowIso(now), ...data }, null, 2);
}

function importError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Restaura una copia (texto JSON u objeto). Lo importado pasa a ser la versión más nueva:
// los días que cambian se sellan con `now` y los que desaparecen quedan como tombstones.
// No toca settings.sync ni settings.ntfy de este dispositivo. Lanza Error en español.
// options: { now, force } — force permite importar una copia con 0 días sobre un teléfono con días.
export function importBackup(state, json, { now, force = false } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw importError('El archivo no es una copia de seguridad válida (no se puede leer).', 'INVALID');
  }
  if (!isPlainObject(data)) throw importError('El archivo no es una copia de seguridad válida.', 'INVALID');
  if (data.format === 'turnos-backup') {
    throw importError('Esta copia está cifrada: recupérala con «Restaurar desde GitHub».', 'ENCRYPTED');
  }
  if (data.app !== undefined && data.app !== 'turnos-mauricio') {
    throw importError('Este archivo no es una copia de Turnos de Mauricio.', 'INVALID');
  }
  if (!isPlainObject(data.days)) throw importError('La copia no contiene días con turnos.', 'INVALID');
  if (data.schema !== undefined && Number(data.schema) > SCHEMA) {
    throw importError('La copia es de una versión más nueva de la app. Actualiza la app primero.', 'NEWER');
  }
  for (const [key, entry] of Object.entries(data.days)) {
    if (!isKey(key)) throw importError(`La copia tiene una fecha no válida: ${key}`, 'INVALID');
    const codes = Array.isArray(entry) ? entry : entry?.codes;
    if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
      throw importError(`La copia tiene datos no válidos el día ${key}.`, 'INVALID');
    }
  }
  if (data.codes !== undefined && !isPlainObject(data.codes)) throw importError('La copia tiene códigos no válidos.', 'INVALID');
  const next = migrateState(data);
  const localDays = state.days || {};
  if (!count(next.days) && count(localDays) && !force) {
    throw importError('Esa copia no tiene ningún día con turnos. No se ha cambiado nada.', 'EMPTY_BACKUP');
  }
  // Ajustes propios de este dispositivo
  const cur = state.settings || {};
  next.settings.sync = mergeSettings(DEFAULT_SETTINGS.sync, cur.sync);
  next.settings.ntfy = clone(mergeSettings(DEFAULT_SETTINGS.ntfy, cur.ntfy));
  if (cur.onboardingDone) next.settings.onboardingDone = true;
  const at = nowIso(now);
  // Días: lo importado gana (sello nuevo) salvo que sea idéntico a lo que ya hay
  next.tombstones = { ...sanitizeStamps(state.tombstones, isKey), ...next.tombstones };
  for (const [key, d] of Object.entries(next.days)) {
    const local = localDays[key];
    if (local && sameList(local.codes, d.codes) && local.note === d.note) {
      next.days[key] = { ...d, source: local.source, updatedAt: local.updatedAt };
    } else {
      next.days[key] = { ...d, source: 'import', updatedAt: at };
    }
    delete next.tombstones[key];
  }
  for (const key of Object.keys(localDays)) if (!next.days[key]) next.tombstones[key] = at;
  // Códigos: los de la copia ganan si son distintos; los que la copia no trae se quedan como están
  next.codeTombstones = { ...sanitizeStamps(state.codeTombstones, validCode), ...next.codeTombstones };
  const inFile = new Set(Object.keys(isPlainObject(data.codes) ? data.codes : {}).filter(isSafeKey).map(cleanCode));
  for (const c of new Set([...Object.keys(next.codes), ...Object.keys(state.codes || {})])) {
    if (!validCode(c)) continue;
    const local = state.codes?.[c] ? sanitizeCodeDef(state.codes[c], c) : null;
    if (!inFile.has(c)) {
      if (local) next.codes[c] = local;
      continue;
    }
    const def = next.codes[c];
    const same = local && stableStringify({ ...local, updatedAt: null }) === stableStringify({ ...def, updatedAt: null });
    next.codes[c] = { ...def, updatedAt: same ? local.updatedAt : at };
    delete next.codeTombstones[c];
  }
  // Registra los días que cambian respecto al teléfono
  const keys = new Set([...Object.keys(localDays), ...Object.keys(next.days)]);
  for (const key of [...keys].sort()) {
    const before = localDays[key]?.codes ?? [];
    const after = next.days[key]?.codes ?? [];
    if (!sameList(before, after)) logChange(next, { at, dayKey: key, before: [...before], after: [...after], source: 'import' });
  }
  return next;
}

// Copia local de seguridad antes de importar/restaurar (máximo MAX_IMPORT_COPIES) → clave o null
export function saveBeforeImport(state, storage = globalThis.localStorage, { now } = {}) {
  if (!storage) return null;
  const t = (now instanceof Date ? now : new Date()).getTime();
  return keepCopy(storage, BEFORE_IMPORT_PREFIX, JSON.stringify(persistable(state)), MAX_IMPORT_COPIES, t);
}

// Copias guardadas, la más nueva primero → [{ key, at, days }]
export function listBeforeImport(storage = globalThis.localStorage) {
  if (!storage) return [];
  return keysWithPrefix(storage, BEFORE_IMPORT_PREFIX).reverse().map((key) => {
    let days = 0;
    try { days = count(JSON.parse(storage.getItem(key))?.days); } catch { /* copia ilegible */ }
    return { key, at: new Date(Number(key.slice(BEFORE_IMPORT_PREFIX.length))).toISOString(), days };
  });
}

// Deshace la última importación: devuelve el estado anterior (como una importación nueva, para que
// gane al sincronizar y conserve sync/ntfy actuales) y borra esa copia. null si no hay copia.
export function undoImport(storage = globalThis.localStorage, current, { now, key } = {}) {
  if (!storage) return null;
  const k = key ?? keysWithPrefix(storage, BEFORE_IMPORT_PREFIX).at(-1);
  if (!k) return null;
  let text = null;
  try { text = storage.getItem(k); } catch { return null; }
  if (!text) return null;
  let restored;
  try {
    restored = importBackup(current ?? createDefaultState(), text, { now, force: true });
  } catch {
    return null;
  }
  removeKey(storage, k);
  return restored;
}

// ---------- Fusión entre dispositivos ----------

const PRISTINE = (c, def) => DEFAULT_CODES[c]
  && stableStringify({ ...def, updatedAt: null }) === stableStringify({ ...sanitizeCodeDef(DEFAULT_CODES[c], c), updatedAt: null });

// Elige la versión ganadora: la más reciente; empate → entrada antes que borrado; luego determinista
function better(a, b, code) {
  if (!a) return b;
  if (!b) return a;
  if (a.ts !== b.ts) return a.ts > b.ts ? a : b;
  if (Boolean(a.value) !== Boolean(b.value)) return a.value ? a : b;
  if (!a.value) return a;
  const sa = stableStringify(a.value), sb = stableStringify(b.value);
  if (sa === sb) return a.side === 'local' ? a : b;
  if (code) {
    if (PRISTINE(code, a.value)) return b;
    if (PRISTINE(code, b.value)) return a;
  }
  return sa > sb ? a : b;
}

const contentOf = (v) => (v?.value ? stableStringify({ ...v.value, updatedAt: null, source: null }) : 'deleted');

function versionsOf(side, entries, tombs, k) {
  const e = entries?.[k], t = tombs?.[k];
  const ve = e ? { side, value: e, ts: tsOf(e.updatedAt) } : null;
  const vt = t ? { side, value: null, ts: tsOf(t), at: t } : null;
  return better(ve, vt);
}

// Unión sin repetidos; si el otro lado no trae nada nuevo, se deja la lista local tal cual
function unionList(a, b, max) {
  const seen = new Map();
  for (const x of a || []) seen.set(stableStringify(x), x);
  const before = seen.size;
  for (const x of b || []) {
    const k = stableStringify(x);
    if (!seen.has(k)) seen.set(k, x);
  }
  if (seen.size === before) return clone(a || []);
  return [...seen.entries()]
    .sort(([ka, x], [kb, y]) => (x.at < y.at ? -1 : x.at > y.at ? 1 : ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, x]) => clone(x)).slice(-max);
}

// Fusiona el estado local con uno remoto (ya migrado). Por día y por código gana el updatedAt más
// reciente (las tombstones cuentan como versión). Ajustes: los del dispositivo; con adoptSettings
// (dispositivo vacío) se toman del remoto los del usuario (nombre, horas, recordatorios).
// since: ISO de la última sincronización (para contar conflictos: cambiados en los dos lados).
// → { state, changed, conflictCount, pulledDays: [key], pulledCodes: [code] }
export function mergeStates(local, remote, { now, since = null, adoptSettings = false } = {}) {
  const L = ensureMaps(clone(local));
  const R = ensureMaps(isPlainObject(remote) ? remote : createDefaultState());
  const out = L;
  const sinceTs = tsOf(since);
  let conflictCount = 0;
  const pulledDays = [], pulledCodes = [];

  const days = {}, tombstones = {};
  const dayKeys = new Set([...Object.keys(L.days), ...Object.keys(L.tombstones), ...Object.keys(R.days), ...Object.keys(R.tombstones)]);
  for (const k of [...dayKeys].sort()) {
    if (!isKey(k)) continue;
    const lv = versionsOf('local', L.days, L.tombstones, k);
    const rv = versionsOf('remote', R.days, R.tombstones, k);
    const win = better(lv, rv);
    if (lv && rv && contentOf(lv) !== contentOf(rv) && lv.ts > sinceTs && rv.ts > sinceTs) conflictCount++;
    if (win.value) days[k] = clone(win.value);
    else tombstones[k] = win.at;
    if (win.side === 'remote' && contentOf(win) !== contentOf(lv)) pulledDays.push(k);
  }

  const codes = {}, codeTombstones = {};
  const codeKeys = new Set([...Object.keys(L.codes), ...Object.keys(L.codeTombstones), ...Object.keys(R.codes), ...Object.keys(R.codeTombstones)]);
  for (const c of [...codeKeys].sort()) {
    if (!validCode(c)) continue;
    const lv = versionsOf('local', L.codes, L.codeTombstones, c);
    const rv = versionsOf('remote', R.codes, R.codeTombstones, c);
    const win = better(lv, rv, c);
    if (win.value) codes[c] = sanitizeCodeDef(win.value, c);
    else if (DEFAULT_CODES[c]) codes[c] = { ...sanitizeCodeDef(DEFAULT_CODES[c], c), updatedAt: win.at }; // de fábrica: se restablece
    else codeTombstones[c] = win.at;
    if (win.side === 'remote' && contentOf(win) !== contentOf(lv)) pulledCodes.push(c);
  }

  out.days = days;
  out.tombstones = tombstones;
  out.codes = codes;
  out.codeTombstones = codeTombstones;
  for (const d of Object.values(out.days)) ensureCodes(out, d.codes);
  out.scans = unionList(L.scans, R.scans, MAX_SCANS);
  out.changes = unionList(L.changes, R.changes, MAX_CHANGES);
  if (adoptSettings && isPlainObject(R.settings)) {
    out.settings = fixSettings(mergeSettings(out.settings, pick(R.settings, USER_SETTINGS)));
  }
  const pruned = pruneTombstones(out, now instanceof Date ? now : new Date());
  const changed = dataFingerprint(pruned) !== dataFingerprint(local)
    || stableStringify(pick(pruned.settings, USER_SETTINGS)) !== stableStringify(pick(local.settings, USER_SETTINGS))
    || stableStringify([pruned.scans, pruned.changes]) !== stableStringify([local.scans || [], local.changes || []]);
  return { state: changed ? pruned : local, changed, conflictCount, pulledDays, pulledCodes };
}
