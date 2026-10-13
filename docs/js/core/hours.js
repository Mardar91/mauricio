// Horas trabajadas, acreditadas y objetivo (Soll) por día, semana y mes; suplementos (§13.3) y
// saldos (§13.4). Todo en minutos.
import { countsAsWork, getCode, getDayCode, isNightCode, shiftInterval } from './codes.js';
import {
  addDays, daysInMonth, fromKey, isHoliday, isKey, isWeekend, makeKey, monthKeys, pad2, parseHHMM, toKey, weekStart, weekdayIndex,
} from './dates.js';
import { isPlainObject } from './util.js';

const FREE_KINDS = ['off', 'wish'];

// Soll diario en minutos = horas semanales / días laborables
export function dailySollMinutes(state) {
  const s = state?.settings || {};
  const weekly = Number(s.weeklyHours) || 35;
  const days = Number(s.workDaysPerWeek) || 5;
  return (weekly * 60) / days;
}

// ¿Este día cuenta para el Soll? (lunes…, según workDaysPerWeek; los festivos lo reducen)
export function isSollDay(state, key) {
  const s = state?.settings || {};
  const days = Number(s.workDaysPerWeek) || 5;
  if (weekdayIndex(key) >= days) return false;
  if (s.holidaysReduceSoll !== false && isHoliday(key)) return false;
  return true;
}

function holidayInWorkWeek(state, key) {
  const days = Number(state?.settings?.workDaysPerWeek) || 5;
  return weekdayIndex(key) < days && isHoliday(key);
}

export function dayMinutes(state, key) {
  const entry = state?.days?.[key];
  const out = { worked: 0, credited: 0, total: 0, items: [] };
  if (!entry) return out;
  for (const code of entry.codes || []) {
    const def = getDayCode(state, key, code); // con el horario especial del día si lo hay
    let minutes = 0, type = 'none';
    if (countsAsWork(def)) {
      const iv = shiftInterval(state, key, code);
      minutes = Math.max(0, Math.round((iv.end - iv.start) / 60000) - (Number(def.breakMin) || 0));
      type = 'worked';
      out.worked += minutes;
    } else if (def.kind === 'vacation' || def.kind === 'sick') {
      type = 'credited';
      // Solo acredita en días laborables que no son festivo
      if (isSollDay(state, key)) {
        minutes = def.creditHours != null ? Math.round(def.creditHours * 60) : Math.round(dailySollMinutes(state));
        out.credited += minutes;
      }
    }
    out.items.push(def.special ? { code, minutes, type, special: true } : { code, minutes, type });
  }
  out.total = out.worked + out.credited;
  return out;
}

function dayInfo(state, key) {
  const entry = state?.days?.[key];
  const m = dayMinutes(state, key);
  return {
    key, ...m,
    codes: entry ? [...entry.codes] : null,
    known: Boolean(entry),
    holiday: isHoliday(key),
    weekend: isWeekend(key),
    soll: isSollDay(state, key) ? dailySollMinutes(state) : 0,
  };
}

export function weekSummary(state, mondayKey) {
  const from = weekStart(mondayKey);
  const to = addDays(from, 6);
  const days = [];
  for (let i = 0; i < 7; i++) days.push(dayInfo(state, addDays(from, i)));
  const worked = days.reduce((s, d) => s + d.worked, 0);
  const credited = days.reduce((s, d) => s + d.credited, 0);
  const total = worked + credited;
  const weekly = (Number(state?.settings?.weeklyHours) || 35) * 60;
  const holidays = state?.settings?.holidaysReduceSoll === false ? 0
    : days.filter((d) => holidayInWorkWeek(state, d.key)).length;
  const soll = Math.max(0, weekly - holidays * dailySollMinutes(state));
  return { from, to, total, worked, credited, soll, diff: total - soll, days, known: days.filter((d) => d.known).length };
}

