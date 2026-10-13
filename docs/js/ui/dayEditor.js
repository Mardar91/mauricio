// Hoja inferior "Editar día": insignias del día, paleta de códigos, nota e historial.
import {
  clearDay, dayMinutes, formatHours, formatLong, formatShort, getCode, hasTime, holidayName, isReadOnlyDevice, isoWeek,
  normalizeDayCodes, setDay,
} from '../core/index.js';
import { badge, badgeFromDef, displayName, groupCodes, timeRange } from './badge.js';
import { cap, dateTime, h, setChildren } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet } from './sheet.js';

const FREE = ['off', 'wish', 'vacation', 'sick'];
// Siempre a mano en la paleta (el resto, si no se usa, en «Más códigos»)
const CORE = ['F1', 'S1', 'N1', 'Z1', '-', 'W-', 'U', 'TS'];

// Aplica la selección de un código con reglas sencillas (un turno y un lugar por día)
export function toggleCode(state, codes, code) {
  if (codes.includes(code)) return codes.filter((c) => c !== code);
  const kind = getCode(state, code).kind;
  const kindOf = (c) => getCode(state, c).kind;
  let next = [...codes];
  if (kind === 'shift') next = next.filter((c) => kindOf(c) !== 'shift' && !FREE.includes(kindOf(c)));
  else if (kind === 'place') next = next.filter((c) => kindOf(c) !== 'place' && !FREE.includes(kindOf(c)));
  else if (FREE.includes(kind)) next = next.filter((c) => kindOf(c) === 'event');
  next.push(code);
  return normalizeDayCodes(state, next);
}

const SOURCE = { scan: '📷 Foto', manual: '✍️ A mano', import: '📥 Copia' };

