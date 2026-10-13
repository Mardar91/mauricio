// Cambio de destino (SPEC §11): un dispositivo con los turnos de una persona nunca los publica en otro
// calendario (otra carpeta, otro repositorio u otra rama) ni le lleva su clave: ni con un enlace, ni
// con el formulario avanzado, ni desconectado, ni cambiando la configuración por debajo, ni con «Usar
// este dispositivo» después. Solo switchPerson (tras confirmarlo) cambia, desde un estado limpio.
import { KEY, SYNC, TOKEN, fakeGitHub, memoryStorage, mockFetch, multiRepo, stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSyncKey } from '../../docs/js/core/cipher.js';
import {
  applySyncConfig, applySyncResult, becomePublisher, buildPersonLink, buildSetupLink, createSyncQueue, decryptBackup,
  icsEventCount, normalizeSyncConfig, parseSetupLink, publicName, pullOnly, syncConfigPatch, syncNow, trySetupConfig,
} from '../../docs/js/core/sync.js';
import {
  createDefaultState, dataTargetOf, personSwitchState, saveBeforeImport, setDay, syncTargetId, undoImport, updateSettings,
} from '../../docs/js/core/store.js';

const T0 = new Date('2026-10-13T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);
const BASE = 'https://mardar91.github.io/mauricio/';
const MAU = { '2026-10-13': ['S1'], '2026-10-14': ['S1'], '2026-10-15': ['N1'] };
const ROOT = 'mardar91/mauricio-datos/:';
const codesOf = (st) => Object.fromEntries(Object.entries(st.days).map(([k, d]) => [k, d.codes]));
const calName = (ics) => /X-WR-CALNAME:(.*)\r\n/.exec(ics || '')?.[1];
const writes = (f) => f.calls.filter((c) => c.method !== 'GET');
const offline = async () => { throw new TypeError('Failed to fetch'); };

function device({ id, name = '', days = {}, ...sync }) {
  const s = stateWith(days, name ? { name } : undefined);
  return updateSettings(s, { sync: { ...SYNC, deviceId: id, ...sync } });
}
async function run(fn, state, fetchImpl, now, extra = {}) {
  const res = await fn(state, { fetchImpl, now, ...extra });
  return applySyncResult(state, res, { now });
}
// Store mínimo como el de la UI (para la cola)
function memStore(st) {
  let s = st;
  return { get: () => s, set: (fn) => { const r = fn(structuredClone(s)); s = r || s; return s; }, saveOk: () => true };
}
const queue = (store, fetchImpl, min = 10) => createSyncQueue(store, { fetchImpl, clock: () => at(min) });
// Formulario avanzado (no tiene clave ni carpeta)
const form = (extra = {}) => normalizeSyncConfig({ owner: 'Mardar91', repo: 'mauricio-datos', branch: '', token: TOKEN, key: '', ...extra });

// Repositorio de Mauricio (con su calendario y una rama «datos» vacía, creada antes de tener datos) y
// otro vacío para su hermana. Mauricio publica la raíz; el ordenador de quien ayuda solo lee.
async function world() {
  const mau = fakeGitHub();
  mau.branches.datos = 'c0';
  const sis = fakeGitHub();
  const fetch = multiRepo({ 'Mardar91/mauricio-datos': mau, 'Mardar91/sorella-datos': sis });
  const M = await run(syncNow, device({ id: 'iphone-mau', name: 'Mauricio', days: MAU }), fetch, at(1));
  const H = await run(syncNow, device({ id: 'pc' }), fetch, at(2));
  return { mau, sis, fetch, M, H };
}

// Lo que hay en un calendario: null (nada) o { days, withOldKey (¿lo descifra la clave de Mauricio?), events, name }
async function published(gh, dir = '', branch) {
  const text = gh.text(dir ? `${dir}/backup.json` : 'backup.json', branch);
  if (!text) return null;
  const doc = JSON.parse(text);
  let withOldKey = true;
  try { await decryptBackup(doc, KEY); } catch { withOldKey = false; }
  const ics = gh.text(dir ? `${dir}/turnos.ics` : 'turnos.ics', branch);
  return { doc, withOldKey, events: icsEventCount(ics), name: calName(ics) };
}

test('formulario con otro repositorio (el caso de la hermana): OTHER_TARGET, no se guarda ni se escribe nada', async () => {
  const { sis, fetch, H } = await world();
  assert.equal(H.settings.sync.publisher, 'iphone-mau');
  assert.deepEqual(codesOf(H), MAU);
  assert.equal(H.settings.name, 'Mauricio', 'el ordenador vacío adoptó el nombre del calendario');
  const n = writes(fetch).length;
  const t = await trySetupConfig(H, form({ repo: 'sorella-datos' }), { fetchImpl: fetch, now: at(3) });
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'OTHER_TARGET');
  assert.equal(t.error.retry, false);
  assert.equal(t.error.message, 'Este dispositivo ya tiene el calendario de Mauricio (Mardar91/mauricio-datos). Esta conexión es a otro calendario (Mardar91/sorella-datos). No se cambió nada.');
  assert.deepEqual(t.otherPerson, {
    reason: 'target', name: null, dir: '', current: { name: 'Mauricio', dir: '' }, working: true, bound: true,
    from: 'Mardar91/mauricio-datos', to: 'Mardar91/sorella-datos',
  });
  assert.equal(t.apply, undefined);
  // Con la cola («Guardar y conectar»): nada cambia y la siguiente sincronización solo lee la raíz
  const store = memStore(H);
  const q = queue(store, fetch);
  assert.equal((await q.setup(form({ repo: 'sorella-datos' }))).error.code, 'OTHER_TARGET');
  assert.equal(store.get(), H);
  const r = await q.sync();
  assert.deepEqual([r.ok, r.readOnly, r.target.repo], [true, true, 'mauricio-datos']);
  assert.equal(writes(fetch).length, n);
  assert.equal(sis.file('backup.json'), null);
  assert.equal(sis.file('turnos.ics'), null);
});

