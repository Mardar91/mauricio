// Hoja inferior "Editar día": insignias del día, horario de ese día (también «solo este día»),
// paleta de códigos, nota e historial.
import * as core from '../core/index.js';
import {
  clearDay, dayMinutes, dayTimedItems, formatHours, formatLong, formatShort, getCode, holidayName, isReadOnlyDevice, isoWeek,
  mapsUrl, normalizeDayCodes, parseHHMM, setDay, travelText,
} from '../core/index.js';
import { badge, badgeFromDef, displayName, groupCodes, timeRange } from './badge.js';
import { append, cap, dateTime, h, nextId, setChildren } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet } from './sheet.js';
import { saveFailedToast, savedToast } from './banners.js';
import {
  BREAK_OPTIONS, dayTimes, dayTimesSupported, nominalOf, normalTimes, overnight, rangeText, sameTimes, workTextOf,
} from './times.js';
import { calendarPhrase } from './platform.js';

const FREE = ['off', 'wish', 'vacation', 'sick'];
const TIMELESS = ['place', 'off', 'wish', 'vacation', 'sick'];
// Siempre a mano en la paleta (el resto, si no se usa, en «Más códigos»)
const CORE = ['F1', 'S1', 'N1', 'Z1', '-', 'W-', 'U', 'K', 'TS'];

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

// ¿Se le puede poner un horario solo para un día? (turnos, reuniones y otros; no lugares ni libres)
function allowsSpecial(def) {
  if (typeof core.allowsSpecialTimes === 'function') return core.allowsSpecialTimes(def);
  return !TIMELESS.includes(def.kind);
}