export function monthSummary(state, year, month1) {
  const keys = monthKeys(year, month1);
  const days = keys.map((k) => dayInfo(state, k));
  const worked = days.reduce((s, d) => s + d.worked, 0);
  const credited = days.reduce((s, d) => s + d.credited, 0);
  const total = worked + credited;
  const soll = Math.round(days.reduce((s, d) => s + d.soll, 0));
  let nights = 0, shifts = 0, vacationDays = 0, freeDays = 0, weekendDaysWorked = 0;
  const shiftCounts = {};
  const weekendsWorked = new Set();
  for (const d of days) {
    if (!d.known) continue;
    const defs = d.codes.map((c) => getDayCode(state, d.key, c));
    const work = defs.filter(countsAsWork);
    // Turnos: todo lo que cuenta horas salvo los eventos (reuniones)
    const shiftLike = work.filter((def) => def.kind !== 'event');
    shifts += shiftLike.length;
    for (const def of shiftLike) shiftCounts[def.code] = (shiftCounts[def.code] || 0) + 1;
    if (work.some(isNightCode)) nights++;
    if (defs.some((def) => def.kind === 'vacation')) vacationDays++;
    if (work.length && d.weekend) {
      weekendDaysWorked++;
      weekendsWorked.add(weekStart(d.key));
    }
    // Libre: solo '-' o 'W-' (o plan vacío); eventos y códigos desconocidos no son días libres
    if (defs.every((def) => FREE_KINDS.includes(def.kind))) freeDays++;
  }
  const weeks = [];
  for (let k = weekStart(keys[0]); k <= keys[keys.length - 1]; k = addDays(k, 7)) weeks.push(weekSummary(state, k));
  return {
    year, month: month1, from: keys[0], to: keys[keys.length - 1],
    total, worked, credited, soll, diff: total - soll,
    nights, weekendsWorked: weekendsWorked.size, weekendDaysWorked, vacationDays, freeDays,
    shifts, shiftCounts, daysKnown: days.filter((d) => d.known).length, days, weeks,
    // Minutos de noche, sábado (franja), domingo y festivo, y € estimados (SPEC §13.3)
    supplements: monthSupplements(state, year, month1),
  };
}

// ---------- Suplementos (SPEC §13.3) ----------
// Minutos trabajados de noche, en la franja del sábado, en domingo y en festivo (Berlín), con la pausa
// descontada en proporción, y una estimación en € si hay salario por hora. Cada minuto cuenta según su
// hora real y su día de calendario (una noche de domingo a lunes: domingo hasta las 24:00, lunes desde
// las 0:00). Seguro con el cambio de hora (se mide tiempo real).

// Valores por defecto (orientativos; la UI pide comprobar el contrato): promedios de Berlín de los
// suplementos típicos de los cuidados (lista de las cajas de cuidados según el §82c SGB XI, a
// 30/09/2026): noche 26 % (como mínimo de 23 a 6 h), domingo 33 % y festivo 40 % (con día libre a
// cambio; sin él, 134 %). El sábado no es obligatorio: 0 % con la franja habitual de 13 a 21 h.
export const SUPPLEMENT_DEFAULTS = Object.freeze({
  night: Object.freeze({ from: '23:00', to: '06:00', pct: 26 }),
  saturday: Object.freeze({ from: '13:00', to: '21:00', pct: 0 }),
  sunday: Object.freeze({ pct: 33 }),
  holiday: Object.freeze({ pct: 40 }),
  hourlyWage: null,
});

export const SUPPLEMENT_KINDS = Object.freeze(['night', 'saturday', 'sunday', 'holiday']);
export const MAX_SUPPLEMENT_PCT = 300;
export const MAX_HOURLY_WAGE = 500;

// Texto para la UI junto a los suplementos
export const SUPPLEMENT_NOTE = 'Valores orientativos (promedio de Berlín en el sector de los cuidados). Comprueba tu contrato.';

const WINDOWED = ['night', 'saturday'];