test('cambio confirmado a otro repositorio: estado limpio y clave nueva; ni «Usar este dispositivo» lleva allí lo de Mauricio', async () => {
  const { mau, sis, fetch, H } = await world();
  const root = [mau.text('backup.json'), mau.text('turnos.ics')];
  const store = memStore(updateSettings(H, { onboardingDone: true, ntfy: { enabled: true, topic: 'turnos-mauricio-pc' } }));
  const q = queue(store, fetch);
  const t = await q.setup(form({ repo: 'sorella-datos' }), { switchPerson: true });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.switched, true);
  let s = store.get();
  assert.deepEqual(codesOf(s), {});
  assert.deepEqual([s.settings.name, s.settings.planName, s.changes.length, s.scans.length], ['', '', 0, 0]);
  const sy = s.settings.sync;
  assert.deepEqual([sy.repo, sy.dir, sy.deviceId, sy.prevKey, sy.publisher, sy.boundTarget], ['sorella-datos', '', 'pc', '', null, '']);
  assert.ok(isSyncKey(sy.key));
  assert.notEqual(sy.key, KEY, 'clave nueva: la de Mauricio no va a otro calendario');
  assert.deepEqual([s.settings.onboardingDone, s.settings.ntfy.topic], [true, 'turnos-mauricio-pc']);
  // Publica su calendario (vacío) y después «Usar este dispositivo» y «Actualizar ahora»
  assert.equal((await q.sync()).pushed, true);
  assert.equal((await q.becomePublisher()).ok, true);
  assert.equal((await q.sync({ force: true })).ok, true);
  const p = await published(sis);
  assert.equal(p.withOldKey, false, 'la clave de Mauricio no descifra el calendario nuevo');
  assert.deepEqual((await decryptBackup(p.doc, sy.key)).days, {});
  assert.deepEqual([p.events, p.name, p.doc.meta.name], [0, 'Mis turnos', undefined]);
  assert.equal(store.get().settings.sync.boundTarget, 'mardar91/sorella-datos/:');
  // La hermana conecta su teléfono con el enlace de este ordenador y pasa a publicar sus turnos
  const link = parseSetupLink(buildSetupLink(BASE, { ...store.get().settings.sync, name: 'Lucía' }));
  const ls = memStore(stateWith({ '2026-10-20': ['F1'] }));
  const ql = queue(ls, fetch, 20);
  const tl = await ql.setup(link);
  assert.equal(tl.ok, true, JSON.stringify(tl.error));
  assert.equal(tl.readOnly, true);
  assert.equal((await ql.becomePublisher()).ok, true);
  // Quien ayuda lee los de ella y vuelve a publicar: solo los de ella
  await q.sync();
  assert.equal((await q.becomePublisher()).tookOver, true);
  s = store.get();
  assert.deepEqual(codesOf(s), { '2026-10-20': ['F1'] });
  const p2 = await published(sis);
  assert.deepEqual(Object.keys((await decryptBackup(p2.doc, sy.key)).days), ['2026-10-20']);
  assert.deepEqual([p2.withOldKey, p2.events, p2.name], [false, 1, 'Turnos de Lucía']);
  // El calendario de Mauricio sigue igual
  assert.deepEqual([mau.text('backup.json'), mau.text('turnos.ics')], root);
});

