import { stateWith } from './helpers.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BALANCE_DEFAULTS, isMonthKey, nextMonthKey, overtimeBalance, sanitizeBalances, vacationSummary } from '../../docs/js/core/hours.js';
import { createDefaultState, exportBackup, importBackup, updateSettings } from '../../docs/js/core/store.js';

const NOW = new Date(2026, 9, 13, 12, 0); // martes 13 oct 2026

// Septiembre a medias (solo 3 días cargados), octubre hasta hoy y días futuros que no cuentan
const DAYS = {
  '2026-09-28': ['F1'], // lunes: 8 h 30 − 7 h = +1 h 30
  '2026-09-29': ['-'],  // martes libre: −7 h
  '2026-09-30': ['F1'], // +1 h 30
  '2026-10-10': ['N1'], // sábado: 7 h 30, sin objetivo → +7 h 30
  '2026-10-12': ['F1'], // +1 h 30
  '2026-10-13': ['S1'], // hoy: 8 h − 7 h = +1 h
  '2026-10-20': ['F1'], // futuro: no cuenta
};

test('saldo de horas: mes a mes desde el mes inicial, solo días con plan, mes en curso hasta hoy', () => {
  const s = stateWith(DAYS, { balances: { overtimeStartMin: 120, overtimeStartMonth: '2026-09' } });
  const b = overtimeBalance(s, { now: NOW });
  assert.equal(b.startMonth, '2026-09');
  assert.equal(b.auto, false);
  assert.equal(b.through, '2026-10-13');
  assert.equal(b.months.length, 2);
  const [sep, oct] = b.months;
  // Septiembre: 3 días con plan (los demás no inventan horas ni restan objetivo)
  assert.deepEqual([sep.month, sep.days, sep.daysKnown, sep.complete, sep.current], ['2026-09', 30, 3, false, false]);
  assert.deepEqual([sep.total, sep.soll, sep.diff, sep.cumulative], [1020, 1260, -240, -120]);
  // Octubre hasta hoy (el 20 no cuenta)
  assert.deepEqual([oct.from, oct.to, oct.days, oct.daysKnown, oct.current], ['2026-10-01', '2026-10-13', 13, 3, true]);
  assert.deepEqual([oct.total, oct.soll, oct.diff], [450 + 510 + 480, 2 * 420, 600]);
  assert.equal(oct.cumulative, 480);
  assert.equal(b.balance, 480);
  // through explícito: hasta el 12
  assert.equal(overtimeBalance(s, { now: NOW, through: '2026-10-12' }).balance, 480 - 60);
  // Un mes completo con plan
  const full = {};
  for (let d = 1; d <= 30; d++) full[`2026-11-${String(d).padStart(2, '0')}`] = ['-'];
  const nov = overtimeBalance(stateWith(full, { balances: { overtimeStartMonth: '2026-11' } }), { now: new Date(2026, 11, 5) });
  assert.equal(nov.months[0].complete, true);
  assert.equal(nov.months[0].soll, 21 * 420); // 21 días laborables en noviembre de 2026
  assert.equal(nov.months[1].month, '2026-12');
  assert.equal(nov.months[1].daysKnown, 0);
  assert.equal(nov.balance, -21 * 420);
});

test('saldo de horas: sin mes inicial empieza en el primer mes con plan; casos vacíos', () => {
  const auto = overtimeBalance(stateWith(DAYS), { now: NOW });
  assert.equal(auto.startMonth, '2026-09');
  assert.equal(auto.auto, true);
  assert.equal(auto.balance, 360); // sin saldo inicial
  // Sin días: solo el saldo inicial
  const empty = overtimeBalance(stateWith({}, { balances: { overtimeStartMin: -90 } }), { now: NOW });
  assert.deepEqual([empty.startMonth, empty.months.length, empty.balance], [null, 0, -90]);
  // Mes inicial en el futuro
  const future = overtimeBalance(stateWith(DAYS, { balances: { overtimeStartMonth: '2027-01', overtimeStartMin: 30 } }), { now: NOW });
  assert.deepEqual([future.months.length, future.balance], [0, 30]);
  // Vacaciones acreditan: día laborable con U = 0
  const vac = overtimeBalance(stateWith({ '2026-10-12': ['U'] }), { now: NOW });
  assert.equal(vac.balance, 0);
  // Contrato de 38,5 h
  const c = overtimeBalance(stateWith({ '2026-10-12': ['F1'] }, { weeklyHours: 38.5 }), { now: NOW });
  assert.equal(c.balance, 510 - 462);
});

