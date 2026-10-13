// Tercera revisión: backup.json borrado, identidad antes de la red, enlaces con otra clave o con
// lugares, calendario de quien dejó de publicar, orden de códigos, resultados viejos y cola única.
import { stateWith, memoryStorage, fakeGitHub, REAL_WEEK, T0, KEY, OTHER_KEY, SYNC } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncNow, pullOnly, becomePublisher, applySyncResult, syncConfigPatch, applySyncConfig, ensureSyncIdentity,
  trySetupConfig, createSyncQueue, parseSetupLink, buildSetupLink, decryptBackup, isReadOnlyDevice, LINK_PLACES_AT,
  UNKNOWN_PUBLISHER,
} from '../../docs/js/core/sync.js';
import { STORAGE_KEY, createDefaultState, createStore, setDay, updateSettings, upsertCode, mergeStates } from '../../docs/js/core/store.js';
import { isSyncKey } from '../../docs/js/core/cipher.js';
import { getAdvice } from '../../docs/js/core/advice.js';
import { clone } from '../../docs/js/core/util.js';

const DAY = 24 * 3600 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);
const device = (id, days = {}, sync = {}) => updateSettings(stateWith(days), { sync: { ...SYNC, deviceId: id, ...sync } });
async function step(fn, s, gh, now, extra = {}) {
  const res = await fn(s, { fetchImpl: gh.fetch, now, ...extra });
  return { res, state: applySyncResult(s, res, { now }) };
}
const doc = (gh, branch) => JSON.parse(gh.text('backup.json', branch));
const events = (gh) => (gh.text('turnos.ics')?.match(/BEGIN:VEVENT/g) || []).length;
const writesSince = (gh, n) => gh.fetch.calls.slice(n).filter((c) => c.method !== 'GET');
const linkCfg = (sync) => parseSetupLink(buildSetupLink('https://x/', sync));

// ---------- backup.json borrado (n3) ----------

test('backup.json borrado: una copia vacía no vacía el calendario y quien solo leía sigue leyendo', async () => {
  const gh = fakeGitHub();
  const { state: M } = await step(syncNow, device('iphone', { '2026-10-20': ['F1'], '2026-10-21': ['S1'], '2026-10-22': ['N1'] }), gh, at(1));
  const { state: R } = await step(pullOnly, device('lector'), gh, at(2)); // ya vio quién publica
  assert.equal(R.settings.sync.publisher, 'iphone');
  const good = gh.text('turnos.ics');
  assert.equal(events(gh), 3);
  gh.remove('backup.json');
  const n = gh.fetch.calls.length;
  // Safari vacío recién configurado (nunca vio publicar a nadie): el turnos.ics publicado no es suyo →
  // solo lee (publisher desconocido); y al pasar a publicar → EMPTY_LOCAL
  const S = device('safari');
  const ro = await syncNow(S, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(ro.ok, true, JSON.stringify(ro.error));
  assert.equal(ro.readOnly, true);
  assert.equal(ro.publisher.deviceId, UNKNOWN_PUBLISHER);
  const r = await becomePublisher(S, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(r.error?.code, 'EMPTY_LOCAL');
  assert.match(r.error.detail, /3 eventos/);
  // El lector (con o sin cambios propios) recuerda quién publicaba: solo lee, ni con force
  for (const s of [R, setDay(R, '2026-10-25', ['F1'], { now: at(DAY) })]) {
    const r = await syncNow(s, { fetchImpl: gh.fetch, now: at(DAY), force: true });
    assert.equal(r.ok, true, JSON.stringify(r.error));
    assert.equal(r.readOnly, true);
    assert.equal(r.publisher.deviceId, 'iphone');
    assert.equal(r.pushed, false);
    assert.equal(r.sync.unpublished, undefined); // sin copia no se puede comparar: no se toca
  }
  assert.deepEqual(writesSince(gh, n), []);
  assert.equal(gh.text('turnos.ics'), good);
  // El iPhone sigue publicando: vuelve a crear la copia con sus días
  const { res } = await step(syncNow, M, gh, at(DAY + 1));
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.pushed, true);
  assert.equal(doc(gh).meta.publisher, 'iphone');
  assert.equal(doc(gh).meta.days, 3);
  // El lector puede pasar a publicar («Usar este dispositivo») aunque recuerde a otro
  gh.remove('backup.json');
  const t = await becomePublisher(R, { fetchImpl: gh.fetch, now: at(2 * DAY) });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.tookOver, true);
  assert.equal(doc(gh).meta.publisher, 'lector');
  // Vaciar a propósito sigue siendo posible tras confirmarlo («Usar este dispositivo» + allowEmpty)
  gh.remove('backup.json');
  const empty = await becomePublisher(S, { fetchImpl: gh.fetch, now: at(3 * DAY), allowEmpty: true });
  assert.equal(empty.pushed, true);
  assert.equal(events(gh), 0);
});

