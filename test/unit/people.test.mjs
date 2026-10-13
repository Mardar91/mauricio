import { API, KEY, REPO, SYNC, TOKEN, fakeGitHub, mockFetch, stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSyncKey } from '../../docs/js/core/cipher.js';
import {
  applySyncConfig, applySyncResult, buildPersonLink, buildSetupLink, calendarUrls, decryptBackup, isValidDir,
  listCalendars, normalizeSyncConfig, parseSetupLink, publicName, pullOnly, slugify, syncNow, trySetupConfig, uniqueDir,
} from '../../docs/js/core/sync.js';
import { createDefaultState, setDay, updateSettings } from '../../docs/js/core/store.js';
import { base64UrlDecode } from '../../docs/js/core/util.js';

const T0 = new Date('2026-10-13T08:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);
const BASE = 'https://mardar91.github.io/mauricio/';

// Dispositivo conectado a una carpeta: { id, dir, key, name, days }
function device({ id, dir = '', key = KEY, name = '', days = {} }) {
  let s = stateWith(days, name ? { name } : undefined);
  s = updateSettings(s, { sync: { ...SYNC, deviceId: id, key, dir } });
  return s;
}

async function sync(state, gh, now) {
  const res = await syncNow(state, { fetchImpl: gh.fetch, now });
  return { res, state: applySyncResult(state, res, { now }) };
}

// Abre un enlace en un dispositivo: comprobar + guardar + sincronizar (como la cola de la UI)
async function openLink(state, link, gh, now) {
  const cfg = parseSetupLink(link);
  assert.ok(cfg, 'enlace no válido');
  const t = await trySetupConfig(state, cfg, { fetchImpl: gh.fetch, now });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  return sync(t.apply(state), gh, now);
}

const payloadOf = (link) => JSON.parse(base64UrlDecode(link.split('#setup=')[1]));

test('slugify y uniqueDir: sin acentos, minúsculas, únicos', () => {
  assert.equal(slugify('Ana'), 'ana');
  assert.equal(slugify('  José María Ñúñez  '), 'jose-maria-nunez');
  assert.equal(slugify('Jürgen Groß'), 'jurgen-gross');
  assert.equal(slugify('¡Hola!'), 'hola');
  assert.equal(slugify('李'), '');
  assert.equal(slugify('a'.repeat(40)).length, 32);
  assert.equal(slugify(`${'a'.repeat(31)} b`), 'a'.repeat(31)); // sin guion al final
  assert.equal(uniqueDir('Ana', ['', 'mauricio']), 'ana');
  assert.equal(uniqueDir('Ana', ['ana', 'ana-2']), 'ana-3');
  assert.equal(uniqueDir('李', []), 'persona');
  const long = uniqueDir('a'.repeat(40), ['a'.repeat(32)]);
  assert.equal(long, `${'a'.repeat(30)}-2`);
  assert.ok(isValidDir('') && isValidDir('ana-2') && !isValidDir('Ana') && !isValidDir('a/b') && !isValidDir('a'.repeat(33)));
  assert.equal(publicName('  Ana  María '), 'Ana');
});

test('enlace de configuración con carpeta y nombre; uno antiguo (sin carpeta) es la raíz', () => {
  const root = buildSetupLink(BASE, SYNC);
  assert.equal('dir' in payloadOf(root), false); // la raíz: igual que antes
  assert.equal(parseSetupLink(root).dir, '');
  const ana = buildSetupLink(BASE, { ...SYNC, dir: 'ana', name: 'Ana' });
  assert.deepEqual(payloadOf(ana), { v: 2, owner: 'Mardar91', repo: 'mauricio-datos', branch: '', token: TOKEN, key: KEY, dir: 'ana', name: 'Ana' });
  assert.deepEqual(parseSetupLink(ana), { enabled: true, owner: 'Mardar91', repo: 'mauricio-datos', branch: '', dir: 'ana', token: TOKEN, key: KEY, name: 'Ana' });
  // Formulario: carpeta en mayúsculas → minúsculas; no válida → null; nombre que no es texto → se ignora
  assert.equal(normalizeSyncConfig({ ...SYNC, dir: ' Ana ' }).dir, 'ana');
  assert.equal(normalizeSyncConfig({ ...SYNC, dir: 'ana maria' }), null);
  assert.equal('name' in normalizeSyncConfig({ ...SYNC, name: 5 }), false);
  assert.equal(normalizeSyncConfig({ ...SYNC, d: 'ana' }).dir, 'ana'); // formato corto
});

test('buildPersonLink: carpeta única, clave NUEVA y el mismo repositorio, rama y token', () => {
  const sync = { ...SYNC, branch: 'datos' };
  const p = buildPersonLink(BASE, sync, { name: '  Ana ', existingDirs: ['', 'ana'] });
  assert.equal(p.dir, 'ana-2');
  assert.equal(p.name, 'Ana');
  assert.ok(isSyncKey(p.key));
  assert.notEqual(p.key, KEY);
  const cfg = parseSetupLink(p.link);
  assert.deepEqual(cfg, { enabled: true, owner: 'Mardar91', repo: 'mauricio-datos', branch: 'datos', dir: 'ana-2', token: TOKEN, key: p.key, name: 'Ana' });
  assert.equal(p.urls.webcal, 'webcal://raw.githubusercontent.com/Mardar91/mauricio-datos/datos/ana-2/turnos.ics');
  // Nunca la carpeta de este dispositivo ni la raíz
  assert.equal(buildPersonLink(BASE, { ...SYNC, dir: 'ana' }, { name: 'Ana' }).dir, 'ana-2');
  // Dos enlaces → dos claves distintas
  assert.notEqual(buildPersonLink(BASE, SYNC, { name: 'Ana' }).key, buildPersonLink(BASE, SYNC, { name: 'Ana' }).key);
  // Errores: sin nombre; sin conexión completa
  assert.throws(() => buildPersonLink(BASE, SYNC, { name: '  ' }), (e) => e.code === 'NAME' && /nombre/.test(e.message));
  assert.throws(() => buildPersonLink(BASE, { ...SYNC, token: '' }, { name: 'Ana' }), (e) => e.code === 'CONFIG');
});

test('dos personas en el mismo repo: cada carpeta con su clave, sus archivos y su publisher', async () => {
  const gh = fakeGitHub();
  // Mauricio publica en la raíz
  let M = device({ id: 'iphone', name: 'Mauricio', days: { '2026-10-12': ['F1'], '2026-10-13': ['S1'] } });
  ({ state: M } = await sync(M, gh, at(1)));
  const rootSha = gh.file('backup.json').sha;
  assert.ok(gh.text('turnos.ics').includes('X-WR-CALNAME:Turnos de Mauricio'));
  // Quien ayuda crea el enlace de Ana desde el iPhone de Mauricio (carpetas que ya hay: la raíz)
  const existing = (await listCalendars(M.settings.sync, { fetchImpl: gh.fetch })).map((c) => c.dir);
  assert.deepEqual(existing, ['']);
  const p = buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: existing });
  assert.equal(p.dir, 'ana');
  // El Android de Ana (nuevo, sin nombre) abre el enlace y carga sus turnos
  let A = createDefaultState();
  const first = await openLink(A, p.link, gh, at(2));
  A = first.state;
  assert.equal(first.res.ok, true, JSON.stringify(first.res.error));
  assert.deepEqual([A.settings.sync.dir, A.settings.sync.key, A.settings.name], ['ana', p.key, 'Ana']);
  A = setDay(A, '2026-10-14', ['N1'], { now: at(3) });
  const second = await sync(A, gh, at(4));
  A = second.state;
  assert.equal(second.res.pushed, true);
  // Sus archivos van en ana/ y la raíz no se toca
  assert.ok(gh.file('ana/backup.json') && gh.file('ana/turnos.ics'));
  assert.equal(gh.file('backup.json').sha, rootSha);
  for (const c of gh.puts()) assert.match(c.url, /contents\/(?:ana\/)?(?:backup\.json|turnos\.ics)$/);
  assert.ok(gh.puts('ana/backup.json').every((c) => /^Turnos \(ana\):/.test(c.json().message)));
  const doc = JSON.parse(gh.text('ana/backup.json'));
  assert.equal(doc.meta.name, 'Ana');
  assert.equal(doc.meta.publisher, A.settings.sync.deviceId);
  assert.deepEqual(Object.keys((await decryptBackup(doc, p.key)).days), ['2026-10-14']);
  await assert.rejects(decryptBackup(doc, KEY), (e) => e.code === 'DECRYPT'); // la clave de Mauricio no sirve
  const ics = gh.text('ana/turnos.ics');
  assert.ok(ics.includes('X-WR-CALNAME:Turnos de Ana'));
  assert.ok(ics.includes('UID:2026-10-14-N1@turnos-dir-ana'));
  assert.ok(!ics.includes('2026-10-12'));
  // Mauricio sigue publicando lo suyo sin ver los turnos de Ana
  const again = await sync(setDay(M, '2026-10-15', ['F1'], { now: at(5) }), gh, at(6));
  assert.equal(again.res.ok, true);
  assert.equal(again.res.readOnly, false);
  assert.equal(again.state.days['2026-10-14'], undefined);
  assert.ok(!gh.text('turnos.ics').includes('N1'));
  // «Calendarios de la familia»
  const cals = await listCalendars(M.settings.sync, { fetchImpl: gh.fetch });
  assert.deepEqual(cals.map((c) => [c.dir, c.name, c.mine, c.hasBackup, c.hasCalendar]), [['', 'Mauricio', true, true, true], ['ana', 'Ana', false, true, true]]);
  assert.equal(cals[1].urls.webcal, calendarUrls({ ...SYNC, dir: 'ana' }).webcal);
  assert.equal(cals[1].updatedAt, at(4).toISOString());
  // Un segundo enlace para «Ana» ya no puede usar ana/
  assert.equal(buildPersonLink(BASE, M.settings.sync, { name: 'Ana', existingDirs: cals.map((c) => c.dir) }).dir, 'ana-2');
});

