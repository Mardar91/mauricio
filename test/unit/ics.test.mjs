import { stateWith, REAL_WEEK } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildICS, escapeText, foldLine, triggerDuration } from '../../docs/js/core/ics.js';
import { setDay, updateSettings, upsertCode } from '../../docs/js/core/store.js';

const NOW = new Date(2026, 9, 12, 10, 0);
const enc = new TextEncoder();

const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
const lines = (ics) => unfold(ics).split('\r\n').filter(Boolean);

// VEVENTs como listas de líneas (desplegadas); sin el aviso «Sube el plan» (plan: true → solo ese)
function events(ics, { plan = false } = {}) {
  const out = [];
  let cur = null;
  for (const l of lines(ics)) {
    if (l === 'BEGIN:VEVENT') cur = [];
    else if (l === 'END:VEVENT') { out.push(cur); cur = null; } else if (cur) cur.push(l);
  }
  return out.filter((ev) => ev.some((l) => l.startsWith('UID:plan-')) === plan);
}
const prop = (ev, name) => ev.find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));
const triggers = (ev) => ev.filter((l) => l.startsWith('TRIGGER:')).map((l) => l.slice(8));
const byUid = (ics, uid) => events(ics).find((ev) => prop(ev, 'UID') === `UID:${uid}`);

test('estructura: CRLF, cabeceras y VTIMEZONE de Berlín', () => {
  const ics = buildICS(stateWith(REAL_WEEK), { now: NOW });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'hay saltos de línea sin CR');
  const ls = lines(ics);
  assert.equal(ls[0], 'BEGIN:VCALENDAR');
  assert.equal(ls.at(-1), 'END:VCALENDAR');
  for (const l of ['VERSION:2.0', 'PRODID:-//Turnos//ES', 'X-WR-CALNAME:Mis turnos', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H', 'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'DTSTART:19700329T020000', 'DTSTART:19701025T030000']) {
    assert.ok(ls.includes(l), `falta ${l}`);
  }
  assert.ok(ls.some((l) => l.startsWith('PRODID:')));
  // BEGIN/END equilibrados
  const depth = ls.reduce((d, l) => d + (l.startsWith('BEGIN:') ? 1 : l.startsWith('END:') ? -1 : 0), 0);
  assert.equal(depth, 0);
});

