import './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toKey, fromKey, addDays, diffDays, weekStart, isoWeek, monthKeys, weekdayShort, formatLong, formatShort,
  formatHours, formatSignedHours, parseHHMM, formatHHMM, berlinHolidays, holidayName, easterSunday, isKey,
  atTime, rangeKeys, weekdayIndex, formatMonth,
} from '../../docs/js/core/dates.js';

test('la zona horaria de los tests es Europe/Berlin', () => {
  assert.equal(new Date('2026-07-01T12:00:00Z').getHours(), 14);
  assert.equal(new Date('2026-12-01T12:00:00Z').getHours(), 13);
});

test('toKey / fromKey usan la fecha local', () => {
  assert.equal(toKey(new Date(2026, 9, 12, 23, 59)), '2026-10-12');
  assert.equal(toKey(new Date('2026-10-12T22:30:00Z')), '2026-10-13'); // 00:30 en Berlín
  const d = fromKey('2026-10-12');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 9, 12, 0, 0]);
  assert.throws(() => fromKey('12/10/2026'));
  assert.ok(isKey('2026-02-28'));
  assert.ok(!isKey('2026-02-30'));
  assert.ok(!isKey('2026-2-3'));
});

test('addDays cruza meses, años y cambios de hora', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-10-24', 1), '2026-10-25');
  assert.equal(addDays('2026-10-25', 1), '2026-10-26');
  assert.equal(addDays('2026-03-28', 2), '2026-03-30');
  assert.equal(diffDays('2026-03-28', '2026-03-30'), 2);
  assert.equal(diffDays('2026-10-30', '2026-10-20'), -10);
  assert.deepEqual(rangeKeys('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
});

test('weekStart devuelve el lunes', () => {
  assert.equal(weekStart('2026-10-12'), '2026-10-12');
  assert.equal(weekStart('2026-10-18'), '2026-10-12');
  assert.equal(weekStart('2026-10-14'), '2026-10-12');
  assert.equal(weekStart('2026-01-01'), '2025-12-29');
  assert.equal(weekStart('2026-03-29'), '2026-03-23'); // domingo del cambio de hora
  assert.equal(weekdayIndex('2026-10-12'), 0);
  assert.equal(weekdayIndex('2026-10-18'), 6);
});

test('isoWeek', () => {
  assert.equal(isoWeek('2026-10-12'), 42);
  assert.equal(isoWeek('2026-10-18'), 42);
  assert.equal(isoWeek('2026-01-01'), 1);
  assert.equal(isoWeek('2025-12-29'), 1);
  assert.equal(isoWeek('2026-12-31'), 53);
  assert.equal(isoWeek('2027-01-03'), 53);
  assert.equal(isoWeek('2027-01-04'), 1);
  assert.equal(isoWeek('2024-12-30'), 1);
});

test('monthKeys', () => {
  const june = monthKeys(2026, 6);
  assert.equal(june.length, 30);
  assert.equal(june[0], '2026-06-01');
  assert.equal(june[29], '2026-06-30');
  assert.equal(monthKeys(2026, 2).length, 28);
  assert.equal(monthKeys(2028, 2).length, 29);
});

test('formatos en español', () => {
  assert.equal(weekdayShort('2026-10-12'), 'lun');
  assert.equal(weekdayShort('2026-10-14'), 'mié');
  assert.equal(weekdayShort('2026-10-17'), 'sáb');
  assert.equal(formatLong('2026-10-13'), 'martes, 13 de octubre');
  assert.equal(formatShort('2026-10-13'), 'mar 13 oct');
  assert.equal(formatLong('2026-06-01'), 'lunes, 1 de junio');
  assert.equal(formatMonth(2026, 10), 'octubre 2026');
});

test('formatHours', () => {
  assert.equal(formatHours(36 * 60 + 30), '36 h 30');
  assert.equal(formatHours(480), '8 h');
  assert.equal(formatHours(0), '0 h');
  assert.equal(formatHours(5), '0 h 05');
  assert.equal(formatHours(-150), '−2 h 30');
  assert.equal(formatHours(-30), '−0 h 30');
  assert.equal(formatHours(-0), '0 h');
  assert.equal(formatSignedHours(270), '+4 h 30');
  assert.equal(formatSignedHours(-120), '−2 h');
  assert.equal(formatSignedHours(0), '0 h');
});

test('parseHHMM / formatHHMM', () => {
  assert.equal(parseHHMM('06:00'), 360);
  assert.equal(parseHHMM('13:30'), 810);
  assert.equal(parseHHMM('22:00'), 1320);
  assert.equal(parseHHMM('6:05'), 365);
  assert.equal(parseHHMM('24:00'), 1440);
  assert.equal(parseHHMM('25:00'), null);
  assert.equal(parseHHMM('12:60'), null);
  assert.equal(parseHHMM(''), null);
  assert.equal(parseHHMM(null), null);
  assert.equal(formatHHMM(810), '13:30');
  assert.equal(formatHHMM(1440), '00:00');
  const d = atTime('2026-10-12', '20:00');
  assert.equal(d.getHours(), 20);
  assert.equal(toKey(d), '2026-10-12');
});

test('festivos de Berlín 2026', () => {
  assert.equal(easterSunday(2026), '2026-04-05');
  assert.equal(easterSunday(2025), '2025-04-20');
  assert.equal(easterSunday(2027), '2027-03-28');
  const h = berlinHolidays(2026);
  for (const k of ['2026-01-01', '2026-03-08', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14',
    '2026-05-25', '2026-10-03', '2026-12-25', '2026-12-26']) {
    assert.ok(h.has(k), `falta ${k}`);
  }
  assert.equal(h.size, 10);
  assert.ok(!h.has('2026-04-05')); // el domingo de Pascua no es festivo legal en Berlín
  assert.equal(holidayName('2026-04-03'), 'Viernes Santo');
  assert.equal(holidayName('2026-10-03'), 'Día de la Unidad Alemana');
  assert.equal(holidayName('2026-10-12'), null);
  assert.ok(!berlinHolidays(2018).has('2018-03-08')); // Frauentag desde 2019
  assert.ok(berlinHolidays(2025).has('2025-04-18'));
});
