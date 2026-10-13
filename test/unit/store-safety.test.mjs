import { stateWith, memoryStorage, T0 } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, CORRUPT_PREFIX, BEFORE_IMPORT_PREFIX, NEWER_SCHEMA_KEY, MAX_CORRUPT_COPIES, TOMBSTONE_DAYS,
  createDefaultState, loadState, saveState, createStore, setDay, clearDay, upsertCode, deleteCode, updateSettings,
  exportBackup, importBackup, migrateState, mergeStates, pruneTombstones, saveBeforeImport, listBeforeImport, undoImport,
  sanitizeCodeDef, safeColor,
} from '../../docs/js/core/store.js';
import { encryptBackup } from '../../docs/js/core/sync.js';

const DAY = 24 * 3600 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);
const iso = (ms) => at(ms).toISOString();

// Evento 'storage' como lo recibe otra pestaña
function storageEvent(key = STORAGE_KEY) {
  const ev = new Event('storage');
  Object.defineProperty(ev, 'key', { value: key });
  return ev;
}

test('tombstones: clearDay deja una, setDay la quita; updatedAt siempre al cambiar', () => {
  let s = stateWith({ '2026-10-12': ['F1'] });
  s = clearDay(s, '2026-10-12', { now: at(DAY) });
  assert.equal(s.days['2026-10-12'], undefined);
  assert.deepEqual(s.tombstones, { '2026-10-12': iso(DAY) });
  s = setDay(s, '2026-10-12', ['S1'], { now: at(2 * DAY) });
  assert.deepEqual(s.tombstones, {});
  assert.equal(s.days['2026-10-12'].updatedAt, iso(2 * DAY));
  // Solo cambia la nota: también se sella
  s = setDay(s, '2026-10-12', ['S1'], { note: 'x', now: at(3 * DAY) });
  assert.equal(s.days['2026-10-12'].updatedAt, iso(3 * DAY));
});

test('tombstones de más de 120 días se podan al guardar', () => {
  let s = stateWith({ '2026-01-01': ['F1'], '2026-10-01': ['F1'] });
  s = clearDay(s, '2026-01-01', { now: at(-(TOMBSTONE_DAYS + 5) * DAY) });
  s = clearDay(s, '2026-10-01', { now: at(-DAY) });
  s.codeTombstones = { X9: iso(-(TOMBSTONE_DAYS + 1) * DAY), K: iso(-DAY) };
  const pruned = pruneTombstones(s, T0);
  assert.deepEqual(Object.keys(pruned.tombstones), ['2026-10-01']);
  assert.deepEqual(Object.keys(pruned.codeTombstones), ['K']);
  assert.equal(pruneTombstones(pruned, T0), pruned); // nada que podar → mismo objeto
  const storage = memoryStorage();
  assert.equal(saveState(s, storage, { now: T0 }), true);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem(STORAGE_KEY)).tombstones), ['2026-10-01']);
  const store = createStore(memoryStorage(), { target: null, now: () => T0 });
  store.set(() => s);
  assert.deepEqual(Object.keys(store.get().tombstones), ['2026-10-01']);
});

test('códigos: updatedAt al editar, tombstone al borrar uno propio, los de fábrica se restablecen', () => {
  let s = upsertCode(createDefaultState(), { code: 'K', kind: 'event', name: 'Curso', start: '08:00', end: '12:00' }, { now: at(DAY) });
  assert.equal(s.codes.K.updatedAt, iso(DAY));
  s = deleteCode(s, 'K', { now: at(2 * DAY) });
  assert.equal(s.codes.K, undefined);
  assert.deepEqual(s.codeTombstones, { K: iso(2 * DAY) });
  s = upsertCode(s, { code: 'K', kind: 'event', name: 'Curso' }, { now: at(3 * DAY) });
  assert.deepEqual(s.codeTombstones, {});
  // De fábrica: vuelve al original, con fecha (para que el cambio llegue a otros dispositivos)
  s = upsertCode(s, { code: 'F1', start: '07:00', end: '15:00' }, { now: at(3 * DAY) });
  s = deleteCode(s, 'F1', { now: at(4 * DAY) });
  assert.equal(s.codes.F1.start, '06:00');
  assert.equal(s.codes.F1.updatedAt, iso(4 * DAY));
  // Un código propio que se usa en algún día queda como supuesto (sin confirmar)
  let u = setDay(createDefaultState(), '2026-10-12', ['FB'], { now: T0 });
  u = upsertCode(u, { code: 'FB', kind: 'event', start: '08:00', end: '16:00' }, { now: T0 });
  u = deleteCode(u, 'FB', { now: at(DAY) });
  assert.equal(u.codes.FB.confirmed, false);
  assert.equal(u.codes.FB.start, null);
  assert.equal(u.codeTombstones.FB, iso(DAY));
});