test('un VEVENT por turno con horario; lugares, UID estable y resumen', () => {
  const ics = buildICS(stateWith(REAL_WEEK), { now: NOW });
  const evs = events(ics);
  assert.equal(evs.length, 5);
  const f1 = byUid(ics, '2026-10-12-F1@turnos-mauricio');
  assert.ok(f1);
  assert.equal(prop(f1, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261012T060000');
  assert.equal(prop(f1, 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261012T150000');
  assert.equal(prop(f1, 'SUMMARY'), 'SUMMARY:🌅 F1 Mañana · F52');
  assert.equal(prop(f1, 'LOCATION'), 'LOCATION:F52');
  assert.match(prop(f1, 'DESCRIPTION'), /06:00–15:00\\nPausa: 30 min/);
  assert.match(prop(f1, 'DTSTAMP'), /^DTSTAMP:\d{8}T\d{6}Z$/);
  const n1 = byUid(ics, '2026-10-17-N1@turnos-mauricio');
  assert.equal(prop(n1, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261017T220000');
  assert.equal(prop(n1, 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261018T060000');
  // Mismo contenido → mismo resultado (hash estable para la sincronización)
  assert.equal(buildICS(stateWith(REAL_WEEK), { now: NOW }), ics);
});

test('alarmas relativas: víspera a las 20:00 y 60 min antes', () => {
  const ics = buildICS(stateWith(REAL_WEEK), { now: NOW });
  assert.deepEqual(triggers(byUid(ics, '2026-10-12-F1@turnos-mauricio')), ['-PT10H', '-PT1H']);
  assert.deepEqual(triggers(byUid(ics, '2026-10-13-S1@turnos-mauricio')), ['-PT17H30M', '-PT1H']);
  assert.deepEqual(triggers(byUid(ics, '2026-10-17-N1@turnos-mauricio')), ['-PT26H', '-PT1H']);
  const f1 = byUid(ics, '2026-10-12-F1@turnos-mauricio');
  assert.equal(f1.filter((l) => l === 'BEGIN:VALARM').length, 2);
  assert.equal(f1.filter((l) => l === 'ACTION:DISPLAY').length, 2);
  assert.equal(f1.filter((l) => l.startsWith('DESCRIPTION:')).length, 3);
});

test('alarma de la víspera con cambio de hora: 27 h reales', () => {
  // Noche del domingo 25 oct: la víspera (sáb 20:00) está a 27 h por el cambio de hora
  const ics = buildICS(stateWith({ '2026-10-25': ['N1'], '2026-10-26': ['F1'] }), { now: NOW });
  assert.deepEqual(triggers(byUid(ics, '2026-10-25-N1@turnos-mauricio')), ['-PT27H', '-PT1H']);
  assert.deepEqual(triggers(byUid(ics, '2026-10-26-F1@turnos-mauricio')), ['-PT10H', '-PT1H']);
});

test('alarmas desactivadas se omiten', () => {
  const s = stateWith({ '2026-10-12': ['F1'] });
  const noEve = buildICS(updateSettings(s, { reminders: { eveningBefore: false, minutesBefore: 90 } }), { now: NOW });
  assert.deepEqual(triggers(byUid(noEve, '2026-10-12-F1@turnos-mauricio')), ['-PT1H30M']);
  const none = buildICS(updateSettings(s, { reminders: { eveningBefore: false, beforeStart: false } }), { now: NOW });
  assert.ok(events(none).every((ev) => !ev.includes('BEGIN:VALARM')));
  const noPlan = buildICS(updateSettings(s, { reminders: { eveningBefore: false, beforeStart: false, planUpload: false } }), { now: NOW });
  assert.ok(!noPlan.includes('BEGIN:VALARM'));
  const late = buildICS(updateSettings(s, { reminders: { eveningTime: '21:15', beforeStart: false } }), { now: NOW });
  assert.deepEqual(triggers(byUid(late, '2026-10-12-F1@turnos-mauricio')), ['-PT8H45M']);
});

test('vacaciones: evento de día completo sin alarma; libres y lugares sin evento', () => {
  const s = stateWith({ '2026-10-29': ['U'], '2026-10-30': ['W-'], '2026-10-31': ['-'] });
  const ics = buildICS(s, { now: NOW });
  const evs = events(ics);
  assert.equal(evs.length, 1);
  const u = byUid(ics, '2026-10-29-U@turnos-mauricio');
  assert.equal(prop(u, 'DTSTART'), 'DTSTART;VALUE=DATE:20261029');
  assert.equal(prop(u, 'DTEND'), 'DTEND;VALUE=DATE:20261030');
  assert.match(prop(u, 'SUMMARY'), /Vacaciones/);
  assert.ok(!u.includes('BEGIN:VALARM'));
});

test('reunión sin horario → día completo; con horario → evento con alarmas', () => {
  let s = stateWith({ '2026-10-26': ['F1', 'TS'] });
  let ts = byUid(buildICS(s, { now: NOW }), '2026-10-26-TS@turnos-mauricio');
  assert.equal(prop(ts, 'DTSTART'), 'DTSTART;VALUE=DATE:20261026');
  assert.ok(!ts.includes('BEGIN:VALARM'));
  s = upsertCode(s, { code: 'TS', start: '15:00', end: '16:00' });
  ts = byUid(buildICS(s, { now: NOW }), '2026-10-26-TS@turnos-mauricio');
  assert.equal(prop(ts, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261026T150000');
  assert.deepEqual(triggers(ts), ['-PT19H', '-PT1H']);
});

test('rango por defecto: desde el día 1 del mes de hace 2 meses; from/to explícitos', () => {
  const s = stateWith({ '2026-07-31': ['F1'], '2026-08-01': ['F1'], '2026-08-20': ['F1'], '2027-03-01': ['S1'] });
  const uids = (ics) => events(ics).map((ev) => prop(ev, 'UID').slice(4, 14));
  assert.deepEqual(uids(buildICS(s, { now: NOW })), ['2026-08-01', '2026-08-20', '2027-03-01']);
  // Todo octubre da el mismo rango (y el mismo contenido, sin el aviso «Sube el plan», que va por días)
  const quiet = updateSettings(s, { reminders: { planUpload: false } }, { now: NOW });
  assert.equal(buildICS(quiet, { now: new Date(2026, 9, 31, 23, 0) }), buildICS(quiet, { now: new Date(2026, 9, 1, 0, 30) }));
  assert.deepEqual(uids(buildICS(s, { now: new Date(2026, 10, 1, 9, 0) })), ['2027-03-01']); // desde el 1 sept
  assert.deepEqual(uids(buildICS(s, { from: '2026-01-01', to: '2026-12-31', now: NOW })), ['2026-07-31', '2026-08-01', '2026-08-20']);
});

test('escape de texto y notas con caracteres especiales', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  let s = stateWith({ '2026-10-12': ['F1', 'F52'] });
  s = setDay(s, '2026-10-12', ['F1', 'F52'], { note: 'Llaves; código 1,2\nllamar' });
  s = upsertCode(s, { code: 'F52', place: 'Hermannstr. 5, Neukölln' });
  const f1 = byUid(buildICS(s, { now: NOW, notes: true }), '2026-10-12-F1@turnos-mauricio');
  assert.equal(prop(f1, 'LOCATION'), 'LOCATION:F52 (Hermannstr. 5\\, Neukölln)');
  assert.match(prop(f1, 'DESCRIPTION'), /Nota: Llaves\\; código 1\\,2\\nllamar/);
  // Por defecto las notas no van al calendario
  assert.ok(!buildICS(s, { now: NOW }).includes('Llaves'));
});

test('plegado de líneas a 75 octetos sin partir caracteres UTF-8', () => {
  let s = stateWith({ '2026-10-12': ['F1', 'F52'] });
  s = setDay(s, '2026-10-12', ['F1', 'F52'], { note: 'ñ🌅é'.repeat(40) });
  const ics = buildICS(s, { now: NOW, notes: true });
  for (const physical of ics.split('\r\n')) {
    assert.ok(enc.encode(physical).length <= 75, `línea de ${enc.encode(physical).length} octetos`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(physical), 'emoji partido');
  }
  assert.ok(ics.includes('\r\n '));
  assert.ok(unfold(ics).includes('ñ🌅é'.repeat(40)));
  assert.equal(foldLine('corta'), 'corta');
  const long = 'X'.repeat(200);
  const folded = foldLine(long);
  assert.deepEqual(folded.split('\r\n').map((l) => l.length), [75, 75, 52]); // 75 + (1+74) + (1+51)
  assert.equal(folded.replace(/\r\n /g, ''), long);
});

test('triggerDuration', () => {
  assert.equal(triggerDuration(10 * 3600000), '-PT10H');
  assert.equal(triggerDuration(26 * 3600000), '-PT26H');
  assert.equal(triggerDuration(90 * 60000), '-PT1H30M');
  assert.equal(triggerDuration(15 * 60000), '-PT15M');
  assert.equal(triggerDuration(0), '-PT0M');
});
