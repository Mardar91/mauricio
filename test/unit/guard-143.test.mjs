// 1.4.3: turnos sin nombre ante el calendario de alguien (S2b), nombre del calendario publicado cuando la
// copia y el enlace no lo traen (S2c), copia sin meta.name reescrita una vez, y cambio a una rama que
// no existe (S3b): no se crea desde la rama por defecto.
import { KEY, SYNC, TOKEN, fakeGitHub, stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEW_BRANCH_MESSAGE, applySyncResult, buildSetupLink, createSyncQueue, decryptBackup, normalizeSyncConfig,
  parseSetupLink, syncNow, trySetupConfig,
} from '../../docs/js/core/sync.js';
import { createDefaultState, updateSettings } from '../../docs/js/core/store.js';

const T0 = new Date('2026-10-13T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);
const BASE = 'https://mardar91.github.io/mauricio/';
const MAU = { '2026-10-15': ['S1', 'S31'], '2026-12-25': ['F1'] };
const codesOf = (st) => Object.fromEntries(Object.entries(st.days).map(([k, d]) => [k, d.codes]));
const writes = (gh) => gh.fetch.calls.filter((c) => c.method !== 'GET');

function device({ id, name = '', days = {}, ...sync }) {
  return updateSettings(stateWith(days, name ? { name } : undefined), { sync: { ...SYNC, deviceId: id, ...sync } });
}
async function publish(gh, state, now = at(1)) {
  const res = await syncNow(state, { fetchImpl: gh.fetch, now });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  return applySyncResult(state, res, { now });
}
function memStore(st) {
  let s = st;
  return { get: () => s, set: (fn) => { const r = fn(structuredClone(s)); s = r || s; return s; }, saveOk: () => true };
}
// Ana escaneó sus turnos y saltó «¿Cómo te llamas?»: nunca conectó
const anaPhone = (settings) => stateWith({ '2026-10-15': ['N1'], '2026-12-24': ['N1'] }, { onboardingDone: true, ...settings });
const rootLink = (extra = {}) => parseSetupLink(buildSetupLink(BASE, { ...SYNC, ...extra }));

test('S2b: teléfono sin nombre, con turnos y sin conectar abre el enlace de Mauricio → se pregunta (unnamed) y no se escribe nada', async () => {
  const gh = fakeGitHub();
  await publish(gh, device({ id: 'iphone1', name: 'Mauricio', days: MAU }));
  const rootBefore = gh.text('backup.json');
  const n = writes(gh).length;
  const phone = anaPhone();
  // Enlace nuevo (con nombre) y enlace antiguo (sin nombre: el de la copia, meta.name)
  for (const cfg of [rootLink({ name: 'Mauricio' }), rootLink()]) {
    const t = await trySetupConfig(phone, cfg, { fetchImpl: gh.fetch, now: at(2) });
    assert.equal(t.ok, false);
    assert.equal(t.error.code, 'OTHER_PERSON');
    assert.deepEqual([t.otherPerson.reason, t.otherPerson.unnamed, t.otherPerson.name, t.otherPerson.bound, t.otherPerson.current.name],
      ['name', true, 'Mauricio', false, null]);
    assert.equal(t.apply, undefined);
  }
  // Con la cola tampoco se guarda nada, ni siquiera «Usar este dispositivo» puede publicar sus turnos
  const store = memStore(phone);
  const q = createSyncQueue(store, { fetchImpl: gh.fetch, clock: () => at(3) });
  assert.equal((await q.setup(rootLink({ name: 'Mauricio' }))).error.code, 'OTHER_PERSON');
  assert.equal(store.get(), phone);
  assert.equal(store.get().settings.sync.enabled, false);
  assert.equal((await q.becomePublisher()).ok, false);
  assert.equal(writes(gh).length, n);
  assert.equal(gh.text('backup.json'), rootBefore);
  // Sin turnos no hay nada que preguntar (teléfono nuevo de Mauricio)
  const fresh = await trySetupConfig(createDefaultState(), rootLink({ name: 'Mauricio' }), { fetchImpl: gh.fetch, now: at(4) });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.error));
});

