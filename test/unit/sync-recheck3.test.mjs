// Cuarta revisión de la sincronización: backup.json borrado y un publisher que no vio la toma de control,
// borrado a propósito de los últimos días, identidad sin guardar (almacenamiento lleno), lugares de un
// enlace sin saltos de SEQUENCE, toma con la respuesta perdida y resultados «viejos» que publicaron.
import { memoryStorage, fakeGitHub, T0, KEY, OTHER_KEY, SYNC } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncNow, becomePublisher, applySyncResult, syncConfigPatch, applySyncConfig, createSyncQueue, parseSetupLink,
  buildSetupLink, decryptBackup, isReadOnlyDevice, UNKNOWN_PUBLISHER,
} from '../../docs/js/core/sync.js';
import { STORAGE_KEY, createStore, loadState, setDay, clearDay, updateSettings, exportBackup, importBackup, upsertCode } from '../../docs/js/core/store.js';

const DAY = 24 * 3600 * 1000;
const FORM = { owner: SYNC.owner, repo: SYNC.repo, branch: '', token: SYNC.token, key: '' };

// Reloj compartido y dispositivos como en app.js (store + cola única)
function world() {
  const gh = fakeGitHub();
  let t = T0.getTime();
  const now = () => new Date(t);
  const adv = (ms) => { t += ms; };
  const dev = (storage = memoryStorage()) => {
    const store = createStore(storage, { target: null, now });
    const d = { storage, store, fetch: (u, i) => gh.fetch(u, i) };
    d.q = createSyncQueue(store, { fetchImpl: (u, i) => d.fetch(u, i), clock: now });
    d.edit = (fn) => store.set((s) => fn(s, now()));
    d.sync = () => store.get().settings.sync;
    return d;
  };
  return { gh, now, adv, dev };
}
const writesSince = (gh, n) => gh.fetch.calls.slice(n).filter((c) => c.method !== 'GET');
const linkOf = (sync) => parseSetupLink(buildSetupLink('https://x/', sync));
const has = (gh, uid) => (gh.text('turnos.ics') || '').includes(`UID:${uid}@`);

// ---------- backup.json borrado: solo quien escribió el turnos.ics publicado lo vuelve a crear ----------

test('backup.json borrado: quien publicó antes y no vio la toma de control no pisa el calendario', async () => {
  const { gh, now, adv, dev } = world();
  const H = dev(), M = dev();
  // Quien ayuda configura su navegador (sin clave) y publica primero
  H.edit((s, at) => setDay(s, '2026-11-02', ['F1'], { now: at }));
  await H.q.setup(FORM);
  assert.equal((await H.q.sync()).pushed, true);
  // El iPhone abre el enlace → solo lee → «Usar este iPhone»
  adv(60e3);
  const link = linkOf(H.sync());
  assert.equal((await M.q.setup(link)).readOnly, true);
  assert.equal((await M.q.becomePublisher()).ok, true);
  adv(DAY);
  M.edit((s, at) => setDay(s, '2026-11-02', ['S1'], { now: at }));
  await M.q.sync();
  const good = gh.text('turnos.ics');
  assert.ok(has(gh, '2026-11-02-S1'));
  // Se borra backup.json (cambio de clave) y el navegador de quien ayuda se abre: solo lee, no escribe
  gh.remove('backup.json');
  adv(60e3);
  const n = gh.fetch.calls.length;
  const r = await H.q.sync();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.readOnly, true);
  assert.equal(r.publisher.deviceId, UNKNOWN_PUBLISHER);
  assert.deepEqual(writesSince(gh, n), []);
  assert.equal(gh.text('turnos.ics'), good);
  assert.equal(isReadOnlyDevice(H.sync()), true);
  // Y sigue así en la siguiente (lo recuerda), hasta «Usar este dispositivo»
  assert.equal((await H.q.sync()).readOnly, true);
  assert.equal(gh.text('backup.json'), null);
  // El que publica de verdad la vuelve a crear, también tras aplicar un enlace con la clave nueva
  adv(60e3);
  const s2 = await M.q.setup({ ...link, key: OTHER_KEY });
  assert.equal(s2.ok, true);
  assert.equal(s2.readOnly, false);
  const rm = await M.q.sync();
  assert.equal(rm.ok, true, JSON.stringify(rm.error));
  assert.equal(rm.pushed, true);
  assert.deepEqual((await decryptBackup(JSON.parse(gh.text('backup.json')), OTHER_KEY)).days['2026-11-02'].codes, ['S1']);
});

