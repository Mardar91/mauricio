// Enlace de OTRA persona en un dispositivo (SPEC §11): trySetupConfig no mezcla calendarios
// (OTHER_PERSON) salvo cambio confirmado (switchPerson, desde un estado limpio). Y lo que un dispositivo
// vacío adopta del remoto: solo lo que aquí está vacío o de fábrica.
import { KEY, SYNC, fakeGitHub, stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applySyncResult, becomePublisher, buildPersonLink, buildSetupLink, createSyncQueue, decryptBackup, parseSetupLink,
  syncNow, trySetupConfig,
} from '../../docs/js/core/sync.js';
import { createDefaultState, mergeStates, personSwitchState, setDay, updateSettings } from '../../docs/js/core/store.js';

const T0 = new Date('2026-10-13T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);
const BASE = 'https://mardar91.github.io/mauricio/';
const codesOf = (st) => Object.fromEntries(Object.entries(st.days).map(([k, d]) => [k, d.codes]));
const calName = (ics) => /X-WR-CALNAME:(.*)\r\n/.exec(ics)?.[1];

function device({ id, dir = '', key = KEY, name = '', days = {} }) {
  let s = stateWith(days, name ? { name } : undefined);
  return updateSettings(s, { sync: { ...SYNC, deviceId: id, key, dir } });
}
async function sync(state, gh, now) {
  const res = await syncNow(state, { fetchImpl: gh.fetch, now });
  return applySyncResult(state, res, { now });
}
// Store mínimo como el de la UI (para la cola)
function memStore(st) {
  let s = st;
  return { get: () => s, set: (fn) => { const r = fn(structuredClone(s)); s = r || s; return s; }, saveOk: () => true };
}

// Mauricio publica en la raíz (S1 el 13 y el 14); Ana tiene su enlace (carpeta ana/, vacía)
async function family() {
  const gh = fakeGitHub();
  const M = await sync(device({ id: 'iphone-mau', name: 'Mauricio', days: { '2026-10-13': ['S1'], '2026-10-14': ['S1'] } }), gh, at(1));
  const ana = buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: [''] });
  return { gh, M, ana };
}

test('Mauricio (conectado) abre el enlace de Ana: OTHER_PERSON, no cambia nada y no escribe', async () => {
  const { gh, M, ana } = await family();
  const puts = gh.puts().length;
  const t = await trySetupConfig(M, parseSetupLink(ana.link), { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'OTHER_PERSON');
  assert.equal(t.error.retry, false);
  assert.equal(t.error.message, 'Este enlace es del calendario de Ana y este dispositivo usa el de Mauricio. No se cambió nada.');
  assert.match(t.error.detail, /Mardar91\/mauricio-datos\/\(raíz\).*Mardar91\/mauricio-datos\/ana/);
  assert.deepEqual(t.otherPerson, {
    reason: 'folder', name: 'Ana', dir: 'ana', current: { name: 'Mauricio', dir: '' }, working: true, bound: true,
    from: 'Mardar91/mauricio-datos', to: 'Mardar91/mauricio-datos, carpeta ana',
  });
  assert.equal(t.apply, undefined);
  assert.equal(gh.puts().length, puts);
  assert.equal(gh.file('ana/backup.json'), null);
  // Con la cola: tampoco se guarda nada
  const store = memStore(M);
  const q = createSyncQueue(store, { fetchImpl: gh.fetch, clock: () => at(3) });
  const r = await q.setup(parseSetupLink(ana.link));
  assert.equal(r.error.code, 'OTHER_PERSON');
  assert.equal(store.get(), M);
});

test('cambio confirmado (switchPerson): estado limpio, nada de Mauricio llega a ana/ y su calendario sigue igual', async () => {
  const { gh, M, ana } = await family();
  const rootBackup = gh.text('backup.json');
  const rootIcs = gh.text('turnos.ics');
  let s = updateSettings(M, { planName: 'Ducuara Mauricio', weeklyHours: 30, onboardingDone: true,
    ntfy: { enabled: true, topic: 'turnos-mauricio-abc' }, supplements: { hourlyWage: 20 } });
  const store = memStore(s);
  const q = createSyncQueue(store, { fetchImpl: gh.fetch, clock: () => at(2) });
  const t = await q.setup(parseSetupLink(ana.link), { switchPerson: true });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.switched, true);
  s = store.get();
  assert.deepEqual(codesOf(s), {});
  assert.deepEqual([s.settings.name, s.settings.planName, s.settings.weeklyHours, s.settings.supplements.hourlyWage], ['Ana', '', 35, null]);
  assert.deepEqual(s.changes, []);
  assert.deepEqual([s.settings.sync.dir, s.settings.sync.key, s.settings.sync.deviceId, s.settings.sync.prevKey], ['ana', ana.key, 'iphone-mau', '']);
  // Lo del dispositivo se queda
  assert.deepEqual([s.settings.onboardingDone, s.settings.ntfy.enabled, s.settings.ntfy.topic], [true, true, 'turnos-mauricio-abc']);
  // Publica su carpeta (vacía) con el nombre de Ana; la raíz no se toca
  const r = await q.sync();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const doc = JSON.parse(gh.text('ana/backup.json'));
  assert.equal(doc.meta.name, 'Ana');
  assert.deepEqual((await decryptBackup(doc, ana.key)).days, {});
  assert.equal(calName(gh.text('ana/turnos.ics')), 'Turnos de Ana');
  assert.equal(gh.text('backup.json'), rootBackup);
  assert.equal(gh.text('turnos.ics'), rootIcs);
});