test('backup.json borrado para cambiar de clave: un dispositivo atrasado con la clave vieja no se adueña', async () => {
  const gh = fakeGitHub();
  let { state: M } = await step(syncNow, device('iphone', { '2026-10-20': ['F1'], '2026-10-21': ['S1'] }), gh, at(1));
  const { state: S } = await step(pullOnly, device('safari', { '2026-10-20': ['N1'] }), gh, at(2));
  // Enlace con la clave nueva en el iPhone (mismo repositorio: recuerda quién publica) y se borra backup.json
  M = applySyncConfig(M, { ...SYNC, key: OTHER_KEY }, { now: at(DAY) });
  assert.equal(M.settings.sync.publisher, 'iphone');
  assert.equal(M.settings.sync.prevKey, KEY);
  gh.remove('backup.json');
  const n = gh.fetch.calls.length;
  const rs = await syncNow(S, { fetchImpl: gh.fetch, now: at(DAY + 1) });
  assert.equal(rs.ok, true, JSON.stringify(rs.error));
  assert.equal(rs.readOnly, true);
  assert.deepEqual(writesSince(gh, n), []);
  // El iPhone publica con la clave nueva (y olvida la anterior); Safari ya no puede leer ni escribir
  const { res: rm, state: M2 } = await step(syncNow, M, gh, at(DAY + 2));
  assert.equal(rm.pushed, true);
  assert.equal(M2.settings.sync.prevKey, '');
  assert.deepEqual(Object.keys((await decryptBackup(doc(gh), OTHER_KEY)).days).sort(), ['2026-10-20', '2026-10-21']);
  const n2 = gh.fetch.calls.length;
  for (const fn of [syncNow, becomePublisher]) assert.equal((await fn(S, { fetchImpl: gh.fetch, now: at(DAY + 3) })).error?.code, 'DECRYPT');
  assert.deepEqual(writesSince(gh, n2), []);
});

test('un dispositivo que solo lee no vuelve a crear una rama borrada; «Usar este dispositivo» sí', async () => {
  const gh = fakeGitHub();
  await step(syncNow, device('iphone', REAL_WEEK, { branch: 'datos' }), gh, at(1));
  const { state: R } = await step(pullOnly, device('lector', {}, { branch: 'datos' }), gh, at(2));
  delete gh.branches.datos;
  const n = gh.fetch.calls.length;
  const r = await syncNow(R, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.readOnly, true);
  assert.equal(gh.branches.datos, undefined);
  assert.deepEqual(writesSince(gh, n), []);
  const t = await becomePublisher(R, { fetchImpl: gh.fetch, now: at(DAY + 1) });
  assert.equal(t.pushed, true);
  assert.equal(doc(gh, 'datos').meta.publisher, 'lector');
  assert.equal(doc(gh, 'datos').meta.days, 7);
});

// ---------- Identidad antes de la red (n2) ----------