test('backup.json borrado: un teléfono nuevo con una copia vieja pregunta antes de publicar', async () => {
  const { gh, adv, dev } = world();
  const A = dev();
  A.edit((s, at) => setDay(s, '2026-11-02', ['F1'], { now: at }));
  const oldFile = exportBackup(A.store.get(), { now: T0 });
  await A.q.setup(FORM);
  await A.q.sync();
  adv(DAY);
  A.edit((s, at) => setDay(s, '2026-11-02', ['S1'], { now: at }));
  await A.q.sync();
  const link = linkOf(A.sync());
  const good = gh.text('turnos.ics');
  gh.remove('backup.json');
  // Teléfono nuevo: importa la copia vieja y abre el enlace sin backup.json
  adv(DAY);
  const N = dev();
  N.edit((s, at) => importBackup(s, oldFile, { now: at }));
  const n = gh.fetch.calls.length;
  const t = await N.q.setup(link);
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.readOnly, true); // la UI pregunta «¿Usar este iPhone?»
  assert.equal((await N.q.sync()).readOnly, true);
  assert.deepEqual(writesSince(gh, n), []);
  assert.equal(gh.text('turnos.ics'), good);
  // El que publicaba (escribió ese turnos.ics) la vuelve a crear sin preguntar
  const r = await A.q.sync();
  assert.equal(r.pushed, true);
  assert.equal(r.readOnly, false);
});

test('syncConfigPatch: con el mismo destino recuerda el último calendario publicado; con otro, lo olvida', () => {
  const s = updateSettings(createStoreState(), { sync: { ...SYNC, lastIcsHash: 'abc', publisher: 'movil1' } });
  assert.equal('lastIcsHash' in syncConfigPatch({ ...SYNC, key: OTHER_KEY }, s), false);
  assert.equal(syncConfigPatch({ ...SYNC, repo: 'otro-repo' }, s).lastIcsHash, null);
  assert.equal(applySyncConfig(s, { ...SYNC, key: OTHER_KEY }).settings.sync.lastIcsHash, 'abc');
});

function createStoreState() {
  return createStore(memoryStorage(), { target: null }).get();
}

// ---------- Borrado a propósito de los últimos días ----------

test('borrar a propósito el último día en el que publica: se publica (no es EMPTY_LOCAL)', async () => {
  const { gh, adv, dev } = world();
  const M = dev();
  M.edit((s, at) => setDay(s, '2026-10-20', ['F1'], { now: at }));
  await M.q.setup({ ...FORM, key: KEY });
  await M.q.sync();
  assert.ok(has(gh, '2026-10-20-F1'));
  adv(DAY);
  M.edit((s, at) => clearDay(s, '2026-10-20', { now: at }));
  const r = await M.q.sync();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.pushed, true);
  assert.equal(has(gh, '2026-10-20-F1'), false);
  assert.equal(M.sync().lastError, null);
});

// ---------- Identidad sin guardar (almacenamiento lleno) ----------

test('cola: si la identidad nueva no se pudo guardar, no publica (ni al reintentar) hasta poder guardarla', async () => {
  const { gh, dev } = world();
  const st = memoryStorage();
  const D = dev(st);
  D.store.set((s) => setDay(updateSettings(s, { sync: { ...SYNC, key: '', deviceId: '' } }), '2026-10-20', ['F1'], { now: T0 }));
  const real = st.setItem;
  st.setItem = (k, v) => { if (k === STORAGE_KEY) throw new DOMException('lleno', 'QuotaExceededError'); return real.call(st, k, v); };
  const r = await D.q.sync();
  assert.equal(r.error?.code, 'RETRY');
  assert.equal(r.pushed, false);
  assert.equal(D.store.saveOk(), false);
  assert.equal(gh.text('backup.json'), null);
  // Reintento (p. ej. la sincronización de fondo un minuto después): ni se conecta
  const n = gh.fetch.calls.length;
  const again = await D.q.sync();
  assert.equal(again.error?.code, 'RETRY');
  assert.equal(again.error.retry, true);
  assert.equal(gh.fetch.calls.length, n);
  assert.equal((await D.q.becomePublisher()).error?.code, 'RETRY');
  assert.equal(gh.fetch.calls.length, n);
  // Leer sí se puede (no escribe nada)
  assert.equal((await D.q.pull()).ok, true);
  assert.deepEqual(writesSince(gh, n), []);
  assert.equal(gh.text('backup.json'), null);
  assert.equal(loadState(st).settings.sync.key, '');
  // Hay espacio otra vez: se guarda la identidad y se publica con ESA clave
  st.setItem = real;
  const ok = await D.q.sync();
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.pushed, true);
  const saved = loadState(st).settings.sync;
  assert.ok(saved.key && saved.deviceId);
  assert.ok(await decryptBackup(JSON.parse(gh.text('backup.json')), saved.key));
});

