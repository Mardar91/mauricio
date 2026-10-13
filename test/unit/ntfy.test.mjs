import { stateWith, mockFetch } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomTopic, sequenceId, syncNtfy, testNtfy, topicUrl, KEEPALIVE_ID, isAppleMobile } from '../../docs/js/core/ntfy.js';
import { updateSettings, setDay, upsertCode, clearDay } from '../../docs/js/core/store.js';

const TOPIC = 'turnos-mauricio-abcdef123456';
const APP = 'https://mardar91.github.io/mauricio/';
const NOW = new Date(2026, 9, 12, 10, 0); // lun 12 oct 10:00 → horizonte: jue 15 08:00
const H = 3600 * 1000;
const unix = (d) => String(Math.floor(d.getTime() / 1000));
const DAYS = {
  '2026-10-13': ['F1', 'F52'], // víspera 12 20:00 · antes 13 05:00
  '2026-10-14': ['S1'],        // víspera 13 20:00 · antes 14 12:30
  '2026-10-15': ['N1'],        // víspera 14 20:00 · antes 15 21:00 (fuera del horizonte)
  '2026-10-16': ['F1'],        // fuera del horizonte
};

const ntfyState = (days = DAYS, ntfy = {}) => updateSettings(stateWith(days), { ntfy: { enabled: true, topic: TOPIC, ...ntfy } });
const okFetch = () => mockFetch(() => ({ status: 200, body: { id: 'x', event: 'message' } }));
const run = (s, now = NOW, f = okFetch()) => syncNtfy(s, now, f, { appUrl: APP }).then((r) => ({ r, f }));
const posts = (f) => f.calls.filter((c) => c.method === 'POST').map((c) => c.json());
const deletes = (f) => f.calls.filter((c) => c.method === 'DELETE').map((c) => c.url);

test('randomTopic y sequenceId', () => {
  const t = randomTopic();
  assert.match(t, /^turnos-mauricio-[a-z0-9]{12}$/);
  assert.notEqual(randomTopic(), t);
  const fixed = randomTopic((buf) => { buf.fill(0); return buf; });
  assert.equal(fixed, 'turnos-mauricio-aaaaaaaaaaaa');
  assert.equal(sequenceId('2026-10-13-W-pre'), '2026-10-13-W-pre');
  assert.equal(sequenceId('2026-10-13-F/1 x-eve'), '2026-10-13-F_1_x-eve');
  assert.equal(sequenceId('x'.repeat(80)).length, 64);
  assert.equal(topicUrl({ server: 'https://ntfy.sh/', topic: TOPIC }), `https://ntfy.sh/${TOPIC}`);
});

test('primera sincronización: programa los recordatorios de las próximas 70 h como JSON', async () => {
  const { r, f } = await run(ntfyState());
  const sent = posts(f);
  assert.ok(f.calls.every((c) => c.url === 'https://ntfy.sh/' && c.method === 'POST'));
  assert.deepEqual(sent.map((p) => p.sequence_id), [
    '2026-10-13-F1-eve', '2026-10-13-F1-pre', '2026-10-14-S1-eve', '2026-10-14-S1-pre', '2026-10-15-N1-eve', KEEPALIVE_ID,
  ]);
  const eve = sent[0];
  assert.equal(eve.topic, TOPIC);
  assert.equal(eve.delay, unix(new Date(2026, 9, 12, 20, 0)));
  assert.equal(eve.click, APP);
  assert.match(eve.title, /Mañana trabajas: 06:00–15:00/);
  assert.match(eve.message, /F52/);
  assert.deepEqual(eve.tags, ['calendar']);
  assert.equal(eve.priority, 3);
  const pre = sent[1];
  assert.equal(pre.delay, unix(new Date(2026, 9, 13, 5, 0)));
  assert.equal(pre.priority, 4);
  assert.deepEqual(pre.tags, ['alarm_clock']);
  // Sin Content-Type → petición simple (sin preflight CORS)
  for (const c of f.calls) assert.equal(c.headers['Content-Type'], undefined);
  // Todo dentro de los límites de ntfy (≥ 10 s y ≤ 3 días)
  for (const p of sent) {
    const delay = Number(p.delay) * 1000 - NOW.getTime();
    assert.ok(delay >= 15000 && delay <= 70 * H, `${p.sequence_id}: ${delay}`);
  }
  assert.deepEqual(Object.keys(r.scheduled).sort(), sent.map((p) => p.sequence_id).sort());
  assert.deepEqual(r.scheduled['2026-10-13-F1-eve'].at, new Date(2026, 9, 12, 20, 0).toISOString());
  assert.match(r.scheduled['2026-10-13-F1-eve'].hash, /^[0-9a-f]{14}$/);
  assert.deepEqual(r.published.length, 6);
  assert.deepEqual(r.cancelled, []);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.nextScheduled, new Date(2026, 9, 12, 20, 0));
  assert.deepEqual(r.ntfy.scheduled, r.scheduled);
  assert.equal(r.ntfy.lastRunAt, NOW.toISOString());
  assert.equal(r.ntfy.lastError, null);
  assert.equal(r.ntfy.topic, TOPIC);
});

