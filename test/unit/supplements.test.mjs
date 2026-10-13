import { stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPLEMENT_DEFAULTS, dayMinutes, daySupplements, intervalSupplementMs, monthSummary, monthSupplements, sanitizeSupplements, supplementSettings,
} from '../../docs/js/core/hours.js';
import { createDefaultState, setDay, updateSettings } from '../../docs/js/core/store.js';

const H = 60;

test('suplementos: valores por defecto (promedios de Berlín) y saneado', () => {
  assert.deepEqual(supplementSettings(createDefaultState()), {
    night: { from: '23:00', to: '06:00', pct: 26 }, saturday: { from: '13:00', to: '21:00', pct: 0 },
    sunday: { pct: 33 }, holiday: { pct: 40 }, hourlyWage: null,
  });
  assert.equal(SUPPLEMENT_DEFAULTS.night.pct, 26);
  const s = sanitizeSupplements({
    night: { from: '20:00', to: '6:00', pct: '25,5' }, saturday: { from: 'x', to: '24:00', pct: 500 },
    sunday: { pct: -1 }, holiday: null, hourlyWage: '18,75', extra: 1,
  });
  assert.deepEqual(s.night, { from: '20:00', to: '06:00', pct: 25.5 });
  assert.deepEqual(s.saturday, { from: '13:00', to: '21:00', pct: 0 }); // hora y porcentaje no válidos → por defecto
  assert.equal(s.sunday.pct, 33);
  assert.equal(s.holiday.pct, 40);
  assert.equal(s.hourlyWage, 18.75);
  assert.equal('extra' in s, false);
  for (const w of [0, -5, 'abc', 1000, null, undefined]) assert.equal(sanitizeSupplements({ hourlyWage: w }).hourlyWage, null, String(w));
  // updateSettings: mezcla profunda y saneado; null borra el salario
  let st = updateSettings(createDefaultState(), { supplements: { night: { pct: 20 }, hourlyWage: 21.5 } });
  assert.deepEqual(st.settings.supplements.night, { from: '23:00', to: '06:00', pct: 20 });
  assert.equal(st.settings.supplements.hourlyWage, 21.5);
  st = updateSettings(st, { supplements: { hourlyWage: null } });
  assert.equal(st.settings.supplements.hourlyWage, null);
});

test('noche de domingo a lunes: domingo hasta las 24:00, noche 23–6, pausa descontada en proporción', () => {
  // N1 22:00–06:00 (8 h, pausa 30 → 7 h 30 de trabajo: factor 450/480) del domingo 18 al lunes 19 oct
  const s = stateWith({ '2026-10-18': ['N1'] });
  assert.equal(dayMinutes(s, '2026-10-18').worked, 450);
  // domingo: 22–24 h = 120 min × 0,9375 = 112,5 → 113; noche: 23–6 h = 420 × 0,9375 = 393,75 → 394
  assert.deepEqual(daySupplements(s, '2026-10-18'), { night: 394, saturday: 0, sunday: 113, holiday: 0 });
  // Sin pausa: minutos enteros
  const noBreak = setDay(s, '2026-10-18', ['N1'], { times: { N1: { start: '22:00', end: '06:00', breakMin: 0 } } });
  assert.deepEqual(daySupplements(noBreak, '2026-10-18'), { night: 7 * H, saturday: 0, sunday: 2 * H, holiday: 0 });
});

test('festivo: noche del 24 al 25 de diciembre y de domingo a lunes de Pentecostés', () => {
  // 25/12/2026 (viernes) es festivo: las 6 h desde medianoche cuentan como festivo
  const xmas = stateWith({ '2026-12-24': ['N1'] });
  assert.deepEqual(daySupplements(xmas, '2026-12-24'), { night: 394, saturday: 0, sunday: 0, holiday: 338 }); // 360 × 0,9375 = 337,5
  // Domingo 24/5 → lunes de Pentecostés (25/5/2026): domingo 2 h y festivo 6 h
  const pfingsten = stateWith({ '2026-05-24': ['N1'] });
  assert.deepEqual(daySupplements(pfingsten, '2026-05-24'), { night: 394, saturday: 0, sunday: 113, holiday: 338 });
  // Festivo en sábado (3/10/2026): solo festivo, sin la franja del sábado
  const unity = stateWith({ '2026-10-03': ['S1'] }, { supplements: { saturday: { pct: 20 } } });
  assert.deepEqual(daySupplements(unity, '2026-10-03'), { night: 0, saturday: 0, sunday: 0, holiday: 480 });
});