const hhmm = (v, fallback) => {
  const m = parseHHMM(v);
  return m === null || m === 1440 ? fallback : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// Número con coma o punto decimal ('15,50' → 15.5); null si no es un número
export function parseDecimal(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  const n = Number(v.trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Porcentaje válido (0..300, con un decimal como mucho)
function pctOf(v, fallback) {
  const n = parseDecimal(v);
  return n === null || n < 0 || n > MAX_SUPPLEMENT_PCT ? fallback : Math.round(n * 10) / 10;
}

// Salario por hora válido (> 0, ≤ 500 €, en céntimos) o null
export function wageOf(v) {
  const n = parseDecimal(v);
  return n === null || n <= 0 || n > MAX_HOURLY_WAGE ? null : Math.round(n * 100) / 100;
}

// Ajustes de suplementos completos y válidos (los que faltan o no valen, por defecto). Nunca lanza.
export function sanitizeSupplements(sp) {
  const src = isPlainObject(sp) ? sp : {};
  const out = {};
  for (const k of SUPPLEMENT_KINDS) {
    const d = SUPPLEMENT_DEFAULTS[k];
    const v = isPlainObject(src[k]) ? src[k] : {};
    out[k] = { pct: pctOf(v.pct, d.pct) };
    if (WINDOWED.includes(k)) {
      out[k] = { from: hhmm(v.from, d.from), to: hhmm(v.to, d.to), pct: out[k].pct };
    }
  }
  out.hourlyWage = wageOf(src.hourlyWage);
  return out;
}

// Ajustes de suplementos del estado (con los valores por defecto)
export function supplementSettings(state) {
  return sanitizeSupplements(state?.settings?.supplements);
}

// Instante (ms) de un día y unos minutos desde medianoche, en hora local
function at(key, min) {
  const d = fromKey(key);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60).getTime();
}

// Franja [from, to) que empieza el día key (si to <= from termina al día siguiente); null si vacía
function windowOf(key, from, to) {
  const f = parseHHMM(from), t = parseHHMM(to);
  if (f === null || t === null || f === t) return null;
  return [at(key, f), t > f ? at(key, t) : at(addDays(key, 1), t)];
}

const overlap = (s, e, a, b) => Math.max(0, Math.min(e, b) - Math.max(s, a));

// Milisegundos de [s, e) en cada categoría. Un festivo que cae en sábado o domingo cuenta solo como
// festivo; la noche se suma aparte (se combina con las demás).
export function intervalSupplementMs(s, e, cfg = SUPPLEMENT_DEFAULTS) {
  const out = { night: 0, saturday: 0, sunday: 0, holiday: 0 };
  const start = s instanceof Date ? s.getTime() : Number(s);
  const end = e instanceof Date ? e.getTime() : Number(e);
  if (!(end > start)) return out;
  const last = toKey(new Date(end - 1));
  // Desde el día anterior: una franja de noche que empezó la víspera también cuenta
  for (let k = addDays(toKey(new Date(start)), -1); k <= last; k = addDays(k, 1)) {
    const d0 = at(k, 0), d1 = at(addDays(k, 1), 0);
    const seg = overlap(start, end, d0, d1);
    if (seg > 0) {
      const wd = weekdayIndex(k);
      if (isHoliday(k)) out.holiday += seg;
      else if (wd === 6) out.sunday += seg;
      else if (wd === 5) {
        const w = windowOf(k, cfg.saturday?.from, cfg.saturday?.to);
        if (w) out.saturday += overlap(start, end, w[0], Math.min(w[1], d1)); // solo dentro del sábado
      }
    }
    const n = windowOf(k, cfg.night?.from, cfg.night?.to);
    if (n) out.night += overlap(start, end, n[0], n[1]);
  }
  return out;
}

// Minutos (con decimales) de cada categoría en los turnos de un día (los que cuentan horas; la noche
// cuenta para el día en que empieza), con la pausa descontada en proporción
function rawDay(state, key, cfg) {
  const out = { night: 0, saturday: 0, sunday: 0, holiday: 0 };
  for (const code of state?.days?.[key]?.codes || []) {
    const def = getDayCode(state, key, code); // con el horario especial del día
    if (!countsAsWork(def)) continue;
    const iv = shiftInterval(state, key, code);
    if (!iv) continue;
    const gross = (iv.end - iv.start) / 60000;
    if (!(gross > 0)) continue;
    const net = Math.max(0, Math.round(gross) - (Number(def.breakMin) || 0));
    const f = net / gross;
    const ms = intervalSupplementMs(iv.start, iv.end, cfg);
    for (const k of SUPPLEMENT_KINDS) out[k] += (ms[k] / 60000) * f;
  }
  return out;
}

// Minutos de suplemento de un día → { night, saturday, sunday, holiday } (enteros)
export function daySupplements(state, key) {
  const raw = rawDay(state, key, supplementSettings(state));
  return Object.fromEntries(SUPPLEMENT_KINDS.map((k) => [k, Math.round(raw[k])]));
}

const round2 = (n) => Math.round(n * 100) / 100;

// Resumen con minutos, porcentaje y € estimados por categoría
function summarize(sum, cfg) {
  const wage = cfg.hourlyWage;
  const out = { hourlyWage: wage, euros: wage === null ? null : 0 };
  for (const k of SUPPLEMENT_KINDS) {
    const minutes = Math.round(sum[k]);
    const { pct } = cfg[k];
    const euros = wage === null ? null : round2((minutes / 60) * wage * (pct / 100));
    out[k] = WINDOWED.includes(k) ? { minutes, pct, from: cfg[k].from, to: cfg[k].to, euros } : { minutes, pct, euros };
    if (euros !== null) out.euros += euros;
  }
  if (out.euros !== null) out.euros = round2(out.euros);
  return out;
}

// Suplementos de un mes (turnos que empiezan ese mes) →
// { night: { minutes, pct, from, to, euros }, saturday: {…}, sunday: { minutes, pct, euros }, holiday: {…},
//   hourlyWage: number|null, euros: number|null (suma estimada) }
export function monthSupplements(state, year, month1) {
  const cfg = supplementSettings(state);
  const sum = { night: 0, saturday: 0, sunday: 0, holiday: 0 };
  for (const key of monthKeys(year, month1)) {
    if (!state?.days?.[key]) continue;
    const d = rawDay(state, key, cfg);
    for (const k of SUPPLEMENT_KINDS) sum[k] += d[k];
  }
  return summarize(sum, cfg);
}

// ---------- Saldos (SPEC §13.4): saldo de horas acumulado mes a mes y vacaciones del año ----------

export const BALANCE_DEFAULTS = Object.freeze({
  overtimeStartMin: 0,        // saldo inicial en minutos (puede ser negativo)
  overtimeStartMonth: null,   // 'YYYY-MM' desde el que se cuenta; null = el primer mes con plan
  vacationDaysPerYear: 30,    // días de vacaciones al año (Unionhilfswerk: 30)
  vacationCarryOver: 0,       // días que quedan del año anterior
});

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const MAX_START_MIN = 100000 * 60; // ±100 000 h: cualquier cosa mayor es un error

// 'YYYY-MM' válido (años 2000–2100) o null
export function isMonthKey(v) {
  const m = MONTH_RE.exec(String(v ?? ''));
  return Boolean(m) && +m[1] >= 2000 && +m[1] <= 2100 && +m[2] >= 1 && +m[2] <= 12;
}

// Mes siguiente: '2026-12' → '2027-01'
export function nextMonthKey(ym) {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad2(m + 1)}`;
}

function days(v, fallback, max) {
  const n = parseDecimal(v);
  return n === null || n < 0 || n > max ? fallback : Math.round(n * 2) / 2; // medios días
}

// Ajustes de saldos completos y válidos. Nunca lanza.
export function sanitizeBalances(b) {
  const src = isPlainObject(b) ? b : {};
  const start = parseDecimal(src.overtimeStartMin);
  return {
    overtimeStartMin: start === null || Math.abs(start) > MAX_START_MIN ? 0 : Math.round(start),
    overtimeStartMonth: isMonthKey(src.overtimeStartMonth) ? src.overtimeStartMonth : null,
    vacationDaysPerYear: days(src.vacationDaysPerYear, BALANCE_DEFAULTS.vacationDaysPerYear, 366),
    vacationCarryOver: days(src.vacationCarryOver, 0, 366),
  };
}

export function balanceSettings(state) {
  return sanitizeBalances(state?.settings?.balances);
}

// Saldo de horas acumulado mes a mes desde el mes inicial (overtimeStartMonth o, sin él, el primer
// mes con plan) hasta hoy (through, incluido). Solo cuentan los días con plan: un día sin cargar no
// suma horas ni resta su objetivo (no se inventan horas); el mes en curso, hasta hoy.
// options: { now, through: 'YYYY-MM-DD' } →
// { startMonth, auto (sin mes inicial elegido), startMin, through, balance (minutos),
//   months: [{ month: 'YYYY-MM', year, month1, from, to, days, daysKnown, complete, current,
//              total, soll, diff, cumulative }] }
export function overtimeBalance(state, { now = new Date(), through } = {}) {
  const b = balanceSettings(state);
  const end = isKey(through) ? through : toKey(now);
  const all = state?.days || {};
  const first = Object.keys(all).filter(isKey).sort()[0] ?? null;
  const startMonth = b.overtimeStartMonth ?? (first ? first.slice(0, 7) : null);
  const out = { startMonth, auto: !b.overtimeStartMonth, startMin: b.overtimeStartMin, through: end, balance: b.overtimeStartMin, months: [] };
  if (!startMonth || `${startMonth}-01` > end) return out;
  const daily = dailySollMinutes(state);
  let cumulative = b.overtimeStartMin;
  for (let ym = startMonth; ym <= end.slice(0, 7); ym = nextMonthKey(ym)) {
    const year = +ym.slice(0, 4), month1 = +ym.slice(5, 7);
    const from = `${ym}-01`, last = makeKey(year, month1, daysInMonth(year, month1));
    const to = last < end ? last : end;
    let total = 0, soll = 0, known = 0, n = 0;
    for (let k = from; k <= to; k = addDays(k, 1)) {
      n++;
      if (!all[k]) continue;
      known++;
      total += dayMinutes(state, k).total;
      if (isSollDay(state, k)) soll += daily;
    }
    soll = Math.round(soll);
    const diff = total - soll;
    cumulative += diff;
    out.months.push({ month: ym, year, month1, from, to, days: n, daysKnown: known, complete: known === n, current: to === end && last > end, total, soll, diff, cumulative });
  }
  out.balance = cumulative;
  return out;
}

// Vacaciones de un año: derecho + arrastre; usadas (días con vacaciones que tienen objetivo, hasta
// hoy incluido), planificadas (después de hoy) y restantes. El arrastre (vacationCarryOver) se suma
// al año que se consulta. options: { now } →
// { year, entitlement, carryOver, total, used, planned, remaining, usedDays: [key], plannedDays: [key] }
export function vacationSummary(state, year, { now = new Date() } = {}) {
  const b = balanceSettings(state);
  const today = toKey(now);
  const y = Number(year) || now.getFullYear();
  const usedDays = [], plannedDays = [];
  for (const [k, entry] of Object.entries(state?.days || {})) {
    if (!isKey(k) || +k.slice(0, 4) !== y) continue;
    if (!(entry?.codes || []).some((c) => getCode(state, c).kind === 'vacation')) continue;
    if (!isSollDay(state, k)) continue; // fines de semana y festivos no gastan vacaciones
    (k <= today ? usedDays : plannedDays).push(k);
  }
  usedDays.sort();
  plannedDays.sort();
  const total = b.vacationDaysPerYear + b.vacationCarryOver;
  return {
    year: y, entitlement: b.vacationDaysPerYear, carryOver: b.vacationCarryOver, total,
    used: usedDays.length, planned: plannedDays.length, remaining: total - usedDays.length - plannedDays.length,
    usedDays, plannedDays,
  };
}