test('otra carpeta nunca hereda la clave guardada; la misma carpeta sí', async () => {
  const gh = fakeGitHub();
  const M = device({ id: 'iphone', days: { '2026-10-12': ['F1'] } });
  // Mismo sitio, sin clave en el formulario: se sigue usando la del dispositivo
  const same = await trySetupConfig(M, { ...SYNC, key: '' }, { fetchImpl: gh.fetch, now: at(1) });
  assert.equal(same.ok, true);
  assert.equal(same.apply(M).settings.sync.key, KEY);
  // Otra carpeta (vacía) sin clave: clave nueva, y la anterior no queda como prevKey
  const other = await trySetupConfig(M, { ...SYNC, key: '', dir: 'nuevo' }, { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(other.ok, true);
  const applied = other.apply(M).settings.sync;
  assert.equal(applied.dir, 'nuevo');
  assert.ok(isSyncKey(applied.key));
  assert.notEqual(applied.key, KEY);
  assert.equal(applied.prevKey, '');
  assert.equal(applied.publisher, null);
  // applySyncConfig directo, otra carpeta: igual (clave nueva)
  const direct = applySyncConfig(M, { ...SYNC, key: '', dir: 'otra' }, { now: at(3) }).settings.sync;
  assert.notEqual(direct.key, KEY);
  assert.equal(direct.prevKey, '');
  // Otra carpeta con copia cifrada y sin clave → NO_KEY (no se guarda nada)
  const A = device({ id: 'android', dir: 'ana', key: Buffer.alloc(32, 3).toString('base64url'), days: { '2026-10-14': ['N1'] } });
  await sync(A, gh, at(4));
  const noKey = await trySetupConfig(M, { ...SYNC, key: '', dir: 'ana' }, { fetchImpl: gh.fetch, now: at(5) });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error.code, 'NO_KEY');
});

test('resultados de otra carpeta no se aplican; carpeta no válida → CONFIG sin red', async () => {
  const gh = fakeGitHub();
  const A = device({ id: 'android', dir: 'ana', days: { '2026-10-14': ['N1'] } });
  const res = await syncNow(A, { fetchImpl: gh.fetch, now: at(1) });
  assert.equal(res.ok, true);
  assert.equal(res.target.dir, 'ana');
  // Mientras tanto el dispositivo pasó a la raíz: el resultado de ana/ no vale
  const moved = updateSettings(A, { sync: { dir: '' } });
  assert.equal(applySyncResult(moved, res, { now: at(2) }), moved);
  // Carpeta no válida (guardada a mano): CONFIG y ninguna petición
  const bad = updateSettings(A, { sync: { dir: 'ana/../x' } });
  const f = mockFetch(() => ({ status: 500 }));
  const r = await syncNow(bad, { fetchImpl: f, now: at(3) });
  assert.equal(r.error.code, 'CONFIG');
  assert.equal(f.calls.length, 0);
  // pullOnly lee solo su carpeta
  const p = await pullOnly(device({ id: 'tablet', dir: 'ana' }), { fetchImpl: gh.fetch, now: at(4) });
  assert.deepEqual(p.pulledDays, ['2026-10-14']);
  assert.ok(gh.fetch.calls.filter((c) => c.method === 'GET' && c.url.includes('/contents/')).every((c) => c.url.includes('/contents/ana/')));
});

test('listCalendars: raíz antigua sin meta.name, solo turnos.ics, carpetas ajenas; repo vacío', async () => {
  const gh = fakeGitHub();
  // Raíz de una versión anterior: backup sin meta.name y calendario «Turnos de Mauricio»
  gh.write('backup.json', JSON.stringify({ format: 'turnos-backup', v: 3, meta: { rev: 4, savedAt: '2026-10-01T10:00:00.000Z', deviceId: 'x', days: 1, publisher: 'x', publisherSince: null }, enc: { alg: 'AES-GCM', iv: 'a', data: 'b' } }));
  gh.write('turnos.ics', 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Turnos de Mauricio\r\nEND:VCALENDAR\r\n');
  gh.write('luis/turnos.ics', 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Turnos de Luis\r\nEND:VCALENDAR\r\n'); // solo calendario
  gh.write('sin-nombre/turnos.ics', 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Mis turnos\r\nEND:VCALENDAR\r\n');
  gh.write('rota/backup.json', '{no es json');
  gh.write('docs/notas.md', 'otra cosa');   // carpeta sin calendario
  gh.write('Ana/turnos.ics', 'x');          // nombre de carpeta no válido
  const cals = await listCalendars({ ...SYNC, dir: 'luis' }, { fetchImpl: gh.fetch });
  assert.deepEqual(cals.map((c) => [c.dir, c.name, c.updatedAt, c.mine]), [
    ['', 'Mauricio', '2026-10-01T10:00:00.000Z', false],
    ['luis', 'Luis', null, true],
    ['rota', null, null, false],
    ['sin-nombre', null, null, false],
  ]);
  // Repo vacío → []
  assert.deepEqual(await listCalendars(SYNC, { fetchImpl: fakeGitHub({ empty: true }).fetch }), []);
  // Errores de GitHub: SyncError con su código
  await assert.rejects(listCalendars(SYNC, { fetchImpl: mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } })) }), (e) => e.code === 'AUTH');
  await assert.rejects(listCalendars({ ...SYNC, token: '' }, { fetchImpl: gh.fetch }), (e) => e.code === 'CONFIG');
});

