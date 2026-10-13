// Un solo dispositivo publica en GitHub (backup.json y turnos.ics); los demás solo leen y fusionan.
import { stateWith, fakeGitHub, memoryStorage, REAL_WEEK, T0, KEY, OTHER_KEY, SYNC } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncNow, pullOnly, becomePublisher, applySyncResult, isReadOnlyDevice, decryptBackup, encryptBackup, syncConfigPatch,
} from '../../docs/js/core/sync.js';
import { encryptText } from '../../docs/js/core/cipher.js';
import { createStore, setDay, updateSettings, upsertCode, syncPayload } from '../../docs/js/core/store.js';

const DAY = 24 * 3600 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);
const device = (id, days = {}, sync = {}) => updateSettings(stateWith(days), { sync: { ...SYNC, deviceId: id, ...sync } });
const run = (s, gh, now, extra = {}) => syncNow(s, { fetchImpl: gh.fetch, now, ...extra });
async function sync(s, gh, now, extra) {
  const res = await run(s, gh, now, extra);
  return { res, state: applySyncResult(s, res, { now }) };
}
async function takeover(s, gh, now) {
  const res = await becomePublisher(s, { fetchImpl: gh.fetch, now });
  return { res, state: applySyncResult(s, res, { now }) };
}
const doc = (gh) => JSON.parse(gh.text('backup.json'));
const remote = async (gh, key = KEY) => decryptBackup(doc(gh), key);
const snapshot = (gh) => ({ backup: gh.text('backup.json'), ics: gh.text('turnos.ics') });
const writesSince = (gh, n) => gh.fetch.calls.slice(n).filter((c) => c.method !== 'GET');

test('el primero que sincroniza publica; los demás solo leen (nunca escriben, ni con cambios más nuevos ni con force)', async () => {
  const gh = fakeGitHub();
  let { res, state: app } = await sync(device('app', { '2026-10-12': ['F1'] }), gh, T0);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.readOnly, false);
  assert.deepEqual(res.publisher, { deviceId: 'app', since: T0.toISOString() });
  assert.equal(doc(gh).meta.publisher, 'app');
  assert.equal(app.settings.sync.publisher, 'app');
  assert.equal(isReadOnlyDevice(app.settings.sync), false);

  // Otro dispositivo con cambios propios más nuevos
  let other = device('safari', { '2026-10-12': ['S1'] });
  other = setDay(other, '2026-10-12', ['S1'], { now: at(DAY) });
  other = setDay(other, '2026-10-13', ['N1'], { now: at(DAY) });
  const before = snapshot(gh);
  const n = gh.fetch.calls.length;
  for (const extra of [{}, { force: true }, { force: true, allowEmpty: true }]) {
    const r = await run(other, gh, at(2 * DAY), extra);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.readOnly, true);
    assert.deepEqual(r.publisher, { deviceId: 'app', since: T0.toISOString() });
    assert.equal(r.pushed, false);
    assert.equal(r.icsPushed, false);
    assert.equal(r.pulled, true);
    assert.deepEqual(r.unpublishedDays, ['2026-10-12', '2026-10-13']);
    assert.equal(r.sync.publisher, 'app');
    assert.equal(r.sync.unpublished, 2);
    assert.equal(r.sync.lastPushAt, undefined);
  }
  assert.deepEqual(writesSince(gh, n), []); // ni PUT ni POST
  assert.deepEqual(snapshot(gh), before);
  // Lo aplicado: fusiona en local (lo suyo, más nuevo, se queda) y sabe que solo lee
  ({ state: other } = await sync(other, gh, at(2 * DAY)));
  assert.deepEqual(other.days['2026-10-12'].codes, ['S1']);
  assert.equal(isReadOnlyDevice(other.settings.sync), true);
  // El que publica sigue igual (no ve los cambios de quien solo lee)
  ({ res } = await sync(app, gh, at(3 * DAY)));
  assert.equal(res.readOnly, false);
  assert.equal(res.pushed, false);
  assert.deepEqual((await remote(gh)).days['2026-10-12'].codes, ['F1']);
});