test('cola: un enlace aplicado sin poder guardarlo tampoco publica con una clave que solo está en memoria', async () => {
  const { gh, dev } = world();
  const st = memoryStorage();
  const D = dev(st);
  D.edit((s, at) => setDay(s, '2026-10-20', ['F1'], { now: at }));
  const real = st.setItem;
  st.setItem = (k, v) => { if (k === STORAGE_KEY) throw new DOMException('lleno', 'QuotaExceededError'); return real.call(st, k, v); };
  const t = await D.q.setup(FORM); // sin clave y sin copia: apply crea la clave
  assert.equal(t.ok, true);
  assert.ok(D.sync().key);
  const r = await D.q.sync();
  assert.equal(r.error?.code, 'RETRY');
  assert.equal(gh.text('backup.json'), null);
  // Otro cambio que sí se guarda deja la identidad a salvo: ya se publica
  st.setItem = real;
  D.edit((s, at) => setDay(s, '2026-10-21', ['S1'], { now: at }));
  const ok = await D.q.sync();
  assert.equal(ok.pushed, true, JSON.stringify(ok.error));
  assert.ok(await decryptBackup(JSON.parse(gh.text('backup.json')), loadState(st).settings.sync.key));
});

// ---------- Lugares de un enlace: sin salto de SEQUENCE ----------

test('los lugares que sugiere un enlace no cambian el sello del calendario (sin saltos de SEQUENCE)', async () => {
  const { gh, adv, dev } = world();
  const M = dev();
  M.edit((s, at) => upsertCode(setDay(s, '2026-10-20', ['F1', 'F51'], { now: at }), { code: 'F51', place: 'Calle Falsa 123' }, { now: at }));
  const link = linkOf({ ...SYNC, publishPlaces: true });
  adv(1);
  await M.q.setup(link);
  await M.q.sync();
  adv(DAY);
  M.edit((s, at) => updateSettings(s, { sync: { publishPlaces: false } }, { now: at }));
  await M.q.sync();
  adv(30 * DAY);
  await M.q.setup(link);
  await M.q.sync();
  const before = gh.text('turnos.ics');
  // Dispositivo nuevo: el enlace sugiere lugares (sin sello) → no toca calendarUpdatedAt
  const N = dev();
  adv(1);
  const t = await N.q.setup(link);
  assert.equal(t.readOnly, true);
  assert.equal(N.store.get().settings.calendarUpdatedAt, M.store.get().settings.calendarUpdatedAt);
  adv(1);
  const take = await N.q.becomePublisher();
  assert.equal(take.ok, true, JSON.stringify(take.error));
  assert.equal(gh.text('turnos.ics'), before); // mismo calendario: sin DTSTAMP/SEQUENCE nuevos
  // Sin enlace, un cambio real de lugares sí sella
  const st = updateSettings(N.store.get(), { sync: { publishPlaces: true } }, { now: new Date('2026-12-01T00:00:00Z') });
  assert.equal(st.settings.calendarUpdatedAt, '2026-12-01T00:00:00.000Z');
  // Un sello explícito en el parche se respeta
  assert.equal(updateSettings(N.store.get(), { reminders: { minutesBefore: 30 }, calendarUpdatedAt: null }).settings.calendarUpdatedAt, null);
});