test('la clave y el deviceId se guardan antes de la primera petición; sin ellos syncNow no publica en esa llamada', async () => {
  const gh = fakeGitHub();
  const H = device('', { '2026-10-20': ['F1'] }, { key: '' });
  // Primera llamada sin identidad: nada escrito (RETRY); perder su resultado (pestaña cerrada) no deja
  // en GitHub una copia que nadie puede leer
  const r1 = await syncNow(H, { fetchImpl: gh.fetch, now: at(1) });
  assert.equal(r1.error?.code, 'RETRY');
  assert.equal(gh.text('backup.json'), null);
  assert.deepEqual(gh.puts(), []);
  const r2 = await syncNow(H, { fetchImpl: gh.fetch, now: at(DAY) }); // se vuelve a abrir
  assert.equal(r2.error?.code, 'RETRY');
  const { res: r3, state: H2 } = await step(syncNow, applySyncResult(H, r2, { now: at(DAY) }), gh, at(DAY + 1));
  assert.equal(r3.pushed, true);
  assert.equal(H2.settings.sync.key, r2.sync.key);
  await decryptBackup(doc(gh), H2.settings.sync.key);
  // Lo recomendado: ensureSyncIdentity dentro de store.set al configurar → en localStorage antes de la red
  const gh2 = fakeGitHub();
  const st = memoryStorage();
  const store = createStore(st, { target: null });
  store.set((s) => ensureSyncIdentity(updateSettings(setDay(s, '2026-10-20', ['F1'], { now: T0 }), { sync: { ...SYNC, key: '', deviceId: '' } })));
  const saved = JSON.parse(st.getItem(STORAGE_KEY)).settings.sync;
  assert.ok(isSyncKey(saved.key));
  assert.match(saved.deviceId, /^[a-z0-9]{12}$/);
  const r = await syncNow(store.get(), { fetchImpl: gh2.fetch, now: at(1) });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.pushed, true);
  assert.equal(r.sync.key, undefined);
  assert.equal(doc(gh2).meta.publisher, saved.deviceId);
  await decryptBackup(doc(gh2), saved.key);
  assert.equal(ensureSyncIdentity(store.get()), store.get()); // ya tiene identidad: mismo estado
  // key: false → solo el deviceId
  const onlyId = ensureSyncIdentity(device('', {}, { key: '' }), { key: false });
  assert.equal(onlyId.settings.sync.key, '');
  assert.ok(onlyId.settings.sync.deviceId);
});

// ---------- Enlace de configuración (n6, n4) ----------

test('enlace con otra clave: trySetupConfig no lo acepta y la clave buena sigue; si se aplicó sin comprobar, se recupera (prevKey)', async () => {
  const gh = fakeGitHub();
  const { state: M } = await step(syncNow, device('iphone', { '2026-10-20': ['F1'] }), gh, at(1));
  const bad = linkCfg({ ...SYNC, key: OTHER_KEY });
  const n = gh.fetch.calls.length;
  const t = await trySetupConfig(M, bad, { fetchImpl: gh.fetch, now: at(30 * DAY) });
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'DECRYPT');
  assert.equal(t.apply, undefined);
  assert.deepEqual(writesSince(gh, n), []);
  // Con la cola y el store: lo guardado no cambia
  const store = createStore(memoryStorage(), { target: null });
  store.set(() => M);
  const q = createSyncQueue(store, { fetchImpl: gh.fetch, clock: () => at(30 * DAY) });
  assert.equal((await q.setup(bad)).ok, false);
  assert.equal(store.get().settings.sync.key, KEY);
  // Red de seguridad: aplicado sin comprobar (syncConfigPatch directo) → al leer se recupera la anterior
  const B = updateSettings(M, { sync: syncConfigPatch(bad, M) }, { now: at(30 * DAY) });
  assert.equal(B.settings.sync.key, OTHER_KEY);
  assert.equal(B.settings.sync.prevKey, KEY);
  const { res: rb, state: B2 } = await step(pullOnly, B, gh, at(30 * DAY + 1));
  assert.equal(rb.ok, true, JSON.stringify(rb.error));
  assert.equal(rb.keyRestored, true);
  assert.equal(B2.settings.sync.key, KEY);
  assert.equal(B2.settings.sync.prevKey, '');
  const rp = await syncNow(B2, { fetchImpl: gh.fetch, now: at(30 * DAY + 2) });
  assert.equal(rp.ok, true, JSON.stringify(rp.error));
  assert.equal(rp.readOnly, false);
  // También si la UI cambia la clave a mano (sin syncConfigPatch con el estado): updateSettings guarda la anterior
  const naive = updateSettings(M, { sync: syncConfigPatch(bad) }, { now: at(30 * DAY) });
  assert.equal(naive.settings.sync.prevKey, KEY);
  const { res: rn, state: N2 } = await step(syncNow, naive, gh, at(30 * DAY + 3));
  assert.equal(rn.ok, true, JSON.stringify(rn.error));
  assert.equal(rn.keyRestored, true);
  assert.equal(N2.settings.sync.key, KEY);
  assert.equal(updateSettings(M, { sync: { key: OTHER_KEY, prevKey: '' } }).settings.sync.prevKey, ''); // explícito
  // Un enlace con la clave buena (p. ej. token nuevo) sí se acepta y conserva quién publica
  const token = `ghp_${'c'.repeat(36)}`;
  const ok = await trySetupConfig(M, linkCfg({ ...SYNC, token }), { fetchImpl: gh.fetch, now: at(31 * DAY) });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  const M2 = ok.apply(M);
  assert.equal(M2.settings.sync.token, token);
  assert.equal(M2.settings.sync.key, KEY);
  assert.equal(M2.settings.sync.publisher, 'iphone');
  assert.equal(isReadOnlyDevice(M2.settings.sync), false);
});