test('becomePublisher: primero lee y fusiona, después publica (rev+1) con publisher = este dispositivo', async () => {
  const gh = fakeGitHub();
  let { state: app } = await sync(device('app', { '2026-10-12': ['F1'], '2026-10-13': ['S1'] }), gh, T0);
  app = setDay(app, '2026-10-14', ['N1'], { now: at(DAY) });
  ({ state: app } = await sync(app, gh, at(DAY))); // rev 2
  // Teléfono nuevo con un día propio
  const phone = setDay(device('nuevo'), '2026-10-20', ['Z1'], { now: at(2 * DAY) });
  const r = await becomePublisher(phone, { fetchImpl: gh.fetch, now: at(2 * DAY) });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.pulled, true);
  assert.equal(r.pushed, true);
  assert.equal(r.tookOver, true);
  assert.equal(r.readOnly, false);
  assert.equal(r.rev, 3);
  assert.deepEqual(r.publisher, { deviceId: 'nuevo', since: at(2 * DAY).toISOString() });
  assert.deepEqual(doc(gh).meta, {
    rev: 3, savedAt: at(2 * DAY).toISOString(), deviceId: 'nuevo', days: 4, publisher: 'nuevo', publisherSince: at(2 * DAY).toISOString(),
  });
  // Lo del otro (12–14) y lo suyo (20), en la copia y en el calendario
  assert.deepEqual(Object.keys((await remote(gh)).days).sort(), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-20']);
  const ics = gh.text('turnos.ics');
  for (const uid of ['2026-10-12-F1', '2026-10-13-S1', '2026-10-14-N1', '2026-10-20-Z1']) assert.ok(ics.includes(`UID:${uid}@`), uid);
  // El anterior pasa a solo leer: sus cambios ya no se publican (ni con force)
  app = setDay(app, '2026-10-12', ['-'], { now: at(3 * DAY) });
  const before = snapshot(gh);
  const n = gh.fetch.calls.length;
  const ra = await run(app, gh, at(3 * DAY), { force: true });
  assert.equal(ra.readOnly, true);
  assert.equal(ra.publisher.deviceId, 'nuevo');
  assert.deepEqual(ra.unpublishedDays, ['2026-10-12']);
  assert.deepEqual(writesSince(gh, n), []);
  assert.deepEqual(snapshot(gh), before);
  assert.ok(ra.state.days['2026-10-20']); // pero recibe lo del nuevo
  // Volver a pedir publicar en el que ya publica: sincronización normal (sin rev nueva si no hay cambios)
  const again = await becomePublisher(applySyncResult(phone, r, { now: at(2 * DAY) }), { fetchImpl: gh.fetch, now: at(4 * DAY) });
  assert.equal(again.ok, true);
  assert.equal(again.tookOver, false);
  assert.equal(again.pushed, false);
  assert.equal(again.rev, 3);
});

test('relevo sin cambios de datos: igualmente publica rev+1 para dejar constancia del nuevo editor', async () => {
  const gh = fakeGitHub();
  await sync(device('a', REAL_WEEK), gh, T0);
  const { state: b } = await sync(device('b'), gh, at(DAY)); // restaura (solo lee)
  const r = await becomePublisher(b, { fetchImpl: gh.fetch, now: at(2 * DAY) });
  assert.equal(r.pushed, true);
  assert.equal(r.rev, 2);
  assert.equal(doc(gh).meta.publisher, 'b');
  assert.equal(r.icsPushed, false); // mismo calendario
});