test('listCalendars con fetch simulado: rutas de la API, rama y nombres', async () => {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64');
  const f = mockFetch((req) => {
    const u = new URL(req.url);
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
    const p = u.pathname;
    if (p === `${REPO}/git/ref/heads/datos`) return { body: { object: { sha: 'abc' } } };
    assert.equal(u.searchParams.get('ref'), 'datos', req.url);
    if (p === `${REPO}/contents`) return { body: [{ type: 'file', name: 'README.md' }, { type: 'dir', name: 'ana' }, { type: 'dir', name: 'mauricio' }] };
    if (p === `${REPO}/contents/ana`) return { body: [{ type: 'file', name: 'backup.json' }, { type: 'file', name: 'turnos.ics' }] };
    if (p === `${REPO}/contents/mauricio`) return { body: [{ type: 'file', name: 'otra.txt' }] };
    if (p === `${REPO}/contents/ana/backup.json`) {
      return { body: { sha: 's1', encoding: 'base64', content: b64({ format: 'turnos-backup', v: 3, meta: { name: 'Ana', savedAt: '2026-10-12T18:00:00.000Z' } }) } };
    }
    return { status: 404, body: { message: 'Not Found' } };
  });
  const cals = await listCalendars({ ...SYNC, branch: 'datos' }, { fetchImpl: f });
  assert.deepEqual(cals.map((c) => [c.dir, c.name, c.updatedAt]), [['ana', 'Ana', '2026-10-12T18:00:00.000Z']]);
  assert.equal(cals[0].urls.https, 'https://raw.githubusercontent.com/Mardar91/mauricio-datos/datos/ana/turnos.ics');
  assert.ok(f.calls.every((c) => c.url.startsWith(API)));
});