test('Ana (conectada a ana/) abre el enlace de Mauricio: OTHER_PERSON con su nombre; al cambiar, solo lee la raíz', async () => {
  const { gh, M, ana } = await family();
  // Ana publica F1 el 13 y el 14 (editados después que los de Mauricio)
  let A = createDefaultState();
  A = setDay(A, '2026-10-13', ['F1'], { now: at(5) });
  A = setDay(A, '2026-10-14', ['F1'], { now: at(5) });
  const sa = memStore(A);
  const qa = createSyncQueue(sa, { fetchImpl: gh.fetch, clock: () => at(6) });
  assert.equal((await qa.setup(parseSetupLink(ana.link))).ok, true);
  assert.equal((await qa.sync()).pushed, true);
  const Anow = sa.get();
  assert.deepEqual([Anow.settings.sync.dir, Anow.settings.name], ['ana', 'Ana']);
  // El enlace de la raíz (sin nombre: enlace antiguo)
  const rootLink = parseSetupLink(buildSetupLink(BASE, M.settings.sync));
  assert.equal(rootLink.name, undefined);
  const rootBackup = gh.text('backup.json');
  const t = await trySetupConfig(Anow, rootLink, { fetchImpl: gh.fetch, now: at(7) });
  assert.equal(t.ok, false);
  assert.equal(t.error.code, 'OTHER_PERSON');
  assert.equal(t.otherPerson.name, 'Mauricio', 'el nombre sale de meta.name de la copia');
  assert.equal(t.error.message, 'Este enlace es del calendario de Mauricio y este dispositivo usa el de Ana. No se cambió nada.');
  // Cambio confirmado: el teléfono de Ana pasa a leer la raíz sin llevar sus F1
  const s = memStore(Anow);
  const q = createSyncQueue(s, { fetchImpl: gh.fetch, clock: () => at(8) });
  const sw = await q.setup(rootLink, { switchPerson: true });
  assert.equal(sw.ok, true, JSON.stringify(sw.error));
  assert.equal(sw.readOnly, true, 'el iPhone de Mauricio sigue publicando');
  assert.deepEqual(codesOf(s.get()), { '2026-10-13': ['S1'], '2026-10-14': ['S1'] });
  assert.equal(s.get().settings.name, 'Mauricio', 'adopta el nombre del calendario (aquí quedó vacío)');
  // Aunque luego «Usar este dispositivo»: la raíz sigue con los turnos y el nombre de Mauricio
  const r = await q.becomePublisher();
  assert.equal(r.ok, true, JSON.stringify(r.error));
  const data = await decryptBackup(JSON.parse(gh.text('backup.json')), KEY);
  assert.deepEqual(Object.fromEntries(Object.entries(data.days).map(([k, d]) => [k, d.codes])), { '2026-10-13': ['S1'], '2026-10-14': ['S1'] });
  assert.equal(calName(gh.text('turnos.ics')), 'Turnos de Mauricio');
  assert.notEqual(gh.text('backup.json'), rootBackup);
  // ana/ conserva los turnos de Ana
  const anaData = await decryptBackup(JSON.parse(gh.text('ana/backup.json')), ana.key);
  assert.deepEqual(Object.keys(anaData.days).map((k) => anaData.days[k].codes), [['F1'], ['F1']]);
});

