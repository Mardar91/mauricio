import { stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upcomingReminders } from '../../docs/js/core/reminders.js';
import { updateSettings, upsertCode } from '../../docs/js/core/store.js';

const NOW = new Date(2026, 9, 12, 10, 0); // lunes 12 oct, 10:00
const DAY = 24 * 3600 * 1000;
const local = (d) => [d.getDate(), d.getHours(), d.getMinutes()];

test('víspera a las 20:00 y 60 min antes, con ids estables', () => {
  const s = stateWith({ '2026-10-13': ['F1', 'F52'] });
  const r = upcomingReminders(s, NOW, 3 * DAY);
  assert.deepEqual(r.map((x) => x.id), ['2026-10-13-F1-eve', '2026-10-13-F1-pre']);
  assert.deepEqual(local(r[0].at), [12, 20, 0]);
  assert.deepEqual(local(r[1].at), [13, 5, 0]);
  for (const x of r) {
    assert.equal(x.key, '2026-10-13');
    assert.equal(x.code, 'F1');
    assert.ok(x.at instanceof Date);
    assert.equal(typeof x.title, 'string');
    assert.match(x.body, /F52/);
  }
  assert.match(r[0].title, /Mañana trabajas: 06:00–15:00/);
  assert.match(r[0].body, /martes, 13 de octubre/);
  assert.match(r[1].title, /en 1 h/);
});

test('noche: víspera 26 h antes; antes del inicio a las 21:00', () => {
  const s = stateWith({ '2026-10-13': ['N1'] });
  const r = upcomingReminders(s, NOW, 3 * DAY);
  assert.deepEqual(r.map((x) => [x.id, ...local(x.at)]), [
    ['2026-10-13-N1-eve', 12, 20, 0],
    ['2026-10-13-N1-pre', 13, 21, 0],
  ]);
});

test('solo futuros y dentro del horizonte, ordenados por hora', () => {
  const s = stateWith({ '2026-10-12': ['S1'], '2026-10-13': ['F1'], '2026-10-20': ['F1'] });
  const r = upcomingReminders(s, NOW, 2 * DAY);
  assert.deepEqual(r.map((x) => x.id), ['2026-10-12-S1-pre', '2026-10-13-F1-eve', '2026-10-13-F1-pre']);
  for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].at <= r[i].at);
  const later = upcomingReminders(s, new Date(2026, 9, 12, 21, 0), 2 * DAY);
  assert.deepEqual(later.map((x) => x.id), ['2026-10-13-F1-pre']);
  // Horizonte por defecto: 7 días (hasta el lun 19 a las 10:00)
  const week = stateWith({ '2026-10-18': ['F1'], '2026-10-20': ['F1'] });
  assert.deepEqual(upcomingReminders(week, NOW).map((x) => x.id), ['2026-10-18-F1-eve', '2026-10-18-F1-pre']);
});

test('respeta los ajustes de recordatorios', () => {
  const s = stateWith({ '2026-10-13': ['F1'] });
  const noEve = updateSettings(s, { reminders: { eveningBefore: false } });
  assert.deepEqual(upcomingReminders(noEve, NOW, 3 * DAY).map((x) => x.id), ['2026-10-13-F1-pre']);
  const noPre = updateSettings(s, { reminders: { beforeStart: false, eveningTime: '21:30' } });
  const r = upcomingReminders(noPre, NOW, 3 * DAY);
  assert.deepEqual(r.map((x) => x.id), ['2026-10-13-F1-eve']);
  assert.deepEqual(local(r[0].at), [12, 21, 30]);
  const min30 = updateSettings(s, { reminders: { minutesBefore: 30 } });
  const pre = upcomingReminders(min30, NOW, 3 * DAY).find((x) => x.id.endsWith('-pre'));
  assert.deepEqual(local(pre.at), [13, 5, 30]);
  assert.match(pre.title, /en 30 min/);
});

test('sin horario no hay recordatorio; un evento con horario sí', () => {
  let s = stateWith({ '2026-10-13': ['TS', '-'], '2026-10-14': ['U'], '2026-10-15': ['W-'] });
  assert.deepEqual(upcomingReminders(s, NOW, 5 * DAY), []);
  s = upsertCode(s, { code: 'TS', start: '14:00', end: '15:00' });
  const r = upcomingReminders(s, NOW, 5 * DAY);
  assert.deepEqual(r.map((x) => x.id), ['2026-10-13-TS-eve', '2026-10-13-TS-pre']);
  assert.match(r[0].title, /Reunión de equipo/);
});