test('otra rama del mismo repositorio también es otro calendario: OTHER_TARGET; al cambiar, clave nueva y nada de lo anterior', async () => {
  const { mau, fetch, M } = await world();
  const t = await trySetupConfig(M, form({ branch: 'datos' }), { fetchImpl: fetch, now: at(3) });
  assert.equal(t.error?.code, 'OTHER_TARGET');
  assert.deepEqual([t.otherPerson.from, t.otherPerson.to], ['Mardar91/mauricio-datos', 'Mardar91/mauricio-datos, rama datos']);
  assert.match(t.error.detail, /Otro destino: este dispositivo Mardar91\/mauricio-datos\/\(raíz\) \(Mauricio\); enlace Mardar91\/mauricio-datos\/\(raíz\)@datos/);
  // Un enlace a esa rama tampoco (aunque sea del mismo nombre)
  const link = parseSetupLink(buildSetupLink(BASE, { ...SYNC, branch: 'datos', key: '', name: 'Mauricio' }));
  assert.equal((await trySetupConfig(M, link, { fetchImpl: fetch, now: at(3) })).error?.code, 'OTHER_TARGET');
  assert.throws(() => applySyncConfig(M, form({ branch: 'datos' })), (e) => e.code === 'OTHER_TARGET');
  assert.equal(mau.file('backup.json', 'datos'), null);
  // Confirmado
  const store = memStore(M);
  const q = queue(store, fetch);
  assert.equal((await q.setup(form({ branch: 'datos' }), { switchPerson: true })).switched, true);
  const sy = store.get().settings.sync;
  assert.deepEqual([sy.branch, codesOf(store.get())], ['datos', {}]);
  assert.notEqual(sy.key, KEY);
  assert.equal((await q.sync()).pushed, true);
  assert.equal((await q.becomePublisher()).ok, true);
  const p = await published(mau, '', 'datos');
  assert.deepEqual([p.withOldKey, p.events], [false, 0]);
  assert.deepEqual((await decryptBackup(p.doc, sy.key)).days, {});
  // La rama principal sigue con lo de Mauricio
  assert.deepEqual(Object.keys((await decryptBackup(JSON.parse(mau.text('backup.json')), KEY)).days), Object.keys(MAU));
});

test('desconectado («Desconectar») con los turnos de un calendario: otro enlace sigue bloqueado (también sin red); el suyo se reconecta', async () => {
  const { mau, fetch, M } = await world();
  const off = updateSettings(M, { sync: { enabled: false } });
  const ana = buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: [''] });
  const noName = parseSetupLink(buildSetupLink(BASE, { ...parseSetupLink(ana.link), name: '' }));
  assert.equal(noName.name, undefined);
  for (const [link, message] of [
    [noName, 'Este enlace es del calendario de otra persona. No se cambió nada.'],
    [parseSetupLink(ana.link), 'Este enlace es del calendario de Ana y este dispositivo usa el de Mauricio. No se cambió nada.'],
  ]) {
    const t = await trySetupConfig(off, link, { fetchImpl: fetch, now: at(3) });
    assert.equal(t.error?.code, 'OTHER_PERSON');
    assert.deepEqual([t.otherPerson.reason, t.otherPerson.working, t.otherPerson.bound], ['folder', false, true]);
    assert.equal(t.error.message, message);
    // Sin red: el guardián no necesita leer
    const o = await trySetupConfig(off, link, { fetchImpl: offline, now: at(3) });
    assert.equal(o.error?.code, 'OTHER_PERSON');
    // Confirmado pero sin red: no se borra nada sin poder leer el calendario nuevo
    const os = await trySetupConfig(off, link, { fetchImpl: offline, now: at(3), switchPerson: true });
    assert.deepEqual([os.ok, os.error.code], [false, 'NETWORK']);
  }
  assert.equal(mau.file('ana/backup.json'), null);
  // El mismo calendario: se vuelve a conectar con sus turnos y su clave (sin preguntar)
  const again = await trySetupConfig(off, parseSetupLink(buildSetupLink(BASE, M.settings.sync)), { fetchImpl: fetch, now: at(4) });
  assert.equal(again.ok, true, JSON.stringify(again.error));
  const s = again.apply(off);
  assert.deepEqual([s.settings.sync.enabled, s.settings.sync.key, codesOf(s)], [true, KEY, MAU]);
  // Sin red, el mismo calendario también (se reintentará solo)
  const o2 = await trySetupConfig(off, parseSetupLink(buildSetupLink(BASE, M.settings.sync)), { fetchImpl: offline, now: at(4) });
  assert.deepEqual([o2.ok, o2.error.code], [true, 'NETWORK']);
});

