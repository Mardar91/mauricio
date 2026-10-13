import { stateWith, REAL_WEEK } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayMinutes, weekSummary, monthSummary, dailySollMinutes, isSollDay } from '../../docs/js/core/hours.js';
import { upsertCode } from '../../docs/js/core/store.js';

const H = 60;

test('horas netas por turno (pausa 30 min)', () => {
  const s = stateWith({ '2026-10-05': ['F1'], '2026-10-06': ['S1'], '2026-10-07': ['N1'], '2026-10-08': ['Z1'] });
  assert.equal(dayMinutes(s, '2026-10-05').worked, 8.5 * H);
  assert.equal(dayMinutes(s, '2026-10-06').worked, 8 * H);
  assert.equal(dayMinutes(s, '2026-10-07').worked, 7.5 * H);
  assert.equal(dayMinutes(s, '2026-10-08').worked, 8 * H);
  assert.deepEqual(dayMinutes(s, '2026-10-05').items, [{ code: 'F1', minutes: 510, type: 'worked' }]);
});

test('la noche del cambio de hora dura 9 h (8 h 30 netas) y cuenta para el día en que empieza', () => {
  const s = stateWith({ '2026-10-24': ['N1'] });
  assert.equal(dayMinutes(s, '2026-10-24').worked, 8.5 * H);
  assert.equal(dayMinutes(s, '2026-10-25').worked, 0);
  const spring = stateWith({ '2026-03-28': ['N1'] });
  assert.equal(dayMinutes(spring, '2026-03-28').worked, 6.5 * H);
});

test('día sin plan, libre y lugares no cuentan', () => {
  const s = stateWith({ '2026-10-14': ['-'], '2026-10-15': ['W-'], '2026-10-16': ['F52'] });
  assert.deepEqual(dayMinutes(s, '2026-10-13'), { worked: 0, credited: 0, total: 0, items: [] });
  assert.equal(dayMinutes(s, '2026-10-14').total, 0);
  assert.equal(dayMinutes(s, '2026-10-15').total, 0);
  assert.equal(dayMinutes(s, '2026-10-16').total, 0);
});

test('semana real de las fotos: 39 h 30 trabajadas, Soll 35 h', () => {
  const s = stateWith(REAL_WEEK);
  const w = weekSummary(s, '2026-10-12');
  assert.equal(w.from, '2026-10-12');
  assert.equal(w.to, '2026-10-18');
  assert.equal(w.worked, 39.5 * H);
  assert.equal(w.total, 39.5 * H);
  assert.equal(w.credited, 0);
  assert.equal(w.soll, 35 * H);
  assert.equal(w.diff, 4.5 * H);
  assert.deepEqual(w.days.map((d) => d.worked / H), [8.5, 8, 0, 8, 0, 7.5, 7.5]);
  assert.equal(w.days.length, 7);
  assert.equal(w.known, 7);
  // Cualquier día de la semana sirve como referencia
  assert.equal(weekSummary(s, '2026-10-16').total, 39.5 * H);
});

test('Soll semanal con festivos (lun–vie)', () => {
  const s = stateWith();
  assert.equal(weekSummary(s, '2026-03-30').soll, 28 * H); // Viernes Santo
  assert.equal(weekSummary(s, '2026-04-06').soll, 28 * H); // Lunes de Pascua
  assert.equal(weekSummary(s, '2026-05-25').soll, 28 * H); // Pentecostés
  assert.equal(weekSummary(s, '2026-09-28').soll, 35 * H); // 3/10/2026 es sábado
  assert.equal(weekSummary(s, '2026-12-21').soll, 28 * H); // 25/12 viernes; 26/12 sábado no cuenta
});

test('festivos no reducen el Soll si holidaysReduceSoll es false', () => {
  const s = stateWith({}, { holidaysReduceSoll: false });
  assert.equal(weekSummary(s, '2026-03-30').soll, 35 * H);
  assert.equal(monthSummary(s, 2026, 5).soll, 21 * 7 * H);
});