test('Safari viejo: una pestaña abierta semanas después no puede cambiar el calendario', async () => {
  const gh = fakeGitHub();
  // Mauricio usó primero Safari (S): fue el primero en sincronizar → publicaba
  let S = device('safari', { '2026-10-12': ['F1'], '2026-10-13': ['S1'] });
  ({ state: S } = await sync(S, gh, T0));
  assert.equal(doc(gh).meta.publisher, 'safari');
  // Instala la app (I) y abre el enlace: lee, la UI pregunta y confirma «Usar este dispositivo»
  let I = updateSettings(stateWith({}), { sync: syncConfigPatch(SYNC) });
  I = updateSettings(I, { sync: { deviceId: 'app' } });
  const p = await pullOnly(I, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(p.readOnly, true);
  I = applySyncResult(I, p, { now: at(DAY) });
  ({ state: I } = await takeover(I, gh, at(DAY)));
  assert.equal(doc(gh).meta.publisher, 'app');
  // En la app: el plan cambia y los avisos también
  I = updateSettings(I, { reminders: { eveningBefore: false, minutesBefore: 120 } }, { now: at(5 * DAY) });
  I = setDay(I, '2026-10-12', ['S1'], { now: at(5 * DAY) });
  I = setDay(I, '2026-10-20', ['N1'], { now: at(5 * DAY) });
  ({ state: I } = await sync(I, gh, at(5 * DAY)));
  const good = snapshot(gh);
  assert.ok(good.ics.includes('TRIGGER:-PT2H'));
  // Semanas después se abre la pestaña de Safari: datos viejos, avisos viejos y un cambio sin conexión
  S = setDay(S, '2026-10-13', ['-'], { now: at(30 * DAY) });
  const n = gh.fetch.calls.length;
  for (const extra of [{}, { force: true }, { force: true, allowEmpty: true }]) {
    const r = await run(S, gh, at(30 * DAY), extra);
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.readOnly, true);
    assert.equal(r.publisher.deviceId, 'app');
  }
  assert.deepEqual(writesSince(gh, n), []);
  assert.deepEqual(snapshot(gh), good);
  // Safari se pone al día (datos y avisos de la app); su cambio queda solo en Safari
  const { res, state: S2 } = await sync(S, gh, at(30 * DAY));
  assert.deepEqual(S2.days['2026-10-12'].codes, ['S1']);
  assert.ok(S2.days['2026-10-20']);
  assert.equal(S2.settings.reminders.minutesBefore, 120);
  assert.equal(S2.settings.reminders.eveningBefore, false);
  assert.deepEqual(res.unpublishedDays, ['2026-10-13']);
  assert.deepEqual(res.unpublishedCodes, []); // sin falsos positivos
  assert.equal(res.unpublishedSettings, false); // adoptó los avisos de la app
  assert.equal(S2.settings.sync.unpublished, 1);
  assert.equal(isReadOnlyDevice(S2.settings.sync), true);
});

test('solo lectura: también cuentan como no publicados los horarios de códigos y los avisos cambiados aquí', async () => {
  const gh = fakeGitHub();
  await sync(device('app', REAL_WEEK), gh, T0);
  let { state: ro } = await sync(device('safari'), gh, at(1));
  assert.equal(ro.settings.sync.unpublished, 0);
  ro = upsertCode(ro, { code: 'F1', start: '07:00', end: '16:00' }, { now: at(DAY) });
  ro = updateSettings(ro, { reminders: { minutesBefore: 15 } }, { now: at(DAY) });
  const n = gh.fetch.calls.length;
  const r = await run(ro, gh, at(2 * DAY));
  assert.equal(r.readOnly, true);
  assert.deepEqual(r.unpublishedDays, []);
  assert.deepEqual(r.unpublishedCodes, ['F1']);
  assert.equal(r.unpublishedSettings, true);
  assert.equal(r.sync.unpublished, 2);
  assert.deepEqual(writesSince(gh, n), []);
  assert.ok(!gh.text('turnos.ics').includes('TRIGGER:-PT15M'));
});

test('Safari congelado a mitad de publicar: si la app pasa a publicar, Safari ya no pisa su calendario', async () => {
  const gh = fakeGitHub();
  let S = device('safari', { '2026-10-20': ['F1'] });
  ({ state: S } = await sync(S, gh, T0));
  // Safari (todavía el que publica) cambia el 21 y empieza a sincronizar; iOS la congela justo antes
  // de escribir turnos.ics
  S = setDay(S, '2026-10-21', ['N1'], { now: at(10) });
  let release;
  const frozen = new Promise((r) => { release = r; });
  const freezing = async (url, init) => {
    if (init?.method === 'PUT' && url.endsWith('turnos.ics')) await frozen;
    return gh.fetch(url, init);
  };
  const pending = syncNow(S, { fetchImpl: freezing, now: at(11) });
  await new Promise((r) => setTimeout(r, 20));
  // Mientras, la app pasa a publicar y cambia el 20 de F1 a S1
  let I = device('app');
  ({ state: I } = await takeover(I, gh, at(20)));
  I = setDay(I, '2026-10-20', ['S1'], { now: at(30) });
  ({ state: I } = await sync(I, gh, at(30)));
  assert.ok(gh.text('turnos.ics').includes('UID:2026-10-20-S1@'));
  // Safari se reanuda: backup.json ya no es el que escribió → no escribe su calendario viejo (F1 el 20)
  release();
  const late = await pending;
  assert.equal(late.error?.code, 'CONFLICT');
  assert.equal(late.error.retry, true);
  assert.ok(!gh.text('turnos.ics').includes('UID:2026-10-20-F1@'));
  // La próxima sincronización de la app (sin cambios) no tiene nada que reparar
  const r = await run(I, gh, at(2 * DAY));
  assert.equal(r.ok, true);
  assert.equal(r.pushed, false);
  assert.equal(r.icsPushed, false);
  const ics = gh.text('turnos.ics');
  assert.ok(ics.includes('UID:2026-10-20-S1@') && !ics.includes('UID:2026-10-20-F1@'));
  assert.ok(ics.includes('UID:2026-10-21-N1@')); // lo de Safari llegó con la fusión
  // Y Safari ya solo lee
  const n = gh.fetch.calls.length;
  assert.equal((await run(S, gh, at(3 * DAY), { force: true })).readOnly, true);
  assert.deepEqual(writesSince(gh, n), []);
});