test('applySyncConfig directo: otro owner, repo, rama o carpeta → se niega; con switchPerson, desde cero (deviceId, ntfy y primer uso se quedan)', () => {
  const M = updateSettings(device({ id: 'iphone', name: 'Mauricio', days: MAU, lastPullAt: T0.toISOString() }),
    { onboardingDone: true, planName: 'Ducuara Mauricio', ntfy: { enabled: true, topic: 't1' } });
  for (const [change, code] of [[{ owner: 'Otra' }, 'OTHER_TARGET'], [{ repo: 'sorella-datos' }, 'OTHER_TARGET'],
    [{ branch: 'datos' }, 'OTHER_TARGET'], [{ dir: 'ana' }, 'OTHER_PERSON'], [{ repo: 'sorella-datos', dir: 'ana' }, 'OTHER_PERSON']]) {
    const cfg = { ...SYNC, key: '', ...change };
    assert.throws(() => applySyncConfig(M, cfg), (e) => e.code === code && e.retry === false && e.otherPerson?.bound === true && /No se cambió nada/.test(e.message), JSON.stringify(change));
    const s = applySyncConfig(M, cfg, { now: at(1), switchPerson: true });
    assert.deepEqual([codesOf(s), s.tombstones, s.changes, s.settings.name, s.settings.planName], [{}, {}, [], '', '']);
    const sy = s.settings.sync;
    assert.ok(isSyncKey(sy.key) && sy.key !== KEY, 'clave nueva');
    assert.deepEqual([sy.prevKey, sy.deviceId, sy.boundTarget, sy.enabled, sy.publisher], ['', 'iphone', '', true, null]);
    assert.deepEqual([s.settings.onboardingDone, s.settings.ntfy.topic], [true, 't1']);
    // Con la clave de ese calendario (la del enlace)
    const other = Buffer.alloc(32, 5).toString('base64url');
    assert.equal(applySyncConfig(M, { ...cfg, key: other }, { switchPerson: true }).settings.sync.key, other);
  }
  // El mismo calendario (otras mayúsculas, otro token, otra clave): sin preguntar y sin borrar nada
  const same = applySyncConfig(M, { ...SYNC, owner: 'mardar91', repo: 'MAURICIO-datos', token: `ghp_${'d'.repeat(36)}` });
  assert.deepEqual([codesOf(same), same.settings.sync.key], [MAU, KEY]);
  // switchPerson sin motivo se ignora
  assert.deepEqual(codesOf(applySyncConfig(M, SYNC, { switchPerson: true })), MAU);
  // Un dispositivo que nunca leyó ni publicó: sus turnos son suyos (p. ej. Ana escanea antes de tener su enlace)
  const own = device({ id: 'android', days: { '2026-10-20': ['F1'] } });
  assert.deepEqual(codesOf(applySyncConfig(own, { ...SYNC, key: '', dir: 'ana' })), { '2026-10-20': ['F1'] });
});

test('configuración cambiada por debajo (syncConfigPatch o updateSettings): no se lee ni se escribe; solo switchPerson sale de ahí', async () => {
  const { sis, fetch, M } = await world();
  assert.equal(M.settings.sync.boundTarget, ROOT);
  const viaPatch = updateSettings(M, { sync: syncConfigPatch({ ...SYNC, repo: 'sorella-datos', key: '' }, M) });
  assert.equal(viaPatch.settings.sync.boundTarget, ROOT, 'el parche conserva de quién son los datos');
  const direct = updateSettings(M, { sync: { repo: 'sorella-datos' } });
  const branch = updateSettings(M, { sync: { branch: 'datos' } });
  const dir = updateSettings(M, { sync: { dir: 'ana' } });
  for (const st of [viaPatch, direct, branch, dir]) {
    for (const fn of [syncNow, pullOnly, becomePublisher]) {
      const f = mockFetch(() => { throw new Error('no debe conectarse'); });
      const r = await fn(st, { fetchImpl: f, now: at(3), force: true, allowEmpty: true });
      assert.deepEqual([r.ok, r.error?.code, r.pushed, r.merged, f.calls.length], [false, 'OTHER_TARGET', false, false, 0]);
      assert.equal(r.error.retry, false);
      assert.equal(r.sync.lastErrorCode, 'OTHER_TARGET');
    }
  }
  // Con la cola: el error queda anotado (lo ve la UI) y no se publica nada
  const store = memStore(direct);
  const q = queue(store, fetch);
  assert.equal((await q.sync()).error.code, 'OTHER_TARGET');
  assert.equal((await q.becomePublisher()).error.code, 'OTHER_TARGET');
  assert.equal(store.get().settings.sync.lastErrorCode, 'OTHER_TARGET');
  assert.equal(sis.file('backup.json'), null);
  // Volver a aplicar su configuración de verdad (la raíz) lo arregla sin borrar nada…
  const back = await trySetupConfig(direct, parseSetupLink(buildSetupLink(BASE, M.settings.sync)), { fetchImpl: fetch, now: at(4) });
  assert.equal(back.ok, true, JSON.stringify(back.error));
  assert.deepEqual(codesOf(back.apply(direct)), MAU);
  // …y para quedarse en el otro calendario hace falta switchPerson (desde cero)
  const t = await q.setup(form({ repo: 'sorella-datos' }));
  assert.equal(t.error.code, 'OTHER_TARGET');
  assert.equal((await q.setup(form({ repo: 'sorella-datos' }), { switchPerson: true })).switched, true);
  assert.deepEqual(codesOf(store.get()), {});
  assert.equal((await q.sync()).pushed, true);
  assert.equal((await published(sis)).withOldKey, false);
});

