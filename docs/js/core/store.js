// Estado de la app en localStorage: carga/migración, mutaciones puras y copia de seguridad.
import { DEFAULT_CODES, KINDS, SHAPES, baseCode, cleanCode, guessCode, normalizeDayCodes } from './codes.js';
import { isKey, parseHHMM } from './dates.js';
import { scanToDays } from './diff.js';
import { clone, isPlainObject } from './util.js';

export const STORAGE_KEY = 'turnos-mauricio:v1';
export const CORRUPT_PREFIX = 'turnos-mauricio:corrupt:';
export const SCHEMA = 1;
export const MAX_SCANS = 30;
export const MAX_CHANGES = 300;
const SOURCES = ['scan', 'manual', 'import'];

export const DEFAULT_SETTINGS = Object.freeze({
  name: 'Mauricio',
  weeklyHours: 35,
  workDaysPerWeek: 5,
  holidaysReduceSoll: true,
  reminders: { eveningBefore: true, eveningTime: '20:00', beforeStart: true, minutesBefore: 60 },
  sync: { enabled: false, owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: '', lastPushAt: null, lastPushHash: null, lastError: null },
  ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', scheduled: {}, lastRunAt: null, lastError: null },
  onboardingDone: false,
});

export function createDefaultState() {
  return {
    schema: SCHEMA,
    settings: clone(DEFAULT_SETTINGS),
    codes: clone({ ...DEFAULT_CODES }),
    days: {},
    scans: [],
    changes: [],
  };
}

const nowIso = (now) => (now instanceof Date ? now : new Date()).toISOString();

// Mezcla profunda de ajustes. El mapa ntfy.scheduled se reemplaza entero; los valores de tipo
// incorrecto se ignoran.
function mergeSettings(base, patch) {
  const out = clone(base);
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    if (v === undefined) continue;
    if (k === 'scheduled') {
      if (isPlainObject(v)) out[k] = clone(v);
    } else if (isPlainObject(cur)) {
      if (isPlainObject(v)) out[k] = mergeSettings(cur, v);
    } else if (cur === null || cur === undefined || typeof cur === typeof v) {
      out[k] = clone(v);
    }
  }
  return out;
}

// Completa los campos de un CodeDef y corrige valores inválidos
export function sanitizeCodeDef(def, code) {
  const c = cleanCode(code ?? def?.code);
  const template = DEFAULT_CODES[c] ? { ...DEFAULT_CODES[c] } : guessCode(c);
  const out = { ...baseCode(c), ...template, ...(isPlainObject(def) ? def : {}), code: c };
  if (!KINDS.includes(out.kind)) out.kind = template.kind;
  if (!SHAPES.includes(out.shape)) out.shape = template.shape;
  out.start = parseHHMM(out.start) === null ? null : normHHMM(out.start);
  out.end = parseHHMM(out.end) === null ? null : normHHMM(out.end);
  out.breakMin = Math.max(0, Math.round(Number(out.breakMin) || 0));
  out.countsHours = Boolean(out.countsHours);
  out.creditHours = out.creditHours === null || out.creditHours === '' || out.creditHours === undefined
    || !Number.isFinite(Number(out.creditHours)) ? null : Number(out.creditHours);
  out.name = String(out.name ?? c);
  out.place = String(out.place ?? '');
  out.color = String(out.color || template.color);
  out.textColor = String(out.textColor || template.textColor);
  out.confirmed = out.confirmed !== false;
  out.builtin = Boolean(DEFAULT_CODES[c]);
  return out;
}

