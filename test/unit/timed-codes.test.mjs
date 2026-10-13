import { stateWith, T0 } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessCode, timedInterval, countsAsWork, isTimedCode, isNightCode } from '../../docs/js/core/codes.js';
import { upcomingReminders, dayTimedItems } from '../../docs/js/core/reminders.js';
import { buildICS } from '../../docs/js/core/ics.js';
import { dayMinutes, monthSummary } from '../../docs/js/core/hours.js';
import { getAdvice } from '../../docs/js/core/advice.js';
import { setDay, upsertCode, updateSettings, migrateState } from '../../docs/js/core/store.js';

const NOW = new Date(2026, 9, 12, 10, 0); // lun 12 oct 10:00
const DAY = 24 * 3600 * 1000;
const unfold = (ics) => ics.replace(/\r\n[ \t]/g, '');
function vevent(ics, uid) {
  const ls = unfold(ics).split('\r\n');
  const i = ls.indexOf(`UID:${uid}`);
  if (i < 0) return null;
  const end = ls.indexOf('END:VEVENT', i);
  return ls.slice(i, end);
}
const prop = (ev, name) => ev.find((l) => l.startsWith(name + ':') || l.startsWith(name + ';'));

test('guessCode: letra+1 dígito → turno; letra+2 dígitos → lugar; lo demás → otro sin horario', () => {
  const x9 = guessCode('X9');
  assert.deepEqual([x9.kind, x9.start, x9.end, x9.confirmed, x9.countsHours], ['shift', null, null, false, true]);
  assert.equal(guessCode('F4').start, '06:00');
  assert.equal(guessCode('Q12').kind, 'place');
  const fb = guessCode('FB');
  assert.deepEqual([fb.kind, fb.start, fb.end, fb.confirmed], ['other', null, null, false]);
});