test('S2c: copia sin meta.name y enlace antiguo → el nombre sale de X-WR-CALNAME del calendario publicado', async () => {
  const gh = fakeGitHub();
  await publish(gh, device({ id: 'iphone1', name: 'Mauricio', days: MAU }));
  // Como una copia de 1.4.1 o antes: sin meta.name (no va en los datos autenticados), calendario «Turnos de Mauricio»
  const doc = JSON.parse(gh.text('backup.json'));
  delete doc.meta.name;
  gh.write('backup.json', JSON.stringify(doc));
  assert.match(gh.text('turnos.ics'), /X-WR-CALNAME:Turnos de Mauricio/);
  const n = writes(gh).length;
  // Ana (con nombre y turnos): OTHER_PERSON por el nombre del calendario
  const t = await trySetupConfig(anaPhone({ name: 'Ana' }), rootLink(), { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t.error?.code, 'OTHER_PERSON');
  assert.deepEqual([t.otherPerson.reason, t.otherPerson.name], ['name', 'Mauricio']);
  assert.equal(t.error.message, 'Este enlace es del calendario de Mauricio y en este dispositivo hay turnos de Ana. No se cambió nada.');
  // Sin nombre: también se pregunta
  const u = await trySetupConfig(anaPhone(), rootLink(), { fetchImpl: gh.fetch, now: at(2) });
  assert.deepEqual([u.error?.code, u.otherPerson?.unnamed, u.otherPerson?.name], ['OTHER_PERSON', true, 'Mauricio']);
  // El mismo nombre no se bloquea; un calendario «Mis turnos» no dice de quién es (no se bloquea)
  assert.equal((await trySetupConfig(anaPhone({ name: 'Mauricio' }), rootLink(), { fetchImpl: gh.fetch, now: at(2) })).ok, true);
  const anon = fakeGitHub();
  await publish(anon, device({ id: 'iphone1', days: MAU }));
  assert.match(anon.text('turnos.ics'), /X-WR-CALNAME:Mis turnos/);
  assert.equal((await trySetupConfig(anaPhone({ name: 'Ana' }), rootLink(), { fetchImpl: anon.fetch, now: at(2) })).ok, true);
  // Solo lee: nada escrito
  assert.equal(writes(gh).length, n);
});

test('el que publica reescribe una vez la copia sin meta.name (o con otro nombre); después no escribe de más', async () => {
  const gh = fakeGitHub();
  let M = await publish(gh, device({ id: 'iphone1', name: 'Mauricio', days: MAU }));
  const doc = JSON.parse(gh.text('backup.json'));
  delete doc.meta.name;
  gh.write('backup.json', JSON.stringify(doc));
  const puts = gh.puts('backup.json').length;
  M = await publish(gh, M, at(2));
  assert.equal(gh.puts('backup.json').length, puts + 1);
  const now = JSON.parse(gh.text('backup.json'));
  assert.equal(now.meta.name, 'Mauricio');
  assert.deepEqual(Object.keys((await decryptBackup(now, KEY)).days), Object.keys(MAU));
  M = await publish(gh, M, at(3));
  assert.equal(gh.puts('backup.json').length, puts + 1, 'una sola vez');
  // Un dispositivo que solo lee nunca la reescribe
  const reader = device({ id: 'pc', name: 'Quien ayuda' });
  const r = await syncNow(reader, { fetchImpl: gh.fetch, now: at(4) });
  assert.deepEqual([r.ok, r.readOnly, r.pushed], [true, true, false]);
  assert.equal(gh.puts('backup.json').length, puts + 1);
});

test('S3b: cambiar a una rama que no existe no la crea desde la rama por defecto (CONFIG, nada escrito)', async () => {
  const gh = fakeGitHub();
  // El ordenador de quien ayuda ya leyó la raíz (sus datos son de la raíz)
  await publish(gh, device({ id: 'iphone1', name: 'Mauricio', days: MAU }));
  const pc = await (async () => {
    const s = device({ id: 'pc' });
    const res = await syncNow(s, { fetchImpl: gh.fetch, now: at(2) });
    return applySyncResult(s, res, { now: at(2) });
  })();
  assert.equal(pc.settings.sync.boundTarget, 'mardar91/mauricio-datos/:');
  const n = writes(gh).length;
  const form = normalizeSyncConfig({ owner: 'Mardar91', repo: 'mauricio-datos', branch: 'datos', token: TOKEN, key: '' });
  for (const opts of [{}, { switchPerson: true }]) {
    const t = await trySetupConfig(pc, form, { fetchImpl: gh.fetch, now: at(3), ...opts });
    assert.equal(t.ok, false);
    assert.equal(t.error.code, 'CONFIG');
    assert.equal(t.error.message, NEW_BRANCH_MESSAGE);
    assert.match(t.error.message, /«Crear enlace para otra persona»/);
    assert.equal(t.res.missingBranch, true);
  }
  const store = memStore(pc);
  const q = createSyncQueue(store, { fetchImpl: gh.fetch, clock: () => at(4) });
  assert.equal((await q.setup(form, { switchPerson: true })).error.code, 'CONFIG');
  assert.equal(store.get(), pc);
  assert.equal(gh.branches.datos, undefined, 'la rama no se creó');
  assert.equal(writes(gh).length, n);
  // Una rama que ya existe sigue el camino de siempre (OTHER_TARGET → switchPerson)
  gh.branches.datos = 'c0';
  const t = await trySetupConfig(pc, form, { fetchImpl: gh.fetch, now: at(5) });
  assert.equal(t.error?.code, 'OTHER_TARGET');
  // Un dispositivo sin datos de ningún destino sí puede estrenar una rama (como antes)
  delete gh.branches.datos;
  const fresh = memStore(updateSettings(createDefaultState(), { onboardingDone: true }));
  const qf = createSyncQueue(fresh, { fetchImpl: gh.fetch, clock: () => at(6) });
  const tf = await qf.setup(normalizeSyncConfig({ owner: 'Mardar91', repo: 'mauricio-datos', branch: 'nueva', token: TOKEN, key: '' }));
  assert.equal(tf.ok, true, JSON.stringify(tf.error));
  assert.equal(tf.res.missingBranch, true);
});

test('«Sí, son de Mauricio»: con el nombre puesto, se conecta y sus turnos se juntan; «No» → cambio limpio', async () => {
  const gh = fakeGitHub();
  await publish(gh, device({ id: 'iphone1', name: 'Mauricio', days: MAU }));
  const link = rootLink({ name: 'Mauricio' });
  // Sí (la UI pone el nombre y repite)
  const yes = memStore(anaPhone());
  const qy = createSyncQueue(yes, { fetchImpl: gh.fetch, clock: () => at(2) });
  yes.set((s) => updateSettings(s, { name: 'Mauricio' }));
  const t = await qy.setup(link);
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.readOnly, true);
  assert.ok(yes.get().days['2026-12-24'] && yes.get().days['2026-12-25']);
  // No → switchPerson: estado limpio, solo lo de Mauricio (y nada se escribe)
  const n = writes(gh).length;
  const no = memStore(anaPhone());
  const qn = createSyncQueue(no, { fetchImpl: gh.fetch, clock: () => at(3) });
  const sw = await qn.setup(link, { switchPerson: true });
  assert.equal(sw.ok, true, JSON.stringify(sw.error));
  assert.equal(sw.switched, true);
  assert.deepEqual(codesOf(no.get()), MAU);
  assert.equal(no.get().settings.name, 'Mauricio');
  assert.equal(writes(gh).length, n);
  // Mauricio sigue publicando sus turnos: el 15 sigue siendo S1/S31
  const data = await decryptBackup(JSON.parse(gh.text('backup.json')), KEY);
  assert.deepEqual(data.days['2026-10-15'].codes, ['S1', 'S31']);
  assert.equal(data.days['2026-12-24'], undefined);
});
