// Insignias de códigos con la misma forma y color que la app Dienstplan original.
import { formatHours, getCode, hasTime, nominalMinutes } from '../core/index.js';
import { h } from './dom.js';

// size: 'sm' | 'md' | 'lg' | 'xl'
export function badge(state, code, { size = 'md', title = true } = {}) {
  const def = getCode(state, code);
  return badgeFromDef(def, { size, title });
}

export function badgeFromDef(def, { size = 'md', title = true } = {}) {
  const label = `${def.code === '-' ? 'Libre' : def.code} · ${def.name}`;
  const common = { class: ['badge', `badge-${size}`, `shape-${def.shape}`], role: 'img', 'aria-label': label };
  if (title) common.title = label;
  if (def.code === '-') {
    return h('span', { ...common, class: [...common.class, 'badge-dash'], style: { '--b-fg': def.textColor || def.color } },
      h('span', { class: 'dash' }));
  }
  if (def.shape === 'text') {
    return h('span', { ...common, style: { '--b-fg': def.textColor || def.color } }, def.code);
  }
  return h('span', {
    ...common,
    style: { '--b-bg': def.color, '--b-fg': def.textColor },
  }, h('span', { class: 'badge-txt' }, def.code));
}

export function badgeRow(state, codes, opts = {}) {
  return h('span', { class: ['badges', opts.class] }, (codes || []).map((c) => badge(state, c, opts)));
}

// Nombre para mostrar (los lugares sin nombre propio muestran su dirección, o «Lugar S51»)
export function displayName(def) {
  if (def.kind === 'place' && (!def.name || def.name === `Lugar ${def.code}`)) return def.place || `Lugar ${def.code}`;
  return def.name;
}

// '06:00–15:00' o ''
export function timeRange(def) {
  return hasTime(def) ? `${def.start}–${def.end}` : '';
}

// '8 h 30 de trabajo (pausa 30 min)'
export function workText(def) {
  const nom = nominalMinutes(def);
  if (nom === null) return '';
  const work = Math.max(0, nom - (Number(def.breakMin) || 0));
  return def.breakMin ? `${formatHours(work)} de trabajo · pausa ${def.breakMin} min` : `${formatHours(work)} de trabajo`;
}

// Nombre en español del tipo de código
export const KIND_LABEL = {
  shift: 'Turno', place: 'Lugar', event: 'Reunión / evento', off: 'Libre', wish: 'Libre deseado',
  vacation: 'Vacaciones', sick: 'Enfermedad', other: 'Otro',
};

// Agrupa códigos para la paleta: Turnos / Lugares / Otros
export function groupCodes(state) {
  const all = Object.values(state.codes || {});
  const order = (a, b) => {
    const ka = a.code.replace(/\d+/, (n) => n.padStart(3, '0'));
    const kb = b.code.replace(/\d+/, (n) => n.padStart(3, '0'));
    const fs = 'FZSN';
    const ia = fs.indexOf(a.code[0]), ib = fs.indexOf(b.code[0]);
    if (ia !== ib) return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib);
    return ka.localeCompare(kb);
  };
  const otherOrder = ['-', 'W-', 'U', 'TS'];
  const oo = (c) => { const i = otherOrder.indexOf(c.code); return i < 0 ? 99 : i; };
  return [
    { id: 'shift', title: 'Turnos', codes: all.filter((d) => d.kind === 'shift').sort(order) },
    { id: 'place', title: 'Lugares', codes: all.filter((d) => d.kind === 'place').sort(order) },
    { id: 'other', title: 'Otros', codes: all.filter((d) => !['shift', 'place'].includes(d.kind)).sort((a, b) => oo(a) - oo(b) || a.code.localeCompare(b.code)) },
  ];
}