test('nunca, por ningún camino: los turnos y la clave de Mauricio no llegan a otra carpeta, otro repositorio ni otra rama', async () => {
  const targets = [
    { label: 'otra carpeta', cfg: { dir: 'ana' }, code: 'OTHER_PERSON', at: (w) => published(w.mau, 'ana') },
    { label: 'otro repositorio', cfg: { repo: 'sorella-datos' }, code: 'OTHER_TARGET', at: (w) => published(w.sis) },
    { label: 'otra rama', cfg: { branch: 'datos' }, code: 'OTHER_TARGET', at: (w) => published(w.mau, '', 'datos') },
  ];
  const linkOf = (cfg) => parseSetupLink(buildSetupLink(BASE, { ...SYNC, key: '', ...cfg }));
  // Cada camino intenta llevar el iPhone de Mauricio (el que publica) al otro calendario sin confirmarlo
  const ways = {
    'enlace': async (q, store, cfg) => assert.equal((await q.setup(linkOf(cfg))).ok, false),
    'formulario': async (q, store, cfg) => assert.equal((await q.setup(form(cfg))).ok, false),
    'desconectado + enlace': async (q, store, cfg) => {
      store.set((s) => updateSettings(s, { sync: { enabled: false } }));
      assert.equal((await q.setup(linkOf(cfg))).ok, false);
      store.set((s) => updateSettings(s, { sync: { enabled: true } }));
    },
    'applySyncConfig': async (q, store, cfg) => assert.throws(() => store.set((s) => applySyncConfig(s, { ...SYNC, key: '', ...cfg }))),
    'syncConfigPatch': async (q, store, cfg) => store.set((s) => updateSettings(s, { sync: syncConfigPatch({ ...SYNC, key: '', ...cfg }, s) })),
    'updateSettings': async (q, store, cfg) => store.set((s) => updateSettings(s, { sync: cfg })),
  };
  for (const tg of targets) {
    for (const [way, attempt] of Object.entries(ways)) {
      const what = `${tg.label} / ${way}`;
      const w = await world();
      const store = memStore(w.M);
      const q = queue(store, w.fetch);
      await attempt(q, store, tg.cfg);
      // Después, todo lo que publica: sincronizar, «Usar este dispositivo», «Actualizar ahora»
      await q.sync();
      await q.becomePublisher();
      await q.sync({ force: true, allowEmpty: true });
      assert.equal(await tg.at(w), null, `${what}: no se publicó nada allí`);
      if (syncTargetId(store.get().settings.sync) === ROOT) assert.deepEqual(codesOf(store.get()), MAU, what);
      // Confirmado (switchPerson): allí solo llega un estado limpio con una clave nueva
      const t = await q.setup(tg.cfg.dir ? linkOf(tg.cfg) : form(tg.cfg), { switchPerson: true });
      assert.equal(t.ok, true, `${what}: ${JSON.stringify(t.error)}`);
      assert.equal(t.switched, true, what);
      await q.sync();
      await q.becomePublisher();
      const p = await tg.at(w);
      assert.ok(p, what);
      assert.equal(p.withOldKey, false, `${what}: la clave de Mauricio no sirve allí`);
      assert.equal(p.events, 0, what);
      const key = store.get().settings.sync.key;
      assert.notEqual(key, KEY, what);
      assert.deepEqual((await decryptBackup(p.doc, key)).days, {}, what);
      // El calendario de Mauricio sigue con sus turnos
      assert.deepEqual(Object.keys((await decryptBackup(JSON.parse(w.mau.text('backup.json')), KEY)).days), Object.keys(MAU), what);
    }
  }
});

