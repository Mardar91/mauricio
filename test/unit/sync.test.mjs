import { stateWith, mockFetch, REAL_WEEK, T0 } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testConnection, ensureBranch, pushData, pullBackup, calendarUrls, parseSetupLink, buildSetupLink, SyncError,
} from '../../docs/js/core/sync.js';
import { updateSettings, importBackup, setDay, createDefaultState } from '../../docs/js/core/store.js';

const TOKEN = 'github_pat_TEST_123';
const SYNC = { enabled: true, owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: TOKEN };
const API = 'https://api.github.com';
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

// GitHub simulado en memoria (refs + contenidos por rama)
function fakeGitHub({ branches = { main: 'sha-main' }, files = {}, repoStatus = 200 } = {}) {
  const gh = { branches: { ...branches }, files: structuredClone(files), seq: 0, conflictsLeft: 0 };
  gh.fetch = mockFetch((req) => {
    const u = new URL(req.url);
    const p = decodeURIComponent(u.pathname);
    let m;
    if (p === '/repos/Mardar91/mauricio' && req.method === 'GET') {
      if (repoStatus !== 200) return { status: repoStatus, body: { message: 'x' } };
      return { body: { full_name: 'Mardar91/mauricio', default_branch: 'main', private: false, permissions: { push: true } } };
    }
    if ((m = /^\/repos\/Mardar91\/mauricio\/git\/ref\/heads\/(.+)$/.exec(p)) && req.method === 'GET') {
      const sha = gh.branches[m[1]];
      return sha ? { body: { ref: `refs/heads/${m[1]}`, object: { sha, type: 'commit' } } } : { status: 404, body: { message: 'Not Found' } };
    }
    if (p === '/repos/Mardar91/mauricio/git/refs' && req.method === 'POST') {
      const { ref, sha } = req.json();
      const name = ref.replace('refs/heads/', '');
      if (gh.branches[name]) return { status: 422, body: { message: 'Reference already exists' } };
      gh.branches[name] = sha;
      return { status: 201, body: { ref, object: { sha } } };
    }
    if ((m = /^\/repos\/Mardar91\/mauricio\/contents\/(.+)$/.exec(p))) {
      const path = m[1];
      if (req.method === 'GET') {
        const f = gh.files[u.searchParams.get('ref')]?.[path];
        return f ? { body: { path, sha: f.sha, encoding: 'base64', content: f.content.match(/.{1,60}/g).join('\n') } } : { status: 404, body: { message: 'Not Found' } };
      }
      if (req.method === 'PUT') {
        const body = req.json();
        const branchFiles = (gh.files[body.branch] ||= {});
        const cur = branchFiles[path];
        if (gh.conflictsLeft > 0) { gh.conflictsLeft--; cur.sha = `sha-${++gh.seq}`; }
        if (cur && !body.sha) return { status: 422, body: { message: "Invalid request. \"sha\" wasn't supplied." } };
        if (cur && body.sha !== cur.sha) return { status: 409, body: { message: 'does not match' } };
        branchFiles[path] = { sha: `sha-${++gh.seq}`, content: body.content };
        return { status: cur ? 200 : 201, body: { content: { path, sha: branchFiles[path].sha } } };
      }
    }
    if ((m = /^\/repos\/Mardar91\/mauricio\/git\/blobs\/(.+)$/.exec(p))) {
      const f = Object.values(gh.files).flatMap((b) => Object.values(b)).find((x) => x.sha === m[1]);
      return f ? { body: { sha: f.sha, encoding: 'base64', content: f.content } } : { status: 404, body: {} };
    }
    return { status: 500, body: { message: `ruta no simulada ${req.method} ${p}` } };
  });
  return gh;
}

const stateSync = (days = REAL_WEEK, sync = SYNC) => updateSettings(stateWith(days), { sync });

