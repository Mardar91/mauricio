import { stateWith, mockFetch, fakeGitHub, REAL_WEEK, T0, TOKEN, KEY, OTHER_KEY, SYNC, API, REPO } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  testConnection, ensureBranch, syncNow, pullOnly, applySyncResult, fetchRemoteBackup, pushData, pullBackup,
  calendarUrls, parseSetupLink, buildSetupLink, normalizeSyncConfig, syncConfigPatch, isValidBranch,
  encryptBackup, decryptBackup, SyncError, SYNC_MESSAGES, becomePublisher,
} from '../../docs/js/core/sync.js';
import { isSyncKey } from '../../docs/js/core/cipher.js';
import { updateSettings, importBackup, setDay, clearDay, createDefaultState } from '../../docs/js/core/store.js';

const DAY = 24 * 3600 * 1000;
const at = (ms) => new Date(T0.getTime() + ms);

const device = (days = REAL_WEEK, sync = {}) => updateSettings(stateWith(days), { sync: { ...SYNC, ...sync } });
const puts = (gh, from = 0) => gh.fetch.calls.slice(from).filter((c) => c.method === 'PUT');
const backupDoc = (gh, branch) => JSON.parse(gh.text('backup.json', branch));
const remoteData = async (gh, key = KEY, branch) => decryptBackup(backupDoc(gh, branch), key);
const run = (s, gh, opts = {}) => syncNow(s, { fetchImpl: gh.fetch, now: T0, ...opts });
// Sincroniza y guarda el resultado como haría la UI
async function syncAndApply(s, gh, opts = {}) {
  const res = await run(s, gh, opts);
  return { res, state: applySyncResult(s, res, { now: opts.now ?? T0 }) };
}

test('cabeceras de la API de GitHub', async () => {
  const gh = fakeGitHub();
  const r = await testConnection(SYNC, gh.fetch);
  assert.equal(r.ok, true);
  assert.match(r.message, /Conexión correcta/);
  const [req] = gh.fetch.calls;
  assert.equal(req.url, `${API}${REPO}`);
  assert.equal(req.method, 'GET');
  assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(req.headers.Accept, 'application/vnd.github+json');
  assert.equal(req.headers['X-GitHub-Api-Version'], '2022-11-28');
  // Repo que publica una web → aviso (el token podría cambiar la app)
  assert.match((await testConnection(SYNC, fakeGitHub({ hasPages: true }).fetch)).warning, /solo para datos/);
});

test('testConnection: mensajes humanos (sin pedir tokens) y detalle técnico aparte', async () => {
  const withStatus = (status, headers) => mockFetch(() => ({ status, body: { message: 'x' }, headers }));
  const cases = [
    [withStatus(401), 'AUTH', /ya no funciona/, /token/],
    [withStatus(403), 'FORBIDDEN', /No se pudo actualizar el calendario/, /Contents: Read and write/],
    [withStatus(403, { 'x-ratelimit-remaining': '0' }), 'RATE_LIMIT', /ocupado/, /límite/],
    [withStatus(404), 'NOT_FOUND', /Pide ayuda/, /no existe Mardar91\/mauricio-datos/],
    [withStatus(503), 'SERVER', /no responde/, /503/],
  ];
  for (const [f, code, msg, detail] of cases) {
    const r = await testConnection(SYNC, f);
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.match(r.message, msg);
    assert.doesNotMatch(r.message, /token|crea/i, `mensaje para Mauricio sin jerga: ${r.message}`);
    assert.match(r.detail, detail);
  }
  const offline = mockFetch(() => { throw new TypeError('Failed to fetch'); });
  assert.match((await testConnection(SYNC, offline)).message, /Sin conexión/);
  const noToken = await testConnection({ ...SYNC, token: '' }, offline);
  assert.equal(noToken.code, 'CONFIG');
  assert.match(noToken.detail, /token/);
  assert.equal(offline.calls.length, 1);
  for (const m of Object.values(SYNC_MESSAGES)) assert.doesNotMatch(m, /token|crea uno/i);
});

