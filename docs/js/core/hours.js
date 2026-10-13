// Horas trabajadas, acreditadas y objetivo (Soll) por día, semana y mes. Todo en minutos.
import { countsAsWork, getCode, isNightCode, shiftInterval } from './codes.js';
import { addDays, isHoliday, isWeekend, monthKeys, weekStart, weekdayIndex } from './dates.js';

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
    const def = getCode(state, code);
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
    out.items.push({ code, minutes, type });
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
    const defs = d.codes.map((c) => getCode(state, c));
    const work = defs.filter(countsAsWork);
    shifts += work.filter((def) => def.kind === 'shift').length;
    for (const def of work) if (def.kind === 'shift') shiftCounts[def.code] = (shiftCounts[def.code] || 0) + 1;
    if (work.some(isNightCode)) nights++;
    const onVacation = defs.some((def) => def.kind === 'vacation' || def.kind === 'sick');
    if (defs.some((def) => def.kind === 'vacation')) vacationDays++;
    if (work.length && d.weekend) {
      weekendDaysWorked++;
      weekendsWorked.add(weekStart(d.key));
    }
    if (!work.length && !onVacation) freeDays++;
  }
  const weeks = [];
  for (let k = weekStart(keys[0]); k <= keys[keys.length - 1]; k = addDays(k, 7)) weeks.push(weekSummary(state, k));
  return {
    year, month: month1, from: keys[0], to: keys[keys.length - 1],
    total, worked, credited, soll, diff: total - soll,
    nights, weekendsWorked: weekendsWorked.size, weekendDaysWorked, vacationDays, freeDays,
    shifts, shiftCounts, daysKnown: days.filter((d) => d.known).length, days, weeks,
  };
}
