// Horario de un código en un día concreto: el normal del código o el «horario especial» de ese día
// (DayEntry.times). effectiveTimes lo da el core; si esta versión del core aún no lo tiene, se usa el
// horario normal y no se ofrece cambiarlo solo un día (nada se rompe).
import * as core from '../core/index.js';

export const BREAK_OPTIONS = [0, 15, 30, 45, 60, 90];

// ¿El core sabe guardar y usar un horario solo para un día?
export function dayTimesSupported() {
  return typeof core.effectiveTimes === 'function';
}

// Horario normal del código (el de todos los días)
export function normalTimes(def) {
  return { start: def?.start || null, end: def?.end || null, breakMin: Number(def?.breakMin) || 0, special: false };
}

// → { start, end, breakMin, special }
export function dayTimes(state, key, code) {
  if (dayTimesSupported()) {
    try {
      const t = core.effectiveTimes(state, key, code);
      if (t) return { start: t.start || null, end: t.end || null, breakMin: Number(t.breakMin) || 0, special: Boolean(t.special) };
    } catch (e) {
      console.warn(e);
    }
  }
  return normalTimes(core.getCode(state, code));
}

const valid = (s) => core.parseHHMM(s) !== null;

// '06:00–15:00', 'desde las 14:00' (solo inicio) o ''
export function rangeText(t, { sep = '–' } = {}) {
  if (!t || !valid(t.start)) return '';
  return valid(t.end) ? `${t.start}${sep}${t.end}` : `desde las ${t.start}`;
}

// Minutos sin pausa (null si falta inicio o fin)
export function nominalOf(t) {
  if (!t || !valid(t.start) || !valid(t.end)) return null;
  const s = core.parseHHMM(t.start), e = core.parseHHMM(t.end);
  return e > s ? e - s : e + 1440 - s;
}

// Minutos de trabajo (con la pausa descontada)
export function workMinutesOf(t) {
  const nom = nominalOf(t);
  return nom === null ? null : Math.max(0, nom - (Number(t.breakMin) || 0));
}

// '8 h 30 de trabajo · pausa 30 min'
export function workTextOf(t) {
  const work = workMinutesOf(t);
  if (work === null) return '';
  return t.breakMin ? `${core.formatHours(work)} de trabajo · pausa ${t.breakMin} min` : `${core.formatHours(work)} de trabajo`;
}

export const sameTimes = (a, b) => Boolean(a && b) && (a.start || null) === (b.start || null) && (a.end || null) === (b.end || null)
  && (Number(a.breakMin) || 0) === (Number(b.breakMin) || 0);

// ¿Termina al día siguiente?
export function overnight(t) {
  return valid(t?.start) && valid(t?.end) && core.parseHHMM(t.end) <= core.parseHHMM(t.start);
}