test('trySetupConfig: sin clave y con copia → NO_KEY; sin copia → crea la clave al guardar; sin red solo en la primera configuración', async () => {
  const gh = fakeGitHub();
  const noKey = linkCfg({ ...SYNC, key: '' });
  const fresh = stateWith({ '2026-10-20': ['F1'] });
  // Repo sin copia: se acepta; la identidad se crea al guardar, antes de publicar
  const t1 = await trySetupConfig(fresh, noKey, { fetchImpl: gh.fetch, now: T0 });
  assert.equal(t1.ok, true, JSON.stringify(t1.error));
  assert.equal(t1.readOnly, false);
  assert.ok(gh.fetch.calls.every((c) => c.method === 'GET'));
  const s1 = t1.apply(fresh);
  assert.equal(s1.settings.sync.enabled, true);
  assert.ok(isSyncKey(s1.settings.sync.key));
  assert.match(s1.settings.sync.deviceId, /^[a-z0-9]{12}$/);
  const { res: p1 } = await step(syncNow, s1, gh, at(1));
  assert.equal(p1.pushed, true);
  assert.equal(doc(gh).meta.publisher, s1.settings.sync.deviceId);
  // Ya hay copia: sin clave → NO_KEY (nada guardado); con la clave → lee, fusiona y dice quién publica
  const t2 = await trySetupConfig(createDefaultState(), noKey, { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t2.ok, false);
  assert.equal(t2.error.code, 'NO_KEY');
  const withKey = { ...noKey, key: s1.settings.sync.key };
  const t3 = await trySetupConfig(createDefaultState(), withKey, { fetchImpl: gh.fetch, now: at(3) });
  assert.equal(t3.ok, true, JSON.stringify(t3.error));
  assert.equal(t3.readOnly, true);
  const s3 = t3.apply(createDefaultState());
  assert.ok(s3.days['2026-10-20']);
  assert.equal(isReadOnlyDevice(s3.settings.sync), true);
  // Sin red: en un dispositivo sin configurar se guarda (se reintentará); en uno que ya funciona, no
  const offline = async () => { throw new TypeError('Load failed'); };
  const t4 = await trySetupConfig(createDefaultState(), withKey, { fetchImpl: offline, now: at(4) });
  assert.equal(t4.ok, true);
  assert.equal(t4.error.code, 'NETWORK');
  assert.equal(t4.apply(createDefaultState()).settings.sync.lastErrorCode, 'NETWORK');
  const t4b = await trySetupConfig(createDefaultState(), noKey, { fetchImpl: offline, now: at(4) });
  assert.equal(t4b.apply(createDefaultState()).settings.sync.key, ''); // sin comprobar, no se inventa clave
  assert.equal((await trySetupConfig(s3, withKey, { fetchImpl: offline, now: at(5) })).ok, false);
  // Configuración no válida
  assert.equal((await trySetupConfig(createDefaultState(), { owner: 'x' }, { fetchImpl: gh.fetch })).error.code, 'CONFIG');
});

test('lugares de un enlace: solo si el dispositivo nunca eligió, sin sello «ahora»; gana la decisión publicada', async () => {
  const gh = fakeGitHub();
  const cfg = linkCfg({ ...SYNC, publishPlaces: true });
  assert.equal(cfg.publishPlaces, true);
  const hasLoc = () => /\r\nLOCATION:/.test(gh.text('turnos.ics'));
  // iPhone nuevo: el enlace sugiere publicar lugares (con el sello mínimo)
  let M = upsertCode(stateWith({ '2026-10-20': ['F1', 'F51'] }), { code: 'F51', place: 'Calle Falsa 123' }, { now: T0 });
  M = applySyncConfig(M, cfg, { now: at(1), deviceId: 'iphone' });
  assert.equal(M.settings.sync.publishPlaces, true);
  assert.equal(M.settings.placesUpdatedAt, LINK_PLACES_AT);
  ({ state: M } = await step(syncNow, M, gh, at(2)));
  assert.ok(hasLoc());
  // Otro dispositivo adopta lo publicado (sin falsos «cambios sin publicar»)
  const { res: rl, state: L } = await step(syncNow, device('lector'), gh, at(3));
  assert.equal(L.settings.sync.publishPlaces, true);
  assert.equal(rl.unpublishedSettings, false);
  assert.equal(L.settings.sync.unpublished, 0);
  // Mauricio decide no publicar lugares
  M = updateSettings(M, { sync: { publishPlaces: false } }, { now: at(DAY) });
  ({ state: M } = await step(syncNow, M, gh, at(DAY)));
  assert.ok(!hasLoc());
  // 30 días después vuelve a pegar el mismo enlace (token caducado): no se reactivan
  const t = await trySetupConfig(M, cfg, { fetchImpl: gh.fetch, now: at(30 * DAY) });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  M = t.apply(M);
  assert.equal(M.settings.sync.publishPlaces, false);
  ({ state: M } = await step(syncNow, M, gh, at(30 * DAY + 1)));
  assert.ok(!hasLoc());
  // Un teléfono nuevo con el enlace viejo: la sugerencia pierde ante la decisión publicada, también al publicar
  const N0 = applySyncConfig(stateWith({}), cfg, { now: at(31 * DAY), deviceId: 'nuevo' });
  assert.equal(N0.settings.sync.publishPlaces, true);
  let { state: N } = await step(pullOnly, N0, gh, at(31 * DAY));
  assert.equal(N.settings.sync.publishPlaces, false);
  ({ state: N } = await step(becomePublisher, N, gh, at(31 * DAY + 1)));
  assert.equal(doc(gh).meta.publisher, 'nuevo');
  assert.ok(!hasLoc());
  // syncConfigPatch nunca toca publishPlaces
  assert.equal('publishPlaces' in syncConfigPatch(cfg, M), false);
  assert.equal('publishPlaces' in syncConfigPatch(cfg), false);
});

test('applySyncConfig: mismo repositorio → recuerda quién publica; otro → empieza de cero; sellos explícitos en updateSettings', () => {
  const s = updateSettings(device('a'), { sync: { publisher: 'b', publisherSince: T0.toISOString(), lastPullAt: T0.toISOString(), baseRev: 4 } });
  const same = applySyncConfig(s, { ...SYNC, token: `ghp_${'d'.repeat(36)}` }, { now: at(1) });
  assert.equal(same.settings.sync.publisher, 'b');
  assert.equal(same.settings.sync.baseRev, 0);
  assert.equal(same.settings.sync.lastPullAt, null);
  assert.equal(same.settings.sync.deviceId, 'a');
  assert.equal(same.settings.sync.key, KEY);
  assert.equal(same.settings.sync.prevKey, ''); // misma clave
  const other = applySyncConfig(s, { ...SYNC, repo: 'otros-datos' }, { now: at(1) });
  assert.equal(other.settings.sync.publisher, null);
  assert.equal(other.settings.sync.repo, 'otros-datos');
  assert.throws(() => applySyncConfig(s, { owner: 'x' }), (e) => e.code === 'CONFIG');
  // Un sello explícito no se sustituye por «ahora» (el .ics sí cambia de sello)
  const u = updateSettings(createDefaultState(), { sync: { publishPlaces: true }, placesUpdatedAt: null }, { now: at(5) });
  assert.equal(u.settings.placesUpdatedAt, null);
  assert.equal(u.settings.calendarUpdatedAt, at(5).toISOString());
  assert.equal(updateSettings(createDefaultState(), { sync: { publishPlaces: true } }, { now: at(5) }).settings.placesUpdatedAt, at(5).toISOString());
});

// ---------- Calendario de quien dejó de publicar (n1) ----------

test('una sincronización congelada del que publicaba no pisa el calendario de quien pasó a publicar', async () => {
  const gh = fakeGitHub();
  let { state: A } = await step(syncNow, device('app', { '2026-10-20': ['F1'] }), gh, at(1));
  let { state: B } = await step(pullOnly, device('helper'), gh, at(2));
  // A abre la app (sin cambios): iOS la congela al pedir turnos.ics
  let release;
  const frozen = new Promise((r) => { release = r; });
  const freezing = async (url, init) => { if (url.includes('turnos.ics')) await frozen; return gh.fetch(url, init); };
  const pending = syncNow(A, { fetchImpl: freezing, now: at(3) });
  await new Promise((r) => setTimeout(r, 20));
  // Mientras, B pasa a publicar y añade el turno del 22
  B = setDay(B, '2026-10-22', ['N1'], { now: at(DAY) });
  ({ state: B } = await step(becomePublisher, B, gh, at(DAY)));
  assert.ok(gh.text('turnos.ics').includes('UID:2026-10-22-N1@'));
  release();
  const late = await pending;
  assert.equal(late.error?.code, 'CONFLICT');
  assert.equal(late.error.retry, true);
  assert.equal(late.sync.publisher, undefined); // no se presupone quién publica
  assert.ok(gh.text('turnos.ics').includes('UID:2026-10-22-N1@'));
  // Al reintentar, A ya solo lee y el calendario sigue bien
  A = applySyncResult(A, late, { now: at(3) });
  const again = await syncNow(A, { fetchImpl: gh.fetch, now: at(DAY + 60e3) });
  assert.equal(again.readOnly, true);
  assert.equal(again.publisher.deviceId, 'helper');
  assert.ok(gh.text('turnos.ics').includes('UID:2026-10-22-N1@'));
  // Solo se lee backup.json de nuevo cuando el calendario difiere (sin cambios: 2 GET)
  const n = gh.fetch.calls.length;
  await syncNow(B, { fetchImpl: gh.fetch, now: at(2 * DAY) });
  assert.deepEqual(gh.fetch.calls.slice(n).map((c) => `${c.method} ${c.url.split('/contents/')[1]}`), ['GET backup.json', 'GET turnos.ics']);
});

// ---------- Orden de los códigos de un día (n5) ----------

test('cambiar el tipo de un código no hace publicar una rev nueva en cada sincronización', async () => {
  const gh = fakeGitHub();
  const A = createStore(memoryStorage(), { target: null });
  A.set((s) => setDay(updateSettings(s, { sync: { ...SYNC, deviceId: 'app' } }), '2026-10-20', ['Z9', 'TS'], { now: at(1) }));
  const runA = async (now) => {
    const r = await syncNow(A.get(), { fetchImpl: gh.fetch, now });
    A.set((c) => applySyncResult(c, r, { now }));
    return r;
  };
  assert.equal((await runA(at(2))).rev, 1);
  let { state: B } = await step(pullOnly, device('safari'), gh, at(3));
  // Z9 no es un turno sino «otro»: el día se reordena (TS es un evento)
  A.set((s) => upsertCode(s, { code: 'Z9', kind: 'other' }, { now: at(DAY) }));
  assert.deepEqual(A.get().days['2026-10-20'].codes, ['TS', 'Z9']);
  const revs = [];
  for (let i = 0; i < 4; i++) revs.push((await runA(at(DAY + 10 + i))).rev);
  assert.deepEqual(revs, [2, 2, 2, 2]);
  for (let i = 0; i < 2; i++) {
    let r;
    ({ res: r, state: B } = await step(syncNow, B, gh, at(2 * DAY + i)));
    assert.deepEqual(r.unpublishedDays, []);
    assert.equal(B.settings.sync.unpublished, 0);
  }
  // mergeStates por sí sola deja el orden canónico al traer una definición con otro tipo
  const local = setDay(createDefaultState(), '2026-10-20', ['Z9', 'TS'], { now: at(1) });
  const remote = clone(local);
  remote.codes.Z9 = { ...remote.codes.Z9, kind: 'other', updatedAt: at(DAY).toISOString() };
  assert.deepEqual(remote.days['2026-10-20'].codes, ['Z9', 'TS']);
  const m = mergeStates(local, remote, { now: at(DAY) }).state;
  assert.equal(m.codes.Z9.kind, 'other');
  assert.deepEqual(m.days['2026-10-20'].codes, ['TS', 'Z9']);
});

// ---------- Resultados viejos y cola única (n7) ----------

test('un resultado viejo (empezó antes de «Usar este dispositivo») no deshace el cambio', async () => {
  const gh = fakeGitHub();
  await step(syncNow, device('helper', { '2026-10-20': ['F1'] }), gh, at(1));
  let { state: B } = await step(pullOnly, device('iphone'), gh, at(2));
  B = setDay(B, '2026-10-21', ['S1'], { now: at(DAY) });
  // Sincronización de fondo lenta (la respuesta tarda)
  let release;
  const slow = new Promise((r) => { release = r; });
  const slowFetch = async (url, init) => { const r = await gh.fetch(url, init); await slow; return r; };
  const bg = syncNow(B, { fetchImpl: slowFetch, now: at(DAY + 1) });
  await new Promise((r) => setTimeout(r, 20));
  ({ state: B } = await step(becomePublisher, B, gh, at(DAY + 2)));
  assert.equal(isReadOnlyDevice(B.settings.sync), false);
  const baseRev = B.settings.sync.baseRev;
  release();
  const old = await bg;
  assert.equal(old.readOnly, true);
  B = applySyncResult(B, old, { now: at(DAY + 3) });
  assert.equal(isReadOnlyDevice(B.settings.sync), false);
  assert.equal(B.settings.sync.publisher, 'iphone');
  assert.equal(B.settings.sync.baseRev, baseRev);
  assert.equal(B.settings.sync.unpublished, 0);
  assert.equal(B.settings.sync.lastSyncStartedAt, at(DAY + 2).toISOString());
  assert.deepEqual(getAdvice(B, at(DAY + 3)).filter((a) => a.id === 'read-only'), []);
  assert.ok(B.days['2026-10-20'] && B.days['2026-10-21']); // los datos sí se fusionan
  assert.equal(doc(gh).meta.publisher, 'iphone');
  // Una marca en el futuro (reloj adelantado y después corregido) no bloquea los resultados nuevos
  const skewed = updateSettings(B, { sync: { lastSyncStartedAt: at(400 * DAY).toISOString() } });
  const fixed = applySyncResult(skewed, { ...old, sync: { ...old.sync } }, { now: at(DAY + 4) });
  assert.equal(fixed.settings.sync.publisher, 'helper');
  assert.equal(fixed.settings.sync.lastSyncStartedAt, old.startedAt);
});

test('createSyncQueue: una llamada cada vez, cada resultado aplicado al llegar, RETRY se repite solo', async () => {
  const gh = fakeGitHub();
  let active = 0, maxActive = 0;
  const counting = async (url, init) => {
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise((r) => setTimeout(r, 1));
      return await gh.fetch(url, init);
    } finally { active--; }
  };
  let t = 0;
  const clock = () => at(t += 1000);
  // Primer dispositivo, configurado sin identidad (versión antigua): RETRY y después publica
  const store = createStore(memoryStorage(), { target: null });
  store.set((s) => setDay(updateSettings(s, { sync: { ...SYNC, key: '', deviceId: '' } }), '2026-10-20', ['F1'], { now: T0 }));
  const q = createSyncQueue(store, { fetchImpl: counting, clock });
  const a = q.sync(), b = q.sync(), c = q.pull();
  assert.equal(a, b); // dos syncNow pendientes se juntan en uno
  const ra = await a;
  assert.equal(ra.ok, true, JSON.stringify(ra.error));
  assert.equal(ra.pushed, true);
  const saved = store.get().settings.sync;
  assert.ok(isSyncKey(saved.key));
  assert.equal(doc(gh).meta.publisher, saved.deviceId);
  assert.equal((await c).ok, true);
  assert.equal(maxActive, 1);
  // Segundo dispositivo: enlace → solo lee → «Usar este dispositivo», con un syncNow de fondo en medio
  const store2 = createStore(memoryStorage(), { target: null });
  const q2 = createSyncQueue(store2, { fetchImpl: counting, clock });
  const setup = await q2.setup(linkCfg({ ...SYNC, key: saved.key }));
  assert.equal(setup.ok, true, JSON.stringify(setup.error));
  assert.equal(setup.readOnly, true);
  assert.ok(store2.get().days['2026-10-20']);
  assert.equal(isReadOnlyDevice(store2.get().settings.sync), true);
  const [bg, take, after] = await Promise.all([q2.sync(), q2.becomePublisher(), q2.sync()]);
  assert.equal(bg.readOnly, true);
  assert.equal(take.tookOver, true);
  assert.equal(after.readOnly, false);
  await q2.idle();
  assert.equal(isReadOnlyDevice(store2.get().settings.sync), false);
  assert.equal(doc(gh).meta.publisher, store2.get().settings.sync.deviceId);
  assert.equal(maxActive, 1); // nunca dos peticiones a la vez
});