function codesText(list) {
  if (!Array.isArray(list) || !list.length) return 'vacío';
  return list.map((c) => (c === '-' ? 'Libre' : String(c))).join(' ');
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Grupos de la paleta: Turnos, Libre y otros, Lugares. Los poco usados quedan en «Más códigos».
export function paletteGroups(state, selected = [], showAll = false) {
  const used = new Set(Object.values(state.days || {}).flatMap((d) => (Array.isArray(d?.codes) ? d.codes : [])));
  const primary = (d) => showAll || d.kind === 'place' || CORE.includes(d.code) || used.has(d.code) || selected.includes(d.code);
  const groups = groupCodes(state);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  const ordered = [byId.shift, { ...byId.other, title: 'Libre y otros' }, byId.place].filter(Boolean);
  let hidden = 0;
  const out = ordered.map((g) => {
    const shown = g.codes.filter(primary);
    hidden += g.codes.length - shown.length;
    return { ...g, codes: shown };
  }).filter((g) => g.codes.length);
  return { groups: out, hidden };
}

// opts: { draft: {codes}, onDone(codes), confirmLabel, onNext(codes), nextLabel, onPhoto }
export function openDayEditor(ctx, key, opts = {}) {
  const { store } = ctx;
  const draftMode = Boolean(opts.draft);
  const initial = store.get().days[key];
  const initialCodes = draftMode ? [...(opts.draft.codes || [])] : [...(initial?.codes || [])];
  const initialNote = draftMode ? '' : (initial?.note || '');
  let codes = [...initialCodes];
  let showAll = false;
  const holiday = holidayName(key);

  const selected = h('div', { class: 'de-selected' });
  const palette = h('div', { class: 'de-palette' });
  const noteInput = h('textarea', {
    class: 'input textarea', rows: '2', placeholder: 'Ej.: llevar llaves', maxlength: '300',
    'aria-label': 'Nota del día', value: initialNote,
  });

  function tempState() {
    const s = store.get();
    return { ...s, days: { ...s.days, [key]: { codes, note: '', source: 'manual', updatedAt: null } } };
  }

  const isDirty = () => !sameList(normalizeDayCodes(store.get(), codes), normalizeDayCodes(store.get(), initialCodes))
    || (!draftMode && noteInput.value.trim() !== initialNote.trim());

  function renderSelected() {
    const state = store.get();
    const m = codes.length ? dayMinutes(tempState(), key) : null;
    const chips = codes.map((c) => {
      const def = getCode(state, c);
      return h('span', { class: 'chip-code' },
        badge(state, c, { size: 'md' }),
        h('span', { class: 'chip-code-name' }, displayName(def)),
        h('button', {
          class: 'chip-remove', type: 'button', 'aria-label': `Quitar ${c === '-' ? 'Libre' : c}`,
          on: { click: () => { codes = codes.filter((x) => x !== c); refresh(); } },
        }, h('span', { class: 'chip-remove-disc' }, icon('close'))));
    });
    const defs = codes.map((c) => getCode(state, c));
    const work = defs.filter((d) => hasTime(d) && (d.kind === 'shift' || d.countsHours));
    const warn = defs.filter((d) => d.confirmed === false && ['shift', 'event', 'other'].includes(d.kind));
    const editable = defs.filter((d) => ['shift', 'event'].includes(d.kind) && d.confirmed !== false);
    setChildren(selected,
      codes.length ? h('div', { class: 'chip-row' }, chips)
        : h('p', { class: 'de-empty' }, draftMode ? 'Nada todavía. Elige abajo 👇' : 'Nada planificado. Elige un turno abajo 👇'),
      codes.length ? h('p', { class: 'de-summary' },
        work.length ? `${work.map((d) => timeRange(d)).join(' · ')} · ` : '',
        h('b', {}, m && m.total ? formatHours(m.total) : '0 h'),
        m && m.credited ? ' acreditadas' : ' de trabajo') : null,
      ...editable.map((d) => h('button', {
        class: 'link-btn de-edit-time', type: 'button', on: { click: () => ctx.openCode(d.code, { onSaved: refresh }) },
      }, icon('clock'), `Cambiar el horario de ${d.code}`)),
      ...warn.map((d) => h('div', { class: 'inline-warn' },
        h('span', {}, `⚠️ El horario de ${d.code} ${d.kind === 'other' ? 'no se conoce' : `es supuesto (${timeRange(d) || 'sin horario'})`}.`),
        h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.openCode(d.code, { onSaved: refresh }) } }, 'Confirmar'))),
    );
  }

  function renderPalette() {
    const state = store.get();
    const { groups, hidden } = paletteGroups(state, codes, showAll);
    setChildren(palette, ...groups.map((g) => h('section', { class: 'de-group' },
      h('h3', { class: 'de-group-title' }, g.title),
      h('div', { class: ['tile-grid', `tiles-${g.id}`] }, g.codes.map((def) => {
        const on = codes.includes(def.code);
        const isPlace = def.kind === 'place';
        const sub = def.kind === 'shift' || (def.kind === 'event' && hasTime(def)) ? (timeRange(def) || 'sin horario') : '';
        const name = isPlace ? (def.place || '') : def.name;
        return h('button', {
          class: ['tile', on && 'on', def.confirmed === false && 'unconfirmed', !name && !sub && 'tile-only', isPlace && 'tile-place'], type: 'button',
          'aria-pressed': on ? 'true' : 'false', 'aria-label': `${def.code === '-' ? 'Libre' : def.code} ${displayName(def)}${sub ? `, ${sub}` : ''}`,
          dataset: { code: def.code },
          on: { click: () => { codes = toggleCode(store.get(), codes, def.code); refresh(); } },
        },
        badgeFromDef(def, { size: 'md', title: false }),
        name || sub ? h('span', { class: 'tile-text' },
          name ? h('span', { class: 'tile-name' }, name) : null,
          sub ? h('span', { class: 'tile-sub' }, sub) : null) : null,
        on ? h('span', { class: 'tile-check', 'aria-hidden': 'true' }, icon('check')) : null);
      })))),
    hidden || showAll ? h('button', {
      class: 'btn btn-plain btn-block more-codes-btn', type: 'button', 'data-testid': 'more-codes',
      on: { click: () => { showAll = !showAll; refresh(); } },
    }, showAll ? 'Menos códigos' : `Más códigos (${hidden})`) : null,
    h('button', {
      class: 'btn btn-secondary btn-block new-code-btn', type: 'button',
      on: { click: () => ctx.openCode(null, { onSaved: (code) => { codes = toggleCode(store.get(), codes, code); refresh(); } }) },
    }, icon('plus'), 'Código nuevo'));
  }

  function history() {
    const list = (store.get().changes || [])
      .filter((c) => c && c.dayKey === key && Array.isArray(c.before) && Array.isArray(c.after))
      .slice(-8).reverse();
    if (!list.length) return null;
    return h('details', { class: 'de-history' },
      h('summary', {}, `Historial de cambios (${list.length})`),
      h('ul', {}, list.map((c) => h('li', {},
        h('span', { class: 'hist-when' }, dateTime(c.at)),
        h('span', { class: 'hist-src' }, SOURCE[c.source] || ''),
        h('span', { class: 'hist-what' }, `${codesText(c.before)} → ${codesText(c.after)}`)))));
  }

  function refresh() {
    // Conserva el foco en la ficha pulsada (VoiceOver / teclado)
    const code = palette.contains(document.activeElement) ? document.activeElement.dataset.code : null;
    renderSelected();
    renderPalette();
    if (code) palette.querySelector(`.tile[data-code="${CSS.escape(code)}"]`)?.focus({ preventScroll: true });
  }

  const readOnly = !draftMode && isReadOnlyDevice(store.get().settings.sync);
  const body = h('div', { class: 'day-editor' },
    readOnly ? h('div', { class: 'notice notice-info small' }, icon('info'), h('p', {},
      'Este dispositivo solo lee: este cambio se queda aquí y no llegará al Calendario del iPhone.')) : null,
    opts.onPhoto ? h('button', { class: 'btn btn-tinted btn-sm de-photo-btn', type: 'button', on: { click: () => opts.onPhoto() } }, icon('photos'), 'Ver la foto') : null,
    holiday ? h('p', { class: 'holiday-banner' }, `🎉 Festivo en Berlín: ${holiday}`) : null,
    selected,
    palette,
    draftMode ? null : h('label', { class: 'field' }, h('span', { class: 'label' }, 'Nota'), noteInput,
      h('span', { class: 'hint' }, 'La nota no sale en el Calendario del iPhone. Aun así, no escribas nombres de pacientes ni de compañeros.')),
    draftMode ? null : history());

  async function save() {
    if (draftMode) {
      sheet.close();
      opts.onDone?.(normalizeDayCodes(store.get(), codes));
      return;
    }
    const before = store.get().days[key] ? { ...store.get().days[key] } : null;
    const note = noteInput.value.trim();
    if (!before && !codes.length && !note) { sheet.close(); return; }
    const next = setDay(store.get(), key, codes, { note, source: 'manual' });
    if (next === store.get()) { sheet.close(); return; }
    store.set(() => next);
    sheet.close();
    if (store.saveOk?.() === false) {
      ctx.toast('No se pudo guardar en este teléfono. Mira el aviso rojo de arriba.', { type: 'error', duration: 8000 });
      return;
    }
    ctx.toast(`Guardado: ${formatShort(key)}`, { type: 'ok', action: { label: 'Deshacer', run: () => restore(before) } });
  }

  function next() {
    sheet.close();
    opts.onNext?.(normalizeDayCodes(store.get(), codes));
  }

  function restore(before) {
    store.set((s) => (before ? setDay(s, key, before.codes, { note: before.note, source: before.source }) : clearDay(s, key)));
  }

  async function remove() {
    const ok = await confirmDialog({
      title: '¿Borrar este día?', text: 'Se quitarán los turnos y la nota de este día.', ok: 'Borrar', danger: true,
    });
    if (!ok) return;
    const before = { ...store.get().days[key] };
    store.set((s) => clearDay(s, key));
    sheet.close();
    ctx.toast('Día borrado', { action: { label: 'Deshacer', run: () => restore(before) } });
  }

  let footer;
  if (draftMode && opts.onNext) {
    footer = [
      h('button', { class: 'btn btn-secondary btn-lg', type: 'button', 'data-testid': 'day-done', on: { click: save } }, opts.confirmLabel || 'Listo'),
      h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', 'data-testid': 'day-next', on: { click: next } }, opts.nextLabel || 'Siguiente ›'),
    ];
  } else if (draftMode) {
    footer = [h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', 'data-testid': 'day-done', on: { click: save } }, opts.confirmLabel || 'Listo')];
  } else {
    footer = [
      initial ? h('button', { class: 'btn btn-danger-plain', type: 'button', on: { click: remove } }, icon('trash'), 'Borrar día') : null,
      h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', 'data-testid': 'day-save', on: { click: save } }, 'Guardar'),
    ];
  }

  const sheet = openSheet({
    title: cap(formatLong(key)),
    subtitle: `Semana ${isoWeek(key)}${draftMode ? ' · revisión' : ''}`,
    body,
    footer: h('div', { class: 'footer-row' }, footer),
    className: 'sheet-day',
    isDirty,
    dirtyText: draftMode ? 'Lo que elegiste para este día no se guardará.' : 'Los cambios de este día no se guardarán.',
  });
  refresh();
  return sheet;
}
