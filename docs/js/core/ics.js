// Calendario iCalendar (RFC 5545) para suscribirse desde el iPhone.
import { codeEmoji, getCode, nominalMinutes } from './codes.js';
import { addDays, atTime, formatHHMM, formatHours, parseHHMM, toKey } from './dates.js';
import { dayTimedItems } from './reminders.js';

const CRLF = '\r\n';

const VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'X-LIC-LOCATION:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

// Escape de valores TEXT: \ ; , y saltos de línea
export function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Octetos UTF-8 de un carácter (punto de código)
function utf8Len(ch) {
  const cp = ch.codePointAt(0);
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

// Plegado a 75 octetos (UTF-8) sin partir caracteres; continuación con un espacio
export function foldLine(line) {
  if (line.length <= 25) return line; // cada unidad UTF-16 ocupa como mucho 3 octetos
  const parts = [];
  let cur = '', size = 0, limit = 75;
  for (const ch of line) {
    const n = utf8Len(ch);
    if (size + n > limit) {
      parts.push(cur);
      cur = ''; size = 0; limit = 74; // la línea siguiente lleva un espacio delante
    }
    cur += ch; size += n;
  }
  parts.push(cur);
  return parts.join(CRLF + ' ');
}

const pad = (n) => String(n).padStart(2, '0');

function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

const dateValue = (key) => key.replace(/-/g, '');

// Hora de pared en Berlín a partir de la clave y 'HH:MM' (no depende del huso del dispositivo)
function wallTime(key, hhmm) {
  const m = parseHHMM(hhmm);
  if (m === 1440) return `${dateValue(addDays(key, 1))}T000000`;
  return `${dateValue(key)}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
}

// Duración relativa negativa: -PT10H, -PT1H30M, -PT0M
export function triggerDuration(ms) {
  const total = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(total / 60), m = total % 60;
  return `-PT${h ? `${h}H` : ''}${m || !h ? `${m}M` : ''}`;
}

// Sello estable del evento: lo más reciente entre el día, sus códigos (también si se borraron) y los
// ajustes del calendario. Nunca "ahora": el mismo contenido da siempre el mismo ICS.
function stampFor(state, key, entry) {
  let best = 0;
  const codes = entry?.codes || [];
  const vals = [entry?.updatedAt, state?.settings?.calendarUpdatedAt,
    ...codes.map((c) => getCode(state, c).updatedAt), ...codes.map((c) => state?.codeTombstones?.[c])];
  for (const v of vals) {
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return best ? new Date(best) : new Date(`${key}T00:00:00Z`);
}

// SEQUENCE monotónica: minutos desde 2024 del sello; sube cuando cambian horario, código o avisos
const SEQ_EPOCH = Date.UTC(2024, 0, 1);
const sequenceOf = (stamp) => Math.max(0, Math.floor((stamp.getTime() - SEQ_EPOCH) / 60000));

function alarm(description, ms) {
  return ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(description)}`,
    `TRIGGER:${triggerDuration(ms)}`, 'END:VALARM'];
}

function lastDayKey(state) {
  const keys = Object.keys(state?.days || {}).sort();
  return keys.length ? keys[keys.length - 1] : null;
}

// Inicio por defecto: día 1 del mes de hace 2 meses (no cambia cada día → contenido estable)
export function defaultIcsFrom(now = new Date()) {
  return toKey(new Date(now.getFullYear(), now.getMonth() - 2, 1));
}

// Fin del evento en hora de pared: el fin del código, o 1 h después si solo tiene inicio
function endWall(key, def, startOnly) {
  if (!startOnly) {
    const endKey = parseHHMM(def.end) <= parseHHMM(def.start) ? addDays(key, 1) : key;
    return wallTime(endKey, def.end);
  }
  const m = parseHHMM(def.start) + 60;
  return m >= 1440 ? wallTime(addDays(key, 1), formatHHMM(m - 1440)) : wallTime(key, formatHHMM(m));
}