test('upsertCode: fin sin inicio no se acepta; solo inicio sí; pausa por defecto solo > 6 h', () => {
  const s = createDefaultState();
  assert.throws(() => upsertCode(s, { code: 'TS', end: '15:00' }), /hora de inicio/);
  const ts = upsertCode(s, { code: 'TS', start: '14:00', end: null });
  assert.equal(ts.codes.TS.start, '14:00');
  assert.equal(ts.codes.TS.end, null);
  // F4 (supuesto 06:00–15:00, pausa 30) confirmado como 06:00–11:00 → sin pausa
  const f4 = upsertCode(setDay(s, '2026-10-12', ['F4']), { code: 'F4', start: '06:00', end: '11:00', breakMin: 30 });
  assert.equal(f4.codes.F4.breakMin, 0);
  // Turno largo: la pausa se mantiene; y una pausa cambiada a mano se respeta
  assert.equal(upsertCode(s, { code: 'F6', start: '07:00', end: '15:30' }).codes.F6.breakMin, 30);
  assert.equal(upsertCode(s, { code: 'F6', start: '07:00', end: '11:00', breakMin: 15 }).codes.F6.breakMin, 15);
  assert.throws(() => upsertCode(s, { code: 'X'.repeat(13) }), /demasiado largo/);
});

test('updateSettings: calendarUpdatedAt cambia solo si cambian los avisos o publishPlaces', () => {
  const s0 = createDefaultState();
  const s1 = updateSettings(s0, { name: 'M' }, { now: T0 });
  assert.equal(s1.settings.calendarUpdatedAt, null);
  const s2 = updateSettings(s1, { reminders: { minutesBefore: 90 } }, { now: at(DAY) });
  assert.equal(s2.settings.calendarUpdatedAt, iso(DAY));
  assert.equal(updateSettings(s2, { reminders: { minutesBefore: 90 } }, { now: at(2 * DAY) }).settings.calendarUpdatedAt, iso(DAY));
  assert.equal(updateSettings(s2, { sync: { publishPlaces: true } }, { now: at(3 * DAY) }).settings.calendarUpdatedAt, iso(3 * DAY));
});

test('mergeStates: por día gana lo más reciente; las tombstones cuentan; resultado simétrico', () => {
  let a = stateWith({});
  a = setDay(a, '2026-10-12', ['F1'], { now: at(1) });
  a = setDay(a, '2026-10-13', ['S1'], { now: at(5) });
  a = setDay(a, '2026-10-14', ['N1'], { now: at(1) });
  let b = stateWith({});
  b = setDay(b, '2026-10-12', ['Z1'], { now: at(3) });   // más nuevo que A
  b = setDay(b, '2026-10-13', ['F1'], { now: at(2) });   // más viejo que A
  b = setDay(b, '2026-10-14', ['N1'], { now: at(0) });
  b = clearDay(b, '2026-10-14', { now: at(4) });          // borrado más nuevo
  b = setDay(b, '2026-10-15', ['-'], { now: at(1) });
  const ab = mergeStates(a, b, { now: T0 });
  const ba = mergeStates(b, a, { now: T0 });
  const codes = (st) => Object.fromEntries(Object.entries(st.days).map(([k, d]) => [k, d.codes.join(',')]));
  assert.deepEqual(codes(ab.state), { '2026-10-12': 'Z1', '2026-10-13': 'S1', '2026-10-15': '-' });
  assert.deepEqual(codes(ba.state), codes(ab.state));
  assert.deepEqual(ab.state.tombstones, { '2026-10-14': iso(4) });
  assert.deepEqual(ab.pulledDays, ['2026-10-12', '2026-10-14', '2026-10-15']);
  assert.equal(ab.changed, true);
  assert.equal(ab.conflictCount, 3); // 12, 13 y 14 cambiaron en los dos lados
  assert.equal(mergeStates(a, b, { now: T0, since: iso(1) }).conflictCount, 1); // solo el 13 cambió en los dos lados después
  // Empate exacto con contenido distinto: misma elección en los dos sentidos
  const x = setDay(stateWith({}), '2026-10-20', ['F1'], { now: T0 });
  const y = setDay(stateWith({}), '2026-10-20', ['S1'], { now: T0 });
  assert.deepEqual(mergeStates(x, y).state.days['2026-10-20'].codes, mergeStates(y, x).state.days['2026-10-20'].codes);
  // Sin nada nuevo → mismo objeto
  assert.equal(mergeStates(a, a).state, a);
});