test('un resultado del calendario anterior que llega después del cambio no trae sus turnos', async () => {
  const { fetch, M, H } = await world();
  // Mauricio añade un día; el ordenador empieza a leerlo… y mientras tanto cambia de calendario
  await run(syncNow, setDay(M, '2026-10-16', ['F1'], { now: at(3) }), fetch, at(3));
  const late = await syncNow(H, { fetchImpl: fetch, now: at(4) });
  assert.equal(late.merged, true);
  const t = await trySetupConfig(H, form({ repo: 'sorella-datos' }), { fetchImpl: fetch, now: at(5), switchPerson: true });
  let s = t.apply(H);
  s = applySyncResult(s, late, { now: at(6) });
  assert.deepEqual(codesOf(s), {});
  assert.equal(s.settings.sync.repo, 'sorella-datos');
  assert.equal(s.settings.sync.lastPullAt, null);
});

test('deshacer el cambio (undoImport con la copia de antes) vuelve al calendario anterior entero: sus turnos no se importan en el nuevo', async () => {
  const { mau, fetch, M } = await world();
  const ana = buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: [''] });
  const ls = memoryStorage();
  const store = memStore(M);
  const q = queue(store, fetch);
  // Como la UI: copia para deshacer → cambio confirmado → publica la carpeta de Ana (vacía)
  const undoKey = saveBeforeImport(store.get(), ls, { now: at(3) });
  assert.equal((await q.setup(parseSetupLink(ana.link), { switchPerson: true })).switched, true);
  assert.equal((await q.sync()).pushed, true);
  // «Deshacer»: vuelve a la raíz con sus turnos, su clave y su nombre
  const prev = undoImport(ls, store.get(), { now: at(4), key: undoKey });
  assert.ok(prev);
  store.set(() => prev);
  const s = store.get();
  assert.deepEqual([s.settings.sync.dir, s.settings.sync.key, s.settings.sync.boundTarget, s.settings.name, codesOf(s)], ['', KEY, ROOT, 'Mauricio', MAU]);
  assert.equal(undoImport(ls, s, { now: at(4), key: undoKey }), null, 'un segundo toque no hace nada');
  const r = await q.sync({ force: true });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.target.dir, '');
  // La carpeta de Ana sigue vacía y la raíz con lo de Mauricio
  assert.deepEqual((await decryptBackup(JSON.parse(mau.text('ana/backup.json')), ana.key)).days, {});
  assert.deepEqual(Object.keys((await decryptBackup(JSON.parse(mau.text('backup.json')), KEY)).days), Object.keys(MAU));

  // Teléfono de Ana sin conectar (con sus turnos) que confirmó el enlace de Mauricio y luego deshace:
  // vuelve a estar sin conectar con sus turnos (la raíz no recibe nada)
  const rootBefore = mau.text('backup.json');
  const A = stateWith({ '2026-10-20': ['F1'] }, { name: 'Ana', onboardingDone: true });
  const as = memStore(A);
  const qa = queue(as, fetch, 20);
  const k2 = saveBeforeImport(A, ls, { now: at(5) });
  const sw = await qa.setup(parseSetupLink(buildSetupLink(BASE, M.settings.sync)), { switchPerson: true });
  assert.deepEqual([sw.ok, sw.switched, sw.readOnly], [true, true, true]);
  const undo = undoImport(ls, as.get(), { now: at(6), key: k2 });
  as.set(() => undo);
  assert.deepEqual([as.get().settings.sync.enabled, as.get().settings.name, codesOf(as.get())], [false, 'Ana', { '2026-10-20': ['F1'] }]);
  await qa.becomePublisher();
  assert.equal(mau.text('backup.json'), rootBefore);
  // Deshacer una importación normal (mismo calendario) sigue igual: conserva la conexión de ahora
  const k3 = saveBeforeImport(M, ls, { now: at(7) });
  const again = undoImport(ls, updateSettings(M, { sync: { token: `ghp_${'e'.repeat(36)}` } }), { now: at(8), key: k3 });
  assert.equal(again.settings.sync.token, `ghp_${'e'.repeat(36)}`);
});