// options: { from, to, now, notes (false: sin notas), places (true: lugar en SUMMARY/LOCATION) }
export function buildICS(state, { from, to, now = new Date(), notes = false, places = true } = {}) {
  const r = state?.settings?.reminders || {};
  const start = from ?? defaultIcsFrom(now);
  const end = to ?? lastDayKey(state);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Turnos de Mauricio//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Turnos de Mauricio',
    'X-WR-TIMEZONE:Europe/Berlin',
    'X-APPLE-CALENDAR-COLOR:#EF8A17',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...VTIMEZONE,
  ];
  const keys = Object.keys(state?.days || {}).filter((k) => k >= start && (!end || k <= end)).sort();
  for (const key of keys) {
    const entry = state.days[key];
    const when = stampFor(state, key, entry);
    const stamp = utcStamp(when);
    const seq = sequenceOf(when);
    const timed = dayTimedItems(state, key);
    for (const item of timed) {
      const def = item.def;
      const placeCodes = places && item.places.length ? ` · ${item.places.map((p) => p.code).join(', ')}` : '';
      const summary = `${codeEmoji(def)} ${def.code} ${def.name}${placeCodes}`;
      const desc = [item.startOnly ? `Hora: ${def.start}` : `Horario: ${def.start}–${def.end}`];
      const nominal = nominalMinutes(def);
      if (!item.startOnly && def.breakMin && nominal !== null) {
        desc.push(`Pausa: ${def.breakMin} min (${formatHours(Math.max(0, nominal - def.breakMin))} de trabajo)`);
      }
      if (item.special) desc.push('Horario especial de este día');
      if (places && item.placeText) desc.push(`Lugar: ${item.placeText}`);
      if (def.confirmed === false) desc.push('Horario sin confirmar');
      if (notes && entry.note) desc.push(`Nota: ${entry.note}`);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${key}-${def.code}@turnos-mauricio`,
        `DTSTAMP:${stamp}`,
        `LAST-MODIFIED:${stamp}`,
        `SEQUENCE:${seq}`,
        `DTSTART;TZID=Europe/Berlin:${wallTime(key, def.start)}`,
        `DTEND;TZID=Europe/Berlin:${endWall(key, def, item.startOnly)}`,
        `SUMMARY:${escapeText(summary)}`,
      );
      if (places && item.placeText) lines.push(`LOCATION:${escapeText(item.placeText)}`);
      lines.push(`DESCRIPTION:${escapeText(desc.join('\n'))}`, 'TRANSP:OPAQUE');
      if (r.eveningBefore !== false && parseHHMM(r.eveningTime) !== null) {
        const eve = atTime(addDays(key, -1), r.eveningTime);
        if (eve < item.start) {
          lines.push(...alarm(`Mañana: ${def.code} ${def.name} a las ${def.start}`, item.start - eve));
        }
      }
      if (r.beforeStart !== false) {
        const min = Math.max(0, Math.round(Number(r.minutesBefore) || 0));
        lines.push(...alarm(`${def.code} ${def.name} empieza a las ${def.start}`, min * 60000));
      }
      lines.push('END:VEVENT');
    }
    // Vacaciones, enfermedad y eventos sin hora: día completo, sin alarma
    const timedCodes = new Set(timed.map((t) => t.code));
    for (const code of entry.codes) {
      const def = getCode(state, code);
      const allDay = def.kind === 'vacation' || def.kind === 'sick' || (def.kind === 'event' && !timedCodes.has(code));
      if (!allDay) continue;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${key}-${def.code}@turnos-mauricio`,
        `DTSTAMP:${stamp}`,
        `LAST-MODIFIED:${stamp}`,
        `SEQUENCE:${seq}`,
        `DTSTART;VALUE=DATE:${dateValue(key)}`,
        `DTEND;VALUE=DATE:${dateValue(addDays(key, 1))}`,
        `SUMMARY:${escapeText(`${codeEmoji(def)} ${def.name}${def.kind === 'event' ? ` (${def.code})` : ''}`)}`,
      );
      if (notes && entry.note) lines.push(`DESCRIPTION:${escapeText(`Nota: ${entry.note}`)}`);
      lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