function normHHMM(s) {
  const m = parseHHMM(s);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function sanitizeDay(entry) {
  if (Array.isArray(entry)) entry = { codes: entry };
  if (!isPlainObject(entry) || !Array.isArray(entry.codes)) return null;
  return {
    codes: entry.codes.filter((c) => typeof c === 'string').map(cleanCode).filter(Boolean),
    note: typeof entry.note === 'string' ? entry.note : '',
    source: SOURCES.includes(entry.source) ? entry.source : 'manual',
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

// Rellena lo que falte y descarta lo inválido. Nunca lanza con objetos.
export function migrateState(raw) {
  const base = createDefaultState();
  if (!isPlainObject(raw)) return base;
  const state = base;
  state.settings = mergeSettings(base.settings, raw.settings);
  if (!isPlainObject(state.settings.ntfy.scheduled)) state.settings.ntfy.scheduled = {};
  for (const k of ['weeklyHours', 'workDaysPerWeek']) {
    const n = Number(state.settings[k]);
    state.settings[k] = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS[k];
  }
  state.settings.workDaysPerWeek = Math.min(7, Math.max(1, Math.round(state.settings.workDaysPerWeek)));
  if (isPlainObject(raw.codes)) {
    for (const [code, def] of Object.entries(raw.codes)) {
      const c = cleanCode(code);
      if (c && isPlainObject(def)) state.codes[c] = sanitizeCodeDef(def, c);
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
  if (Array.isArray(raw.scans)) state.scans = raw.scans.filter(isPlainObject).slice(-MAX_SCANS);
  if (Array.isArray(raw.changes)) state.changes = raw.changes.filter(isPlainObject).slice(-MAX_CHANGES);
  state.schema = SCHEMA;
  return state;
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
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('no es un objeto');
    return migrateState(parsed);
  } catch {
    try { storage.setItem(CORRUPT_PREFIX + Date.now(), raw); } catch { /* sin espacio: se pierde la copia */ }
    return createDefaultState();
  }
}

// Devuelve true si se pudo guardar
export function saveState(state, storage = globalThis.localStorage) {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

// Store reactivo para la UI. mutatorFn(draft) puede modificar el borrador o devolver un estado nuevo.
export function createStore(storage = globalThis.localStorage) {
  let state = loadState(storage);
  const subs = new Set();
  return {
    get: () => state,
    set(mutatorFn) {
      const draft = clone(state);
      const result = mutatorFn(draft);
      state = isPlainObject(result) ? result : draft;
      saveState(state, storage);
      for (const fn of [...subs]) {
        try { fn(state); } catch (e) { console.error(e); }
      }
      return state;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
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
    if (!state.codes[c]) state.codes[c] = sanitizeCodeDef(guessCode(c), c);
  }
}

// Guarda los códigos de un día (devuelve un estado nuevo; si nada cambia, el mismo)
export function setDay(state, key, codes, { note, source = 'manual', now } = {}) {
  if (!isKey(key)) throw new Error(`Fecha no válida: ${key}`);
  const prev = state.days?.[key] ?? null;
  const after = normalizeDayCodes(state, codes);
  const nextNote = note === undefined ? (prev?.note ?? '') : String(note ?? '');
  if (prev && sameList(prev.codes, after) && prev.note === nextNote) return state;
  const next = clone(state);
  ensureCodes(next, after);
  const at = nowIso(now);
  next.days[key] = { codes: after, note: nextNote, source: SOURCES.includes(source) ? source : 'manual', updatedAt: at };
  if (!prev || !sameList(prev.codes, after)) {
    logChange(next, { at, dayKey: key, before: prev ? [...prev.codes] : [], after: [...after], source: next.days[key].source });
  }
  return next;
}

export function clearDay(state, key, { source = 'manual', now } = {}) {
  const prev = state.days?.[key];
  if (!prev) return state;
  const next = clone(state);
  delete next.days[key];
  logChange(next, { at: nowIso(now), dayKey: key, before: [...prev.codes], after: [], source });
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
  next.scans = [...(next.scans || []), {
    at: nowIso(now),
    layout: scanResult?.layout ?? 'unknown',
    month: month ?? scanResult?.month ?? null,
    year: year ?? scanResult?.year ?? null,
    daysFound: Array.isArray(scanResult?.days) ? scanResult.days.length : 0,
  }].slice(-MAX_SCANS);
  return next;
}

// Crea o edita un código. Guardar un horario cuenta como confirmarlo (salvo confirmed explícito).
export function upsertCode(state, def) {
  const c = cleanCode(def?.code);
  if (!c) throw new Error('El código no puede estar vacío.');
  if (def.start && parseHHMM(def.start) === null) throw new Error(`Hora de inicio no válida: ${def.start}`);
  if (def.end && parseHHMM(def.end) === null) throw new Error(`Hora de fin no válida: ${def.end}`);
  const patch = { ...def, code: c };
  if (patch.confirmed === undefined && (def.start !== undefined || def.end !== undefined)) patch.confirmed = true;
  const next = clone(state);
  next.codes[c] = sanitizeCodeDef({ ...(state.codes?.[c] ?? {}), ...patch }, c);
  return next;
}

// Borra un código propio; uno de fábrica vuelve a su definición original
export function deleteCode(state, code) {
  const c = cleanCode(code);
  const next = clone(state);
  if (DEFAULT_CODES[c]) next.codes[c] = clone({ ...DEFAULT_CODES[c] });
  else delete next.codes[c];
  return next;
}

export function updateSettings(state, patch) {
  const next = clone(state);
  next.settings = mergeSettings(state.settings, patch);
  return next;
}

// Datos que viajan en la copia (sin token ni estado local de envíos)
function backupData(state, { publicCopy = false } = {}) {
  const s = clone(state);
  s.settings.sync = { ...s.settings.sync, token: '', lastPushAt: null, lastPushHash: null, lastError: null };
  s.settings.ntfy = { ...s.settings.ntfy, scheduled: {}, lastRunAt: null, lastError: null };
  if (publicCopy) s.settings.ntfy.topic = '';
  return {
    app: 'turnos-mauricio',
    schema: SCHEMA,
    settings: s.settings,
    codes: s.codes,
    days: s.days,
    scans: s.scans,
    changes: s.changes,
  };
}

// JSON de la copia sin la parte que cambia en cada exportación (para hashes)
export function backupFingerprint(state, opts) {
  return JSON.stringify(backupData(state, opts));
}

// Copia de seguridad en JSON (sin el token de GitHub). publicCopy: también sin el topic de ntfy.
export function exportBackup(state, { now, publicCopy = false } = {}) {
  const data = backupData(state, { publicCopy });
  return JSON.stringify({ app: data.app, schema: data.schema, exportedAt: nowIso(now), ...data }, null, 2);
}

// Restaura una copia. Conserva el token y el estado local de notificaciones de este teléfono.
export function importBackup(state, json, { now } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('El archivo no es una copia de seguridad válida (no se puede leer).');
  }
  if (!isPlainObject(data)) throw new Error('El archivo no es una copia de seguridad válida.');
  if (data.app !== undefined && data.app !== 'turnos-mauricio') {
    throw new Error('Este archivo no es una copia de Turnos de Mauricio.');
  }
  if (!isPlainObject(data.days)) throw new Error('La copia no contiene días con turnos.');
  if (data.schema !== undefined && Number(data.schema) > SCHEMA) {
    throw new Error('La copia es de una versión más nueva de la app. Actualiza la app primero.');
  }
  for (const [key, entry] of Object.entries(data.days)) {
    if (!isKey(key)) throw new Error(`La copia tiene una fecha no válida: ${key}`);
    const codes = Array.isArray(entry) ? entry : entry?.codes;
    if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
      throw new Error(`La copia tiene datos no válidos el día ${key}.`);
    }
  }
  if (data.codes !== undefined && !isPlainObject(data.codes)) throw new Error('La copia tiene códigos no válidos.');
  const next = migrateState(data);
  next.settings.sync.token = state.settings?.sync?.token ?? '';
  next.settings.sync.lastPushHash = null;
  next.settings.ntfy.scheduled = clone(state.settings?.ntfy?.scheduled ?? {});
  if (!next.settings.ntfy.topic) next.settings.ntfy.topic = state.settings?.ntfy?.topic ?? '';
  // Registra los días que cambian respecto al teléfono
  const at = nowIso(now);
  const keys = new Set([...Object.keys(state.days || {}), ...Object.keys(next.days)]);
  for (const key of [...keys].sort()) {
    const before = state.days?.[key]?.codes ?? [];
    const after = next.days[key]?.codes ?? [];
    if (!sameList(before, after)) logChange(next, { at, dayKey: key, before: [...before], after: [...after], source: 'import' });
  }
  return next;
}
