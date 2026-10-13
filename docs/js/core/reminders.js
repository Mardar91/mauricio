// Recordatorios: la víspera a una hora fija y X minutos antes del inicio (antes de salir, si hay
// tiempo de viaje), y el aviso «Sube el plan» del mes siguiente.
import { codeEmoji, dayTravel, getDayCode, isTimedCode, timedInterval } from './codes.js';
import { addDays, atTime, formatHours, formatLong, formatTime, makeKey, monthName, pad2, parseHHMM, toKey } from './dates.js';

const DEFAULT_HORIZON = 7 * 24 * 3600 * 1000;

// Turnos/eventos con hora de un día, con su lugar. Incluye cualquier código con hora de inicio
// (turno, evento, 'other' o que cuente horas). Si solo tiene inicio dura 1 h (startOnly: true).
// Con horario especial del día (DayEntry.times), def lleva ese horario y special: true.
// Viaje (SPEC §13.2): el del día (el mayor de sus códigos) va en el primer elemento que empieza
// (travelMin, leaveAt = inicio − viaje, travelTo = código del lugar o null); los demás llevan 0.
export function dayTimedItems(state, key) {
  const entry = state?.days?.[key];
  if (!entry) return [];
  const defs = (entry.codes || []).map((c) => getDayCode(state, key, c));
  const places = defs.filter((d) => d.kind === 'place');
  const placeText = places.map((p) => (p.place ? `${p.code} (${p.place})` : p.code)).join(', ');
  const out = [];
  for (const def of defs) {
    if (!isTimedCode(def)) continue;
    const iv = timedInterval(state, key, def.code);
    if (!iv) continue;
    out.push({
      key, code: def.code, def, start: iv.start, end: iv.end, startOnly: iv.startOnly, special: Boolean(def.special), places, placeText,
      travelMin: 0, leaveAt: null, travelTo: null,
    });
  }
  const travel = dayTravel(state, key);
  if (travel.minutes > 0 && out.length) {
    const first = out.reduce((a, b) => (b.start < a.start ? b : a));
    first.travelMin = travel.minutes;
    first.leaveAt = new Date(first.start.getTime() - travel.minutes * 60000);
    first.travelTo = travel.to?.code ?? null;
  }
  return out;
}

// Duración del viaje en palabras: '25 min', '1 h 30'
const travelDuration = (min) => (min < 60 ? `${min} min` : formatHours(min));

// «Sal a las 13:05 hacia F51 (25 min de viaje)»; places: false → sin el lugar. '' si no hay viaje.
export function travelText(item, { places = true } = {}) {
  if (!item?.travelMin || !item.leaveAt) return '';
  const to = places && item.travelTo ? ` hacia ${item.travelTo}` : '';
  return `Sal a las ${formatTime(item.leaveAt)}${to} (${travelDuration(item.travelMin)} de viaje)`;
}

export const PLAN_UPLOAD_TIME = '19:00';
export const PLAN_UPLOAD_DAY = 20;
const PLAN_UPLOAD_MIN = 15;

// Aviso «📷 Sube el plan de <mes>» (SPEC §13.1): si el mes siguiente no tiene ningún día cargado, el
// día 20 del mes actual a las 19:00; si eso ya pasó, hoy a las 19:00 si aún no ha llegado, y si no,
// mañana a las 19:00 (si mañana sigue siendo este mes). Así la sincronización de cada mañana deja un
// aviso que suena ese mismo día (también el último del mes). Dura 15 min. null si no toca (o
// reminders.planUpload es false).
// → { id: 'plan-YYYY-MM', year, month (del plan que falta), key, start, end, moved, stamp (Date estable
//     para DTSTAMP/SEQUENCE), title, body }
export function planUploadReminder(state, now = new Date()) {
  if (state?.settings?.reminders?.planUpload === false) return null;
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const prefix = `${ny}-${pad2(nm)}-`;
  if (Object.keys(state?.days || {}).some((k) => k.startsWith(prefix))) return null;
  let key = makeKey(y, m, PLAN_UPLOAD_DAY);
  let start = atTime(key, PLAN_UPLOAD_TIME);
  let moved = false;
  if (start <= now) {
    key = toKey(now);
    start = atTime(key, PLAN_UPLOAD_TIME);
    if (start <= now) {
      key = addDays(key, 1);
      if (+key.slice(5, 7) !== m) return null; // ya no queda mes
      start = atTime(key, PLAN_UPLOAD_TIME);
    }
    moved = true;
  }
  // Sello estable mientras no cambie el aviso: el día 1 del mes; si se va moviendo, la hora a la que
  // pasó a ese día (las 19:00 del día anterior). Nunca retrocede y nunca es futuro.
  const stamp = moved ? atTime(addDays(key, -1), PLAN_UPLOAD_TIME) : new Date(y, m - 1, 1);
  return {
    id: `plan-${ny}-${pad2(nm)}`, year: ny, month: nm, key, start,
    end: new Date(start.getTime() + PLAN_UPLOAD_MIN * 60000), moved, stamp,
    title: `📷 Sube el plan de ${monthName(nm)}`,
    body: `Todavía no hay turnos de ${monthName(nm)} en la app. Toma una foto del plan y súbela en la app Turnos.`,
  };
}