test('un enlace de otro calendario con la clave de este: CONFIG (pide uno nuevo), salvo que allí ya haya una copia con esa clave', async () => {
  const { mau, fetch, M } = await world();
  const bad = parseSetupLink(buildSetupLink(BASE, { ...M.settings.sync, dir: 'ana', name: 'Ana' }));
  assert.equal(bad.key, KEY);
  for (const switchPerson of [false, true]) {
    const t = await trySetupConfig(M, bad, { fetchImpl: fetch, now: at(3), switchPerson });
    assert.deepEqual([t.ok, t.error.code, t.error.retry], [false, 'CONFIG', false]);
    assert.match(t.error.message, /misma clave que el calendario de este dispositivo/);
  }
  // Tampoco en uno conectado que aún no leyó (lleva la clave de su calendario)
  const fresh = device({ id: 'android', days: { '2026-10-20': ['F1'] } });
  assert.equal((await trySetupConfig(fresh, bad, { fetchImpl: fetch, now: at(3) })).error?.code, 'CONFIG');
  assert.equal(mau.file('ana/backup.json'), null);
  // Si esa carpeta ya tiene una copia cifrada con esa clave, es la suya: se puede cambiar (tras confirmarlo)
  await run(syncNow, device({ id: 'android-ana', dir: 'ana', name: 'Ana', days: { '2026-10-21': ['F1'] } }), fetch, at(4));
  const t = await trySetupConfig(M, bad, { fetchImpl: fetch, now: at(5) });
  assert.equal(t.error?.code, 'OTHER_PERSON');
  const sw = await trySetupConfig(M, bad, { fetchImpl: fetch, now: at(5), switchPerson: true });
  assert.equal(sw.ok, true, JSON.stringify(sw.error));
  assert.deepEqual(codesOf(sw.apply(M)), { '2026-10-21': ['F1'] });
});

test('enlace de la raíz con el nombre (buildSetupLink con name): de punta a punta', async () => {
  const gh = fakeGitHub();
  // Quien ayuda conecta su ordenador (sin nombre) a la raíz vacía y publica: aún no hay meta.name
  const pc = memStore(updateSettings(createDefaultState(), { onboardingDone: true }));
  const qp = queue(pc, gh.fetch, 1);
  assert.equal((await qp.setup(form())).ok, true);
  assert.equal((await qp.sync()).pushed, true);
  assert.equal(JSON.parse(gh.text('backup.json')).meta.name, undefined);
  // Sin nombre en el dispositivo el enlace es el de siempre
  const st0 = pc.get().settings;
  assert.equal(buildSetupLink(BASE, { ...st0.sync, name: publicName(st0.name) }), buildSetupLink(BASE, st0.sync));
  // «¿De quién son estos turnos?» → «Mauricio Ducuara»: el enlace lleva el nombre de pila
  pc.set((s) => updateSettings(s, { name: 'Mauricio Ducuara' }));
  const st = pc.get().settings;
  const cfg = parseSetupLink(buildSetupLink(BASE, { ...st.sync, name: publicName(st.name) }));
  assert.deepEqual([cfg.name, cfg.dir, cfg.key], ['Mauricio', '', st.sync.key]);
  // El teléfono de Ana (con sus turnos): el nombre del enlace basta para no mezclarlos
  const ana = stateWith({ '2026-10-20': ['F1'] }, { name: 'Ana' });
  const ta = await trySetupConfig(ana, cfg, { fetchImpl: gh.fetch, now: at(3) });
  assert.equal(ta.error?.code, 'OTHER_PERSON');
  assert.deepEqual([ta.otherPerson.reason, ta.otherPerson.name, ta.otherPerson.bound], ['name', 'Mauricio', false]);
  assert.equal(ta.error.message, 'Este enlace es del calendario de Mauricio y en este dispositivo hay turnos de Ana. No se cambió nada.');
  // Con el mismo nombre (mayúsculas aparte) no se bloquea
  const same = stateWith({ '2026-10-20': ['F1'] }, { name: 'mauricio' });
  assert.equal((await trySetupConfig(same, cfg, { fetchImpl: gh.fetch, now: at(3) })).ok, true);
  // El iPhone de Mauricio (con lo que escaneó, sin nombre): toma el del enlace y, al pasar a publicar,
  // el calendario es suyo
  const ip = memStore(stateWith({ '2026-10-21': ['S1'] }, { onboardingDone: true }));
  const qi = queue(ip, gh.fetch, 5);
  const t = await qi.setup(cfg);
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.readOnly, true, 'publica el ordenador de quien ayuda');
  assert.equal(ip.get().settings.name, 'Mauricio');
  const b = await qi.becomePublisher();
  assert.equal(b.ok, true, JSON.stringify(b.error));
  assert.equal(JSON.parse(gh.text('backup.json')).meta.name, 'Mauricio');
  assert.equal(calName(gh.text('turnos.ics')), 'Turnos de Mauricio');
  // El ordenador lee y sigue con su nombre; sus enlaces ya dicen «Mauricio»
  assert.equal((await qp.sync()).readOnly, true);
  assert.deepEqual(codesOf(pc.get()), { '2026-10-21': ['S1'] });
  assert.equal(parseSetupLink(buildSetupLink(BASE, { ...pc.get().settings.sync, name: publicName(pc.get().settings.name) })).name, 'Mauricio');
});

