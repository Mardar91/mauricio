// Códigos del plan (F1, S1, N1…): definiciones, horarios e intervalos reales.
import { fromKey, parseHHMM } from './dates.js';

export const KINDS = ['shift', 'place', 'event', 'off', 'wish', 'vacation', 'sick', 'other'];
export const SHAPES = ['circle', 'hexagon', 'tag', 'text'];

export const COLORS = {
  early: '#F2E500', late: '#8DC47E', night: '#3D63B8', mid: '#F3B9BF',
  place: '#E31CE0', placeRed: '#E0281E', meeting: '#3D63B8', wish: '#F4B6BF',
  red: '#D21F1F', other: '#9E9E9E', dark: '#1F1F1F', white: '#FFFFFF',
};

// Plantilla con todos los campos de CodeDef
export function baseCode(code) {
  return {
    code, kind: 'other', name: code, start: null, end: null, breakMin: 0,
    countsHours: false, creditHours: null, color: COLORS.other, textColor: COLORS.white,
    shape: 'circle', place: '', confirmed: true, builtin: false,
  };
}

function shift(code, name, start, end, color, textColor, confirmed = true) {
  return { ...baseCode(code), kind: 'shift', name, start, end, breakMin: 30, countsHours: true,
    color, textColor, confirmed, builtin: true };
}

function place(code, color = COLORS.place) {
  return { ...baseCode(code), kind: 'place', name: `Lugar ${code}`, color, textColor: COLORS.white, builtin: true };
}

function build() {
  const list = [
    shift('F1', 'Mañana', '06:00', '15:00', COLORS.early, COLORS.dark),
    shift('F2', 'Mañana', '06:00', '15:00', COLORS.early, COLORS.dark, false),
    shift('F3', 'Mañana', '06:00', '15:00', COLORS.early, COLORS.dark, false),
    shift('F6', 'Mañana', '06:00', '15:00', COLORS.early, COLORS.dark, false),
    shift('F8', 'Mañana', '06:00', '15:00', COLORS.early, COLORS.dark, false),
    shift('S1', 'Tarde', '13:30', '22:00', COLORS.late, COLORS.dark),
    shift('N1', 'Noche', '22:00', '06:00', COLORS.night, COLORS.white),
    shift('Z1', 'Intermedio', '09:30', '18:00', COLORS.mid, COLORS.dark),
    place('F51'), place('F52'), place('F53'), place('S51'), place('S52'), place('N51'),
    place('S31', COLORS.placeRed),
    { ...baseCode('TS'), kind: 'event', name: 'Reunión de equipo', color: COLORS.meeting,
      textColor: COLORS.white, shape: 'hexagon', builtin: true },
    { ...baseCode('W-'), kind: 'wish', name: 'Libre deseado', color: COLORS.wish,
      textColor: COLORS.dark, shape: 'tag', builtin: true },
    { ...baseCode('U'), kind: 'vacation', name: 'Vacaciones', color: COLORS.red,
      textColor: COLORS.red, shape: 'text', builtin: true },
    { ...baseCode('-'), kind: 'off', name: 'Libre', color: COLORS.red,
      textColor: COLORS.red, shape: 'text', builtin: true },
  ];
  return Object.freeze(Object.fromEntries(list.map((d) => [d.code, Object.freeze(d)])));
}

export const DEFAULT_CODES = build();

// Limpia un código leído o escrito a mano: mayúsculas, guiones normales, sin espacios.
export function cleanCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[‐-―−]/g, '-').replace(/\s+/g, '');
}

// Definición supuesta para un código nuevo (ver SPEC §3)
export function guessCode(code) {
  const c = cleanCode(code);
  if (DEFAULT_CODES[c]) return { ...DEFAULT_CODES[c] };
  const m = /^([FSNZ])(\d)$/.exec(c);
  if (m) {
    const base = DEFAULT_CODES[`${m[1]}1`];
    return { ...base, code: c, confirmed: false, builtin: false };
  }
  if (/^[A-Z]\d{2}$/.test(c)) {
    return { ...baseCode(c), kind: 'place', name: `Lugar ${c}`, color: COLORS.place, textColor: COLORS.white };
  }
  return { ...baseCode(c), confirmed: false };
}

export function getCode(state, code) {
  const c = cleanCode(code);
  return state?.codes?.[c] ?? DEFAULT_CODES[c] ?? guessCode(c);
}

export function kindOf(state, code) {
  return getCode(state, code).kind;
}

// Códigos que todavía no tienen definición en el estado
export function unknownCodes(state, codes) {
  return [...new Set((codes || []).map(cleanCode).filter((c) => c && !state?.codes?.[c]))];
}

export function hasTime(def) {
  return parseHHMM(def?.start) !== null && parseHHMM(def?.end) !== null;
}

// Duración nominal en minutos (sin pausa); null si no tiene horario
export function nominalMinutes(def) {
  const s = parseHHMM(def?.start), e = parseHHMM(def?.end);
  if (s === null || e === null) return null;
  return e > s ? e - s : e + 1440 - s;
}

// Intervalo real del código ese día (fechas locales; si fin <= inicio termina al día siguiente)
export function shiftInterval(state, dayKey, code) {
  const def = getCode(state, code);
  const s = parseHHMM(def.start), e = parseHHMM(def.end);
  if (s === null || e === null) return null;
  const d = fromKey(dayKey);
  const y = d.getFullYear(), mo = d.getMonth(), day = d.getDate();
  const start = new Date(y, mo, day, Math.floor(s / 60), s % 60);
  const end = new Date(y, mo, day + (e > s ? 0 : 1), Math.floor(e / 60), e % 60);
  return { start, end };
}

// ¿El código cuenta como trabajo con horas? (turnos y eventos activados con horario)
export function countsAsWork(def) {
  if (!def || !hasTime(def)) return false;
  if (def.kind === 'shift') return def.countsHours !== false;
  if (def.kind === 'event') return def.countsHours === true;
  return false;
}

// Turno de noche: termina al día siguiente
export function isNightCode(def) {
  const s = parseHHMM(def?.start), e = parseHHMM(def?.end);
  return def?.kind === 'shift' && s !== null && e !== null && e <= s;
}

const RANK = { shift: 0, event: 1, place: 3 };

// Orden: turnos, eventos, otros, lugares; sin duplicados ni vacíos
export function normalizeDayCodes(state, codes) {
  const seen = new Set();
  const list = [];
  for (const raw of codes || []) {
    const c = cleanCode(raw);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    list.push(c);
  }
  return list
    .map((c, i) => ({ c, i, r: RANK[kindOf(state, c)] ?? 2 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

// Emoji según tipo y hora de inicio
export function codeEmoji(def) {
  if (!def) return '📌';
  switch (def.kind) {
    case 'event': return '👥';
    case 'vacation': return '🏖️';
    case 'sick': return '🤒';
    case 'place': return '📍';
    case 'off': case 'wish': return '🌿';
    default: break;
  }
  const s = parseHHMM(def.start);
  if (s === null) return '📌';
  if (s < 9 * 60) return '🌅';
  if (s < 12 * 60) return '☀️';
  if (s < 20 * 60) return '🌇';
  return '🌙';
}