test('mergeStates: códigos por updatedAt, borrados y ajustes del dispositivo', () => {
  let a = upsertCode(createDefaultState(), { code: 'F1', start: '07:00', end: '15:00' }, { now: at(1) });
  a = upsertCode(a, { code: 'K', kind: 'event', name: 'Curso' }, { now: at(1) });
  a = updateSettings(a, { name: 'Local', sync: { token: 'tok', enabled: true } });
  let b = upsertCode(createDefaultState(), { code: 'F1', start: '06:30', end: '15:00' }, { now: at(2) });
  b = deleteCode(upsertCode(b, { code: 'K', kind: 'event' }, { now: at(0) }), 'K', { now: at(3) });
  b = updateSettings(b, { name: 'Remoto', reminders: { minutesBefore: 15 } });
  const m = mergeStates(a, b, { now: T0 }).state;
  assert.equal(m.codes.F1.start, '06:30');
  assert.equal(m.codes.K, undefined);
  assert.equal(m.codeTombstones.K, iso(3));
  assert.equal(m.settings.name, 'Local'); // ajustes del dispositivo
  assert.equal(m.settings.sync.token, 'tok');
  // Dispositivo vacío: adopta los ajustes del usuario (no los del dispositivo)
  const fresh = mergeStates(updateSettings(createDefaultState(), { sync: { token: 'mio' } }), b, { now: T0, adoptSettings: true }).state;
  assert.equal(fresh.settings.name, 'Remoto');
  assert.equal(fresh.settings.reminders.minutesBefore, 15);
  assert.equal(fresh.settings.sync.token, 'mio');
  // Un código de fábrica intacto no gana a uno editado con la misma fecha (null)
  const edited = migrateState({ codes: { F2: { ...createDefaultState().codes.F2, start: '07:00', confirmed: true } }, days: {} });
  assert.equal(mergeStates(createDefaultState(), edited).state.codes.F2.start, '07:00');
  assert.equal(mergeStates(edited, createDefaultState()).state.codes.F2.start, '07:00');
});

test('dos pestañas: el evento storage recarga y cada escritura parte de lo último guardado', () => {
  const storage = memoryStorage();
  const tabA = new EventTarget(), tabB = new EventTarget();
  const a = createStore(storage, { target: tabA });
  const b = createStore(storage, { target: tabB });
  const seenA = [];
  a.subscribe((s) => seenA.push(s));
  b.set((s) => setDay(s, '2026-10-21', ['S1'], { note: 'de B' }));
  // A sin evento todavía: al escribir, parte de lo guardado por B (no lo pisa)
  a.set((d) => { d.settings.reminders.eveningBefore = false; });
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.deepEqual(saved.days['2026-10-21'].codes, ['S1']);
  assert.equal(saved.settings.reminders.eveningBefore, false);
  // B recibe el evento de A y se recarga
  b.set((s) => setDay(s, '2026-10-22', ['F1']));
  tabA.dispatchEvent(storageEvent());
  assert.ok(a.get().days['2026-10-22']);
  assert.equal(seenA.length, 2);
  // Eventos de otras claves se ignoran; refresh() relee a mano
  tabA.dispatchEvent(storageEvent('otra-clave'));
  assert.equal(seenA.length, 2);
  storage.setItem(STORAGE_KEY, JSON.stringify(setDay(a.get(), '2026-10-23', ['N1'])));
  assert.equal(a.refresh(), true);
  assert.ok(a.get().days['2026-10-23']);
  assert.equal(a.refresh(), false);
  // Si otra pestaña deja JSON ilegible, no se pierde lo que hay en memoria
  storage.setItem(STORAGE_KEY, '{roto');
  tabA.dispatchEvent(storageEvent());
  assert.ok(a.get().days['2026-10-23']);
  a.destroy();
  b.destroy();
});