test('ensureBranch: rama vacía = la por defecto, existente, inexistente (se crea) y repo vacío', async () => {
  let gh = fakeGitHub();
  assert.deepEqual(await ensureBranch(SYNC, gh.fetch), { branch: '', created: false, empty: false });
  assert.equal(gh.fetch.calls.length, 0);
  gh.branches.datos = 'c0';
  assert.deepEqual(await ensureBranch({ ...SYNC, branch: 'datos' }, gh.fetch), { branch: 'datos', created: false, empty: false, sha: 'c0' });
  gh = fakeGitHub();
  assert.deepEqual(await ensureBranch({ ...SYNC, branch: 'datos' }, gh.fetch), { branch: 'datos', created: true, empty: false, sha: 'c0' });
  assert.deepEqual(gh.fetch.calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${API}${REPO}/git/ref/heads/datos`, `GET ${API}${REPO}`, `GET ${API}${REPO}/git/ref/heads/main`, `POST ${API}${REPO}/git/refs`,
  ]);
  assert.equal(gh.branches.datos, 'c0');
  assert.deepEqual(await ensureBranch({ ...SYNC, branch: 'datos' }, fakeGitHub({ empty: true }).fetch), { branch: 'datos', created: false, empty: true });
  await assert.rejects(ensureBranch({ ...SYNC, branch: 'datos' }, fakeGitHub({ repoStatus: 404 }).fetch),
    (e) => e instanceof SyncError && e.code === 'NOT_FOUND' && e.status === 404);
});

test('syncNow: primera publicación en un repo vacío → backup.json cifrado (rev 1) y turnos.ics', async () => {
  const gh = fakeGitHub({ empty: true });
  let s = setDay(device(), '2026-10-12', ['F1', 'F52'], { note: 'Frau Müller: Insulina', now: T0 });
  s = updateSettings(s, { name: 'Mauricio Ducuara' });
  const res = await run(s, gh);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.pushed, true);
  assert.equal(res.icsPushed, true);
  assert.equal(res.pulled, false);
  assert.equal(res.rev, 1);
  assert.equal(res.state, s); // nada que fusionar
  // El primero que sincroniza (sin copia remota) pasa a ser el que publica
  assert.equal(res.readOnly, false);
  assert.deepEqual(res.publisher, { deviceId: 'movil1', since: T0.toISOString() });
  // Sin rama: nada de ?ref ni branch; se crea la rama por defecto con el primer archivo
  for (const c of gh.fetch.calls) {
    assert.ok(!c.url.includes('?ref='), c.url);
    if (c.method === 'PUT') assert.equal(c.json().branch, undefined);
  }
  assert.deepEqual(puts(gh).map((c) => c.url.split('/').pop()), ['backup.json', 'turnos.ics']);
  const doc = backupDoc(gh);
  assert.equal(doc.format, 'turnos-backup');
  assert.equal(doc.v, 3);
  // meta.name: solo el nombre de pila en claro (para «Calendarios de la familia»), nunca el apellido
  assert.deepEqual(doc.meta, { rev: 1, savedAt: T0.toISOString(), deviceId: 'movil1', days: 7, publisher: 'movil1', publisherSince: T0.toISOString(), name: 'Mauricio' });
  assert.equal(doc.enc.alg, 'AES-GCM');
  // Nada en claro fuera de enc.iv/enc.data (base64url aleatorio: podrían contener «F52» por casualidad)
  const clear = JSON.stringify({ ...doc, enc: { ...doc.enc, iv: '', data: '' } });
  assert.match(doc.enc.iv, /^[A-Za-z0-9_-]{16}$/);
  assert.match(doc.enc.data, /^[A-Za-z0-9_-]+$/);
  for (const secret of ['Insulina', 'Ducuara', 'F52', TOKEN, KEY, 'changes', 'Mañana']) assert.ok(!clear.includes(secret), `en claro: ${secret}`);
  const data = await remoteData(gh);
  assert.deepEqual(data.days['2026-10-12'].codes, ['F1', 'F52']);
  assert.equal(data.days['2026-10-12'].note, 'Frau Müller: Insulina');
  assert.equal(data.settings.name, 'Mauricio Ducuara');
  assert.equal(data.settings.sync, undefined); // ni token ni clave dentro
  assert.ok(!JSON.stringify(data).includes(TOKEN) && !JSON.stringify(data).includes(KEY));
  // Calendario sin notas ni lugares (publishPlaces desactivado)
  const ics = gh.text('turnos.ics');
  assert.ok(ics.includes('UID:2026-10-12-F1@turnos-mauricio'));
  assert.ok(!ics.includes('Insulina') && !ics.includes('\r\nLOCATION:') && !ics.includes('F52'));
  // Parche para guardar
  assert.equal(res.sync.baseRev, 1);
  assert.match(res.sync.lastPushHash, /^[0-9a-f]{14}$/);
  assert.match(res.sync.lastIcsHash, /^[0-9a-f]{14}$/);
  assert.equal(res.sync.lastPushAt, T0.toISOString());
  assert.equal(res.sync.lastError, null);
  assert.equal(res.sync.publisher, 'movil1');
  assert.equal(res.sync.publisherSince, T0.toISOString());
  for (const c of gh.fetch.calls) assert.ok(!(c.body || '').includes(TOKEN), 'el token no viaja en el cuerpo');
});

test('syncNow: sin cambios no publica; cambio real → rev 2; ICS estable de un día a otro', async () => {
  const gh = fakeGitHub();
  let { state: s } = await syncAndApply(device(), gh);
  assert.equal(s.settings.sync.baseRev, 1);
  let n = gh.fetch.calls.length;
  const again = await run(s, gh, { now: at(DAY) }); // al día siguiente, mismo contenido
  assert.equal(again.ok, true);
  assert.equal(again.pushed, false);
  assert.equal(again.icsPushed, false);
  assert.equal(puts(gh, n).length, 0);
  // Lee la copia y compara el calendario publicado (GET); no escribe nada
  assert.deepEqual(gh.fetch.calls.slice(n).map((c) => `${c.method} ${c.url.replace(API + REPO, '')}`), ['GET /contents/backup.json', 'GET /contents/turnos.ics']);
  s = applySyncResult(s, again);
  s = setDay(s, '2026-10-19', ['F1', 'F51'], { now: at(DAY) });
  n = gh.fetch.calls.length;
  const second = await run(s, gh, { now: at(DAY) });
  assert.equal(second.pushed, true);
  assert.equal(second.rev, 2);
  assert.equal(backupDoc(gh).meta.rev, 2);
  const putBackup = puts(gh, n).find((c) => c.url.endsWith('backup.json'));
  assert.equal(putBackup.json().sha, 'f1'); // escribe sobre la versión que leyó
  assert.ok(gh.text('turnos.ics').includes('UID:2026-10-19-F1@turnos-mauricio'));
  // force: vuelve a publicar la copia (rev 3) aunque no haya cambios; el ICS idéntico no se reescribe
  s = applySyncResult(s, second);
  const forced = await run(s, gh, { now: at(DAY), force: true });
  assert.equal(forced.pushed, true);
  assert.equal(forced.rev, 3);
  assert.equal(forced.icsPushed, false);
});

test('syncNow: sin clave y sin copia remota → genera la clave, pero publica en la llamada siguiente (ya guardada)', async () => {
  const gh = fakeGitHub();
  const s = device(REAL_WEEK, { key: '', deviceId: '' });
  const res = await run(s, gh);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'RETRY');
  assert.equal(res.error.retry, true);
  assert.ok(isSyncKey(res.sync.key));
  assert.match(res.sync.deviceId, /^[a-z0-9]{12}$/);
  assert.equal(res.sync.lastError, undefined); // no es un fallo
  assert.equal(puts(gh).length, 0); // nada escrito con una clave que aún no está guardada
  const saved = applySyncResult(s, res, { now: T0 });
  assert.equal(saved.settings.sync.key, res.sync.key);
  const again = await run(saved, gh, { now: at(1) });
  assert.equal(again.ok, true, JSON.stringify(again.error));
  assert.equal(again.pushed, true);
  const data = await remoteData(gh, res.sync.key);
  assert.equal(Object.keys(data.days).length, 7);
});

test('dispositivo atrasado: solo lee y fusiona; al pasar a publicar, fusiona en lugar de sobrescribir', async () => {
  const gh = fakeGitHub();
  // A publica 12 F1 y 13 S1
  const a0 = device({ '2026-10-12': ['F1'], '2026-10-13': ['S1'] });
  const { state: a1 } = await syncAndApply(a0, gh);
  // B (copia vieja, otra pestaña/otro móvil): 13 N1 más antiguo y 14 F1 nuevo
  let b = device({}, { deviceId: 'safari' });
  b = setDay(b, '2026-10-13', ['N1'], { now: at(-DAY) });
  b = setDay(b, '2026-10-14', ['F1'], { now: at(DAY) });
  const n = gh.fetch.calls.length;
  const rb = await run(b, gh, { now: at(DAY) });
  assert.equal(rb.ok, true, JSON.stringify(rb.error));
  assert.equal(rb.readOnly, true);
  assert.equal(rb.pulled, true);
  assert.equal(rb.merged, true);
  assert.equal(rb.pushed, false);
  assert.equal(puts(gh, n).length, 0); // solo lee
  assert.deepEqual(rb.pulledDays, ['2026-10-12', '2026-10-13']);
  const codes = (st) => Object.fromEntries(Object.entries(st.days).map(([k, d]) => [k, d.codes.join(',')]));
  assert.deepEqual(codes(rb.state), { '2026-10-12': 'F1', '2026-10-13': 'S1', '2026-10-14': 'F1' });
  assert.deepEqual(rb.unpublishedDays, ['2026-10-14']); // lo suyo que no está publicado
  assert.equal(rb.sync.unpublished, 1);
  // B pasa a publicar: fusiona primero y publica rev 2 con todo
  const tb = await becomePublisher(applySyncResult(b, rb, { now: at(DAY) }), { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(tb.ok, true, JSON.stringify(tb.error));
  assert.equal(tb.pushed, true);
  assert.equal(tb.tookOver, true);
  assert.equal(tb.rev, 2);
  const remote = await remoteData(gh);
  assert.deepEqual(Object.keys(remote.days).sort(), ['2026-10-12', '2026-10-13', '2026-10-14']);
  assert.deepEqual(remote.days['2026-10-13'].codes, ['S1']);
  assert.equal(backupDoc(gh).meta.deviceId, 'safari');
  assert.equal(backupDoc(gh).meta.publisher, 'safari');
  // A vuelve: ahora solo lee y recibe el 14 sin perder nada
  const ra = await run(a1, gh, { now: at(2 * DAY) });
  assert.equal(ra.pulled, true);
  assert.equal(ra.readOnly, true);
  assert.equal(ra.pushed, false);
  assert.deepEqual(codes(ra.state), { '2026-10-12': 'F1', '2026-10-13': 'S1', '2026-10-14': 'F1' });
  assert.equal(ra.sync.baseRev, 2);
  assert.equal(ra.sync.publisher, 'safari');
});

test('dispositivo vacío (enlace abierto en Safari): restaura en vez de publicar vacío', async () => {
  const gh = fakeGitHub();
  const full = updateSettings(device(), { name: 'Mauri', reminders: { minutesBefore: 90 } }, { now: T0 });
  await run(full, gh);
  const before = { backup: gh.text('backup.json'), ics: gh.text('turnos.ics') };
  const n = gh.fetch.calls.length;
  const empty = device({}, { deviceId: 'safari' });
  const res = await run(empty, gh, { now: at(DAY) });
  assert.equal(res.ok, true);
  assert.equal(res.pulled, true);
  assert.equal(res.pushed, false);
  assert.equal(res.readOnly, true);
  assert.equal(puts(gh, n).length, 0);
  assert.equal(gh.text('backup.json'), before.backup);
  assert.equal(gh.text('turnos.ics'), before.ics);
  assert.equal(Object.keys(res.state.days).length, 7);
  assert.equal(res.state.settings.name, 'Mauri'); // un dispositivo vacío adopta los ajustes del usuario
  assert.equal(res.state.settings.reminders.minutesBefore, 90);
  assert.equal(res.state.settings.sync.deviceId, 'safari'); // pero no los del dispositivo
  assert.equal(res.sync.baseRev, 1);
  const applied = applySyncResult(empty, res, { now: at(DAY) });
  assert.equal(Object.keys(applied.days).length, 7);
  assert.equal(applied.settings.sync.baseRev, 1);
});

test('clave equivocada o sin clave → no se publica nada y el error es claro', async () => {
  const gh = fakeGitHub();
  await run(device(), gh);
  const n = gh.fetch.calls.length;
  const wrong = device({ '2026-10-20': ['F1'] }, { key: OTHER_KEY, deviceId: 'otro' });
  const res = await run(wrong, gh, { now: at(DAY) });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'DECRYPT');
  assert.match(res.error.message, /clave no coincide/);
  assert.match(res.error.message, /No se envió nada/);
  assert.equal(res.error.retry, false);
  assert.equal(res.sync.lastErrorCode, 'DECRYPT');
  assert.equal(res.sync.lastError, res.error.message);
  assert.equal(res.state, wrong);
  assert.equal(puts(gh, n).length, 0);
  const noKey = await run(device({ '2026-10-20': ['F1'] }, { key: '' }), gh, { now: at(DAY) });
  assert.equal(noKey.error.code, 'NO_KEY');
  assert.equal(puts(gh, n).length, 0);
  // Metadatos manipulados → no se puede descifrar (van autenticados)
  const doc = backupDoc(gh);
  doc.meta.days = 0;
  gh.write('backup.json', JSON.stringify(doc));
  const tampered = await run(device({ '2026-10-20': ['F1'] }), gh, { now: at(DAY) });
  assert.equal(tampered.error.code, 'DECRYPT');
});

test('nunca publica 0 días encima de una copia con días (salvo allowEmpty o un borrado a propósito)', async () => {
  const gh = fakeGitHub();
  let { state: s } = await syncAndApply(device({ '2026-10-12': ['F1'], '2026-10-13': ['S1'] }), gh);
  // Días que desaparecen sin un borrado más nuevo (aquí: tombstones viejísimas que se podan al fusionar)
  const old = '2026-01-01T00:00:00.000Z';
  const lost = { ...s, days: {}, tombstones: { '2026-10-12': old, '2026-10-13': old } };
  const remote = await remoteData(gh);
  for (const d of Object.values(remote.days)) d.updatedAt = '2025-12-01T00:00:00.000Z';
  const doc = backupDoc(gh);
  gh.write('backup.json', JSON.stringify(await encryptBackup(remote, { rev: doc.meta.rev, now: T0, deviceId: 'movil1', key: KEY, publisher: 'movil1', publisherSince: doc.meta.publisherSince })));
  const n = gh.fetch.calls.length;
  const res = await run(lost, gh, { now: at(DAY) });
  assert.equal(res.error?.code, 'EMPTY_LOCAL');
  assert.equal(puts(gh, n).length, 0);
  // Borrar a propósito los últimos días en el que publica: el borrado sí se publica (y el calendario se vacía)
  const del = clearDay(clearDay(s, '2026-10-12', { now: at(DAY) }), '2026-10-13', { now: at(DAY) });
  const ok = await run(del, gh, { now: at(DAY) });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.pushed, true);
  const data = await remoteData(gh);
  assert.deepEqual(data.days, {});
  assert.deepEqual(Object.keys(data.tombstones).sort(), ['2026-10-12', '2026-10-13']);
  assert.equal((gh.text('turnos.ics').match(/^UID:(?!plan-)/gm) || []).length, 0); // solo queda «Sube el plan»
});

test('un borrado (tombstone) llega al otro dispositivo', async () => {
  const gh = fakeGitHub();
  let { state: a } = await syncAndApply(device({ '2026-10-15': ['S1'], '2026-10-16': ['F1'] }), gh);
  let { state: b } = await syncAndApply(device({}, { deviceId: 'b' }), gh, { now: at(1000) });
  assert.deepEqual(b.days['2026-10-15'].codes, ['S1']);
  a = clearDay(a, '2026-10-15', { now: at(DAY) });
  ({ state: a } = await syncAndApply(a, gh, { now: at(DAY) }));
  assert.equal(a.settings.sync.baseRev, 2);
  const rb = await run(b, gh, { now: at(2 * DAY) });
  assert.equal(rb.pulled, true);
  assert.equal(rb.state.days['2026-10-15'], undefined);
  assert.ok(rb.state.tombstones['2026-10-15']);
  assert.deepEqual(rb.state.days['2026-10-16'].codes, ['F1']);
  assert.ok(!gh.text('turnos.ics').includes('2026-10-15-S1'));
  // Volver a poner el día después del borrado gana a la tombstone (B pasa a publicar)
  b = applySyncResult(b, rb, { now: at(2 * DAY) });
  b = setDay(b, '2026-10-15', ['N1'], { now: at(3 * DAY) });
  assert.equal(b.tombstones['2026-10-15'], undefined);
  const rb2 = await becomePublisher(b, { fetchImpl: gh.fetch, now: at(3 * DAY) });
  assert.equal(rb2.pushed, true);
  assert.deepEqual((await remoteData(gh)).days['2026-10-15'].codes, ['N1']);
});

test('conflicto de sha: otro dispositivo escribe entre la lectura y la escritura → relee, fusiona y publica encima', async () => {
  const gh = fakeGitHub();
  const { state: a } = await syncAndApply(device({ '2026-10-12': ['F1'] }), gh);
  // Otra pestaña del mismo teléfono (mismo editor) ya preparó su versión (rev 2) con el día 20
  const other = setDay(device({ '2026-10-12': ['F1'] }), '2026-10-20', ['N1'], { now: at(DAY) });
  const otherDoc = await encryptBackup(other, { rev: 2, now: at(DAY), deviceId: 'movil1', key: KEY });
  let injected = false;
  gh.beforePut = (path) => {
    if (path === 'backup.json' && !injected) { injected = true; gh.write('backup.json', JSON.stringify(otherDoc)); }
  };
  const mine = setDay(a, '2026-10-21', ['S1'], { now: at(2 * DAY) });
  const res = await run(mine, gh, { now: at(2 * DAY) });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.rev, 3);
  const backupPuts = gh.fetch.calls.filter((c) => c.method === 'PUT' && c.url.endsWith('backup.json'));
  assert.equal(backupPuts.length, 3); // primera publicación + intento rechazado + reintento
  const data = await remoteData(gh);
  assert.deepEqual(Object.keys(data.days).sort(), ['2026-10-12', '2026-10-20', '2026-10-21']);
  assert.deepEqual(Object.keys(res.state.days).sort(), ['2026-10-12', '2026-10-20', '2026-10-21']);
  // Conflicto que no se resuelve → error pasajero, sin pisar nada
  const busy = [];
  for (let r = 10; r < 13; r++) busy.push(await encryptBackup(other, { rev: r, now: at(DAY), deviceId: 'movil1', key: KEY }));
  gh.beforePut = (path) => { if (path === 'backup.json' && busy.length) gh.write('backup.json', JSON.stringify(busy.shift())); };
  const before = gh.fetch.calls.length;
  const stuck = await run(setDay(applySyncResult(a, res), '2026-10-22', ['F1'], { now: at(3 * DAY) }), gh, { now: at(3 * DAY) });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error.code, 'CONFLICT');
  assert.equal(stuck.error.retry, true);
  assert.equal(puts(gh, before).filter((c) => c.url.endsWith('turnos.ics')).length, 0);
  assert.equal(backupDoc(gh).meta.rev, 12); // lo del otro dispositivo sigue intacto
});

test('rama indicada que no existe → se crea desde la por defecto y se escribe allí', async () => {
  const gh = fakeGitHub();
  const res = await run(device(REAL_WEEK, { branch: 'datos' }), gh);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.ok(gh.branches.datos);
  assert.equal(gh.text('backup.json', 'main'), null); // la rama por defecto no se toca
  assert.ok(gh.text('backup.json', 'datos'));
  for (const c of gh.fetch.calls.filter((x) => x.url.includes('/contents/'))) {
    if (c.method === 'GET') assert.ok(c.url.endsWith('?ref=datos'), c.url);
    else assert.equal(c.json().branch, 'datos');
  }
});

test('repo vacío con rama indicada: el primer archivo crea la rama por defecto y luego se crea la rama', async () => {
  const gh = fakeGitHub({ empty: true });
  const res = await run(device(REAL_WEEK, { branch: 'datos' }), gh);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.ok(gh.branches.main && gh.branches.datos);
  assert.ok(gh.text('backup.json', 'datos'));
  assert.ok(gh.text('turnos.ics', 'datos'));
  const [first, second] = puts(gh);
  assert.equal(first.json().branch, undefined);
  assert.equal(second.json().branch, 'datos');
  // La siguiente vez todo va a la rama
  const again = await run(applySyncResult(device(REAL_WEEK, { branch: 'datos' }), res), gh, { now: at(DAY) });
  assert.equal(again.ok, true);
  assert.equal(again.pushed, false);
});

test('errores HTTP y sin red: código, mensaje humano y detalle técnico en el parche', async () => {
  const status = (st, headers) => mockFetch(() => ({ status: st, body: { message: 'Bad credentials' }, headers }));
  const r401 = await run(device(), { fetch: status(401) });
  assert.equal(r401.error.code, 'AUTH');
  assert.equal(r401.error.status, 401);
  assert.doesNotMatch(r401.error.message, /token/i);
  assert.match(r401.error.detail, /token/);
  assert.equal(r401.sync.lastErrorDetail, r401.error.detail);
  assert.equal(r401.error.retry, false);
  assert.equal((await run(device(), { fetch: status(403) })).error.code, 'FORBIDDEN');
  assert.equal((await run(device(), { fetch: status(429) })).error.code, 'RATE_LIMIT');
  assert.equal((await run(device(), { fetch: status(404) })).error.code, 'NOT_FOUND');
  const offline = await run(device(), { fetch: mockFetch(() => { throw new TypeError('NetworkError'); }) });
  assert.equal(offline.error.code, 'NETWORK');
  assert.equal(offline.error.retry, true);
  assert.match(offline.error.message, /Sin conexión/);
  const noToken = await run(device(REAL_WEEK, { token: '' }), { fetch: mockFetch(() => ({})) });
  assert.equal(noToken.error.code, 'CONFIG');
  // 422 al escribir (no por sha) → INVALID
  const gh = fakeGitHub();
  gh.override = (req) => (req.method === 'PUT' ? { status: 422, body: { message: 'path is invalid' } } : null);
  assert.equal((await run(device(), gh)).error.code, 'INVALID');
});

test('copia remota dañada o de una versión más nueva → no se publica', async () => {
  const gh = fakeGitHub();
  gh.write('backup.json', '{ esto no es json');
  let n = gh.fetch.calls.length;
  assert.equal((await run(device(), gh)).error.code, 'BAD_REMOTE');
  assert.equal(puts(gh, n).length, 0);
  gh.write('backup.json', JSON.stringify({ format: 'turnos-backup', v: 4, meta: { rev: 4 }, enc: {} }));
  n = gh.fetch.calls.length;
  const newer = await run(device(), gh);
  assert.equal(newer.error.code, 'NEWER_REMOTE');
  assert.match(newer.error.message, /Actualiza la app/);
  assert.equal(puts(gh, n).length, 0);
});

test('un teléfono con datos de una versión más nueva no publica', async () => {
  const gh = fakeGitHub();
  const res = await run({ ...device(), __newerSchema: true, schema: 2 }, gh);
  assert.equal(res.error.code, 'NEWER_LOCAL');
  assert.equal(puts(gh).length, 0);
});

test('compatibilidad: un turnos.json antiguo en claro se fusiona y se migra a backup.json', async () => {
  const gh = fakeGitHub();
  gh.write('turnos.json', JSON.stringify({ app: 'turnos-mauricio', schema: 1, days: { '2026-09-01': { codes: ['F1'], updatedAt: '2026-09-01T10:00:00.000Z' } } }));
  const res = await run(device({ '2026-10-12': ['S1'] }), gh);
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(res.pulled, true);
  assert.equal(res.pushed, true);
  assert.equal(res.rev, 1);
  assert.deepEqual(Object.keys((await remoteData(gh)).days).sort(), ['2026-09-01', '2026-10-12']);
});

test('pullOnly: fusiona sin escribir nada; dice quién publica; becomePublisher publica lo nuevo del teléfono', async () => {
  const gh = fakeGitHub();
  await run(device({ '2026-10-12': ['F1'] }), gh);
  const n = gh.fetch.calls.length;
  let s = setDay(device({}, { deviceId: 'nuevo' }), '2026-10-30', ['N1'], { now: at(DAY) });
  const res = await pullOnly(s, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(res.ok, true);
  assert.equal(res.pulled, true);
  assert.equal(res.pushed, false);
  assert.equal(res.readOnly, true); // otro dispositivo publica → la UI puede ofrecer «Usar este dispositivo»
  assert.equal(res.publisher.deviceId, 'movil1');
  assert.equal(puts(gh, n).length, 0);
  assert.deepEqual(Object.keys(res.state.days).sort(), ['2026-10-12', '2026-10-30']);
  assert.equal(res.sync.baseRev, 1);
  s = applySyncResult(s, res, { now: at(DAY) });
  assert.equal(s.settings.sync.publisher, 'movil1');
  // syncNow sin confirmar: sigue leyendo, no escribe
  assert.equal((await run(s, gh, { now: at(DAY) })).pushed, false);
  assert.equal(puts(gh, n).length, 0);
  const pushed = await becomePublisher(s, { fetchImpl: gh.fetch, now: at(DAY) });
  assert.equal(pushed.pushed, true);
  assert.equal(pushed.rev, 2);
  // Sin copia remota: no hay nada que traer, y tampoco se escribe; este dispositivo publicaría
  const none = await pullOnly(device(), { fetchImpl: fakeGitHub().fetch, now: T0 });
  assert.equal(none.ok, true);
  assert.equal(none.pulled, false);
  assert.equal(none.remote, null);
  assert.equal(none.readOnly, false);
  assert.equal(none.publisher, null);
  // Una rama indicada que no existe no se crea al solo leer
  const g2 = fakeGitHub();
  const nb = await pullOnly(device(REAL_WEEK, { branch: 'datos' }), { fetchImpl: g2.fetch, now: T0 });
  assert.equal(nb.ok, true);
  assert.equal(nb.remote, null);
  assert.equal(g2.branches.datos, undefined);
  assert.ok(g2.fetch.calls.every((c) => c.method === 'GET'));
});

test('applySyncResult: respeta lo editado durante la sincronización y otra configuración', async () => {
  const gh = fakeGitHub();
  await run(device({ '2026-10-12': ['F1'] }), gh);
  const start = device({}, { deviceId: 'b' });
  const res = await run(start, gh, { now: at(DAY) });
  // Mientras tanto, Mauricio guardó el 13
  const during = setDay(start, '2026-10-13', ['S1'], { now: at(DAY + 1000) });
  const applied = applySyncResult(during, res, { now: at(DAY + 2000) });
  assert.deepEqual(Object.keys(applied.days).sort(), ['2026-10-12', '2026-10-13']);
  assert.equal(applied.settings.sync.baseRev, 1);
  // Si cambió el repositorio entre medias, no se aplica nada
  const moved = updateSettings(during, { sync: { repo: 'otro-repo' } });
  assert.equal(applySyncResult(moved, res), moved);
  assert.equal(applySyncResult(during, null), during);
});

test('calendario publicado: lugares solo con publishPlaces; sin notas nunca', async () => {
  const gh = fakeGitHub();
  let s = updateSettings(device({ '2026-10-12': ['F1', 'F52'] }), { sync: { publishPlaces: true } });
  s = setDay(s, '2026-10-12', ['F1', 'F52'], { note: 'secreto', now: T0 });
  await run(s, gh);
  const ics = gh.text('turnos.ics');
  assert.ok(ics.includes('LOCATION:F52'));
  assert.ok(ics.includes('SUMMARY:🌅 F1 Mañana · F52'));
  assert.ok(!ics.includes('secreto'));
});

test('compatibilidad: pushData lanza SyncError; pullBackup devuelve JSON en claro restaurable', async () => {
  const gh = fakeGitHub();
  const s = device();
  const r = await pushData(s, { fetchImpl: gh.fetch, now: T0 });
  assert.equal(r.pushed, true);
  assert.equal(r.sync.token, TOKEN);
  await assert.rejects(pushData(device(REAL_WEEK, { token: '' }), mockFetch(() => ({}))), (e) => e instanceof SyncError && e.code === 'CONFIG');
  const json = await pullBackup(SYNC, gh.fetch);
  const restored = importBackup(updateSettings(createDefaultState(), { sync: { token: TOKEN } }), json, { now: T0 });
  assert.deepEqual(Object.keys(restored.days).sort(), Object.keys(s.days).sort());
  assert.equal(restored.settings.sync.token, TOKEN);
  const remote = await fetchRemoteBackup(SYNC, gh.fetch);
  assert.equal(remote.rev, 1);
  assert.equal(remote.meta.days, 7);
  await assert.rejects(pullBackup(SYNC, fakeGitHub().fetch), (e) => e.code === 'NO_REMOTE' && /Todavía no hay ninguna copia/.test(e.message));
  // Archivo grande: sin contenido en la API de contenidos → blob
  const doc = backupDoc(gh);
  const big = mockFetch((req) => (req.url.includes('/contents/')
    ? { body: { sha: 'blob1', encoding: 'none', content: '' } }
    : { body: { sha: 'blob1', encoding: 'base64', content: Buffer.from(JSON.stringify(doc)).toString('base64') } }));
  assert.equal(Object.keys(JSON.parse(await pullBackup(SYNC, big)).days).length, 7);
  assert.equal(big.calls[1].url, `${API}${REPO}/git/blobs/blob1`);
});

test('calendarUrls: rama por defecto (HEAD), rama indicada y codificación', () => {
  assert.deepEqual(calendarUrls(SYNC), {
    webcal: 'webcal://raw.githubusercontent.com/Mardar91/mauricio-datos/HEAD/turnos.ics',
    https: 'https://raw.githubusercontent.com/Mardar91/mauricio-datos/HEAD/turnos.ics',
    webcals: 'webcals://raw.githubusercontent.com/Mardar91/mauricio-datos/HEAD/turnos.ics',
    // Android: abre ICSx⁵ (o su página de Google Play)
    android: 'intent://raw.githubusercontent.com/Mardar91/mauricio-datos/HEAD/turnos.ics#Intent;scheme=webcals;package=at.bitfire.icsdroid;'
      + 'S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dat.bitfire.icsdroid;end',
  });
  // Carpeta de otra persona
  assert.equal(calendarUrls({ ...SYNC, dir: 'ana' }).webcal, 'webcal://raw.githubusercontent.com/Mardar91/mauricio-datos/HEAD/ana/turnos.ics');
  assert.equal(calendarUrls({ ...SYNC, branch: 'datos', dir: 'ana' }).android.split('#')[0], 'intent://raw.githubusercontent.com/Mardar91/mauricio-datos/datos/ana/turnos.ics');
  assert.equal(calendarUrls({ ...SYNC, branch: 'datos' }).https, 'https://raw.githubusercontent.com/Mardar91/mauricio-datos/datos/turnos.ics');
  assert.equal(calendarUrls({ ...SYNC, branch: 'a/b' }).https, 'https://raw.githubusercontent.com/Mardar91/mauricio-datos/a/b/turnos.ics');
});

test('enlace de configuración: incluye la clave y se valida campo a campo', () => {
  const link = buildSetupLink('https://mardar91.github.io/mauricio/#hoy', SYNC);
  assert.match(link, /^https:\/\/mardar91\.github\.io\/mauricio\/#setup=[A-Za-z0-9_-]+$/);
  const hash = link.slice(link.indexOf('#'));
  assert.deepEqual(parseSetupLink(hash), { enabled: true, owner: 'Mardar91', repo: 'mauricio-datos', branch: '', dir: '', token: TOKEN, key: KEY });
  assert.deepEqual(parseSetupLink(link), parseSetupLink(hash));
  assert.equal(parseSetupLink('#setup=nobase64!!'), null);
  assert.equal(parseSetupLink('#hoy'), null);
  assert.equal(parseSetupLink(''), null);
  const enc = (o) => `#setup=${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
  const ok = { owner: 'Mardar91', repo: 'mauricio-datos', token: TOKEN };
  assert.deepEqual(parseSetupLink(enc(ok)), { enabled: true, ...ok, branch: '', dir: '', key: '' });
  assert.equal(parseSetupLink(enc({ owner: 'a' })), null);
  const bad = [
    { owner: 'a/../b' }, { owner: '-abc' }, { owner: 'a'.repeat(40) }, { owner: 'a--b' },
    { repo: '..' }, { repo: 'r/x' }, { repo: 'x'.repeat(101) },
    { token: 'tok' }, { token: 'ghp_short' }, { token: `ghp_${'a'.repeat(36)}!` },
    { branch: 'x/../../attacker/repo/main' }, { branch: '../x' }, { branch: 'a//b' }, { branch: '.hidden' }, { branch: 'x.lock' }, { branch: 'HEAD' },
    { key: 'corta' }, { key: `${KEY}x` }, { branch: 5 },
    { dir: '../ana' }, { dir: 'ana/x' }, { dir: 'a'.repeat(33) }, { dir: 'ana maría' }, { dir: 'ñ' }, { dir: 5 },
  ];
  for (const b of bad) assert.equal(parseSetupLink(enc({ ...ok, ...b })), null, JSON.stringify(b));
  assert.equal(parseSetupLink(enc({ ...ok, token: `ghp_${'a'.repeat(36)}` })).token, `ghp_${'a'.repeat(36)}`);
  // Formato corto y publishPlaces
  const short = parseSetupLink(enc({ o: 'X', r: 'y', t: TOKEN, b: 'datos', k: KEY, p: true }));
  assert.deepEqual(short, { enabled: true, owner: 'X', repo: 'y', branch: 'datos', dir: '', token: TOKEN, key: KEY, publishPlaces: true });
  assert.equal(normalizeSyncConfig(null), null);
  assert.ok(isValidBranch('feature/turnos-2026'));
  assert.ok(!isValidBranch('a b'));
  // Parche para aplicar: reinicia la contabilidad para fusionar primero
  const patch = syncConfigPatch(parseSetupLink(hash));
  assert.equal(patch.enabled, true);
  assert.equal(patch.baseRev, 0);
  assert.equal(patch.lastPushHash, null);
  assert.equal(patch.key, KEY);
  assert.equal('key' in syncConfigPatch({ ...ok, key: '' }), false); // sin clave en el enlace: se conserva la del teléfono
});