test('cabeceras de la API de GitHub', async () => {
  const gh = fakeGitHub();
  const r = await testConnection(SYNC, gh.fetch);
  assert.equal(r.ok, true);
  assert.match(r.message, /Conexión correcta/);
  const [req] = gh.fetch.calls;
  assert.equal(req.url, `${API}/repos/Mardar91/mauricio`);
  assert.equal(req.method, 'GET');
  assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(req.headers.Accept, 'application/vnd.github+json');
  assert.equal(req.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('testConnection: errores en español (401, 403, 404, red, rate limit, sin token)', async () => {
  const withStatus = (status, headers) => mockFetch(() => ({ status, body: { message: 'x' }, headers }));
  assert.match((await testConnection(SYNC, withStatus(401))).message, /token de GitHub no es válido/);
  assert.match((await testConnection(SYNC, withStatus(403))).message, /no tiene permiso/);
  assert.match((await testConnection(SYNC, withStatus(403, { 'x-ratelimit-remaining': '0' }))).message, /limitado/);
  const nf = await testConnection(SYNC, withStatus(404));
  assert.equal(nf.ok, false);
  assert.match(nf.message, /No se encontró el repositorio Mardar91\/mauricio/);
  const offline = mockFetch(() => { throw new TypeError('Failed to fetch'); });
  assert.match((await testConnection(SYNC, offline)).message, /No hay conexión/);
  const noToken = await testConnection({ ...SYNC, token: '' }, offline);
  assert.match(noToken.message, /Falta el token/);
  assert.equal(offline.calls.length, 1);
});

test('ensureBranch: si existe no crea nada', async () => {
  const gh = fakeGitHub({ branches: { main: 'sha-main', datos: 'sha-datos' } });
  assert.deepEqual(await ensureBranch(SYNC, gh.fetch), { created: false, sha: 'sha-datos' });
  assert.deepEqual(gh.fetch.calls.map((c) => `${c.method} ${c.url}`), [`GET ${API}/repos/Mardar91/mauricio/git/ref/heads/datos`]);
});

test('ensureBranch: crea "datos" desde la rama por defecto', async () => {
  const gh = fakeGitHub();
  assert.deepEqual(await ensureBranch(SYNC, gh.fetch), { created: true, sha: 'sha-main' });
  assert.deepEqual(gh.fetch.calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${API}/repos/Mardar91/mauricio/git/ref/heads/datos`,
    `GET ${API}/repos/Mardar91/mauricio`,
    `GET ${API}/repos/Mardar91/mauricio/git/ref/heads/main`,
    `POST ${API}/repos/Mardar91/mauricio/git/refs`,
  ]);
  assert.deepEqual(gh.fetch.calls[3].json(), { ref: 'refs/heads/datos', sha: 'sha-main' });
  assert.equal(gh.branches.datos, 'sha-main');
});

test('ensureBranch: repositorio inexistente → error claro', async () => {
  const gh = fakeGitHub({ repoStatus: 404 });
  await assert.rejects(ensureBranch(SYNC, gh.fetch), (e) => e instanceof SyncError && e.status === 404 && /No se encontró/.test(e.message));
});

test('pushData: crea turnos.ics y turnos.json en la rama datos (sin token)', async () => {
  const gh = fakeGitHub();
  const s = stateSync();
  const r = await pushData(s, { fetchImpl: gh.fetch, now: T0 });
  assert.equal(r.pushed, true);
  assert.match(r.hash, /^[0-9a-f]{14}$/);
  assert.equal(r.sync.lastPushHash, r.hash);
  assert.equal(r.sync.lastPushAt, T0.toISOString());
  assert.equal(r.sync.token, TOKEN); // ajustes para guardar en el teléfono
  const puts = gh.fetch.calls.filter((c) => c.method === 'PUT');
  assert.deepEqual(puts.map((c) => c.url), [`${API}/repos/Mardar91/mauricio/contents/turnos.ics`, `${API}/repos/Mardar91/mauricio/contents/turnos.json`]);
  for (const put of puts) {
    const body = put.json();
    assert.equal(body.branch, 'datos');
    assert.equal(body.sha, undefined);
    assert.equal(typeof body.message, 'string');
  }
  const gets = gh.fetch.calls.filter((c) => c.method === 'GET' && c.url.includes('/contents/'));
  assert.ok(gets.every((c) => c.url.endsWith('?ref=datos')));
  const ics = unb64(gh.files.datos['turnos.ics'].content);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.includes('UID:2026-10-12-F1@turnos-mauricio'));
  assert.ok(ics.includes('Mañana')); // UTF-8 correcto
  const json = unb64(gh.files.datos['turnos.json'].content);
  assert.ok(!json.includes(TOKEN));
  assert.equal(JSON.parse(json).settings.sync.token, '');
  assert.deepEqual(JSON.parse(json).days['2026-10-12'].codes, ['F1', 'F52']);
  for (const c of gh.fetch.calls) assert.ok(!(c.body || '').includes(TOKEN), 'el token no viaja en el cuerpo');
});

test('pushData: sin cambios no hace ninguna petición; con cambios actualiza con sha', async () => {
  const gh = fakeGitHub();
  let s = stateSync();
  const first = await pushData(s, { fetchImpl: gh.fetch, now: T0 });
  s = updateSettings(s, { sync: first.sync });
  const n = gh.fetch.calls.length;
  const again = await pushData(s, { fetchImpl: gh.fetch, now: T0 });
  assert.deepEqual([again.pushed, again.hash], [false, first.hash]);
  assert.equal(gh.fetch.calls.length, n);
  // Otro momento del mismo día: el contenido no cambia
  const later = await pushData(s, { fetchImpl: gh.fetch, now: new Date(T0.getTime() + 3600000) });
  assert.equal(later.pushed, false);
  // Cambio real
  s = setDay(s, '2026-10-19', ['F1', 'F51']);
  const oldSha = gh.files.datos['turnos.ics'].sha;
  const second = await pushData(s, { fetchImpl: gh.fetch, now: T0 });
  assert.equal(second.pushed, true);
  assert.notEqual(second.hash, first.hash);
  const put = gh.fetch.calls.slice(n).find((c) => c.method === 'PUT' && c.url.endsWith('turnos.ics'));
  assert.equal(put.json().sha, oldSha);
  assert.ok(unb64(gh.files.datos['turnos.ics'].content).includes('UID:2026-10-19-F1@turnos-mauricio'));
  // force: vuelve a escribir aunque el hash sea igual; si el archivo es idéntico no hace PUT
  s = updateSettings(s, { sync: second.sync });
  const m = gh.fetch.calls.length;
  const forced = await pushData(s, { fetchImpl: gh.fetch, now: T0, force: true });
  assert.equal(forced.pushed, true);
  assert.equal(forced.changed, false);
  assert.equal(gh.fetch.calls.slice(m).filter((c) => c.method === 'PUT').length, 0);
});

test('pushData: conflicto de sha (409) → vuelve a leer y reintenta una vez', async () => {
  const gh = fakeGitHub({ branches: { main: 'm', datos: 'd' }, files: { datos: { 'turnos.ics': { sha: 'old', content: b64('viejo') }, 'turnos.json': { sha: 'oldj', content: b64('{}') } } } });
  gh.conflictsLeft = 1; // alguien escribió entre el GET y el PUT
  const r = await pushData(stateSync(), { fetchImpl: gh.fetch, now: T0 });
  assert.equal(r.pushed, true);
  const icsPuts = gh.fetch.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('turnos.ics'));
  assert.equal(icsPuts.length, 2);
  assert.equal(icsPuts[0].json().sha, 'old');
  assert.notEqual(icsPuts[1].json().sha, 'old');
  assert.ok(unb64(gh.files.datos['turnos.ics'].content).startsWith('BEGIN:VCALENDAR'));
});

test('pushData: conflicto persistente → error', async () => {
  const fetchImpl = mockFetch((req) => {
    if (req.url.includes('/git/ref/heads/datos')) return { body: { object: { sha: 'd' } } };
    if (req.method === 'GET') return { body: { sha: 'x', encoding: 'base64', content: b64('otro') } };
    return { status: 409, body: { message: 'conflict' } };
  });
  await assert.rejects(pushData(stateSync(), { fetchImpl, now: T0 }), SyncError);
});

test('pushData: errores comprensibles y sin red', async () => {
  await assert.rejects(pushData(stateSync(REAL_WEEK, { ...SYNC, token: '' }), mockFetch(() => ({}))), /Falta el token/);
  const offline = mockFetch(() => { throw new TypeError('NetworkError'); });
  await assert.rejects(pushData(stateSync(), offline), /No hay conexión con GitHub/);
  const unauthorized = mockFetch(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  await assert.rejects(pushData(stateSync(), unauthorized), (e) => e.status === 401 && /no es válido/.test(e.message));
});

test('pullBackup devuelve el JSON y se puede restaurar', async () => {
  const gh = fakeGitHub();
  const s = stateSync();
  await pushData(s, { fetchImpl: gh.fetch, now: T0 });
  const json = await pullBackup(SYNC, gh.fetch);
  const restored = importBackup(updateSettings(createDefaultState(), { sync: { token: TOKEN } }), json);
  assert.deepEqual(restored.days, s.days);
  assert.equal(restored.settings.sync.token, TOKEN);
  // Archivo grande: sin contenido en la API de contenidos → blob
  const big = mockFetch((req) => (req.url.includes('/contents/')
    ? { body: { sha: 'blob1', encoding: 'none', content: '' } }
    : { body: { sha: 'blob1', encoding: 'base64', content: b64('{"days":{}}') } }));
  assert.equal(await pullBackup(SYNC, big), '{"days":{}}');
  assert.equal(big.calls[1].url, `${API}/repos/Mardar91/mauricio/git/blobs/blob1`);
  await assert.rejects(pullBackup(SYNC, fakeGitHub().fetch), /Todavía no hay ninguna copia/);
});

test('calendarUrls', () => {
  assert.deepEqual(calendarUrls(SYNC), {
    webcal: 'webcal://raw.githubusercontent.com/Mardar91/mauricio/datos/turnos.ics',
    https: 'https://raw.githubusercontent.com/Mardar91/mauricio/datos/turnos.ics',
  });
});

test('enlace de configuración: buildSetupLink / parseSetupLink', () => {
  const link = buildSetupLink('https://mardar91.github.io/mauricio/#hoy', SYNC);
  assert.match(link, /^https:\/\/mardar91\.github\.io\/mauricio\/#setup=[A-Za-z0-9_-]+$/);
  const hash = link.slice(link.indexOf('#'));
  assert.deepEqual(parseSetupLink(hash), { enabled: true, owner: 'Mardar91', repo: 'mauricio', branch: 'datos', token: TOKEN });
  assert.deepEqual(parseSetupLink(link), parseSetupLink(hash));
  assert.equal(parseSetupLink('#setup=nobase64!!'), null);
  assert.equal(parseSetupLink('#hoy'), null);
  assert.equal(parseSetupLink(''), null);
  assert.equal(parseSetupLink('#setup=' + Buffer.from('{"owner":"a"}').toString('base64url')), null);
  assert.equal(parseSetupLink('#setup=' + Buffer.from('{"owner":"a/../b","repo":"r","token":"t"}').toString('base64url')), null);
  // Formato corto
  const short = '#setup=' + Buffer.from(JSON.stringify({ o: 'X', r: 'y', t: 'tok' })).toString('base64url');
  assert.deepEqual(parseSetupLink(short), { enabled: true, owner: 'X', repo: 'y', branch: 'datos', token: 'tok' });
});