test('sábado: solo la franja 13–21 h; configurable', () => {
  // S1 13:30–22:00 (8 h 30, pausa 30): 13:30–21:00 = 450 min × 480/510 = 423,5 → 424
  const s = stateWith({ '2026-10-17': ['S1'] });
  assert.deepEqual(daySupplements(s, '2026-10-17'), { night: 0, saturday: 424, sunday: 0, holiday: 0 });
  // F1 de sábado: 13:00–15:00 = 120 × 510/540
  assert.equal(daySupplements(stateWith({ '2026-10-17': ['F1'] }), '2026-10-17').saturday, 113);
  // Otra franja (12–20 h) y otra noche (20–6 h)
  const c = updateSettings(s, { supplements: { saturday: { from: '12:00', to: '20:00' }, night: { from: '20:00', to: '06:00' } } });
  assert.deepEqual(daySupplements(c, '2026-10-17'), { night: Math.round(120 * 480 / 510), saturday: Math.round(390 * 480 / 510), sunday: 0, holiday: 0 });
  // Un día laborable normal no tiene suplementos
  assert.deepEqual(daySupplements(stateWith({ '2026-10-13': ['F1'] }), '2026-10-13'), { night: 0, saturday: 0, sunday: 0, holiday: 0 });
});

test('cambio de hora: la noche del 25 oct dura 9 h reales y la del 29 mar, 7 h', () => {
  // Sábado 24 → domingo 25 oct 2026 (a las 3:00 vuelven a ser las 2:00): 9 h reales, pausa 30 → 510
  const oct = stateWith({ '2026-10-24': ['N1'] });
  assert.equal(dayMinutes(oct, '2026-10-24').worked, 510);
  // domingo 0–6 h = 7 h reales; noche 23–6 h = 8 h reales (× 510/540)
  assert.deepEqual(daySupplements(oct, '2026-10-24'), { night: Math.round(480 * 510 / 540), saturday: 0, sunday: Math.round(420 * 510 / 540), holiday: 0 });
  // Sábado 28 → domingo 29 mar 2026 (a las 2:00 pasan a ser las 3:00): 7 h reales, pausa 30 → 390
  const mar = stateWith({ '2026-03-28': ['N1'] });
  assert.equal(dayMinutes(mar, '2026-03-28').worked, 390);
  assert.deepEqual(daySupplements(mar, '2026-03-28'), { night: Math.round(360 * 390 / 420), saturday: 0, sunday: Math.round(300 * 390 / 420), holiday: 0 });
  // Intervalo suelto: 22:00 del 24 a 06:00 del 25 oct
  const ms = intervalSupplementMs(new Date(2026, 9, 24, 22, 0), new Date(2026, 9, 25, 6, 0));
  assert.deepEqual(ms, { night: 8 * 3600000, saturday: 0, sunday: 7 * 3600000, holiday: 0 });
});

test('mes: suma de todos los turnos (la noche cuenta para el mes en que empieza) y € estimados', () => {
  let s = stateWith({
    '2026-10-17': ['S1'], '2026-10-18': ['N1'], '2026-10-24': ['N1'], '2026-10-03': ['F1'], '2026-10-31': ['N1'],
    '2026-10-13': ['U'], '2026-10-14': ['-'],
  });
  const m = monthSummary(s, 2026, 10).supplements;
  // 31/10 (sábado) N1 → 1/11 (domingo, no es festivo en Berlín): cuenta en octubre
  const d31 = daySupplements(s, '2026-10-31');
  assert.equal(d31.sunday, Math.round(360 * 0.9375));
  assert.equal(m.night.minutes, Math.round(393.75 + 480 * 510 / 540 + 393.75));
  assert.equal(m.holiday.minutes, 510);
  assert.equal(m.saturday.minutes, 424);
  assert.deepEqual([m.night.pct, m.night.from, m.night.to], [26, '23:00', '06:00']);
  assert.equal(m.euros, null);
  assert.equal(m.night.euros, null);
  assert.deepEqual(monthSupplements(s, 2026, 10), m);
  assert.deepEqual(monthSupplements(s, 2026, 11).night.minutes, 0);
  // Con salario: € = horas × salario × %
  s = updateSettings(s, { supplements: { hourlyWage: 20, saturday: { pct: 20 } } });
  const e = monthSummary(s, 2026, 10).supplements;
  assert.equal(e.hourlyWage, 20);
  assert.equal(e.night.euros, Math.round(e.night.minutes / 60 * 20 * 26) / 100);
  assert.equal(e.saturday.euros, Math.round(424 / 60 * 20 * 20) / 100);
  assert.equal(e.holiday.euros, 68); // 8 h 30 × 20 € × 40 %
  assert.equal(e.euros, Math.round((e.night.euros + e.saturday.euros + e.sunday.euros + e.holiday.euros) * 100) / 100);
});

test('suplementos: solo lo que cuenta horas, con el horario especial del día', () => {
  // TS sin horario, vacaciones y lugares no suman; un turno con horario especial usa ese horario
  let s = stateWith({ '2026-10-18': ['F1', 'TS', 'F52'], '2026-10-25': ['U'] });
  assert.deepEqual(daySupplements(s, '2026-10-25'), { night: 0, saturday: 0, sunday: 0, holiday: 0 });
  s = setDay(s, '2026-10-18', ['F1', 'TS', 'F52'], { times: { F1: { start: '05:00', end: '09:00', breakMin: 0 } } });
  assert.deepEqual(daySupplements(s, '2026-10-18'), { night: H, saturday: 0, sunday: 4 * H, holiday: 0 });
  // Un día sin plan
  assert.deepEqual(daySupplements(s, '2026-10-19'), { night: 0, saturday: 0, sunday: 0, holiday: 0 });
});
