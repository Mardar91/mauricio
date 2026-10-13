// Fechas en hora local (Europe/Berlin en el teléfono de Mauricio). Claves 'YYYY-MM-DD'.

const DAYS_LONG = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DAYS_SHORT = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const pad2 = (n) => String(n).padStart(2, '0');

export function isKey(key) {
  const m = KEY_RE.exec(String(key ?? ''));
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getFullYear() === +m[1] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[3];
}

export function toKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fromKey(key) {
  const m = KEY_RE.exec(String(key));
  if (!m) throw new Error(`Fecha no válida: ${key}`);
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

export function makeKey(year, month1, day) {
  return `${year}-${pad2(month1)}-${pad2(day)}`;
}

export function addDays(key, n) {
  const d = fromKey(key);
  return toKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
}

// Diferencia en días de calendario (b − a).
export function diffDays(a, b) {
  const da = fromKey(a), db = fromKey(b);
  return Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate())
    - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000);
}

// 0 = lunes … 6 = domingo
export function weekdayIndex(key) {
  return (fromKey(key).getDay() + 6) % 7;
}

export function isWeekend(key) {
  return weekdayIndex(key) >= 5;
}

export function weekStart(key) {
  return addDays(key, -weekdayIndex(key));
}

export function isoWeek(key) {
  const d = fromKey(key);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // jueves de la misma semana
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
}

export function daysInMonth(year, month1) {
  return new Date(year, month1, 0).getDate();
}

export function monthKeys(year, month1) {
  const n = daysInMonth(year, month1);
  const out = [];
  for (let d = 1; d <= n; d++) out.push(makeKey(year, month1, d));
  return out;
}

// Lista de claves desde from hasta to (ambas incluidas).
export function rangeKeys(from, to) {
  const out = [];
  for (let k = from; k <= to; k = addDays(k, 1)) out.push(k);
  return out;
}

export function weekdayShort(key) {
  return DAYS_SHORT[fromKey(key).getDay()];
}

export function weekdayLong(key) {
  return DAYS_LONG[fromKey(key).getDay()];
}

export function monthName(month1) {
  return MONTHS_LONG[month1 - 1];
}

export function monthShort(month1) {
  return MONTHS_SHORT[month1 - 1];
}

// 'martes, 13 de octubre'
export function formatLong(key) {
  const d = fromKey(key);
  return `${DAYS_LONG[d.getDay()]}, ${d.getDate()} de ${MONTHS_LONG[d.getMonth()]}`;
}

// 'mar 13 oct'
export function formatShort(key) {
  const d = fromKey(key);
  return `${DAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
}

// 'octubre 2026'
export function formatMonth(year, month1) {
  return `${MONTHS_LONG[month1 - 1]} ${year}`;
}

const MINUS = '−';

// minutos → '36 h 30' / '8 h' / '0 h' / '−2 h 30'
export function formatHours(minutes) {
  const m = Math.round(Number(minutes) || 0);
  const abs = Math.abs(m);
  const h = Math.floor(abs / 60), r = abs % 60;
  const txt = r ? `${h} h ${pad2(r)}` : `${h} h`;
  return m < 0 ? MINUS + txt : txt;
}

// Con signo explícito: '+4 h 30' / '−2 h' / '0 h'
export function formatSignedHours(minutes) {
  const m = Math.round(Number(minutes) || 0);
  return m > 0 ? '+' + formatHours(m) : formatHours(m);
}

// 'HH:MM' → minutos desde medianoche (null si no es válido)
export function parseHHMM(s) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(s ?? ''));
  if (!m) return null;
  const h = +m[1], min = +m[2];
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return null;
  return h * 60 + min;
}

// minutos → 'HH:MM'
export function formatHHMM(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

// Date → 'HH:MM' (hora local)
export function formatTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// Fecha local para una clave y una hora 'HH:MM'
export function atTime(key, hhmm) {
  const d = fromKey(key);
  const min = parseHHMM(hhmm) ?? 0;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60);
}

// Domingo de Pascua (algoritmo gregoriano anónimo)
export function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return makeKey(year, month, day);
}

const holidayCache = new Map();

// Festivos de Berlín → Map<clave, nombre en español>
export function berlinHolidayNames(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const easter = easterSunday(year);
  const map = new Map([
    [makeKey(year, 1, 1), 'Año Nuevo'],
    [makeKey(year, 5, 1), 'Día del Trabajo'],
    [makeKey(year, 10, 3), 'Día de la Unidad Alemana'],
    [makeKey(year, 12, 25), 'Navidad'],
    [makeKey(year, 12, 26), 'San Esteban (2.º día de Navidad)'],
  ]);
  if (year >= 2019) map.set(makeKey(year, 3, 8), 'Día Internacional de la Mujer');
  map.set(addDays(easter, -2), 'Viernes Santo');
  map.set(addDays(easter, 1), 'Lunes de Pascua');
  map.set(addDays(easter, 39), 'Ascensión');
  map.set(addDays(easter, 50), 'Lunes de Pentecostés');
  const sorted = new Map([...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  holidayCache.set(year, sorted);
  return sorted;
}

export function berlinHolidays(year) {
  return new Set(berlinHolidayNames(year).keys());
}

export function holidayName(key) {
  return berlinHolidayNames(+String(key).slice(0, 4)).get(key) ?? null;
}

export function isHoliday(key) {
  return holidayName(key) !== null;
}
