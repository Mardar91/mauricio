// Hoja "Código": crear o editar un código (horario, pausa, lugar, color y forma).
import {
  DEFAULT_CODES, cleanCode, deleteCode, formatHours, getCode, nominalMinutes, parseHHMM, upsertCode,
} from '../core/index.js';
import { badgeFromDef, KIND_LABEL } from './badge.js';
import { contrastText, h, nextId, parseNum, setChildren } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog, openSheet } from './sheet.js';

export const SWATCHES = [
  ['#F2E500', 'Amarillo'], ['#8DC47E', 'Verde'], ['#3D63B8', 'Azul'], ['#F3B9BF', 'Rosa'],
  ['#E31CE0', 'Magenta'], ['#E0281E', 'Rojo'], ['#EF8A17', 'Naranja'], ['#8E5BD8', 'Morado'],
  ['#2BA7A0', 'Turquesa'], ['#9E9E9E', 'Gris'],
];

const KIND_ORDER = ['shift', 'place', 'event', 'off', 'wish', 'vacation', 'sick', 'other'];
const SHAPE_BY_KIND = { event: 'hexagon', wish: 'tag', vacation: 'text', off: 'text', sick: 'circle' };
const SHAPES = [['circle', 'Círculo'], ['hexagon', 'Hexágono'], ['tag', 'Etiqueta'], ['text', 'Solo texto']];
const BREAKS = [0, 15, 30, 45, 60, 90];