test('boundTarget: lo ponen la lectura y la publicación; personSwitchState lo quita; el mismo calendario lo conserva al cambiar la clave', async () => {
  const gh = fakeGitHub();
  const M = await run(syncNow, device({ id: 'iphone', name: 'Mauricio', days: MAU }), gh.fetch, at(1));
  assert.equal(M.settings.sync.boundTarget, ROOT);
  assert.equal(syncTargetId({ owner: ' Mardar91 ', repo: 'Mauricio-Datos', dir: 'Ana', branch: 'datos' }), 'mardar91/mauricio-datos/ana:datos');
  const reader = await run(pullOnly, device({ id: 'pc' }), gh.fetch, at(2));
  assert.equal(reader.settings.sync.boundTarget, ROOT);
  // Nunca leyó ni publicó: sin destino; datos de antes (sin sello) pero ya leyó: el configurado
  assert.equal(dataTargetOf(device({ id: 'x', days: MAU }).settings.sync), '');
  assert.equal(dataTargetOf(updateSettings(M, { sync: { boundTarget: '' } }).settings.sync), ROOT);
  assert.equal(personSwitchState(M).settings.sync.boundTarget, '');
  // Sin red tampoco se pone (no se leyó nada)
  assert.equal((await syncNow(device({ id: 'y', days: MAU }), { fetchImpl: offline, now: at(2) })).sync.boundTarget, undefined);
  // Cambiar la clave (backup.json borrado): el mismo calendario, sigue siendo de sus datos
  gh.remove('backup.json');
  const OTHER = Buffer.alloc(32, 9).toString('base64url');
  const t = await trySetupConfig(M, parseSetupLink(buildSetupLink(BASE, { ...M.settings.sync, key: OTHER })), { fetchImpl: gh.fetch, now: at(3) });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  const M2 = t.apply(M);
  assert.deepEqual([M2.settings.sync.key, M2.settings.sync.lastPullAt, M2.settings.sync.boundTarget], [OTHER, null, ROOT]);
  const ana = buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: [''] });
  assert.equal((await trySetupConfig(M2, parseSetupLink(ana.link), { fetchImpl: gh.fetch, now: at(4) })).error?.code, 'OTHER_PERSON');
  const r = await syncNow(M2, { fetchImpl: gh.fetch, now: at(5) });
  assert.equal(r.pushed, true, JSON.stringify(r.error));
  assert.deepEqual(Object.keys((await decryptBackup(JSON.parse(gh.text('backup.json')), OTHER)).days), Object.keys(MAU));
});

test('q.setup: si el estado cambia mientras se comprueba (otra pestaña conectó otro calendario), no guarda nada', async () => {
  const { fetch, M } = await world();
  const store = memStore(createDefaultState());
  let flipped = false;
  const f = async (url, init) => {
    if (!flipped) { flipped = true; store.set(() => M); }
    return fetch(url, init);
  };
  const q = createSyncQueue(store, { fetchImpl: f, clock: () => at(3) });
  const ana = buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: [''] });
  const r = await q.setup(parseSetupLink(ana.link));
  assert.deepEqual([r.ok, r.error.code, r.otherPerson?.reason], [false, 'OTHER_PERSON', 'folder']);
  assert.equal(store.get(), M);
});

test('otro repositorio con otro nombre en su copia: OTHER_PERSON (motivo name) aunque la carpeta se llame igual', async () => {
  const { sis, fetch, H } = await world();
  // La hermana ya publica en su repositorio (raíz) con su nombre
  await run(syncNow, device({ id: 'android', repo: 'sorella-datos', key: Buffer.alloc(32, 4).toString('base64url'), name: 'Lucía', days: { '2026-10-20': ['F1'] } }), fetch, at(3));
  assert.equal(JSON.parse(sis.text('backup.json')).meta.name, 'Lucía');
  const link = parseSetupLink(buildSetupLink(BASE, { ...SYNC, repo: 'sorella-datos', key: Buffer.alloc(32, 4).toString('base64url') }));
  const t = await trySetupConfig(H, link, { fetchImpl: fetch, now: at(4) });
  assert.equal(t.error?.code, 'OTHER_PERSON');
  assert.deepEqual([t.otherPerson.reason, t.otherPerson.name, t.otherPerson.bound], ['name', 'Lucía', true]);
  assert.equal(t.error.message, 'Este enlace es del calendario de Lucía y este dispositivo usa el de Mauricio. No se cambió nada.');
  // Confirmado: solo los de ella, con su nombre
  const sw = await trySetupConfig(H, link, { fetchImpl: fetch, now: at(5), switchPerson: true });
  const s = sw.apply(H);
  assert.deepEqual([codesOf(s), s.settings.name, sw.readOnly], [{ '2026-10-20': ['F1'] }, 'Lucía', true]);
});
