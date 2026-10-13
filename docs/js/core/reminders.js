// Recordatorios: la víspera a una hora fija y X minutos antes del inicio.
import { getCode, shiftInterval, codeEmoji } from './codes.js';
import { addDays, atTime, formatHours, formatLong, formatTime, parseHHMM, toKey } from './dates.js';

const DEFAULT_HORIZON = 7 * 24 * 3600 * 1000;

// Turnos/eventos con horario de un día, con su lugar
export function dayTimedItems(state, key) {
  const entry = state?.days?.[key];
  if (!entry) return [];
  const defs = entry.codes.map((c) => getCode(state, c));
  const places = defs.filter((d) => d.kind === 'place');
  const placeText = places.map((p) => (p.place ? `${p.code} (${p.place})` : p.code)).join(', ');
  const out = [];
  for (const def of defs) {
    if (def.kind !== 'shift' && def.kind !== 'event') continue;
    const iv = shiftInterval(state, key, def.code);
    if (!iv) continue;
    out.push({ key, code: def.code, def, start: iv.start, end: iv.end, places, placeText });
  }
  return out;
}

// 'en 1 h', 'en 30 min', 'en 1 h 30'
function inText(minutes) {
  return minutes < 60 ? `en ${minutes} min` : `en ${formatHours(minutes)}`;
}

function describe(item) {
  const time = `${formatTime(item.start)}–${formatTime(item.end)}`;
  const where = item.placeText ? ` · 📍 ${item.placeText}` : '';
  const label = `${codeEmoji(item.def)} ${item.def.name} ${item.code}`;
  return { time, where, label, isShift: item.def.kind === 'shift' };
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
      const base = { key, code: item.code, start: item.start, end: item.end, emoji: codeEmoji(item.def) };
      if (eveOk) {
        const at = atTime(addDays(key, -1), r.eveningTime);
        if (at > now && at.getTime() <= limit && at < item.start) {
          out.push({
            ...base, id: `${key}-${item.code}-eve`, at, type: 'eve', tag: 'calendar',
            title: isShift ? `Mañana trabajas: ${time} (${item.code})`
              : `Mañana: ${item.def.name} a las ${formatTime(item.start)} (${item.code})`,
            body: `${label} · ${formatLong(key)}${where}`,
          });
        }
      }
      if (preOk) {
        const at = new Date(item.start.getTime() - before * 60000);
        if (at > now && at.getTime() <= limit) {
          const when = before ? inText(before) : 'ahora';
          out.push({
            ...base, id: `${key}-${item.code}-pre`, at, type: 'pre', tag: 'alarm_clock',
            title: isShift ? `Tu turno empieza ${when} (${formatTime(item.start)})`
              : `${item.def.name} ${when} (${formatTime(item.start)})`,
            body: `${label} · ${time}${where}`,
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}