test('set() avisa si no se pudo guardar (cuota llena) y libera espacio', () => {
  const storage = memoryStorage();
  let full = true;
  const quota = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
  const setItem = storage.setItem;
  storage.setItem = (k, v) => { if (full && k === STORAGE_KEY) throw quota; setItem(k, v); };
  const errors = [];
  const store = createStore(storage, { target: null, onError: (e) => errors.push(e) });
  const other = [];
  const off = store.onError((e) => other.push(e));
  store.set((s) => setDay(s, '2026-10-20', ['F1']));
  assert.equal(store.saveOk(), false);
  assert.equal(store.lastSave().error.code, 'QUOTA');
  assert.match(store.lastSave().error.message, /No se pudo guardar/);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'save');
  assert.equal(other.length, 1);
  assert.ok(store.get().days['2026-10-20']); // sigue en memoria
  off();
  // Si hay copias corruptas que ocupan sitio, se borran y se reintenta
  setItem(`${CORRUPT_PREFIX}1`, 'x'.repeat(100));
  storage.setItem = (k, v) => { if (k === STORAGE_KEY && storage.getItem(`${CORRUPT_PREFIX}1`) !== null) throw quota; setItem(k, v); };
  store.set((s) => setDay(s, '2026-10-21', ['S1']));
  assert.equal(store.saveOk(), true);
  assert.equal(storage.getItem(`${CORRUPT_PREFIX}1`), null);
  assert.ok(JSON.parse(storage.getItem(STORAGE_KEY)).days['2026-10-21']);
  assert.equal(errors.length, 1);
});

test('JSON corrupto: una sola copia por contenido y como mucho 3', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{roto' });
  for (let i = 0; i < 3; i++) loadState(storage);
  const copies = () => [...storage.map.keys()].filter((k) => k.startsWith(CORRUPT_PREFIX));
  assert.equal(copies().length, 1);
  for (let i = 0; i < 5; i++) {
    storage.setItem(STORAGE_KEY, `{roto ${i}`);
    loadState(storage);
  }
  assert.equal(copies().length, MAX_CORRUPT_COPIES);
  assert.ok(copies().some((k) => storage.getItem(k) === '{roto 4'));
});

test('datos de una versión más nueva: se conservan los campos desconocidos y se marca __newerSchema', () => {
  const future = {
    schema: 2, futuro: { a: 1 },
    settings: { name: 'M', nuevoAjuste: true, reminders: { minutesBefore: 30, extra: 'x' } },
    codes: { F1: { code: 'F1', kind: 'shift', start: '06:00', end: '15:00', icono: '⭐' } },
    days: { '2026-10-12': { codes: ['F1'], updatedAt: T0.toISOString(), equipo: 'B' } },
  };
  const raw = JSON.stringify(future);
  const storage = memoryStorage({ [STORAGE_KEY]: raw });
  const s = loadState(storage);
  assert.equal(s.__newerSchema, true);
  assert.equal(s.schema, 2);
  assert.deepEqual(s.futuro, { a: 1 });
  assert.equal(s.settings.nuevoAjuste, true);
  assert.equal(s.settings.reminders.extra, 'x');
  assert.equal(s.codes.F1.icono, '⭐');
  assert.equal(s.days['2026-10-12'].equipo, 'B');
  assert.equal(storage.getItem(NEWER_SCHEMA_KEY), raw); // copia intacta
  // Al guardar no se pierde nada (y la marca interna no se guarda)
  const store = createStore(storage, { target: null });
  store.set((st) => setDay(st, '2026-10-13', ['S1']));
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.schema, 2);
  assert.deepEqual(saved.futuro, { a: 1 });
  assert.equal(saved.days['2026-10-12'].equipo, 'B');
  assert.equal(saved.__newerSchema, undefined);
  assert.equal(store.get().__newerSchema, true);
  // Un estado normal no lleva la marca
  assert.equal(loadState(memoryStorage({ [STORAGE_KEY]: JSON.stringify(createDefaultState()) })).__newerSchema, undefined);
});

