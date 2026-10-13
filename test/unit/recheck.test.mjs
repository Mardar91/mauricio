// Escenarios de la segunda revisión de la lógica (sincronización, importar, códigos, calendario).
import { stateWith, memoryStorage, fakeGitHub, T0, KEY, OTHER_KEY, SYNC } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncNow, pullOnly, becomePublisher, applySyncResult, pushData, syncConfigPatch, decryptBackup, SyncError,
} from '../../docs/js/core/sync.js';
import {
  STORAGE_KEY, NEWER_SCHEMA_KEY, BEFORE_IMPORT_PREFIX, createDefaultState, createStore, loadState, setDay, upsertCode,
  deleteCode, updateSettings, importBackup, exportBackup, saveBeforeImport, undoImport, mergeStates, syncPayload,
} from '../../docs/js/core/store.js';
import { buildICS } from '../../docs/js/core/ics.js';

const DAY = 24 * 3600 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);
const device = (id, days = {}, sync = {}) => updateSettings(stateWith(days), { sync: { ...SYNC, deviceId: id, ...sync } });
async function sync(s, gh, now, extra = {}) {
  const res = await syncNow(s, { fetchImpl: gh.fetch, now, ...extra });
  return { res, state: applySyncResult(s, res, { now }) };
}
async function takeover(s, gh, now) {
  const res = await becomePublisher(s, { fetchImpl: gh.fetch, now });
  return { res, state: applySyncResult(s, res, { now }) };
}
const doc = (gh) => JSON.parse(gh.text('backup.json'));
const triggers = (ics) => (ics.match(/TRIGGER:[^\r]+/g) || []);
const event = (ics, uid) => (ics.split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}@`)) || '');
const seqOf = (ics, uid) => Number(/SEQUENCE:(\d+)/.exec(event(ics, uid))?.[1]);

// ---------- Ajustes que dan forma al calendario: convergen ----------

test('avisos: el cambio más reciente se propaga; un dispositivo atrasado no publica sus avisos viejos', async () => {
  const gh = fakeGitHub();
  // Safari (S) primero; después la app (I) restaura y pasa a publicar
  let S = device('safari', { '2026-10-12': ['F1'], '2026-10-13': ['S1'] });
  ({ state: S } = await sync(S, gh, T0));
  let I = device('app');
  ({ state: I } = await sync(I, gh, at(1000)));
  ({ state: I } = await takeover(I, gh, at(2000)));
  // En la app: aviso 2 h antes y sin aviso la víspera (sin tocar los datos)
  I = updateSettings(I, { reminders: { eveningBefore: false, minutesBefore: 120 } }, { now: at(DAY) });
  const r = await syncNow(I, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(r.pushed, true); // los avisos también viajan en la copia
  I = applySyncResult(I, r, { now: at(DAY) });
  assert.deepEqual([...new Set(triggers(gh.text('turnos.ics')))], ['TRIGGER:-PT2H']);
  assert.equal((await decryptBackup(doc(gh), KEY)).settings.reminders.minutesBefore, 120);
  // Días después se abre Safari (avisos viejos): los adopta
  ({ state: S } = await sync(S, gh, at(3 * DAY)));
  assert.equal(S.settings.reminders.minutesBefore, 120);
  assert.equal(S.settings.reminders.eveningBefore, false);
  // Si Safari pasa a publicar, el calendario mantiene los avisos de la app
  ({ state: S } = await takeover(S, gh, at(4 * DAY)));
  assert.deepEqual([...new Set(triggers(gh.text('turnos.ics')))], ['TRIGGER:-PT2H']);
  // Y un aviso cambiado después en Safari gana
  S = updateSettings(S, { reminders: { minutesBefore: 30 } }, { now: at(5 * DAY) });
  ({ state: S } = await sync(S, gh, at(5 * DAY)));
  ({ state: I } = await sync(I, gh, at(6 * DAY)));
  assert.equal(I.settings.reminders.minutesBefore, 30);
});

test('publicar lugares (privacidad): el cambio más reciente gana también en el dispositivo que pasa a publicar', async () => {
  const gh = fakeGitHub();
  // Safari tenía lugares activados (enlace viejo con p:true)
  let S = updateSettings(device('safari', { '2026-10-12': ['F1', 'F52'] }), { sync: { publishPlaces: true } }, { now: T0 });
  ({ state: S } = await sync(S, gh, T0));
  assert.ok(gh.text('turnos.ics').includes('LOCATION:F52'));
  let I = device('app');
  ({ state: I } = await sync(I, gh, at(1000)));
  ({ state: I } = await takeover(I, gh, at(2000)));
  // En la app los desactiva
  I = updateSettings(I, { sync: { publishPlaces: false } }, { now: at(DAY) });
  ({ state: I } = await sync(I, gh, at(DAY)));
  assert.ok(!gh.text('turnos.ics').includes('\r\nLOCATION:'));
  // Safari lee y adopta; si pasa a publicar, no vuelven los lugares
  ({ state: S } = await sync(S, gh, at(2 * DAY)));
  assert.equal(S.settings.sync.publishPlaces, false);
  ({ state: S } = await takeover(S, gh, at(3 * DAY)));
  assert.ok(!gh.text('turnos.ics').includes('\r\nLOCATION:'));
  assert.ok(!gh.text('turnos.ics').includes('F52'));
});

test('mergeStates: avisos y lugares por fecha de cambio; calendarUpdatedAt nunca retrocede', () => {
  const local = updateSettings(createDefaultState(), { reminders: { minutesBefore: 30 } }, { now: at(2 * DAY) });
  const older = updateSettings(createDefaultState(), { reminders: { minutesBefore: 90 }, sync: { publishPlaces: true } }, { now: at(DAY) });
  const m1 = mergeStates(local, older, { now: T0 }).state;
  assert.equal(m1.settings.reminders.minutesBefore, 30); // lo local es más nuevo
  assert.equal(m1.settings.sync.publishPlaces, true); // lugares: el remoto los cambió y aquí nunca
  assert.equal(m1.settings.calendarUpdatedAt, at(2 * DAY).toISOString());
  const newer = updateSettings(createDefaultState(), { reminders: { minutesBefore: 15 } }, { now: at(3 * DAY) });
  const m2 = mergeStates(local, newer, { now: T0 });
  assert.equal(m2.changed, true);
  assert.equal(m2.state.settings.reminders.minutesBefore, 15);
  assert.equal(m2.state.settings.remindersUpdatedAt, at(3 * DAY).toISOString());
  assert.equal(m2.state.settings.calendarUpdatedAt, at(3 * DAY).toISOString());
  // Un enlace con p:true en un dispositivo atrasado no hace ganar sus avisos viejos
  const stale = updateSettings(older, { sync: syncConfigPatch({ ...SYNC, publishPlaces: true }) }, { now: at(4 * DAY) });
  assert.equal(mergeStates(newer, stale, { now: T0 }).state.settings.reminders.minutesBefore, 15);
  // El nombre sigue siendo del dispositivo (salvo dispositivo vacío)
  assert.equal(mergeStates(local, updateSettings(newer, { name: 'Otro' }), { now: T0 }).state.settings.name, 'Mauricio');
  // La copia compartida lleva publishPlaces fuera de sync, y se lee bien
  const payload = syncPayload(older);
  assert.equal(payload.settings.publishPlaces, true);
  assert.equal(payload.settings.sync, undefined);
});

// ---------- Calendario: siempre se compara con el publicado ----------

test('calendario: el que publica compara turnos.ics con lo publicado y lo repara aunque sus datos no cambien', async () => {
  const gh = fakeGitHub();
  let A = device('app', { '2026-10-20': ['F1'] });
  ({ state: A } = await sync(A, gh, T0));
  const good = gh.text('turnos.ics');
  // Otra pestaña del mismo teléfono (mismo editor) congelada antes de escribir el calendario viejo
  gh.write('turnos.ics', good.replace('2026-10-20-F1', '2026-10-20-XX'));
  const r = await syncNow(A, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(r.pushed, false);
  assert.equal(r.icsPushed, true);
  assert.equal(gh.text('turnos.ics'), good);
  // Sin diferencias: solo lee
  const n = gh.fetch.calls.length;
  assert.equal((await syncNow(A, { fetchImpl: gh.fetch, now: at(DAY) })).icsPushed, false);
  assert.equal(gh.fetch.calls.slice(n).filter((c) => c.method !== 'GET').length, 0);
});

// ---------- Importar en un teléfono nuevo ----------

test('importar una copia vieja en un teléfono sin conectar y conectarlo no pisa cambios posteriores', async () => {
  const gh = fakeGitHub();
  let A = device('viejo', { '2026-11-03': ['F1'], '2026-11-04': ['F1'] });
  ({ state: A } = await sync(A, gh, at(1)));
  const fichero = exportBackup(A, { now: at(2) }); // copia en iCloud Drive
  // Semanas después cambia el plan: 3 y 4 de noviembre pasan a S1
  A = setDay(A, '2026-11-03', ['S1'], { now: at(20 * DAY) });
  A = setDay(A, '2026-11-04', ['S1'], { now: at(20 * DAY) });
  ({ state: A } = await sync(A, gh, at(20 * DAY)));
  // Teléfono nuevo: importa la copia (conserva las fechas del archivo) y abre el enlace
  let N = importBackup(createDefaultState(), fichero, { now: at(25 * DAY) });
  assert.equal(N.days['2026-11-03'].updatedAt, T0.toISOString()); // fecha real, no «ahora»
  assert.deepEqual(N.tombstones, {});
  N = updateSettings(N, { sync: { ...syncConfigPatch(SYNC), deviceId: 'nuevo' } });
  const p = await pullOnly(N, { fetchImpl: gh.fetch, now: at(25 * DAY) });
  assert.equal(p.readOnly, true);
  N = applySyncResult(N, p, { now: at(25 * DAY) });
  ({ state: N } = await takeover(N, gh, at(25 * DAY + 1)));
  ({ state: A } = await sync(A, gh, at(26 * DAY)));
  assert.deepEqual(N.days['2026-11-03'].codes, ['S1']);
  assert.deepEqual(A.days['2026-11-03'].codes, ['S1']);
  assert.ok(gh.text('turnos.ics').includes('UID:2026-11-03-S1@'));
  assert.ok(!gh.text('turnos.ics').includes('UID:2026-11-03-F1@'));
});

// ---------- Códigos ----------

test('upsertCode sin cambios reales devuelve el mismo estado (una copia vieja no gana después)', async () => {
  const gh = fakeGitHub();
  let I = device('app', { '2026-10-20': ['F1'] });
  ({ state: I } = await sync(I, gh, at(1)));
  let S = device('safari');
  ({ state: S } = await sync(S, gh, at(2)));
  // En la app: F1 pasa a 07:00–16:00
  I = upsertCode(I, { code: 'F1', start: '07:00', end: '16:00' }, { now: at(DAY) });
  ({ state: I } = await sync(I, gh, at(DAY)));
  // En Safari (sin conexión) se abre F1 y se pulsa Guardar sin cambiar nada
  const shown = S.codes.F1;
  const same = upsertCode(S, { ...shown, confirmed: true }, { now: at(DAY + 20) });
  assert.equal(same, S);
  assert.equal(upsertCode(S, { code: 'F1', start: '06:00', end: '15:00' }, { now: at(DAY + 20) }), S);
  // Un cambio real sí sella (también confirmar uno supuesto)
  assert.notEqual(upsertCode(S, { code: 'F1', start: '06:30' }, { now: at(DAY + 20) }), S);
  const f6 = upsertCode(S, { code: 'F6', confirmed: true }, { now: at(DAY + 20) });
  assert.equal(f6.codes.F6.updatedAt, at(DAY + 20).toISOString());
  // Safari pasa a publicar más tarde: F1 sigue a las 07:00
  ({ state: S } = await takeover(same, gh, at(DAY + 30)));
  assert.equal(S.codes.F1.start, '07:00');
  assert.match(gh.text('turnos.ics'), /DTSTART;TZID=Europe\/Berlin:20261020T070000/);
});

test('los códigos importados solo guardan los campos conocidos (nada de claves extra enormes)', () => {
  const file = JSON.stringify({
    app: 'turnos-mauricio', schema: 1, days: { '2026-10-14': { codes: ['F1'] } },
    codes: { F1: { code: 'F1', kind: 'shift', start: '06:00', end: '15:00', junk: 'x'.repeat(300000), onclick: 'alert(1)' } },
  });
  const s = importBackup(createDefaultState(), file, { now: T0 });
  assert.equal(s.codes.F1.junk, undefined);
  assert.equal(s.codes.F1.onclick, undefined);
  assert.equal(s.codes.F1.start, '06:00');
  assert.ok(exportBackup(s).length < 20000);
  assert.ok(JSON.stringify(syncPayload(s)).length < 20000);
});

test('SEQUENCE nunca retrocede: borrar un código usado y importar avisos distintos', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  let s = setDay(createDefaultState(), '2026-10-20', ['F4'], { now: new Date('2026-10-01T10:00:00Z') });
  s = upsertCode(s, { code: 'F4', start: '07:00', end: '16:00' }, { now: new Date('2026-10-05T10:00:00Z') });
  const uid = '2026-10-20-F4';
  const before = seqOf(buildICS(s, { now }), uid);
  const deleted = deleteCode(s, 'F4', { now: new Date('2026-10-10T10:00:00Z') });
  const ics = buildICS(deleted, { now });
  assert.match(event(ics, uid), /DTSTART;TZID=Europe\/Berlin:20261020T060000/); // vuelve al supuesto
  assert.ok(seqOf(ics, uid) > before);
  assert.match(event(ics, uid), /DTSTAMP:20261010T100000Z/);
  // Importar una copia con otros avisos: el calendario lo nota (sello nuevo)
  const local = updateSettings(s, { reminders: { minutesBefore: 30 } }, { now: new Date('2026-10-12T10:00:00Z') });
  const file = exportBackup(s, { now: new Date('2026-10-06T00:00:00Z') });
  const imp = importBackup(local, file, { now });
  assert.equal(imp.settings.reminders.minutesBefore, 60);
  assert.equal(imp.settings.calendarUpdatedAt, now.toISOString());
  assert.ok(seqOf(buildICS(imp, { now }), uid) > seqOf(buildICS(local, { now }), uid));
  // Misma configuración de avisos: el sello del teléfono se conserva
  const same = importBackup(local, exportBackup(local), { now });
  assert.equal(same.settings.calendarUpdatedAt, local.settings.calendarUpdatedAt);
});

// ---------- La clave y la copia remota ----------

test('copia borrada y vuelta a crear con otra clave: un dispositivo con la misma rev no publica (DECRYPT)', async () => {
  const gh = fakeGitHub();
  let I = device('app', { '2026-10-12': ['F1'] });
  ({ state: I } = await sync(I, gh, at(1)));
  let S = device('safari');
  ({ state: S } = await sync(S, gh, at(2)));
  for (let i = 0; i < 2; i++) {
    I = setDay(I, `2026-10-1${3 + i}`, ['S1'], { now: at(10 + i) });
    ({ state: I } = await sync(I, gh, at(10 + i)));
  }
  ({ state: S } = await sync(S, gh, at(20)));
  assert.equal(S.settings.sync.baseRev, 3);
  // Clave nueva (K2) para la app: se borra backup.json y la app publica rev 1..3 con K2
  I = updateSettings(I, { sync: { ...syncConfigPatch({ ...SYNC, key: OTHER_KEY }), deviceId: 'app' } });
  gh.remove('backup.json');
  ({ state: I } = await sync(I, gh, at(41)));
  I = setDay(I, '2026-10-22', ['N1'], { now: at(42) });
  ({ state: I } = await sync(I, gh, at(42)));
  I = setDay(I, '2026-10-20', ['S1'], { now: at(43) });
  ({ state: I } = await sync(I, gh, at(43)));
  assert.equal(doc(gh).meta.rev, 3); // la misma rev que S tenía
  const before = { backup: gh.text('backup.json'), ics: gh.text('turnos.ics') };
  // Safari (K1, baseRev 3) con un cambio sin conexión: siempre descifra → DECRYPT, no escribe
  S = setDay(S, '2026-10-25', ['-'], { now: at(44) });
  const n = gh.fetch.calls.length;
  for (const r of [await syncNow(S, { fetchImpl: gh.fetch, now: at(45) }), await becomePublisher(S, { fetchImpl: gh.fetch, now: at(45) })]) {
    assert.equal(r.error?.code, 'DECRYPT');
  }
  assert.equal(gh.fetch.calls.slice(n).filter((c) => c.method !== 'GET').length, 0);
  assert.deepEqual({ backup: gh.text('backup.json'), ics: gh.text('turnos.ics') }, before);
  assert.deepEqual((await decryptBackup(doc(gh), OTHER_KEY)).days['2026-10-20'].codes, ['S1']);
});

test('con la misma rev pero sin días en local (sin tombstones): restaura en vez de EMPTY_LOCAL', async () => {
  const gh = fakeGitHub();
  let A = device('app', { '2026-10-12': ['F1'], '2026-10-13': ['S1'] });
  ({ state: A } = await sync(A, gh, T0));
  const lost = { ...A, days: {}, tombstones: {} }; // datos perdidos, ajustes intactos (baseRev 1)
  const r = await syncNow(lost, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.pulled, true);
  assert.equal(r.pushed, false);
  assert.deepEqual(Object.keys(r.state.days).sort(), ['2026-10-12', '2026-10-13']);
});

test('pushData (obsoleto) sin clave no escribe nada (la copia quedaría ilegible)', async () => {
  const gh = fakeGitHub();
  const s = device('', { '2026-10-20': ['F1'] }, { key: '' });
  await assert.rejects(pushData(s, { fetchImpl: gh.fetch, now: T0 }), (e) => e instanceof SyncError && e.code === 'NO_KEY');
  assert.equal(gh.fetch.calls.length, 0);
  assert.equal(gh.text('backup.json'), null);
});

// ---------- Deshacer una importación ----------

test('deshacer cuando la copia de seguridad de ESA importación falló: no restaura una más vieja', () => {
  const st = memoryStorage();
  const store = createStore(st, { target: null });
  store.set((s) => updateSettings(setDay(s, '2026-09-01', ['F1'], { now: T0 }), { sync: { enabled: true, lastPullAt: T0.toISOString() } }));
  // 1ª importación con copia C1
  const fileSept = exportBackup(store.get(), { now: T0 });
  const c1 = saveBeforeImport(store.get(), st, { now: at(1) });
  assert.ok(c1);
  store.set((s) => importBackup(s, fileSept, { now: at(1) }));
  // Un mes de turnos nuevos
  for (let d = 1; d <= 20; d++) store.set((s) => setDay(s, `2026-10-${String(d).padStart(2, '0')}`, ['S1'], { now: at(30 * DAY + d) }));
  // 2ª importación: la copia falla (almacenamiento lleno)
  const realSet = st.setItem;
  st.setItem = (k, v) => { if (k.startsWith(BEFORE_IMPORT_PREFIX)) throw new DOMException('lleno', 'QuotaExceededError'); return realSet(k, v); };
  const c2 = saveBeforeImport(store.get(), st, { now: at(31 * DAY) });
  st.setItem = realSet;
  assert.equal(c2, null);
  store.set((s) => importBackup(s, exportBackup(s), { now: at(31 * DAY) }));
  // «Deshacer» con la clave de esta importación (null): nada
  assert.equal(undoImport(st, store.get(), { now: at(31 * DAY + 5), key: c2 }), null);
  assert.equal(Object.keys(store.get().days).filter((k) => k.startsWith('2026-10')).length, 20);
});

// ---------- Datos de una versión más nueva ----------

test('versión más nueva: se conservan tipos desconocidos, la copia intacta se renueva y no se exporta', () => {
  const raw = {
    schema: 2, futureTop: { a: 1 },
    settings: { name: 'M', reminders: { eveningBefore: true, eveningTime: '20:00', beforeStart: true, minutesBefore: 60, sound: 'bell' } },
    codes: { F1: { code: 'F1', kind: 'training', name: 'X', start: '06:00', end: '15:00', newProp: 7 } },
    days: { '2026-10-14': { codes: ['F1'], note: 'n', source: 'manual', updatedAt: '2026-10-01T00:00:00Z', mood: 'good' } },
  };
  const st = memoryStorage({ [STORAGE_KEY]: JSON.stringify(raw) });
  const store = createStore(st, { target: null });
  assert.equal(store.get().__newerSchema, true);
  assert.equal(st.getItem(NEWER_SCHEMA_KEY), JSON.stringify(raw));
  store.set((d) => { d.settings.name = 'Mauricio'; });
  const saved = JSON.parse(st.getItem(STORAGE_KEY));
  assert.equal(saved.codes.F1.kind, 'training'); // no se convierte en 'shift'
  assert.equal(saved.codes.F1.newProp, 7);
  assert.equal(saved.days['2026-10-14'].mood, 'good');
  // Lo que esta versión reescribió no sustituye a la copia intacta
  loadState(st);
  assert.equal(st.getItem(NEWER_SCHEMA_KEY), JSON.stringify(raw));
  // La versión nueva vuelve a guardar algo distinto: la copia intacta se renueva
  const raw2 = JSON.stringify({ ...raw, futureTop: { a: 2 } });
  st.setItem(STORAGE_KEY, raw2);
  loadState(st);
  assert.equal(st.getItem(NEWER_SCHEMA_KEY), raw2);
  // Exportar una copia recortaría los datos nuevos
  assert.throws(() => exportBackup(store.get()), (e) => e.code === 'NEWER' && /Actualiza la app/.test(e.message));
});

// ---------- Ajustes: null borra los campos que por defecto son null ----------

test('updateSettings/applySyncResult: un error se borra al ir bien (null borra campos anulables)', async () => {
  let s = updateSettings(createDefaultState(), { sync: { lastError: 'x', lastErrorCode: 'NETWORK', lastPushAt: T0.toISOString(), publisher: 'a' } });
  s = updateSettings(s, { sync: { lastError: null, lastErrorCode: null, lastPushAt: null, publisher: null, token: null }, name: null });
  assert.equal(s.settings.sync.lastError, null);
  assert.equal(s.settings.sync.lastErrorCode, null);
  assert.equal(s.settings.sync.lastPushAt, null);
  assert.equal(s.settings.sync.publisher, null);
  assert.equal(s.settings.sync.token, ''); // los que no son anulables no cambian con null
  assert.equal(s.settings.name, 'Mauricio');
  // De punta a punta: falla sin red, después va bien → sin error guardado
  const gh = fakeGitHub();
  let A = device('app', { '2026-10-12': ['F1'] });
  const offline = await syncNow(A, { fetchImpl: async () => { throw new TypeError('Load failed'); }, now: T0 });
  A = applySyncResult(A, offline, { now: T0 });
  assert.equal(A.settings.sync.lastErrorCode, 'NETWORK');
  assert.equal(A.settings.sync.lastErrorSince, T0.toISOString());
  // Sigue fallando: lastErrorSince se mantiene
  const again = await syncNow(A, { fetchImpl: async () => { throw new TypeError('Load failed'); }, now: at(DAY) });
  A = applySyncResult(A, again, { now: at(DAY) });
  assert.equal(A.settings.sync.lastErrorSince, T0.toISOString());
  ({ state: A } = await sync(A, gh, at(2 * DAY)));
  assert.equal(A.settings.sync.lastError, null);
  assert.equal(A.settings.sync.lastErrorCode, null);
  assert.equal(A.settings.sync.lastErrorSince, null);
  // Un enlace nuevo reinicia la contabilidad (también quién publica)
  const reset = updateSettings(A, { sync: syncConfigPatch(SYNC) });
  assert.equal(reset.settings.sync.lastPushAt, null);
  assert.equal(reset.settings.sync.baseRev, 0);
  assert.equal(reset.settings.sync.publisher, null);
});

test('importar no hace retroceder un borrado: se queda la tombstone más reciente', () => {
  // B borró el 12 a las 08:55; el archivo de C trae un borrado más viejo (08:43)
  const late = new Date('2026-10-01T08:55:00.000Z'), early = new Date('2026-10-01T08:43:00.000Z');
  let b = updateSettings(stateWith({ '2026-10-12': ['S1'], '2026-10-15': ['F1'] }), { sync: { enabled: true, lastPullAt: T0.toISOString() } });
  b = { ...b, tombstones: {} };
  let c = setDay(stateWith({ '2026-10-12': ['F1'] }), '2026-10-15', ['F1']);
  c = { ...c, days: { '2026-10-15': c.days['2026-10-15'] }, tombstones: { '2026-10-12': early.toISOString() } };
  const deleted = { ...b, days: { '2026-10-15': b.days['2026-10-15'] }, tombstones: { '2026-10-12': late.toISOString() } };
  const r = importBackup(deleted, exportBackup(c), { now: new Date('2026-10-01T09:00:00.000Z') });
  assert.equal(r.tombstones['2026-10-12'], late.toISOString());
  // Y al revés: un borrado más nuevo en el archivo sí gana
  const r2 = importBackup({ ...deleted, tombstones: { '2026-10-12': early.toISOString() } }, exportBackup({ ...c, tombstones: { '2026-10-12': late.toISOString() } }), { now: new Date('2026-10-01T09:00:00.000Z') });
  assert.equal(r2.tombstones['2026-10-12'], late.toISOString());
  // Lo mismo con los códigos borrados
  const withCode = { ...deleted, codeTombstones: { K: late.toISOString() } };
  const r3 = importBackup(withCode, exportBackup({ ...c, codeTombstones: { K: early.toISOString() } }), { now: new Date('2026-10-01T09:00:00.000Z') });
  assert.equal(r3.codeTombstones.K, late.toISOString());
});