test("C3: un código 'other' con horario da avisos, evento en el calendario y no es día libre", () => {
  let s = stateWith({ '2026-10-13': ['F1'], '2026-10-15': ['FB'], '2026-10-16': ['-'] });
  // Como lo guarda el editor: tipo 'Otro' con 08:00–16:00
  s = upsertCode(s, { code: 'FB', kind: 'other', name: 'Formación', start: '08:00', end: '16:00', breakMin: 30, countsHours: false, confirmed: true });
  const ids = upcomingReminders(s, NOW, 5 * DAY).map((r) => r.id);
  assert.ok(ids.includes('2026-10-15-FB-eve') && ids.includes('2026-10-15-FB-pre'), ids.join());
  const ev = vevent(buildICS(s, { now: NOW }), '2026-10-15-FB@turnos-mauricio');
  assert.equal(prop(ev, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261015T080000');
  assert.equal(prop(ev, 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261015T160000');
  assert.equal(ev.filter((l) => l === 'BEGIN:VALARM').length, 2);
  assert.equal(dayMinutes(s, '2026-10-15').worked, 0); // no cuenta horas si no se marca
  const advice = getAdvice(s, NOW);
  assert.ok(!advice.some((a) => a.id.startsWith('free-2026-10-15')), advice.map((a) => a.id).join());
  // Si cuenta horas, se comporta como un turno
  const counted = upsertCode(s, { code: 'FB', countsHours: true });
  assert.equal(dayMinutes(counted, '2026-10-15').worked, 7 * 60 + 30);
  assert.ok(countsAsWork(counted.codes.FB));
  assert.match(upcomingReminders(counted, NOW, 5 * DAY).find((r) => r.id === '2026-10-15-FB-pre').title, /Tu turno empieza/);
  // Sin horario sigue sin evento ni aviso
  const plain = stateWith({ '2026-10-15': ['FB'] });
  assert.equal(upcomingReminders(plain, NOW, 5 * DAY).length, 0);
  assert.ok(!buildICS(plain, { now: NOW }).includes('FB'));
});

test('C4: un evento con solo hora de inicio → aviso y evento de 1 h (no de día completo)', () => {
  let s = stateWith({ '2026-10-15': ['F1', 'TS'] });
  s = upsertCode(s, { code: 'TS', start: '14:00', end: null });
  const iv = timedInterval(s, '2026-10-15', 'TS');
  assert.equal(iv.startOnly, true);
  assert.equal((iv.end - iv.start) / 60000, 60);
  const items = dayTimedItems(s, '2026-10-15');
  assert.deepEqual(items.map((i) => [i.code, i.startOnly]), [['F1', false], ['TS', true]]);
  const rem = upcomingReminders(s, NOW, 5 * DAY).filter((r) => r.code === 'TS');
  assert.deepEqual(rem.map((r) => r.id), ['2026-10-15-TS-eve', '2026-10-15-TS-pre']);
  assert.match(rem[0].title, /Mañana: Reunión de equipo a las 14:00/);
  assert.match(rem[1].body, /· 14:00$/);
  const ev = vevent(buildICS(s, { now: NOW }), '2026-10-15-TS@turnos-mauricio');
  assert.equal(prop(ev, 'DTSTART'), 'DTSTART;TZID=Europe/Berlin:20261015T140000');
  assert.equal(prop(ev, 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261015T150000');
  assert.match(prop(ev, 'DESCRIPTION'), /Hora: 14:00/);
  assert.equal(ev.filter((l) => l === 'BEGIN:VALARM').length, 2);
  assert.ok(!ev.some((l) => l.includes('VALUE=DATE')));
  assert.equal(dayMinutes(s, '2026-10-15').items.find((i) => i.code === 'TS').minutes, 0); // sin fin no suma horas
  // A última hora del día: el fin pasa al día siguiente
  const late = upsertCode(s, { code: 'TS', start: '23:30' });
  assert.equal(prop(vevent(buildICS(late, { now: NOW }), '2026-10-15-TS@turnos-mauricio'), 'DTEND'), 'DTEND;TZID=Europe/Berlin:20261016T003000');
});

test('isTimedCode / isNightCode con tipos no turno', () => {
  assert.equal(isTimedCode({ kind: 'event', start: '10:00', end: null }), true);
  assert.equal(isTimedCode({ kind: 'place', start: '10:00', end: '12:00', countsHours: false }), false);
  assert.equal(isTimedCode({ kind: 'place', start: '10:00', end: '12:00', countsHours: true }), true);
  assert.equal(isTimedCode({ kind: 'vacation', start: '10:00', end: '12:00', countsHours: true }), false);
  assert.equal(isNightCode({ kind: 'other', start: '22:00', end: '06:00', countsHours: true }), true);
  assert.equal(isNightCode({ kind: 'event', start: '22:00', end: '06:00', countsHours: false }), false);
});

test('C6: días sin updatedAt → DTSTAMP fijo (no "ahora"); el ICS no cambia entre ejecuciones', () => {
  const s = migrateState({ days: { '2026-10-20': ['F1'] } }); // formato antiguo, sin updatedAt
  assert.equal(s.days['2026-10-20'].updatedAt, null);
  const a = buildICS(s, { now: NOW });
  const b = buildICS(s, { now: new Date(NOW.getTime() + 3 * DAY) });
  assert.equal(a, b);
  assert.equal(prop(vevent(a, '2026-10-20-F1@turnos-mauricio'), 'DTSTAMP'), 'DTSTAMP:20261020T000000Z');
});

test('C8: LAST-MODIFIED y SEQUENCE suben si cambia el horario del código o los avisos; si no, estables', () => {
  const s0 = stateWith({ '2026-10-20': ['F6'] }); // días sellados en T0
  const ev = (s) => vevent(buildICS(s, { now: NOW }), '2026-10-20-F6@turnos-mauricio');
  const seq = (s) => Number(prop(ev(s), 'SEQUENCE').slice(9));
  assert.equal(prop(ev(s0), 'LAST-MODIFIED'), 'LAST-MODIFIED:20261001T080000Z');
  assert.equal(prop(ev(s0), 'DTSTAMP'), 'DTSTAMP:20261001T080000Z');
  // Mismo contenido otro día → idéntico
  assert.equal(buildICS(s0, { now: NOW }), buildICS(s0, { now: new Date(NOW.getTime() + 5 * DAY) }));
  const s1 = upsertCode(s0, { code: 'F6', start: '07:00', end: '15:30' }, { now: new Date(T0.getTime() + DAY) });
  assert.equal(prop(ev(s1), 'LAST-MODIFIED'), 'LAST-MODIFIED:20261002T080000Z');
  assert.ok(seq(s1) > seq(s0));
  const s2 = updateSettings(s1, { reminders: { minutesBefore: 90 } }, { now: new Date(T0.getTime() + 2 * DAY) });
  assert.ok(seq(s2) > seq(s1));
  assert.equal(prop(ev(s2), 'LAST-MODIFIED'), 'LAST-MODIFIED:20261003T080000Z');
  // Cambiar otra cosa (el nombre) no toca el calendario
  assert.equal(buildICS(updateSettings(s2, { name: 'X' }), { now: NOW }), buildICS(s2, { now: NOW }));
});

test('ICS: opción places=false quita lugar de SUMMARY, LOCATION y DESCRIPTION', () => {
  let s = stateWith({ '2026-10-20': ['F1', 'F52'] });
  s = upsertCode(s, { code: 'F52', place: 'Hermannstr. 5' });
  const ics = buildICS(s, { now: NOW, places: false });
  const ev = vevent(ics, '2026-10-20-F1@turnos-mauricio');
  assert.equal(prop(ev, 'SUMMARY'), 'SUMMARY:🌅 F1 Mañana');
  assert.equal(prop(ev, 'LOCATION'), undefined);
  assert.ok(!ics.includes('Hermannstr'));
});

test('C5 (horas): un día con solo una reunión o un código desconocido no es día libre', () => {
  const s = stateWith({ '2026-10-13': ['TS'], '2026-10-14': ['-'], '2026-10-15': ['W-'], '2026-10-16': ['FB'], '2026-10-17': [] });
  const m = monthSummary(s, 2026, 10);
  assert.equal(m.freeDays, 3); // '-', 'W-' y el plan vacío
});

test("hours: un código 'other' que cuenta horas suma como turno (también de noche)", () => {
  let s = stateWith({ '2026-10-13': ['NX'] });
  s = upsertCode(s, { code: 'NX', kind: 'other', start: '22:00', end: '06:00', breakMin: 30, countsHours: true });
  const m = monthSummary(s, 2026, 10);
  assert.equal(m.nights, 1);
  assert.equal(m.shifts, 1);
  assert.equal(dayMinutes(s, '2026-10-13').worked, 7 * 60 + 30);
  assert.ok(setDay(s, '2026-10-14', ['NX']).days['2026-10-14']);
});