test('lo importado se sanea: colores, longitudes, cambios, escaneos y claves peligrosas', () => {
  const evil = JSON.parse(`{
    "settings": { "name": "${'N'.repeat(500)}", "__proto__": { "hacked": true }, "constructor": { "x": 1 },
      "ntfy": { "scheduled": { "__proto__": { "at": "x" }, "ok-1": { "at": "2026-10-12T10:00:00.000Z", "hash": "h" }, "bad id!": { "at": "x" } } } },
    "codes": { "X9": { "kind": "shift", "color": "url(https://tracker.example/p.png)", "textColor": "#abc", "name": "${'n'.repeat(300)}" },
               "__proto__": { "kind": "shift" } },
    "days": { "2026-10-12": { "codes": ["F1", "${'Z'.repeat(40)}"], "note": "${'x'.repeat(5000)}", "updatedAt": "ayer" } },
    "tombstones": { "2026-10-13": "2026-10-13T10:00:00.000Z", "basura": "2026-10-13T10:00:00.000Z", "2026-10-14": "no" },
    "changes": [ { "at": "2026-10-12T10:00:00.000Z", "dayKey": "2026-10-12", "before": "F1", "after": 5 },
                 { "at": "2026-10-12T10:00:00.000Z", "dayKey": "2026-10-12", "before": ["f1"], "after": ["S1", 3], "source": "hack" },
                 { "dayKey": "2026-10-12", "before": [], "after": [] } ],
    "scans": [ { "at": "2026-10-12T10:00:00.000Z", "layout": "<img>", "month": 13, "year": "2026", "daysFound": -4 }, { "at": 5 } ]
  }`);
  const s = importBackup(createDefaultState(), evil, { now: T0 });
  assert.equal({}.hacked, undefined);
  assert.equal(Object.getPrototypeOf(s.settings), Object.prototype);
  assert.equal(s.settings.hacked, undefined);
  assert.equal(s.settings.name.length, 60);
  assert.equal(s.codes.X9.color, '#9E9E9E'); // nada de url()
  assert.equal(s.codes.X9.textColor, '#AABBCC');
  assert.equal(s.codes.X9.name.length, 40);
  assert.deepEqual(s.days['2026-10-12'].codes, ['F1']);
  assert.equal(s.days['2026-10-12'].note.length, 1000);
  assert.deepEqual(Object.keys(s.tombstones), ['2026-10-13']);
  assert.equal(s.changes.filter((c) => c.source !== 'import').length, 1);
  assert.deepEqual(s.changes[0], { at: '2026-10-12T10:00:00.000Z', dayKey: '2026-10-12', before: ['F1'], after: ['S1'], source: 'manual' });
  assert.deepEqual(s.scans, [{ at: '2026-10-12T10:00:00.000Z', layout: 'unknown', month: null, year: null, daysFound: 0 }]);
  assert.deepEqual(migrateState({ days: { '2026-10-12': { codes: ['F1', 5, null] } } }).days['2026-10-12'].codes, ['F1']);
  const local = migrateState({ settings: { ntfy: evil.settings.ntfy } });
  assert.deepEqual(Object.keys(local.settings.ntfy.scheduled), ['ok-1']);
  assert.equal(safeColor('red', '#000000'), '#000000');
  assert.equal(safeColor('#12ab9F', '#000000'), '#12ab9F');
  assert.equal(sanitizeCodeDef({ color: 'var(--x)' }, 'F1').color, '#F2E500');
});

test('importBackup no toca la sync ni ntfy de este teléfono (ni el onboarding)', () => {
  let phone = stateWith({ '2026-10-12': ['F1'] });
  phone = updateSettings(phone, {
    onboardingDone: true,
    sync: { enabled: true, owner: 'Mardar91', repo: 'mauricio-datos', token: 'TOK', key: 'K'.repeat(43), baseRev: 7, deviceId: 'movil' },
    ntfy: { enabled: true, topic: 'turnos-mauricio-aaa', server: 'https://ntfy.sh', scheduled: { a: { at: '2026-10-13T05:00:00.000Z', hash: 'h' } } },
  });
  const old = exportBackup(updateSettings(stateWith({ '2026-10-12': ['S1'] }), { reminders: { minutesBefore: 30 } }), { now: T0 });
  const crafted = JSON.parse(old);
  crafted.settings.sync = { enabled: false, owner: 'atacante', repo: 'x', token: '' };
  crafted.settings.ntfy = { enabled: false, topic: 'otro', server: 'https://evil.example' };
  for (const json of [old, JSON.stringify(crafted)]) {
    const r = importBackup(phone, json, { now: at(DAY) });
    assert.deepEqual(r.settings.sync, phone.settings.sync);
    assert.deepEqual(r.settings.ntfy, phone.settings.ntfy);
    assert.equal(r.settings.onboardingDone, true);
    assert.equal(r.settings.reminders.minutesBefore, 30); // las preferencias sí vienen de la copia
    assert.deepEqual(r.days['2026-10-12'].codes, ['S1']);
  }
});