test('aviso "Abre Turnos" de día, ~70 h después, y no se reenvía a cada rato', async () => {
  const { r } = await run(ntfyState());
  const keep = r.scheduled[KEEPALIVE_ID];
  // 12 oct 10:00 + 70 h = 15 oct 08:00 → se adelanta a las 20:00 del día anterior
  assert.equal(keep.at, new Date(2026, 9, 14, 20, 0).toISOString());
  let s = updateSettings(ntfyState(), { ntfy: r.ntfy });
  const { r: r2, f: f2 } = await run(s, new Date(NOW.getTime() + H));
  assert.equal(f2.calls.length, 0);
  assert.deepEqual(r2.scheduled[KEEPALIVE_ID], keep);
  // Un día después (y con turnos más allá del horizonte) se reprograma con el mismo sequence ID
  const { f: f3 } = await run(setDay(s, '2026-10-20', ['F1']), new Date(NOW.getTime() + 24 * H));
  assert.ok(posts(f3).some((p) => p.sequence_id === KEEPALIVE_ID && /Abre Turnos/.test(p.message)));
  // Sin turnos más allá del horizonte → se cancela
  s = clearDay(clearDay(s, '2026-10-16'), '2026-10-15');
  const { r: r4, f: f4 } = await run(s);
  assert.ok(deletes(f4).includes(`https://ntfy.sh/${TOPIC}/${KEEPALIVE_ID}`));
  assert.equal(r4.scheduled[KEEPALIVE_ID], undefined);
});

test('segunda sincronización sin cambios: ninguna petición', async () => {
  const { r } = await run(ntfyState());
  const s = updateSettings(ntfyState(), { ntfy: { scheduled: r.scheduled } });
  const { r: r2, f } = await run(s);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r2.scheduled, r.scheduled);
});

test('cambios: reemplaza con el mismo sequence ID y cancela los obsoletos', async () => {
  const { r } = await run(ntfyState());
  let s = updateSettings(ntfyState(), { ntfy: r.ntfy });
  s = setDay(s, '2026-10-14', ['F1']);               // S1 → F1
  s = upsertCode(s, { code: 'F1', start: '07:00' }); // nuevo horario de F1
  const { r: r2, f } = await run(s);
  assert.deepEqual(deletes(f).sort(), [
    `https://ntfy.sh/${TOPIC}/2026-10-14-S1-eve`, `https://ntfy.sh/${TOPIC}/2026-10-14-S1-pre`,
  ]);
  assert.deepEqual(posts(f).map((p) => p.sequence_id), ['2026-10-13-F1-eve', '2026-10-13-F1-pre', '2026-10-14-F1-eve', '2026-10-14-F1-pre']);
  assert.equal(posts(f)[1].delay, unix(new Date(2026, 9, 13, 6, 0)));
  assert.deepEqual(r2.cancelled.sort(), ['2026-10-14-S1-eve', '2026-10-14-S1-pre']);
  assert.equal(r2.scheduled['2026-10-14-S1-eve'], undefined);
  assert.equal(r2.scheduled['2026-10-13-F1-pre'].at, new Date(2026, 9, 13, 6, 0).toISOString());
  // Las peticiones de cancelación van antes que las nuevas
  const firstPost = f.calls.findIndex((c) => c.method === 'POST');
  assert.ok(f.calls.slice(0, firstPost).every((c) => c.method === 'DELETE'));
});

test('los ya entregados se olvidan sin DELETE; los que salen en < 15 s no se tocan', async () => {
  const { r } = await run(ntfyState());
  const s = updateSettings(ntfyState(), { ntfy: r.ntfy });
  // 12 oct 20:00:30 → la víspera de las 20:00 ya salió
  const { r: r2, f } = await run(s, new Date(2026, 9, 12, 20, 0, 30));
  assert.equal(deletes(f).length, 0);
  assert.equal(r2.scheduled['2026-10-13-F1-eve'], undefined);
  // 12 oct 19:59:55 → sale en 5 s: ni se reprograma ni se cancela
  const s2 = setDay(s, '2026-10-13', ['F1', 'F51']); // cambia el texto
  const { r: r3, f: f3 } = await run(s2, new Date(2026, 9, 12, 19, 59, 55));
  assert.ok(!posts(f3).some((p) => p.sequence_id === '2026-10-13-F1-eve'));
  assert.ok(!deletes(f3).some((u) => u.endsWith('2026-10-13-F1-eve')));
  assert.deepEqual(r3.scheduled['2026-10-13-F1-eve'], r.scheduled['2026-10-13-F1-eve']);
});