// 'en 1 h', 'en 30 min', 'en 1 h 30'
function inText(minutes) {
  return minutes < 60 ? `en ${minutes} min` : `en ${formatHours(minutes)}`;
}

function describe(item) {
  const time = item.startOnly ? formatTime(item.start) : `${formatTime(item.start)}–${formatTime(item.end)}`;
  const where = item.placeText ? ` · 📍 ${item.placeText}` : '';
  const label = `${codeEmoji(item.def)} ${item.def.name} ${item.code}`;
  // Se habla de "turno" si es un turno o si cuenta horas como tal
  const isShift = item.def.kind === 'shift' || item.def.countsHours === true;
  return { time, where, label, isShift };
}

export function upcomingReminders(state, now = new Date(), horizonMs = DEFAULT_HORIZON) {
  const r = state?.settings?.reminders || {};
  const limit = now.getTime() + horizonMs;
  const eveOk = r.eveningBefore !== false && parseHHMM(r.eveningTime) !== null;
  const preOk = r.beforeStart !== false;
  const before = Math.max(0, Math.round(Number(r.minutesBefore) || 0));
  const out = [];
  // La víspera de un día cae el día anterior: se mira un día más allá del horizonte
  const last = addDays(toKey(new Date(limit)), 1);
  for (let key = toKey(now); key <= last; key = addDays(key, 1)) {
    for (const item of dayTimedItems(state, key)) {
      const { time, where, label, isShift } = describe(item);
      const base = { key, code: item.code, start: item.start, end: item.end, emoji: codeEmoji(item.def), travelMin: item.travelMin, leaveAt: item.leaveAt };
      const leave = item.travelMin ? ` · Sal a las ${formatTime(item.leaveAt)}` : '';
      if (eveOk) {
        const at = atTime(addDays(key, -1), r.eveningTime);
        if (at > now && at.getTime() <= limit && at < item.start) {
          out.push({
            ...base, id: `${key}-${item.code}-eve`, at, type: 'eve', tag: 'calendar',
            title: isShift ? `Mañana trabajas: ${time} (${item.code})`
              : `Mañana: ${item.def.name} a las ${formatTime(item.start)} (${item.code})`,
            body: `${label} · ${formatLong(key)}${where}${leave}`,
          });
        }
      }
      if (preOk) {
        // Con viaje: X min antes de salir (inicio − viaje − minutesBefore)
        const at = new Date(item.start.getTime() - (before + item.travelMin) * 60000);
        if (at > now && at.getTime() <= limit) {
          const when = before ? inText(before) : 'ahora';
          let title = isShift ? `Tu turno empieza ${when} (${formatTime(item.start)})`
            : `${item.def.name} ${when} (${formatTime(item.start)})`;
          if (item.travelMin) title = travelText(item);
          out.push({
            ...base, id: `${key}-${item.code}-pre`, at, type: 'pre', tag: item.travelMin ? 'walking' : 'alarm_clock',
            title,
            body: item.travelMin ? `${label} · empieza a las ${formatTime(item.start)}${where}` : `${label} · ${time}${where}`,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