test('vacaciones del año: derecho + arrastre, usadas, planificadas y restantes', () => {
  const s = stateWith({
    '2026-10-05': ['U'],  // lunes, pasado → usado
    '2026-10-06': ['K'],  // enfermedad: no gasta vacaciones
    '2026-10-13': ['U'],  // hoy → usado
    '2026-10-17': ['U'],  // sábado: no gasta
    '2026-10-19': ['U'],  // futuro → planificado
    '2026-12-25': ['U'],  // festivo (viernes): no gasta
    '2027-01-04': ['U'],  // otro año
  }, { balances: { vacationDaysPerYear: 30, vacationCarryOver: 2.5 } });
  const v = vacationSummary(s, 2026, { now: NOW });
  assert.deepEqual(v, {
    year: 2026, entitlement: 30, carryOver: 2.5, total: 32.5, used: 2, planned: 1, remaining: 29.5,
    usedDays: ['2026-10-05', '2026-10-13'], plannedDays: ['2026-10-19'],
  });
  assert.deepEqual(vacationSummary(s, 2027, { now: NOW }).plannedDays, ['2027-01-04']);
  assert.equal(vacationSummary(stateWith({}), 2026, { now: NOW }).remaining, 30);
});

test('saldos: valores por defecto, saneado y viajan en la copia', () => {
  assert.deepEqual(createDefaultState().settings.balances, { ...BALANCE_DEFAULTS });
  assert.deepEqual(sanitizeBalances({ overtimeStartMin: '90', overtimeStartMonth: '2026-13', vacationDaysPerYear: -1, vacationCarryOver: '1,5' }), {
    overtimeStartMin: 90, overtimeStartMonth: null, vacationDaysPerYear: 30, vacationCarryOver: 1.5,
  });
  assert.equal(sanitizeBalances({ overtimeStartMin: 1e12 }).overtimeStartMin, 0);
  assert.equal(sanitizeBalances({ overtimeStartMin: -150.4 }).overtimeStartMin, -150);
  assert.ok(isMonthKey('2026-10') && !isMonthKey('1999-01') && !isMonthKey('2026-1'));
  assert.equal(nextMonthKey('2026-12'), '2027-01');
  // Copia de seguridad: suplementos, saldos y planName viajan
  const s = updateSettings(stateWith({ '2026-10-12': ['F1'] }), {
    planName: 'Ducuara Ana', balances: { vacationCarryOver: 3 }, supplements: { hourlyWage: 19 },
  });
  const back = importBackup(createDefaultState(), exportBackup(s));
  assert.equal(back.settings.planName, 'Ducuara Ana');
  assert.equal(back.settings.balances.vacationCarryOver, 3);
  assert.equal(back.settings.supplements.hourlyWage, 19);
});

test('updateSettings e importBackup aceptan números escritos como texto («27,5», «18,75»), también si ya había un número', () => {
  let s = updateSettings(createDefaultState(), { balances: { vacationDaysPerYear: '27,5', vacationCarryOver: '1,5', overtimeStartMin: '90' } });
  assert.deepEqual(s.settings.balances, { overtimeStartMin: 90, overtimeStartMonth: null, vacationDaysPerYear: 27.5, vacationCarryOver: 1.5 });
  s = updateSettings(s, { supplements: { hourlyWage: '18,75' } });
  assert.equal(s.settings.supplements.hourlyWage, 18.75);
  // Segundo cambio, ya con número guardado
  s = updateSettings(s, { supplements: { hourlyWage: '19,50', night: { pct: '25,5' } }, balances: { vacationCarryOver: '2' } });
  assert.deepEqual([s.settings.supplements.hourlyWage, s.settings.supplements.night.pct, s.settings.balances.vacationCarryOver], [19.5, 25.5, 2]);
  // Texto que no es un número: se ignora; fuera de rango: lo sanea (valor por defecto)
  s = updateSettings(s, { supplements: { night: { pct: 'mucho' } }, balances: { vacationDaysPerYear: '400' } });
  assert.deepEqual([s.settings.supplements.night.pct, s.settings.balances.vacationDaysPerYear], [25.5, BALANCE_DEFAULTS.vacationDaysPerYear]);
  // weeklyHours también («37,5»)
  assert.equal(updateSettings(createDefaultState(), { weeklyHours: '37,5' }).settings.weeklyHours, 37.5);
  // Un archivo con números como texto
  const file = JSON.stringify({ app: 'turnos-mauricio', schema: 1, days: { '2026-10-13': { codes: ['S1'] } },
    settings: { weeklyHours: '30', balances: { vacationDaysPerYear: '28,5' }, supplements: { sunday: { pct: '50' }, hourlyWage: '20,5' } } });
  const imp = importBackup(createDefaultState(), file).settings;
  assert.deepEqual([imp.weeklyHours, imp.balances.vacationDaysPerYear, imp.supplements.sunday.pct, imp.supplements.hourlyWage], [30, 28.5, 50, 20.5]);
});