test('relevo a mitad de una publicación del anterior: su escritura choca (sha) y pasa a solo leer', async () => {
  const gh = fakeGitHub();
  let { state: A } = await sync(device('a', { '2026-10-12': ['F1'] }), gh, T0);
  const { state: B0 } = await sync(device('b', { '2026-10-14': ['N1'] }), gh, at(1));
  const B = setDay(B0, '2026-10-14', ['N1'], { now: at(2) });
  // A lee y, justo antes de su PUT, B pasa a publicar
  let done = false;
  gh.beforePut = async (path) => {
    if (path === 'backup.json' && !done) {
      done = true;
      gh.beforePut = null;
      const t = await becomePublisher(B, { fetchImpl: gh.fetch, now: at(3) });
      assert.equal(t.pushed, true);
    }
  };
  A = setDay(A, '2026-10-13', ['S1'], { now: at(3) });
  const n = gh.fetch.calls.length;
  const r = await run(A, gh, at(4));
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.readOnly, true);
  assert.equal(r.pushed, false);
  assert.equal(doc(gh).meta.publisher, 'b');
  // Solo el intento de A (rechazado) y lo de B; nada más de A después
  const aPuts = gh.fetch.calls.slice(n).filter((c) => c.method === 'PUT' && JSON.parse(c.body).message.includes('rev'));
  assert.equal(aPuts.length, 2); // A (rechazado) + B
  assert.deepEqual(Object.keys((await remote(gh)).days).sort(), ['2026-10-12', '2026-10-14']);
  assert.deepEqual(r.unpublishedDays, ['2026-10-13']);
});

test('copia v2 (sin publisher): publica quien la escribió; al publicar se pasa a v3', async () => {
  const gh = fakeGitHub();
  // backup.json v2 escrito por 'viejo' (como lo dejaba la versión anterior)
  const payload = syncPayload(stateWith({ '2026-10-12': ['F1'] }));
  const meta = { rev: 4, savedAt: T0.toISOString(), deviceId: 'viejo', days: 1 };
  const v2 = { format: 'turnos-backup', v: 2, meta };
  v2.enc = await encryptText(JSON.stringify(payload), KEY, `turnos-backup|2|4|viejo|1|${meta.savedAt}`);
  gh.write('backup.json', JSON.stringify(v2));
  // Otro dispositivo: solo lee
  const other = await run(device('otro', { '2026-10-13': ['S1'] }), gh, at(DAY));
  assert.equal(other.ok, true, JSON.stringify(other.error));
  assert.equal(other.readOnly, true);
  assert.equal(other.publisher.deviceId, 'viejo');
  assert.equal(doc(gh).v, 2);
  // El mismo dispositivo: publica y migra a v3 (aunque no haya cambios)
  const same = await run(device('viejo', { '2026-10-12': ['F1'] }), gh, at(DAY));
  assert.equal(same.ok, true, JSON.stringify(same.error));
  assert.equal(same.pushed, true);
  assert.equal(doc(gh).v, 3);
  assert.equal(doc(gh).meta.rev, 5);
  assert.equal(doc(gh).meta.publisher, 'viejo');
});