// opts: { onSaved(code), kind }
export function openCodeEditor(ctx, code, opts = {}) {
  const { store } = ctx;
  const isNew = !code;
  const existing = code ? getCode(store.get(), code) : null;
  const d = existing ? { ...existing } : {
    code: '', kind: opts.kind || 'shift', name: '', start: '', end: '', breakMin: 30, countsHours: true,
    creditHours: null, color: '#F2E500', textColor: '#1F1F1F', shape: 'circle', place: '', confirmed: true,
  };
  const wasUnconfirmed = existing?.confirmed === false;
  let touchedShape = !isNew;

  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const preview = h('div', { class: 'ce-preview' });

  const fid = nextId('ce');
  const codeInput = h('input', {
    class: 'input input-code', id: `${fid}-code`, value: d.code, maxlength: '6', autocapitalize: 'characters',
    autocomplete: 'off', spellcheck: false, placeholder: 'Ej.: F4', disabled: !isNew,
    on: { input: () => { d.code = cleanCode(codeInput.value); updatePreview(); } },
  });
  const nameInput = h('input', {
    class: 'input', id: `${fid}-name`, value: d.name, maxlength: '40', placeholder: 'Ej.: Mañana corta',
    on: { input: () => { d.name = nameInput.value; updatePreview(); } },
  });
  const startInput = h('input', { class: 'input input-time', type: 'time', id: `${fid}-start`, value: d.start || '', on: { input: () => { d.start = startInput.value; updatePreview(); } } });
  const endInput = h('input', { class: 'input input-time', type: 'time', id: `${fid}-end`, value: d.end || '', on: { input: () => { d.end = endInput.value; updatePreview(); } } });
  const breakSel = h('select', { class: 'input select', id: `${fid}-break`, value: String(d.breakMin ?? 0), on: { change: () => { d.breakMin = Number(breakSel.value); updatePreview(); } } },
    [...new Set([...BREAKS, Number(d.breakMin) || 0])].sort((a, b) => a - b).map((m) => h('option', { value: String(m) }, m ? `${m} min` : 'Sin pausa')));
  const placeInput = h('input', { class: 'input', id: `${fid}-place`, value: d.place || '', maxlength: '80', placeholder: 'Ej.: Karl-Marx-Str. 1 / Ruta norte', on: { input: () => { d.place = placeInput.value; } } });
  const creditInput = h('input', {
    class: 'input', id: `${fid}-credit`, inputmode: 'decimal', value: d.creditHours == null ? '' : String(d.creditHours).replace('.', ','),
    placeholder: 'Automático (7 h)', on: { input: () => { d.creditHours = creditInput.value.trim() === '' ? null : parseNum(creditInput.value); } },
  });
  const countsSwitch = h('input', { type: 'checkbox', class: 'switch', id: `${fid}-counts`, checked: Boolean(d.countsHours), on: { change: () => { d.countsHours = countsSwitch.checked; updatePreview(); } } });

  const kindGroup = h('div', { class: 'choice-wrap', role: 'radiogroup', 'aria-label': 'Tipo' });
  const colorGroup = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Color' });
  const shapeGroup = h('div', { class: 'choice-wrap shapes', role: 'radiogroup', 'aria-label': 'Forma' });

  const field = (label, input, hint) => h('div', { class: 'field' },
    h('label', { class: 'label', for: input.id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);

  const secTime = h('div', { class: 'ce-sec' },
    h('div', { class: 'field-row field-row-2' }, field('Empieza', startInput), field('Termina', endInput)),
    field('Pausa sin pagar', breakSel),
    h('p', { class: 'hint ce-overnight', hidden: true }, '🌙 Termina al día siguiente.'));
  const secCounts = h('label', { class: 'switch-row', for: countsSwitch.id }, h('span', {}, 'Cuenta como horas de trabajo'), countsSwitch);
  const secCredit = field('Horas que cuenta por día', creditInput, 'Déjalo vacío para usar tu jornada normal.');
  const secPlace = field('Lugar o dirección (opcional)', placeInput);

  function renderKinds() {
    setChildren(kindGroup, ...KIND_ORDER.map((k) => h('button', {
      class: ['choice', d.kind === k && 'on'], type: 'button', role: 'radio', 'aria-checked': d.kind === k ? 'true' : 'false',
      on: { click: () => setKind(k) },
    }, KIND_LABEL[k])));
  }

  function setKind(k) {
    d.kind = k;
    if (!touchedShape) d.shape = SHAPE_BY_KIND[k] || 'circle';
    if (k === 'shift') d.countsHours = true;
    if (k === 'place' || k === 'off' || k === 'wish') d.countsHours = false;
    countsSwitch.checked = Boolean(d.countsHours);
    renderKinds(); renderShapes(); updateVisibility(); updatePreview();
  }

  function renderColors() {
    setChildren(colorGroup, ...SWATCHES.map(([hex, name]) => h('button', {
      class: ['swatch', d.color.toUpperCase() === hex && 'on'], type: 'button', role: 'radio',
      'aria-checked': d.color.toUpperCase() === hex ? 'true' : 'false', 'aria-label': name, style: { '--sw': hex },
      on: { click: () => { d.color = hex; d.textColor = d.shape === 'text' ? hex : contrastText(hex); renderColors(); updatePreview(); } },
    }, d.color.toUpperCase() === hex ? icon('check') : null)));
  }

  function renderShapes() {
    setChildren(shapeGroup, ...SHAPES.map(([s, name]) => {
      const sample = { ...d, code: d.code || 'AB', shape: s, textColor: s === 'text' ? d.color : contrastText(d.color) };
      return h('button', {
        class: ['choice', 'choice-shape', d.shape === s && 'on'], type: 'button', role: 'radio', 'aria-checked': d.shape === s ? 'true' : 'false',
        'aria-label': name, on: { click: () => { d.shape = s; touchedShape = true; d.textColor = s === 'text' ? d.color : contrastText(d.color); renderShapes(); updatePreview(); } },
      }, badgeFromDef(sample, { size: 'sm', title: false }));
    }));
  }

  function updateVisibility() {
    const k = d.kind;
    secTime.hidden = !['shift', 'event', 'other'].includes(k);
    secCounts.hidden = k !== 'event';
    secCredit.hidden = !['vacation', 'sick'].includes(k);
    secPlace.hidden = !['shift', 'place', 'event'].includes(k);
  }

  function updatePreview() {
    const s = parseHHMM(d.start), e = parseHHMM(d.end);
    secTime.querySelector('.ce-overnight').hidden = !(s !== null && e !== null && e <= s);
    const def = { ...d, code: d.code || '?', name: d.name || KIND_LABEL[d.kind] };
    const nom = nominalMinutes(def);
    let line = KIND_LABEL[d.kind];
    if (['shift', 'event', 'other'].includes(d.kind) && nom !== null) {
      const work = Math.max(0, nom - (Number(d.breakMin) || 0));
      line = `${d.start}–${d.end} · ${formatHours(work)}${d.kind === 'event' && !d.countsHours ? ' (no cuenta)' : ''}`;
    }
    setChildren(preview, badgeFromDef(def, { size: 'lg', title: false }),
      h('div', {}, h('p', { class: 'ce-prev-name' }, def.name), h('p', { class: 'muted small' }, line)));
  }

  function showError(msg) {
    err.textContent = msg;
    err.hidden = !msg;
  }

  async function save() {
    const state = store.get();
    const c = cleanCode(codeInput.value);
    if (!c) return showError('Escribe el código, por ejemplo F4.');
    if (!/^[A-Z0-9ÄÖÜ+\-/]{1,6}$/.test(c)) return showError('El código solo puede tener letras, números y guion (máximo 6).');
    if (isNew && state.codes[c]) return showError(`El código ${c} ya existe. Búscalo en la lista para editarlo.`);
    if (['shift'].includes(d.kind) && (!d.start || !d.end)) return showError('Pon la hora de inicio y de fin del turno.');
    if (d.kind === 'vacation' || d.kind === 'sick') {
      if (d.creditHours !== null && !(d.creditHours >= 0 && d.creditHours <= 24)) return showError('Las horas por día deben estar entre 0 y 24.');
    }
    const def = {
      code: c, kind: d.kind, name: (d.name || '').trim() || KIND_LABEL[d.kind], breakMin: Number(d.breakMin) || 0,
      color: d.color, textColor: d.shape === 'text' ? d.color : (d.textColor || contrastText(d.color)), shape: d.shape,
      place: (d.place || '').trim(), countsHours: d.kind === 'shift' ? true : d.kind === 'event' ? Boolean(d.countsHours) : false,
      creditHours: ['vacation', 'sick'].includes(d.kind) ? d.creditHours : null, confirmed: true,
      start: ['shift', 'event', 'other'].includes(d.kind) && d.start ? d.start : null,
      end: ['shift', 'event', 'other'].includes(d.kind) && d.end ? d.end : null,
    };
    try {
      const next = upsertCode(state, def);
      store.set(() => next);
    } catch (e) {
      return showError(e.message);
    }
    sheet.close();
    ctx.toast(isNew ? `Código ${c} creado` : `${c} guardado${wasUnconfirmed ? ' y confirmado' : ''}`, { type: 'ok' });
    opts.onSaved?.(c);
  }

  async function remove() {
    const state = store.get();
    const used = Object.values(state.days).filter((e) => e.codes.includes(existing.code)).length;
    const builtin = Boolean(DEFAULT_CODES[existing.code]);
    const ok = await confirmDialog({
      title: builtin ? `¿Restablecer ${existing.code}?` : `¿Borrar ${existing.code}?`,
      text: builtin ? 'Volverá a su horario y color de fábrica.'
        : used ? `Se usa en ${used} ${used === 1 ? 'día' : 'días'}. Esos días lo mantendrán, pero con un horario supuesto.` : 'Este código no se usa en ningún día.',
      ok: builtin ? 'Restablecer' : 'Borrar', danger: !builtin,
    });
    if (!ok) return;
    store.set((s) => deleteCode(s, existing.code));
    sheet.close();
    ctx.toast(builtin ? `${existing.code} restablecido` : `${existing.code} borrado`);
    opts.onSaved?.(existing.code);
  }

  const body = h('form', { class: 'code-editor', on: { submit: (e) => { e.preventDefault(); save(); } } },
    wasUnconfirmed ? h('div', { class: 'notice notice-warn' }, icon('warning'),
      h('p', {}, existing.kind === 'other' ? 'La app no sabe qué es este código. Dile qué tipo es y su horario.'
        : 'Este horario es supuesto. Revísalo y pulsa «Confirmar».')) : null,
    preview,
    h('div', { class: 'field-row field-row-code' },
      field('Código', codeInput),
      field('Nombre', nameInput)),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Tipo'), kindGroup),
    secTime, secCounts, secCredit, secPlace,
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Color'), colorGroup),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Forma'), shapeGroup),
    err,
    h('button', { type: 'submit', hidden: true, tabindex: '-1', 'aria-hidden': 'true' }));

  const footer = h('div', { class: 'footer-row' },
    existing && (state0().codes[existing.code] || DEFAULT_CODES[existing.code])
      ? h('button', { class: 'btn btn-danger-plain', type: 'button', on: { click: remove } }, icon(DEFAULT_CODES[existing.code] ? 'refresh' : 'trash'), DEFAULT_CODES[existing.code] ? 'Restablecer' : 'Borrar')
      : null,
    h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', on: { click: save } }, wasUnconfirmed ? 'Confirmar' : 'Guardar'));

  function state0() { return store.get(); }

  renderKinds(); renderColors(); renderShapes(); updateVisibility(); updatePreview();
  const sheet = openSheet({
    title: isNew ? 'Código nuevo' : `Código ${existing.code === '-' ? '“-” (libre)' : existing.code}`,
    subtitle: isNew ? 'Por ejemplo, un turno o un lugar que no estaba' : KIND_LABEL[existing.kind],
    body, footer, className: 'sheet-code',
  });
  if (isNew) setTimeout(() => codeInput.focus({ preventScroll: true }), 350);
  return sheet;
}