// Teléfono conectado: sync activa y ya leyó el remoto (lo importado se sella como lo más nuevo)
const connected = (s) => updateSettings(s, { sync: { enabled: true, token: 'TOK', lastPullAt: T0.toISOString() } });

test('importBackup: copia vacía rechazada si el teléfono tiene días (salvo force); copia cifrada → aviso', () => {
  const phone = connected(stateWith({ '2026-10-12': ['F1'] }));
  const empty = JSON.stringify({ app: 'turnos-mauricio', schema: 1, days: {} });
  assert.throws(() => importBackup(phone, empty), (e) => e.code === 'EMPTY_BACKUP' && /No se cambió nada/.test(e.message));
  const forced = importBackup(phone, empty, { force: true, now: T0 });
  assert.deepEqual(forced.days, {});
  assert.ok(forced.tombstones['2026-10-12']);
  assert.deepEqual(importBackup(createDefaultState(), empty).days, {});
  assert.throws(() => importBackup(phone, { format: 'turnos-backup', v: 2, meta: {}, enc: {} }), (e) => e.code === 'ENCRYPTED');
});

test('copia de seguridad antes de importar (máx. 3) y deshacer', () => {
  const storage = memoryStorage();
  const phone = connected(stateWith({ '2026-10-12': ['F1'], '2026-10-13': ['S1'] }));
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(saveBeforeImport(phone, storage, { now: at(i * 1000) }));
  for (const k of keys) assert.ok(k.startsWith(BEFORE_IMPORT_PREFIX));
  const list = listBeforeImport(storage);
  assert.equal(list.length, 3);
  assert.equal(list[0].at, iso(3000)); // la más nueva primero
  assert.equal(list[0].days, 2);
  const imported = importBackup(phone, JSON.stringify({ days: { '2026-10-20': ['N1'] } }), { now: at(DAY) });
  // Mientras tanto cambió el token y se programaron avisos: deshacer los conserva
  const current = updateSettings(imported, { sync: { token: 'NUEVO' }, ntfy: { scheduled: { z: { at: '2026-10-21T05:00:00.000Z', hash: 'h' } } } });
  // Sin la clave de ESA importación no se deshace nada (nunca «la más nueva» a ciegas)
  assert.equal(undoImport(storage, current, { now: at(2 * DAY) }), null);
  assert.equal(undoImport(storage, current, { now: at(2 * DAY), key: 'otra-cosa' }), null);
  const undone = undoImport(storage, current, { now: at(2 * DAY), key: keys[3] });
  assert.deepEqual(Object.keys(undone.days).sort(), ['2026-10-12', '2026-10-13']);
  assert.equal(undone.days['2026-10-12'].updatedAt, iso(2 * DAY)); // gana al sincronizar
  assert.ok(undone.tombstones['2026-10-20']);
  assert.equal(undone.settings.sync.token, 'NUEVO');
  assert.deepEqual(Object.keys(undone.settings.ntfy.scheduled), ['z']);
  assert.equal(listBeforeImport(storage).length, 2); // la copia usada se borra
  // Segundo toque en «Deshacer»: esa copia ya no existe → nada (no restaura otra más vieja)
  assert.equal(undoImport(storage, undone, { now: at(2 * DAY), key: keys[3] }), null);
  assert.equal(listBeforeImport(storage).length, 2);
  assert.equal(undoImport(memoryStorage(), current, { key: keys[3] }), null);
});

test('una copia cifrada se puede restaurar descifrándola primero', async () => {
  const key = Buffer.alloc(32, 3).toString('base64url');
  const doc = await encryptBackup(stateWith({ '2026-10-12': ['F1'] }), { rev: 1, now: T0, deviceId: 'x', key });
  const { decryptBackup } = await import('../../docs/js/core/sync.js');
  const plain = await decryptBackup(doc, key);
  assert.deepEqual(importBackup(createDefaultState(), plain).days['2026-10-12'].codes, ['F1']);
});