test('vacaciones: acreditan el Soll diario solo en días laborables', () => {
  let s = stateWith({ '2026-06-29': ['U'], '2026-06-30': ['U'], '2026-06-27': ['U'] });
  assert.equal(dailySollMinutes(s), 7 * H);
  assert.equal(dayMinutes(s, '2026-06-29').credited, 7 * H);
  assert.equal(dayMinutes(s, '2026-06-29').total, 7 * H);
  assert.equal(dayMinutes(s, '2026-06-27').credited, 0); // sábado
  assert.equal(weekSummary(s, '2026-06-29').credited, 14 * H);
  s = upsertCode(s, { code: 'U', creditHours: 8 });
  assert.equal(dayMinutes(s, '2026-06-29').credited, 8 * H);
  assert.ok(isSollDay(s, '2026-06-29'));
  assert.ok(!isSollDay(s, '2026-05-25'));
});

test('evento con horario solo cuenta si se activa', () => {
  let s = stateWith({ '2026-10-26': ['F1', 'TS'] });
  assert.equal(dayMinutes(s, '2026-10-26').worked, 8.5 * H);
  s = upsertCode(s, { code: 'TS', start: '15:00', end: '16:30', breakMin: 0, countsHours: true });
  assert.equal(dayMinutes(s, '2026-10-26').worked, 10 * H);
  s = upsertCode(s, { code: 'TS', countsHours: false });
  assert.equal(dayMinutes(s, '2026-10-26').worked, 8.5 * H);
});

test('Soll mensual: junio 2026 = 154 h; mayo 2026 = 126 h (3 festivos)', () => {
  const s = stateWith();
  const june = monthSummary(s, 2026, 6);
  assert.equal(june.soll, 154 * H);
  assert.equal(june.total, 0);
  assert.equal(june.diff, -154 * H);
  assert.equal(monthSummary(s, 2026, 5).soll, 126 * H);
  assert.equal(monthSummary(s, 2026, 10).soll, 22 * 7 * H); // 3/10 cae en sábado
});

test('resumen del mes de junio 2026 (impresión del PC)', () => {
  const days = {};
  const put = (list, codes) => { for (const d of list) days[`2026-06-${String(d).padStart(2, '0')}`] = codes; };
  put([1, 2, 3, 8, 9, 10, 13, 14, 17, 18, 19], ['-']);
  put([4, 5, 6, 7], ['F6', 'F52']);
  put([11, 12, 24], ['S1', 'S52']);
  put([15, 16], ['S1', 'S51']);
  put([20, 21], ['F1', 'F51']);
  put([22, 23], ['Z1', 'S52']);
  put([25, 26, 27, 28], ['W-']);
  put([29, 30], ['U']);
  const s = stateWith(days);
  const m = monthSummary(s, 2026, 6);
  // 4×F6 8,5 + 5×S1 8 + 2×F1 8,5 + 2×Z1 8 = 34 + 40 + 17 + 16 = 107 h; + 2 días de vacaciones (14 h)
  assert.equal(m.worked, 107 * H);
  assert.equal(m.credited, 14 * H);
  assert.equal(m.total, 121 * H);
  assert.equal(m.soll, 154 * H);
  assert.equal(m.diff, -33 * H);
  assert.equal(m.shifts, 13);
  assert.deepEqual(m.shiftCounts, { F6: 4, S1: 5, F1: 2, Z1: 2 });
  assert.equal(m.nights, 0);
  assert.equal(m.vacationDays, 2);
  assert.equal(m.freeDays, 15); // 11 libres + 4 W-
  // Fines de semana con turno: 6-7 jun (F6) y 20-21 jun (F1)
  assert.equal(m.weekendsWorked, 2);
  assert.equal(m.weekendDaysWorked, 4);
  assert.equal(m.daysKnown, 30);
  assert.equal(m.weeks.length, 5);
  assert.equal(m.weeks[0].from, '2026-06-01');
  assert.equal(m.weeks[4].from, '2026-06-29');
});

test('noches del mes y semana que empieza en el mes anterior', () => {
  const s = stateWith(REAL_WEEK);
  const m = monthSummary(s, 2026, 10);
  assert.equal(m.nights, 2);
  assert.equal(m.weekendsWorked, 1); // 17-18 oct
  assert.equal(m.weeks[0].from, '2026-09-28');
  assert.equal(m.weeks.length, 5);
  assert.equal(m.total, 39.5 * H);
});