// ---------- «Usar este dispositivo» con la respuesta perdida ----------

test('toma de control cuya respuesta se pierde: no se presupone quién publica; la siguiente lectura lo dice', async () => {
  const { gh, adv, dev } = world();
  const H = dev(), M = dev();
  H.edit((s, at) => setDay(s, '2026-10-20', ['F1'], { now: at }));
  await H.q.setup({ ...FORM, key: KEY });
  await H.q.sync();
  adv(1);
  assert.equal((await M.q.setup({ ...FORM, key: KEY })).readOnly, true);
  // El PUT de backup.json llega, pero la respuesta se pierde
  let lose = true;
  M.fetch = async (u, i) => {
    const r = await gh.fetch(u, i);
    if (lose && i?.method === 'PUT' && String(u).includes('backup.json')) { lose = false; throw new TypeError('Load failed'); }
    return r;
  };
  adv(1);
  const t = await M.q.becomePublisher();
  assert.equal(t.error?.code, 'NETWORK');
  assert.equal(JSON.parse(gh.text('backup.json')).meta.publisher, M.sync().deviceId); // sí llegó
  assert.equal('publisher' in t.sync, false);
  assert.equal('publisherSince' in t.sync, false);
  // La siguiente sincronización lee la copia: este dispositivo es el que publica
  adv(1);
  const r = await M.q.sync();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.readOnly, false);
  assert.equal(isReadOnlyDevice(M.sync()), false);
  assert.ok(has(gh, '2026-10-20-F1'));
});

// ---------- Resultados «viejos» que publicaron una rev más nueva ----------

test('applySyncResult: un «Usar este dispositivo» que empezó antes que otra lectura no se descarta', async () => {
  const gh = fakeGitHub();
  const at = (ms) => new Date(T0.getTime() + ms);
  const H = updateSettings(setDay(loadState(memoryStorage()), '2026-10-20', ['F1'], { now: T0 }), { sync: { ...SYNC, deviceId: 'helper' } });
  applySyncResult(H, await syncNow(H, { fetchImpl: gh.fetch, now: at(1) }), { now: at(1) });
  let M = updateSettings(loadState(memoryStorage()), { sync: { ...SYNC, deviceId: 'iphone' } });
  M = applySyncResult(M, await syncNow(M, { fetchImpl: gh.fetch, now: at(2) }), { now: at(2) });
  assert.equal(isReadOnlyDevice(M.settings.sync), true);
  // Otra pestaña: una sincronización de fondo que empezó DESPUÉS (t=20) pero leyó la copia anterior…
  const bg = await syncNow(M, { fetchImpl: gh.fetch, now: at(20) });
  assert.equal(bg.readOnly, true);
  // …y otra que empezó entre medias (t=15), también con la copia anterior
  const mid = await syncNow(M, { fetchImpl: gh.fetch, now: at(15) });
  // «Usar este dispositivo» empezó antes (t=10) y publicó la rev 2
  const take = await becomePublisher(M, { fetchImpl: gh.fetch, now: at(10) });
  assert.equal(take.tookOver, true);
  assert.equal(take.rev, 2);
  let cur = applySyncResult(M, bg, { now: at(30) });
  assert.equal(cur.settings.sync.lastSyncStartedAt, at(20).toISOString());
  cur = applySyncResult(cur, take, { now: at(31) });
  assert.equal(cur.settings.sync.publisher, 'iphone');
  assert.equal(cur.settings.sync.baseRev, 2);
  assert.equal(isReadOnlyDevice(cur.settings.sync), false);
  assert.equal(cur.settings.sync.lastSyncStartedAt, at(20).toISOString()); // nunca hacia atrás
  // La lectura vieja de en medio sí se descarta (no deshace la toma)
  cur = applySyncResult(cur, mid, { now: at(32) });
  assert.equal(cur.settings.sync.publisher, 'iphone');
  assert.equal(cur.settings.sync.baseRev, 2);
  // Una toma vieja cuya rev ya está superada (baseRev ≥ rev) sí es vieja
  const later = applySyncResult(cur, { ...take, startedAt: at(5).toISOString(), sync: { ...take.sync, publisher: 'x' } }, { now: at(33) });
  assert.equal(later.settings.sync.publisher, 'iphone');
});
