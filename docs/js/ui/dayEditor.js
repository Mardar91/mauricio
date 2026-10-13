// Hoja inferior "Editar día": insignias del día, paleta de códigos, nota e historial.
import {
  clearDay, dayMinutes, formatHours, formatLong, formatShort, getCode, hasTime, holidayName, isoWeek, normalizeDayCodes, setDay,
} from '../core/index.js';
import { badge, badgeFromDef, displayName, groupCodes, timeRange } from './badge.js';
import { cap, dateTime, h, setChildren } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet } from './sheet.js';

const FREE = ['off', 'wish', 'vacation', 'sick'];

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
  if (!list || !list.length) return 'vacío';
  return list.map((c) => (c === '-' ? 'Libre' : c)).join(' ');
}

// opts: { draft: {codes}, onDone(codes), confirmLabel }
export function openDayEditor(ctx, key, opts = {}) {
  const { store } = ctx;
  const draftMode = Boolean(opts.draft);
  const initial = store.get().days[key];
  let codes = draftMode ? [...(opts.draft.codes || [])] : [...(initial?.codes || [])];
  const holiday = holidayName(key);

  const selected = h('div', { class: 'de-selected' });
  const palette = h('div', { class: 'de-palette' });
  const noteInput = h('textarea', {
    class: 'input textarea', rows: '2', placeholder: 'Ej.: cambio con Ana, llevar llaves…', maxlength: '300',
    'aria-label': 'Nota del día', value: initial?.note || '',
  });

  function tempState() {
    const s = store.get();
    return { ...s, days: { ...s.days, [key]: { codes, note: '', source: 'manual', updatedAt: null } } };
  }

  function renderSelected() {
    const state = store.get();
    const m = codes.length ? dayMinutes(tempState(), key) : null;
    const chips = codes.map((c) => {
      const def = getCode(state, c);
      return h('span', { class: 'chip-code' },
        badge(state, c, { size: 'md' }),
        h('span', { class: 'chip-code-name' }, displayName(def)),
        h('button', {
          class: 'chip-remove', type: 'button', 'aria-label': `Quitar ${c}`,
          on: { click: () => { codes = codes.filter((x) => x !== c); refresh(); } },
        }, icon('close')));
    });
    const work = codes.map((c) => getCode(state, c)).filter((d) => hasTime(d) && (d.kind === 'shift' || d.countsHours));
    const warn = codes.map((c) => getCode(state, c)).filter((d) => d.confirmed === false && ['shift', 'event', 'other'].includes(d.kind));
    setChildren(selected, 
      codes.length ? h('div', { class: 'chip-row' }, chips)
        : h('p', { class: 'de-empty' }, draftMode ? 'Nada todavía. Elige abajo 👇' : 'Nada planificado. Elige un turno abajo 👇'),
      codes.length ? h('p', { class: 'de-summary' },
        work.length ? `${work.map((d) => timeRange(d)).join(' · ')} · ` : '',
        h('b', {}, m && m.total ? formatHours(m.total) : '0 h'),
        m && m.credited ? ' acreditadas' : ' de trabajo') : null,
      ...warn.map((d) => h('div', { class: 'inline-warn' },
        h('span', {}, `⚠️ El horario de ${d.code} ${d.kind === 'other' ? 'no se conoce' : `es supuesto (${timeRange(d) || 'sin horario'})`}.`),
        h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.openCode(d.code, { onSaved: refresh }) } }, 'Confirmar'))),
    );
  }

  function renderPalette() {
    const state = store.get();
    const groups = groupCodes(state);
    setChildren(palette, ...groups.map((g) => h('section', { class: 'de-group' },
      h('h3', { class: 'de-group-title' }, g.title),
      h('div', { class: ['tile-grid', `tiles-${g.id}`] }, g.codes.map((def) => {
        const on = codes.includes(def.code);
        const isPlace = def.kind === 'place';
        const sub = def.kind === 'shift' || (def.kind === 'event' && hasTime(def)) ? (timeRange(def) || 'sin horario')
          : isPlace ? (def.place || '') : '';
        const name = isPlace ? (displayName(def) === 'Lugar de trabajo' ? '' : displayName(def)) : def.name;
        return h('button', {
          class: ['tile', on && 'on', def.confirmed === false && 'unconfirmed', !(name || (sub && !isPlace)) && 'tile-only'], type: 'button',
          'aria-pressed': on ? 'true' : 'false', 'aria-label': `${def.code === '-' ? 'Libre' : def.code} ${displayName(def)}${sub && sub !== name ? `, ${sub}` : ''}`,
          dataset: { code: def.code },
          on: { click: () => { codes = toggleCode(store.get(), codes, def.code); refresh(); } },
        },
        badgeFromDef(def, { size: 'md', title: false }),
        name || (sub && !isPlace) ? h('span', { class: 'tile-text' },
          name ? h('span', { class: 'tile-name' }, name) : null,
          sub && sub !== name ? h('span', { class: 'tile-sub' }, sub) : null) : null,
        on ? h('span', { class: 'tile-check', 'aria-hidden': 'true' }, icon('check')) : null);
      })))),
    h('button', {
      class: 'btn btn-secondary btn-block new-code-btn', type: 'button',
      on: { click: () => ctx.openCode(null, { onSaved: (code) => { codes = toggleCode(store.get(), codes, code); refresh(); } }) },
    }, icon('plus'), 'Código nuevo'));
  }

  function history() {
    const list = (store.get().changes || []).filter((c) => c.dayKey === key).slice(-8).reverse();
    if (!list.length) return null;
    return h('details', { class: 'de-history' },
      h('summary', {}, `Historial de cambios (${list.length})`),
      h('ul', {}, list.map((c) => h('li', {},
        h('span', { class: 'hist-when' }, dateTime(c.at)),
        h('span', { class: 'hist-src' }, SOURCE[c.source] || c.source),
        h('span', { class: 'hist-what' }, `${codesText(c.before)} → ${codesText(c.after)}`)))));
  }

  function refresh() {
    // Conserva el foco en la ficha pulsada (VoiceOver / teclado)
    const code = palette.contains(document.activeElement) ? document.activeElement.dataset.code : null;
    renderSelected();
    renderPalette();
    if (code) palette.querySelector(`.tile[data-code="${CSS.escape(code)}"]`)?.focus({ preventScroll: true });
  }

  const body = h('div', { class: 'day-editor' },
    holiday ? h('p', { class: 'holiday-banner' }, `🎉 Festivo en Berlín: ${holiday}`) : null,
    selected,
    palette,
    draftMode ? null : h('label', { class: 'field' }, h('span', { class: 'label' }, 'Nota'), noteInput),
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
    ctx.toast(`Guardado: ${formatShort(key)}`, { type: 'ok', action: { label: 'Deshacer', run: () => restore(before) } });
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

  const footer = draftMode
    ? [h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: save } }, opts.confirmLabel || 'Listo')]
    : [
      initial ? h('button', { class: 'btn btn-danger-plain', type: 'button', on: { click: remove } }, icon('trash'), 'Borrar día') : null,
      h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', on: { click: save } }, 'Guardar'),
    ];

  const sheet = openSheet({
    title: cap(formatLong(key)),
    subtitle: `Semana ${isoWeek(key)}${draftMode ? ' · revisión' : ''}`,
    body,
    footer: h('div', { class: 'footer-row' }, footer),
    className: 'sheet-day',
  });
  refresh();
  return sheet;
}