// ¿Cuenta horas de trabajo con este horario? (para mostrar «X h de trabajo» y la pausa)
const countsWork = (def) => def.kind === 'shift' || def.countsHours === true;

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
  // Horario especial de este día por código ({ start, end, breakMin }); solo fuera de la revisión
  const special = !draftMode && dayTimesSupported();
  const initialTimes = {};
  if (special) {
    // Se parte del horario efectivo (si el guardado no trae pausa, vale la del código, como en el núcleo)
    for (const c of Object.keys(initial?.times || {})) {
      if (!initialCodes.includes(c)) continue;
      const e = dayTimes(store.get(), key, c);
      if (e.special && e.start && e.end) initialTimes[c] = { start: e.start, end: e.end, breakMin: e.breakMin };
    }
  }
  let codes = [...initialCodes];
  let times = Object.fromEntries(Object.entries(initialTimes).map(([c, t]) => [c, { ...t }]));
  const editing = new Set();     // códigos con el panel «solo este día» abierto
  const breakTouched = new Set(); // pausa elegida a mano (si no, se ajusta sola)
  let showAll = false;
  const holiday = holidayName(key);

  const selected = h('div', { class: 'de-selected' });
  const palette = h('div', { class: 'de-palette' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const noteInput = h('textarea', {
    class: 'input textarea', rows: '2', placeholder: 'Ej.: llevar llaves', maxlength: '300',
    'aria-label': 'Nota del día', value: initialNote,
  });

  const showError = (msg) => { err.textContent = msg || ''; err.hidden = !msg; if (msg) err.scrollIntoView?.({ block: 'nearest' }); };

  // Horarios especiales listos para guardar: solo los de códigos del día y distintos del normal.
  // → objeto, o { error } si falta una hora
  function cleanTimes() {
    const state = store.get();
    const out = {};
    for (const c of codes) {
      const t = times[c];
      if (!t) continue;
      if (parseHHMM(t.start) === null || parseHHMM(t.end) === null) {
        return { error: `Pon la hora de inicio y la de fin de ${c}, o toca «Volver al horario normal».` };
      }
      if (t.start === t.end) return { error: `La hora de fin de ${c} no puede ser la misma que la de inicio.` };
      if (sameTimes(t, normalTimes(getCode(state, c)))) continue;
      out[c] = { start: t.start, end: t.end, breakMin: Number(t.breakMin) || 0 };
    }
    return out;
  }

  function tempState() {
    const s = store.get();
    const entry = { codes, note: '', source: 'manual', updatedAt: null };
    if (special) {
      const t = cleanTimes();
      if (!t.error && Object.keys(t).length) entry.times = t;
    } else if (s.days[key]?.times) entry.times = s.days[key].times;
    return { ...s, days: { ...s.days, [key]: entry } };
  }

  const isDirty = () => !sameList(normalizeDayCodes(store.get(), codes), normalizeDayCodes(store.get(), initialCodes))
    || (!draftMode && noteInput.value.trim() !== initialNote.trim())
    || (special && JSON.stringify(cleanTimes()) !== JSON.stringify(initialTimes));

  // Horario que se ve ahora para un código: el que se está escribiendo, o el de ese día
  function shownTimes(c) {
    if (times[c]) return { ...times[c], special: !sameTimes(times[c], normalTimes(getCode(store.get(), c))) };
    if (special) return normalTimes(getCode(store.get(), c));
    return dayTimes(store.get(), key, c);
  }

  // Pausa por defecto de un horario especial: la del código, salvo días de 6 h o menos con la pausa
  // estándar (30 min), que no llevan pausa (como en el core)
  function autoBreak(def, t) {
    const nom = nominalOf(t);
    const base = Number(def.breakMin) || 0;
    return nom !== null && nom <= 360 && base === 30 && !sameTimes({ ...t, breakMin: base }, normalTimes(def)) ? 0 : base;
  }

  const summaryEl = h('p', { class: 'de-summary', 'aria-live': 'polite' });
  function updateSummary(cards) {
    const m = codes.length ? dayMinutes(tempState(), key) : null;
    const n = cards ?? selected.querySelectorAll('.de-time').length;
    // Con una sola tarjeta ya se ve su «X h de trabajo»; un día libre o solo un lugar no dice «0 h»
    const show = codes.length && (n > 1 || Boolean(m && m.credited));
    summaryEl.hidden = !show;
    if (show) {
      setChildren(summaryEl, n > 1 ? 'Total del día: ' : '', h('b', {}, m && m.total ? formatHours(m.total) : '0 h'),
        m && m.credited ? ' acreditadas' : ' de trabajo');
    }
  }

  // Tarjeta del horario de un código ese día
  function timeCard(c) {
    const state = store.get();
    const def = getCode(state, c);
    const normal = normalTimes(def);
    const canEdit = special && allowsSpecial(def);
    const open = canEdit && (editing.has(c) || Boolean(times[c]));
    const fid = nextId('dt');

    const timeEl = h('span', { class: 'de-time-range' });
    const pill = h('span', { class: 'pill pill-special', hidden: true }, 'horario especial');
    const workEl = h('span', { class: 'de-time-work' });
    // «Sal a las 13:05 hacia S51 (25 min de viaje)»: solo en el primer turno del día (viaje de ida)
    const travelEl = h('span', { class: 'de-time-travel', 'data-testid': 'day-travel', hidden: true });
    const nightEl = h('p', { class: 'hint de-time-night', hidden: true }, '🌙 Termina al día siguiente.');
    const card = h('div', { class: 'de-time', dataset: { code: c }, 'data-testid': 'day-time' });

    const update = () => {
      const t = shownTimes(c);
      timeEl.textContent = rangeText(t) || 'Sin hora';
      card.classList.toggle('is-special', Boolean(t.special));
      pill.hidden = !t.special;
      const work = countsWork(def) ? workTextOf(t) : '';
      workEl.textContent = work;
      workEl.hidden = !work;
      const trip = draftMode ? null : dayTimedItems(tempState(), key).find((x) => x.code === c && x.travelMin > 0);
      const tt = trip ? travelText(trip) : '';
      travelEl.textContent = tt;
      travelEl.hidden = !tt;
      nightEl.hidden = !(open && overnight(t));
      updateSummary();
    };

    const head = h('div', { class: 'de-time-head' },
      badge(state, c, { size: 'sm', title: false }),
      h('span', { class: 'de-time-main' },
        h('span', { class: 'de-time-line' }, timeEl, pill),
        workEl, travelEl));

    let panel = null;
    if (open) {
      const cur = times[c] || { start: normal.start || '', end: normal.end || '', breakMin: normal.breakMin };
      const startIn = h('input', { class: 'input input-time', type: 'time', id: `${fid}-s`, value: cur.start || '', 'data-testid': 'day-time-start' });
      const endIn = h('input', { class: 'input input-time', type: 'time', id: `${fid}-e`, value: cur.end || '', 'data-testid': 'day-time-end' });
      const breaks = [...new Set([...BREAK_OPTIONS, Number(cur.breakMin) || 0])].sort((a, b) => a - b);
      const breakSel = h('select', { class: 'input select', id: `${fid}-b`, value: String(Number(cur.breakMin) || 0), 'data-testid': 'day-time-break' },
        breaks.map((m) => h('option', { value: String(m) }, m ? `${m} min` : 'Sin pausa')));
      const read = () => {
        const t = { start: startIn.value, end: endIn.value, breakMin: Number(breakSel.value) || 0 };
        if (!breakTouched.has(c) && parseHHMM(t.start) !== null && parseHHMM(t.end) !== null) {
          t.breakMin = autoBreak(def, t);
          if (!breaks.includes(t.breakMin)) t.breakMin = Number(breakSel.value) || 0;
          breakSel.value = String(t.breakMin);
        }
        times[c] = t;
        showError('');
        update();
      };
      startIn.addEventListener('input', read);
      endIn.addEventListener('input', read);
      breakSel.addEventListener('change', () => { breakTouched.add(c); read(); });
      const field = (label, input) => h('div', { class: 'field' }, h('label', { class: 'label', for: input.id }, label), input);
      panel = h('div', { class: 'de-time-panel' },
        h('div', { class: 'field-row field-row-2' }, field('Empieza', startIn), field('Termina', endIn)),
        countsWork(def) ? field('Pausa sin pagar', breakSel) : null,
        nightEl,
        h('p', { class: 'hint' }, normal.start
          ? `Solo para este día. Los demás días, ${c} sigue ${rangeText(normal)}.`
          : 'Solo para este día.'),
        h('button', {
          class: 'link-btn de-time-reset', type: 'button', 'data-testid': 'day-time-reset',
          on: { click: () => { delete times[c]; editing.delete(c); breakTouched.delete(c); showError(''); refresh(); } },
        }, icon('refresh'), normal.start ? 'Volver al horario normal' : 'Quitar la hora de este día'));
    }

    const actions = [];
    // «Abrir en Mapas» en el primer turno del día, si el lugar tiene dirección
    const maps = draftMode ? null : mapsLinkFor(c);
    if (maps) actions.push(maps);
    if (canEdit && !open) {
      actions.push(h('button', {
        class: 'btn btn-tinted btn-sm de-time-edit', type: 'button', 'data-testid': 'day-time-edit',
        on: { click: () => {
          editing.add(c);
          refresh();
          selected.querySelector(`.de-time[data-code="${CSS.escape(c)}"] input[type="time"]`)?.focus({ preventScroll: true });
        } },
      }, icon('clock'), normal.start ? 'Cambiar la hora solo este día' : 'Poner la hora solo este día'));
    }
    // Lo de todos los días (con aviso en el editor de códigos)
    if (['shift', 'event'].includes(def.kind) && def.confirmed !== false) {
      actions.push(h('button', {
        class: 'link-btn de-edit-time', type: 'button', 'data-testid': 'code-all-days',
        on: { click: () => ctx.openCode(c, { onSaved: refresh, fromDay: key }) },
      }, `Cambiar el horario de ${c} en todos los días`));
    }
    append(card, [head, panel, actions.length ? h('div', { class: 'de-time-actions' }, actions) : null]);
    update();
    return card;
  }

  // Enlace al lugar del día (el destino del viaje, o el primer lugar con dirección), en la tarjeta
  // del primer turno con hora
  function mapsLinkFor(c) {
    const items = dayTimedItems(tempState(), key);
    if (!items.length) return null;
    const first = items.reduce((a, b) => (b.start < a.start ? b : a));
    if (first.code !== c) return null;
    const dest = (first.travelTo && first.places.find((p) => p.code === first.travelTo && p.place)) || first.places.find((p) => p.place);
    const url = dest ? mapsUrl(dest, ctx.platform) : null;
    if (!url) return null;
    return h('a', {
      class: 'link-btn de-maps', href: url, target: '_blank', rel: 'noopener', 'data-testid': 'day-maps',
      'aria-label': `Abrir ${dest.place} en Mapas`,
    }, icon('map'), `Abrir en Mapas (${dest.code})`);
  }

  function renderSelected() {
    const state = store.get();
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
    const warn = defs.filter((d) => d.confirmed === false && ['shift', 'event', 'other'].includes(d.kind));
    // Tarjetas: códigos con hora (o a los que se les puede poner una solo este día)
    const timed = defs.filter((d) => !TIMELESS.includes(d.kind) && (parseHHMM(d.start) !== null || (special && allowsSpecial(d)) || times[d.code]));
    const cards = timed.map((d) => timeCard(d.code));
    setChildren(selected,
      codes.length ? h('div', { class: 'chip-row' }, chips)
        : h('p', { class: 'de-empty' }, draftMode ? 'Nada todavía. Elige abajo 👇' : 'Nada planificado. Elige un turno abajo 👇'),
      cards.length ? h('div', { class: 'de-times' }, cards) : null,
      summaryEl,
      ...warn.map((d) => h('div', { class: 'inline-warn' },
        h('span', {}, `⚠️ El horario de ${d.code} ${d.kind === 'other' ? 'no se conoce' : `es supuesto (${timeRange(d) || 'sin horario'})`}.`),
        h('button', { class: 'link-btn', type: 'button', on: { click: () => ctx.openCode(d.code, { onSaved: refresh }) } }, 'Confirmar'))),
      err,
    );
    updateSummary(cards.length);
  }

  function renderPalette() {
    const state = store.get();
    const { groups, hidden } = paletteGroups(state, codes, showAll);
    setChildren(palette, ...groups.map((g) => h('section', { class: 'de-group' },
      h('h3', { class: 'de-group-title' }, g.title),
      h('div', { class: ['tile-grid', `tiles-${g.id}`] }, g.codes.map((def) => {
        const on = codes.includes(def.code);
        const isPlace = def.kind === 'place';
        const sub = def.kind === 'shift' || (def.kind === 'event' && def.start && def.end) ? (timeRange(def) || 'sin horario') : '';
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
    // Un código que se quita pierde su horario de este día
    for (const c of Object.keys(times)) if (!codes.includes(c)) delete times[c];
    for (const c of [...editing]) if (!codes.includes(c)) editing.delete(c);
    // Conserva el foco en la ficha pulsada (VoiceOver / teclado)
    const code = palette.contains(document.activeElement) ? document.activeElement.dataset.code : null;
    renderSelected();
    renderPalette();
    if (code) palette.querySelector(`.tile[data-code="${CSS.escape(code)}"]`)?.focus({ preventScroll: true });
  }

  const readOnly = !draftMode && isReadOnlyDevice(store.get().settings.sync);
  const body = h('div', { class: 'day-editor' },
    readOnly ? h('div', { class: 'notice notice-info small' }, icon('info'), h('p', {},
      `Este dispositivo solo lee: este cambio se queda aquí y no llegará al ${calendarPhrase()}.`)) : null,
    opts.onPhoto ? h('button', { class: 'btn btn-tinted btn-sm de-photo-btn', type: 'button', on: { click: () => opts.onPhoto() } }, icon('photos'), 'Ver la foto') : null,
    holiday ? h('p', { class: 'holiday-banner' }, `🎉 Festivo en Berlín: ${holiday}`) : null,
    selected,
    palette,
    draftMode ? null : h('label', { class: 'field' }, h('span', { class: 'label' }, 'Nota'), noteInput,
      h('span', { class: 'hint' }, `La nota no sale en el ${calendarPhrase()}. Aun así, no escribas nombres de pacientes ni de compañeros.`)),
    draftMode ? null : history());

  async function save() {
    if (draftMode) {
      sheet.close();
      opts.onDone?.(normalizeDayCodes(store.get(), codes));
      return;
    }
    const before = store.get().days[key] ? { ...store.get().days[key] } : null;
    const note = noteInput.value.trim();
    const t = special ? cleanTimes() : null;
    if (t?.error) { showError(t.error); return; }
    if (!before && !codes.length && !note) { sheet.close(); return; }
    let next;
    try {
      next = setDay(store.get(), key, codes, { note, source: 'manual', ...(special ? { times: t } : {}) });
    } catch (e) {
      showError(e?.message || 'No se pudo guardar este día.');
      return;
    }
    if (next === store.get()) { sheet.close(); return; }
    store.set(() => next);
    sheet.close();
    savedToast(ctx, `Guardado: ${formatShort(key)}`, { action: { label: 'Deshacer', run: () => restore(before) } });
  }

  function next() {
    sheet.close();
    opts.onNext?.(normalizeDayCodes(store.get(), codes));
  }

  function restore(before) {
    store.set((s) => (before
      ? setDay(s, key, before.codes, { note: before.note, source: before.source, ...(special ? { times: before.times || {} } : {}) })
      : clearDay(s, key)));
    if (store.saveOk?.() === false) saveFailedToast(ctx);
  }

  async function remove() {
    const ok = await confirmDialog({
      title: '¿Borrar este día?', text: 'Se quitarán los turnos y la nota de este día.', ok: 'Borrar', danger: true,
    });
    if (!ok) return;
    const before = { ...store.get().days[key] };
    store.set((s) => clearDay(s, key));
    sheet.close();
    savedToast(ctx, 'Día borrado', { action: { label: 'Deshacer', run: () => restore(before) } });
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
