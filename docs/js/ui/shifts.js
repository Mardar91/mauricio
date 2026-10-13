// Ayudas de presentación de turnos compartidas por las vistas.
import {
  addDays, dayMinutes, dayTimedItems, diffDays, formatHours, formatLong, formatTime, getCode, hasTime, holidayName, toKey, weekdayLong,
} from '../core/index.js';
import { cap } from './dom.js';
import { displayName } from './badge.js';
import { dayTimes, rangeText } from './times.js';

// Turno en curso o el siguiente (hasta 60 días) → { item, current, key } | null
export function nextShift(state, now = new Date()) {
  const today = toKey(now);
  for (let key = addDays(today, -1); key <= addDays(today, 60); key = addDays(key, 1)) {
    const items = dayTimedItems(state, key)
      .filter((i) => i.def.kind === 'shift' || i.def.countsHours)
      .sort((a, b) => a.start - b.start);
    for (const item of items) {
      if (item.end > now) return { item, key, current: item.start <= now };
    }
  }
  return null;
}

// 'Hoy, martes 13 de octubre' / 'Mañana, …' / 'Jueves, 15 de octubre'
export function dayLabel(key, today) {
  const d = diffDays(today, key);
  const long = formatLong(key);
  if (d === 0) return `Hoy, ${long.replace(',', '')}`;
  if (d === 1) return `Mañana, ${long.replace(',', '')}`;
  if (d === -1) return `Ayer, ${long.replace(',', '')}`;
  return cap(long);
}

// Cuenta atrás: 'en 45 min', 'en 5 h 20 min', 'mañana a las 22:00', 'el jueves', 'en 9 días'
export function countdown(ms, start, now = new Date()) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 1) return 'ahora';
  if (min < 60) return `en ${min} min`;
  const days = start ? diffDays(toKey(now), toKey(start)) : null;
  if (min < 12 * 60 || (days === 0 && min < 24 * 60)) {
    const hh = Math.floor(min / 60), mm = min % 60;
    return mm ? `en ${hh} h ${mm} min` : `en ${hh} h`;
  }
  if (days === 1) return `mañana a las ${formatTime(start)}`;
  if (days !== null && days < 7) return `el ${weekdayLong(toKey(start))}`;
  const d = days ?? Math.round(min / 1440);
  return `en ${d} días`;
}

// 'quedan 5 h 10 min'
export function remaining(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const hh = Math.floor(min / 60), mm = min % 60;
  return mm ? `${hh} h ${mm} min` : `${hh} h`;
}

// Resumen de un día para listas: { name, time, hours, main, kind, holiday, note, special }
// time usa el horario de ese día (special: true si algún código tiene «horario especial»)
export function daySummary(state, key) {
  const entry = state.days?.[key];
  const holiday = holidayName(key);
  if (!entry) return { known: false, name: '', time: '', hours: '', holiday, note: '', special: false };
  const defs = entry.codes.map((c) => getCode(state, c));
  const m = dayMinutes(state, key);
  const timed = defs.map((d) => ({ d, t: dayTimes(state, key, d.code) }))
    .filter(({ d, t }) => (d.kind === 'shift' || (d.kind === 'event' && d.countsHours)) && hasTime(t));
  const work = timed.map((x) => x.d);
  const main = work[0] || defs.find((d) => d.kind !== 'place') || defs[0] || null;
  const name = main && defs.length ? displayName(main) : '';
  const time = timed.map((x) => rangeText(x.t)).join(' · ');
  const special = timed.some((x) => x.t.special);
  const hours = m.total ? formatHours(m.total) : '';
  return { known: true, name, time, hours, main, kind: main?.kind ?? null, holiday, note: entry.note || '', minutes: m, codes: entry.codes, special };
}