test('desactivado: cancela todo lo pendiente', async () => {
  const { r } = await run(ntfyState());
  const s = updateSettings(ntfyState(), { ntfy: { ...r.ntfy, enabled: false } });
  const { r: r2, f } = await run(s);
  assert.equal(posts(f).length, 0);
  assert.equal(deletes(f).length, 6);
  assert.deepEqual(r2.scheduled, {});
  assert.equal(r2.nextScheduled, null);
  // Desactivado y sin nada pendiente: sin red
  const { f: f2 } = await run(updateSettings(stateWith(DAYS), { ntfy: { enabled: false } }));
  assert.equal(f2.calls.length, 0);
});

test('cambio de topic: cancela en el viejo y programa en el nuevo', async () => {
  const { r } = await run(ntfyState());
  const s = updateSettings(ntfyState(), { ntfy: { ...r.ntfy, topic: 'turnos-mauricio-nuevo0000000' } });
  const { r: r2, f } = await run(s);
  assert.equal(deletes(f).length, 6);
  assert.ok(deletes(f).every((u) => u.startsWith(`https://ntfy.sh/${TOPIC}/`)));
  assert.equal(posts(f).length, 6);
  assert.ok(posts(f).every((p) => p.topic === 'turnos-mauricio-nuevo0000000'));
  assert.ok(Object.values(r2.scheduled).every((e) => e.topic === 'turnos-mauricio-nuevo0000000'));
});

test('errores de red: se guardan y se reintenta la próxima vez', async () => {
  const offline = mockFetch(() => { throw new TypeError('Failed to fetch'); });
  const { r } = await run(ntfyState(), NOW, offline);
  assert.deepEqual(r.scheduled, {});
  assert.deepEqual(r.errors, ['No hay conexión con ntfy. Comprueba internet.']);
  assert.equal(offline.calls.length, 1); // sin red no se insiste
  assert.equal(r.ntfy.lastError, r.errors[0]);
  // Cancelación fallida: la entrada se conserva
  const { r: ok } = await run(ntfyState());
  const s = updateSettings(ntfyState(), { ntfy: { ...ok.ntfy, enabled: false } });
  const { r: r2 } = await run(s, NOW, mockFetch(() => ({ status: 500 })));
  assert.equal(Object.keys(r2.scheduled).length, 6);
  assert.match(r2.errors[0], /ntfy no responde/);
  const limited = mockFetch(() => ({ status: 429 }));
  const { r: r3 } = await run(ntfyState(), NOW, limited);
  assert.match(r3.errors[0], /demasiados avisos/);
  assert.equal(limited.calls.length, 1);
  // Un error puntual (400) no detiene el resto
  let n = 0;
  const flaky = mockFetch(() => (++n === 1 ? { status: 400 } : { status: 200 }));
  const { r: r4 } = await run(ntfyState(), NOW, flaky);
  assert.equal(flaky.calls.length, 6);
  assert.equal(Object.keys(r4.scheduled).length, 5);
  assert.equal(r4.errors.length, 1);
});

test('servidor propio y recordatorios desactivados', async () => {
  const s = ntfyState(DAYS, { server: 'https://ntfy.example.org/' });
  const { f } = await run(updateSettings(s, { reminders: { eveningBefore: false } }));
  assert.ok(f.calls.every((c) => c.url === 'https://ntfy.example.org/'));
  assert.deepEqual(posts(f).map((p) => p.sequence_id), ['2026-10-13-F1-pre', '2026-10-14-S1-pre', KEEPALIVE_ID]);
});

test('testNtfy', async () => {
  const f = okFetch();
  const r = await testNtfy({ server: 'https://ntfy.sh', topic: TOPIC }, f, { appUrl: APP });
  assert.equal(r.ok, true);
  assert.match(r.message, /prueba/);
  assert.equal(f.calls[0].url, 'https://ntfy.sh/');
  const body = f.calls[0].json();
  assert.equal(body.topic, TOPIC);
  assert.equal(body.title, 'Turnos'); // título neutro (lo usan Mauricio y su hermana)
  assert.doesNotMatch(r.message, /iPhone/);
  assert.equal(body.click, APP);
  assert.equal(body.delay, undefined);
  assert.equal(body.sequence_id, undefined);
  assert.equal((await testNtfy({ topic: '' }, f)).ok, false);
  const bad = await testNtfy({ topic: TOPIC }, mockFetch(() => ({ status: 429 })));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /demasiados/);
});

test('IOS-2: el aviso "abre la app" es honesto y no lleva enlace (abriría Safari)', async () => {
  const { r, f } = await run(ntfyState());
  const keep = posts(f).find((p) => p.sequence_id === KEEPALIVE_ID);
  assert.equal(keep.click, undefined);
  assert.match(keep.message, /desde su icono en la pantalla de inicio/);
  assert.match(keep.message, /no desde este aviso/);
  assert.ok(r.scheduled[KEEPALIVE_ID]);
  // En iPhone/iPad no se pone enlace por defecto
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)' }), true);
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(isAppleMobile({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), false);
  assert.equal(isAppleMobile(null), false);
  // ntfy viene desactivado por defecto
  const { createDefaultState } = await import('../../docs/js/core/store.js');
  assert.equal(createDefaultState().settings.ntfy.enabled, false);
});