test('quién publica va autenticado: cambiarlo a mano en backup.json → no se puede leer ni escribir', async () => {
  const gh = fakeGitHub();
  await sync(device('app', REAL_WEEK), gh, T0);
  const d = doc(gh);
  d.meta.publisher = 'atacante';
  gh.write('backup.json', JSON.stringify(d));
  const n = gh.fetch.calls.length;
  for (const id of ['atacante', 'app']) {
    const r = await run(device(id, { '2026-10-30': ['F1'] }), gh, at(DAY));
    assert.equal(r.error?.code, 'DECRYPT');
  }
  const t = await becomePublisher(device('otro'), { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(t.error?.code, 'DECRYPT');
  assert.deepEqual(writesSince(gh, n), []);
  // Sin publisher en una v3 → copia dañada
  delete d.meta.publisher;
  gh.write('backup.json', JSON.stringify(d));
  assert.equal((await run(device('app'), gh, at(DAY))).error?.code, 'BAD_REMOTE');
});

test('dos pestañas en la primera sincronización (sin clave ni identificador): ninguna escribe; la identidad que se guarda primero publica', async () => {
  for (const order of ['1-primero', '2-primero']) {
    const gh = fakeGitHub();
    const st = memoryStorage();
    const tab1 = createStore(st, { target: null });
    tab1.set((s) => setDay(updateSettings(s, { sync: { ...SYNC, key: '', deviceId: '' } }), '2026-10-12', ['F1'], { now: T0 }));
    const tab2 = createStore(st, { target: null });
    const [r1, r2] = await Promise.all([
      syncNow(tab1.get(), { fetchImpl: gh.fetch, now: at(1000) }),
      syncNow(tab2.get(), { fetchImpl: gh.fetch, now: at(1000) }),
    ]);
    for (const r of [r1, r2]) {
      assert.equal(r.error?.code, 'RETRY');
      assert.equal(r.error.retry, true);
      assert.ok(r.sync.key && r.sync.deviceId);
    }
    assert.notEqual(r1.sync.key, r2.sync.key);
    assert.deepEqual(gh.puts(), []); // nada cifrado con una clave sin guardar
    const [first, second] = order === '1-primero' ? [[tab1, r1], [tab2, r2]] : [[tab2, r2], [tab1, r1]];
    first[0].set((cur) => applySyncResult(cur, first[1], { now: at(1000) }));
    second[0].set((cur) => applySyncResult(cur, second[1], { now: at(1000) })); // relee: ya hay identidad
    const saved = createStore(st, { target: null }).get();
    assert.equal(saved.settings.sync.key, first[1].sync.key, order);
    assert.equal(saved.settings.sync.deviceId, first[1].sync.deviceId);
    assert.equal(saved.settings.sync.lastError, null);
    // Las dos pestañas parten ya de la identidad guardada: la siguiente publica con ella
    const next = await run(saved, gh, at(DAY));
    assert.equal(next.ok, true, JSON.stringify(next.error));
    assert.equal(next.pushed, true);
    assert.equal(doc(gh).meta.publisher, saved.settings.sync.deviceId);
    await decryptBackup(doc(gh), saved.settings.sync.key);
  }
});

test('applySyncResult: el deviceId o la clave de un resultado solo rellenan los que faltan', async () => {
  const gh = fakeGitHub();
  await sync(device('app', { '2026-10-12': ['F1'] }), gh, T0); // otro publica
  const fresh = device('', { '2026-10-12': ['F1'] });
  const r1 = await run(fresh, gh, at(1)); // solo lee: puede crear el id en la misma llamada
  assert.equal(r1.ok, true, JSON.stringify(r1.error));
  assert.equal(r1.readOnly, true);
  const r2 = await run(fresh, gh, at(2)); // otra pestaña con el estado viejo: otro id
  assert.notEqual(r2.sync.deviceId, r1.sync.deviceId);
  for (const [a, b] of [[r1, r2], [r2, r1]]) {
    const s = applySyncResult(applySyncResult(fresh, a, { now: at(3) }), b, { now: at(3) });
    assert.equal(s.settings.sync.deviceId, a.sync.deviceId); // el que se guardó primero
    assert.equal(s.settings.sync.publisher, 'app');
    assert.equal(isReadOnlyDevice(s.settings.sync), true);
  }
  // Una clave de otro resultado tampoco sustituye a la guardada
  const withKey = applySyncResult(device('x'), { ...r1, target: { ...r1.target }, sync: { key: OTHER_KEY } }, { now: at(4) });
  assert.equal(withKey.settings.sync.key, KEY);
});

test('encryptBackup: publisher por defecto = deviceId; los metadatos llevan quién publica y desde cuándo', async () => {
  const d = await encryptBackup(stateWith({ '2026-10-12': ['F1'] }), { rev: 1, now: T0, deviceId: 'x', key: KEY });
  assert.equal(d.v, 3);
  assert.equal(d.meta.publisher, 'x');
  assert.equal(d.meta.publisherSince, T0.toISOString());
  const e = await encryptBackup(stateWith({}), { rev: 2, now: T0, deviceId: 'y', key: KEY, publisher: 'x', publisherSince: '2026-09-01T00:00:00.000Z' });
  assert.equal(e.meta.publisher, 'x');
  assert.equal(e.meta.publisherSince, '2026-09-01T00:00:00.000Z');
});