test('formulario sin carpeta: se queda en la del dispositivo; enlace sin carpeta: la raíz', async () => {
  const gh = fakeGitHub();
  const annaKey = Buffer.alloc(32, 3).toString('base64url');
  let A = device({ id: 'android', dir: 'ana', key: annaKey, days: { '2026-10-14': ['N1'] } });
  ({ state: A } = await sync(A, gh, at(1)));
  // Renovar el token desde un formulario que no conoce la carpeta (y sin clave): sigue en ana/ con su clave
  const NEW_TOKEN = `github_pat_${'C'.repeat(22)}_${'D'.repeat(59)}`;
  const form = normalizeSyncConfig({ owner: 'Mardar91', repo: 'mauricio-datos', branch: '', token: NEW_TOKEN, key: '' });
  assert.equal('dir' in form, false);
  const t = await trySetupConfig(A, form, { fetchImpl: gh.fetch, now: at(2) });
  assert.equal(t.ok, true, JSON.stringify(t.error));
  const s = t.apply(A).settings.sync;
  assert.deepEqual([s.dir, s.key, s.token, s.publisher], ['ana', annaKey, NEW_TOKEN, 'android']);
  assert.equal(applySyncConfig(A, form, { now: at(3) }).settings.sync.dir, 'ana');
  // Un enlace antiguo (sin carpeta) sí es la raíz: con otra clave y una copia allí → DECRYPT, nada cambia
  const M = device({ id: 'iphone', days: { '2026-10-12': ['F1'] } });
  await sync(M, gh, at(4));
  const old = parseSetupLink(buildSetupLink(BASE, { ...SYNC, key: annaKey }));
  assert.equal(old.dir, '');
  const r = await trySetupConfig(A, old, { fetchImpl: gh.fetch, now: at(5) });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'DECRYPT');
});