test('sin conectar: con turnos y otro nombre → OTHER_PERSON; sin nombre o con el mismo, no se bloquea', async () => {
  const { gh, ana } = await family();
  const link = parseSetupLink(ana.link);
  const days = { '2026-10-20': ['F1'] };
  // Teléfono de Mauricio sin conectar, con turnos escaneados: el enlace es para Ana
  const mau = stateWith(days, { name: 'Mauricio' });
  const t = await trySetupConfig(mau, link, { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t.error?.code, 'OTHER_PERSON');
  assert.deepEqual([t.otherPerson.reason, t.otherPerson.name, t.otherPerson.working], ['name', 'Ana', false]);
  assert.equal(t.error.message, 'Este enlace es del calendario de Ana y en este dispositivo hay turnos de Mauricio. No se cambió nada.');
  // Ana escanea antes de tener su enlace (sin nombre, o con el suyo; mayúsculas y acentos no cuentan)
  for (const name of [undefined, 'Ana', 'ána maría']) {
    const s = stateWith(days, name ? { name } : undefined);
    const r = await trySetupConfig(s, link, { fetchImpl: gh.fetch, now: at(3) });
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.error)}`);
    assert.equal(r.switched, false);
    const applied = r.apply(s);
    assert.deepEqual(codesOf(applied), { '2026-10-20': ['F1'] }, 'sus turnos se quedan');
    assert.equal(applied.settings.name, name ? name.trim() : 'Ana');
  }
  // Sin turnos y con otro nombre: no se bloquea (nada que mezclar) y conserva su nombre
  const empty = updateSettings(createDefaultState(), { name: 'Mauricio' });
  const e = await trySetupConfig(empty, link, { fetchImpl: gh.fetch, now: at(4) });
  assert.equal(e.ok, true, JSON.stringify(e.error));
  assert.equal(e.apply(empty).settings.name, 'Mauricio');
});

test('sin conectar: el nombre de la copia remota (meta.name) cuenta aunque el enlace no lo traiga', async () => {
  const { gh, M } = await family();
  const rootLink = parseSetupLink(buildSetupLink(BASE, M.settings.sync));
  const ana = stateWith({ '2026-10-20': ['F1'] }, { name: 'Ana' });
  const t = await trySetupConfig(ana, rootLink, { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t.error?.code, 'OTHER_PERSON');
  assert.equal(t.otherPerson.name, 'Mauricio');
  // Confirmado: sus F1 no se mezclan con la raíz
  const sw = await trySetupConfig(ana, rootLink, { fetchImpl: gh.fetch, now: at(3), switchPerson: true });
  assert.equal(sw.ok, true);
  const s = sw.apply(ana);
  assert.deepEqual(codesOf(s), { '2026-10-13': ['S1'], '2026-10-14': ['S1'] });
  assert.equal(s.settings.name, 'Mauricio');
});

test('la misma carpeta nunca se bloquea (otra clave, otro token, mayúsculas en owner/repo); switchPerson sin motivo no borra nada', async () => {
  const { gh, M } = await family();
  // Otro nombre en la copia (p. ej. la publicó quien ayuda) pero es la carpeta de este dispositivo
  const helper = await sync(device({ id: 'pc', name: 'Pedro' }), gh, at(2));
  assert.equal(helper.settings.sync.publisher, 'iphone-mau');
  const again = await trySetupConfig(helper, parseSetupLink(buildSetupLink(BASE, helper.settings.sync)), { fetchImpl: gh.fetch, now: at(3) });
  assert.equal(again.ok, true, JSON.stringify(again.error));
  // Owner y repo con otras mayúsculas: es el mismo repositorio de GitHub
  gh.override = (req) => (/\/repos\/mardar91\/MAURICIO-datos/.test(req.url)
    ? gh.fetch(req.url.replace('/repos/mardar91/MAURICIO-datos', '/repos/Mardar91/mauricio-datos'), { method: req.method, headers: req.headers, body: req.body })
    : null);
  const lower = parseSetupLink(buildSetupLink(BASE, { ...M.settings.sync, owner: 'mardar91', repo: 'MAURICIO-datos' }));
  const t = await trySetupConfig(M, lower, { fetchImpl: gh.fetch, now: at(4) });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  assert.equal(t.apply(M).settings.sync.key, KEY);
  gh.override = null;
  // switchPerson cuando no hace falta: se ignora (los turnos se quedan)
  const keep = await trySetupConfig(M, parseSetupLink(buildSetupLink(BASE, M.settings.sync)), { fetchImpl: gh.fetch, now: at(5), switchPerson: true });
  assert.equal(keep.ok, true);
  assert.equal(keep.switched, false);
  assert.deepEqual(codesOf(keep.apply(M)), codesOf(M));
});

test('un error al leer va antes que OTHER_PERSON (sin red, clave equivocada): no cambia nada', async () => {
  const { gh, M, ana } = await family();
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  const t = await trySetupConfig(M, parseSetupLink(ana.link), { fetchImpl: offline, now: at(2) });
  assert.deepEqual([t.ok, t.error.code], [false, 'NETWORK']);
  // Con switchPerson y sin red tampoco
  const t2 = await trySetupConfig(M, parseSetupLink(ana.link), { fetchImpl: offline, now: at(2), switchPerson: true });
  assert.deepEqual([t2.ok, t2.error.code], [false, 'NETWORK']);
  // Clave equivocada en el enlace de Ana (su carpeta ya tiene copia): DECRYPT
  await sync(device({ id: 'android-ana', dir: 'ana', key: ana.key, days: { '2026-10-20': ['F1'] } }), gh, at(3));
  const wrong = parseSetupLink(buildSetupLink(BASE, { ...M.settings.sync, dir: 'ana', key: KEY }));
  const t3 = await trySetupConfig(M, wrong, { fetchImpl: gh.fetch, now: at(4) });
  assert.deepEqual([t3.ok, t3.error.code], [false, 'DECRYPT']);
});

test('personSwitchState: solo deviceId, ntfy y el primer uso', () => {
  let s = stateWith({ '2026-10-13': ['S1'] }, { name: 'Mauricio', planName: 'Ducuara Mauricio', weeklyHours: 30, onboardingDone: true });
  s = updateSettings(s, { sync: { ...SYNC, deviceId: 'iphone', dir: 'x' }, ntfy: { enabled: true, topic: 't1' }, reminders: { eveningTime: '19:00' } });
  const c = personSwitchState(s);
  const def = createDefaultState();
  assert.deepEqual(c.days, {});
  assert.deepEqual(c.codes, def.codes);
  assert.deepEqual(c.changes, []);
  assert.equal(c.settings.sync.deviceId, 'iphone');
  assert.deepEqual({ ...c.settings.sync, deviceId: '' }, def.settings.sync);
  assert.deepEqual([c.settings.ntfy.enabled, c.settings.ntfy.topic, c.settings.onboardingDone], [true, 't1', true]);
  assert.deepEqual([c.settings.name, c.settings.planName, c.settings.weeklyHours, c.settings.reminders.eveningTime, c.settings.calendarUpdatedAt],
    ['', '', 35, '20:00', null]);
});

// ---------- Ajustes que adopta un dispositivo vacío ----------

test('dispositivo vacío: el nombre escrito en el primer uso no se cambia por el de quien ayuda', async () => {
  const gh = fakeGitHub();
  // El ordenador de quien ayuda hizo el primer uso con su nombre y publicó la raíz
  await sync(updateSettings(createDefaultState(), { name: 'Pedro', onboardingDone: true, sync: { ...SYNC, deviceId: 'pc' } }), gh, at(1));
  assert.equal(JSON.parse(gh.text('backup.json')).meta.name, 'Pedro');
  // iPhone de Mauricio recién instalado: escribió su nombre y el del plan
  const ip = updateSettings(createDefaultState(), { onboardingDone: true, name: 'Mauricio', planName: 'Ducuara Mauricio' });
  const t = await trySetupConfig(ip, parseSetupLink(buildSetupLink(BASE, SYNC)), { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  const s = t.apply(ip);
  assert.deepEqual([s.settings.name, s.settings.planName], ['Mauricio', 'Ducuara Mauricio']);
  // Al pasar a publicar, el calendario se llama como él
  const r = await becomePublisher(s, { fetchImpl: gh.fetch, now: at(3) });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(calName(gh.text('turnos.ics')), 'Turnos de Mauricio');
  assert.equal(JSON.parse(gh.text('backup.json')).meta.name, 'Mauricio');
  // Un nombre vacío en la copia nunca borra el de aquí
  const remote = updateSettings(createDefaultState(), { name: '', planName: '' });
  const m = mergeStates(updateSettings(createDefaultState(), { name: 'Ana', planName: 'Ducuara Ana' }), remote, { adoptSettings: true }).state;
  assert.deepEqual([m.settings.name, m.settings.planName], ['Ana', 'Ducuara Ana']);
});

test('dispositivo vacío: adopta solo lo que aquí está vacío o de fábrica', () => {
  const remote = updateSettings(createDefaultState(), {
    name: 'Mauricio', planName: 'Ducuara Mauricio', weeklyHours: 30, workDaysPerWeek: 4, holidaysReduceSoll: false,
    supplements: { night: { pct: 25 }, hourlyWage: 19.5 }, balances: { vacationDaysPerYear: 28 },
  });
  const adopt = (local) => mergeStates(local, remote, { adoptSettings: true }).state.settings;
  // Todo de fábrica: se adopta todo
  const all = adopt(createDefaultState());
  assert.deepEqual([all.name, all.planName, all.weeklyHours, all.workDaysPerWeek, all.holidaysReduceSoll, all.supplements.night.pct, all.supplements.hourlyWage, all.balances.vacationDaysPerYear],
    ['Mauricio', 'Ducuara Mauricio', 30, 4, false, 25, 19.5, 28]);
  // Lo elegido aquí se queda
  const mine = adopt(updateSettings(createDefaultState(), { weeklyHours: 20, supplements: { hourlyWage: 15 }, balances: { vacationCarryOver: 2 } }));
  assert.deepEqual([mine.weeklyHours, mine.supplements.hourlyWage, mine.supplements.night.pct, mine.balances.vacationDaysPerYear, mine.balances.vacationCarryOver],
    [20, 15, 26, 30, 2]);
  assert.equal(mine.workDaysPerWeek, 4);
  // Nombre del plan: solo si el nombre de pila coincide (o aquí no hay)
  assert.equal(adopt(updateSettings(createDefaultState(), { name: 'mauricio' })).planName, 'Ducuara Mauricio');
  const other = adopt(updateSettings(createDefaultState(), { name: 'Ana' }));
  assert.deepEqual([other.name, other.planName], ['Ana', '']);
  // Sin adoptSettings (dispositivo con turnos): nada de esto
  const withDays = mergeStates(stateWith({ '2026-10-13': ['S1'] }), remote, { adoptSettings: false }).state.settings;
  assert.deepEqual([withDays.name, withDays.weeklyHours], ['', 35]);
});
