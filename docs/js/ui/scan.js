// Pestaña "Escanear": fotos → reconocimiento → revisión → guardar. Con plan B a mano.
import {
  applyScan, daysInMonth, diffScan, formatMonth, getCode, makeKey, mergeScans, monthName, setDay, toKey, weekdayShort,
} from '../core/index.js';
import { badgeRow } from './badge.js';
import { ago, cap, h, setChildren } from './dom.js';
import { icon } from './icons.js';
import { confirmDialog } from './sheet.js';

const LOW_CONFIDENCE = 0.7;
const EMPLOYEE = 'Ducuara';

let tessPromise = null;

// Carga vendor/tesseract/tesseract.min.js una sola vez (define globalThis.Tesseract)
export function loadTesseract() {
  if (globalThis.Tesseract) return Promise.resolve(true);
  if (!tessPromise) {
    tessPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('vendor/tesseract/tesseract.min.js', document.baseURI).href;
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => { tessPromise = null; s.remove(); reject(new Error('No se pudo cargar el lector de fotos.')); };
      document.head.append(s);
    });
  }
  return tessPromise;
}

export function tesseractPaths() {
  const u = (p) => new URL(p, document.baseURI).href;
  return {
    workerPath: u('vendor/tesseract/worker.min.js'),
    corePath: u('vendor/tesseract/core/'),
    langPath: u('vendor/tesseract/lang/best_int/'),
    langPathLegacy: u('vendor/tesseract/lang/legacy/'),
  };
}

function monthOptions(sel) {
  return Array.from({ length: 12 }, (_, i) => h('option', { value: String(i + 1), selected: sel === i + 1 }, cap(monthName(i + 1))));
}

function yearOptions(sel, around) {
  const ys = [around - 1, around, around + 1];
  if (sel && !ys.includes(sel)) ys.push(sel);
  return ys.sort().map((y) => h('option', { value: String(y), selected: sel === y }, String(y)));
}

export function createScan(ctx) {
  const { store } = ctx;
  const el = h('section', { 'aria-label': 'Escanear' });
  let mode = 'home';     // home | processing | review | fallback
  let photos = [];       // [{ file, url, progress, label, status }]
  let review = null;     // { layout, year, month, rows: Map(day → row), warnings, manual, showAll, source }
  let runId = 0;

  // ---------- Inicio ----------
  function fileButton(label, iconName, cls, attrs) {
    const input = h('input', {
      type: 'file', accept: 'image/*', class: 'visually-hidden', tabindex: '-1', ...attrs,
      on: { change: () => { const files = [...input.files]; input.value = ''; if (files.length) process(files); } },
    });
    return h('label', { class: ['btn', cls], role: 'button', tabindex: '0',
      on: { keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } } },
    icon(iconName), h('span', {}, label), input);
  }

  function renderHome(state) {
    const scans = [...(state.scans || [])].reverse().slice(0, 3);
    setChildren(el, 
      h('header', { class: 'page-head' },
        h('h1', { class: 'large-title' }, 'Escanear'),
        h('p', { class: 'page-sub' }, 'Haz una foto de tu plan y la app apunta tus turnos.')),
      h('div', { class: 'card scan-hero' },
        h('div', { class: 'scan-illus', 'aria-hidden': 'true' }, scanArt()),
        h('ul', { class: 'tips' },
          tip('Foto recta, con buena luz y sin reflejos'),
          tip('Que se vea el mes arriba (p. ej. «Oktober 2026»)'),
          tip('Puedes hacer varias fotos del mismo mes'),
          tip('También vale la hoja del PC'))),
      h('div', { class: 'scan-actions' },
        fileButton('Hacer foto', 'camera', 'btn-primary btn-lg btn-block', { capture: 'environment', 'data-testid': 'scan-camera' }),
        fileButton('Elegir fotos', 'photos', 'btn-secondary btn-lg btn-block', { multiple: true, 'data-testid': 'scan-pick' }),
        h('button', { class: 'btn btn-plain btn-block', type: 'button', on: { click: () => startManual() } }, icon('pencil'), 'Escribir el plan a mano')),
      scans.length ? h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Últimos escaneos'),
        h('ul', { class: 'card list-card' }, scans.map((s) => h('li', { class: 'list-row' },
          h('span', { class: 'row-icon', 'aria-hidden': 'true' }, s.layout === 'pc-grid' ? '🖥️' : '📱'),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, s.month && s.year ? cap(formatMonth(s.year, s.month)) : 'Mes desconocido'),
            h('span', { class: 'row-sub' }, `${s.daysFound} ${s.daysFound === 1 ? 'día leído' : 'días leídos'} · ${ago(s.at, ctx.now())}`)))))) : null,
    );
  }

  function tip(text) {
    return h('li', {}, h('span', { class: 'tip-check', 'aria-hidden': 'true' }, icon('check')), h('span', {}, text));
  }

  // ---------- Procesando ----------
  function renderProcessing() {
    const n = photos.length;
    const done = photos.filter((p) => p.status === 'done').length;
    setChildren(el, 
      h('header', { class: 'page-head' },
        h('h1', { class: 'large-title' }, 'Leyendo…'),
        h('p', { class: 'page-sub', 'aria-live': 'polite' }, n > 1 ? `Foto ${Math.min(done + 1, n)} de ${n}. Esto tarda unos segundos.` : 'Esto tarda unos segundos. No cierres la app.')),
      h('ul', { class: 'photo-list' }, photos.map((p, i) => h('li', { class: ['photo-item', `st-${p.status}`] },
        h('img', { class: 'photo-thumb', src: p.url, alt: `Foto ${i + 1}` }),
        h('div', { class: 'photo-info' },
          h('p', { class: 'photo-title' }, `Foto ${i + 1}`),
          h('p', { class: 'photo-label' }, p.status === 'done' ? (p.found ? `${p.found} días encontrados` : 'No se encontraron días') : p.status === 'error' ? 'No se pudo leer' : (p.label || 'En espera…')),
          h('div', { class: 'progress progress-sm', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p.progress * 100)), 'aria-label': `Progreso de la foto ${i + 1}` },
            h('div', { class: 'progress-fill', style: { width: `${Math.round(p.progress * 100)}%` } }))),
        h('span', { class: 'photo-state', 'aria-hidden': 'true' }, p.status === 'done' ? icon('check') : p.status === 'working' ? h('span', { class: 'spinner' }) : null)))),
      h('button', { class: 'btn btn-plain btn-block', type: 'button', on: { click: cancelProcessing } }, 'Cancelar'),
    );
  }

  function updatePhoto(i) {
    const items = el.querySelectorAll('.photo-item');
    const p = photos[i], li = items[i];
    if (!li) return;
    li.querySelector('.photo-label').textContent = p.label || 'Leyendo…';
    const pct = Math.round(p.progress * 100);
    li.querySelector('.progress-fill').style.width = `${pct}%`;
    li.querySelector('.progress').setAttribute('aria-valuenow', String(pct));
  }

  function cancelProcessing() {
    runId++;
    cleanupPhotos();
    mode = 'home';
    render(store.get());
  }

  function cleanupPhotos() {
    for (const p of photos) URL.revokeObjectURL(p.url);
    photos = [];
  }

  async function process(files) {
    const id = ++runId;
    cleanupPhotos();
    photos = files.map((file) => ({ file, url: URL.createObjectURL(file), progress: 0, label: '', status: 'waiting', found: 0 }));
    mode = 'processing';
    render(store.get());
    window.scrollTo(0, 0);
    let recognize, dispose;
    try {
      await loadTesseract().catch((e) => console.warn(e.message));
      ({ recognize, dispose } = await import('../recognize/index.js'));
    } catch (e) {
      console.error(e);
      if (id !== runId) return;
      return showFallback(null, ['No se pudo abrir el lector de fotos. Comprueba la conexión la primera vez.']);
    }
    const state = store.get();
    const results = [];
    for (let i = 0; i < photos.length; i++) {
      if (id !== runId) return;
      const p = photos[i];
      p.status = 'working'; p.label = 'Preparando la foto…';
      renderProcessing();
      try {
        const res = await recognize(p.file, {
          tesseract: tesseractPaths(),
          knownCodes: Object.keys(state.codes),
          employeeName: EMPLOYEE,
          onProgress: (f, label) => {
            if (id !== runId) return;
            p.progress = Math.max(p.progress, Math.min(1, Number(f) || 0));
            if (label) p.label = label;
            updatePhoto(i);
          },
        });
        if (id !== runId) return;
        results.push(res);
        p.found = res?.days?.length || 0;
        p.status = 'done'; p.progress = 1;
      } catch (e) {
        console.error(e);
        p.status = 'error'; p.progress = 1;
        results.push({ layout: 'unknown', month: null, year: null, days: [], warnings: [`No se pudo leer la foto ${i + 1}.`] });
      }
      renderProcessing();
    }
    // Libera la memoria de Tesseract (en iPhone es importante)
    Promise.resolve().then(() => dispose?.()).catch(() => {});
    if (id !== runId) return;
    const merged = results.length === 1 ? { ...results[0], warnings: [...(results[0].warnings || [])] } : mergeScans(results);
    if (!merged.days?.length) return showFallback(merged, merged.warnings);
    showReview(merged, { source: 'scan' });
  }

  // ---------- Plan B: a mano ----------
  function showFallback(result, warnings = []) {
    const now = ctx.now();
    review = {
      layout: result?.layout || 'unknown',
      year: result?.year || now.getFullYear(), month: result?.month || now.getMonth() + 1,
      rows: new Map(), warnings, manual: true, showAll: true, source: 'scan',
    };
    mode = 'fallback';
    render(store.get());
    window.scrollTo(0, 0);
  }

  function startManual() {
    cleanupPhotos();
    const now = ctx.now();
    review = { layout: 'unknown', year: now.getFullYear(), month: now.getMonth() + 1, rows: new Map(), warnings: [], manual: true, showAll: true, source: 'manual' };
    mode = 'review';
    render(store.get());
    window.scrollTo(0, 0);
  }

  function monthPicker(onChange) {
    const mSel = h('select', { class: 'input select', 'aria-label': 'Mes', on: { change: () => { review.month = +mSel.value; onChange(); } } }, monthOptions(review.month));
    const ySel = h('select', { class: 'input select', 'aria-label': 'Año', on: { change: () => { review.year = +ySel.value; onChange(); } } }, yearOptions(review.year, ctx.now().getFullYear()));
    return h('div', { class: 'month-picker' }, mSel, ySel);
  }

  function photoStrip() {
    if (!photos.length) return null;
    return h('div', { class: 'photo-strip' }, photos.map((p, i) => h('a', {
      href: p.url, target: '_blank', rel: 'noopener', class: 'photo-strip-item', 'aria-label': `Ver la foto ${i + 1} en grande`,
    }, h('img', { src: p.url, alt: '' }))));
  }

  function renderFallback() {
    setChildren(el, 
      h('div', { class: 'fallback' },
        h('div', { class: 'fallback-emoji', 'aria-hidden': 'true' }, '🤔'),
        h('h1', { class: 'fallback-title' }, 'No he podido leer la foto'),
        h('p', { class: 'fallback-text' }, 'No pasa nada: elige el mes y marca tus turnos a mano mirando la foto. Es solo un minuto.'),
        ...(review.warnings || []).filter((w) => !/No se pudo leer la foto automáticamente/.test(w)).map((w) => h('p', { class: 'notice notice-info small' }, w)),
        photoStrip(),
        h('div', { class: 'card fallback-card' },
          h('p', { class: 'label' }, '¿De qué mes es el plan?'),
          monthPicker(() => {}),
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', on: { click: () => { mode = 'review'; render(store.get()); window.scrollTo(0, 0); } } }, icon('pencil'), 'Rellenar a mano')),
        h('div', { class: 'fallback-more' },
          fileButton('Probar con otra foto', 'camera', 'btn-secondary btn-block', { capture: 'environment' }),
          h('button', { class: 'btn btn-plain btn-block', type: 'button', on: { click: cancelReview } }, 'Cancelar'))),
    );
  }

  // ---------- Revisión ----------
  // result: RecognizeResult (o uno inyectado en tests)
  function showReview(result, { source = 'scan' } = {}) {
    const now = ctx.now();
    const rows = new Map();
    for (const d of result?.days || []) {
      const day = Number(d.day);
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      const conf = Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : 1;
      rows.set(day, {
        day, codes: [...(d.codes || [])], confidence: conf, conflict: Boolean(d.conflict),
        alternatives: d.alternatives || [], fromScan: true, edited: false,
        accepted: null, // null → por defecto según el tipo
      });
    }
    review = {
      layout: result?.layout || 'unknown',
      year: result?.year || now.getFullYear(), month: result?.month || now.getMonth() + 1,
      detectedMonth: Boolean(result?.month && result?.year),
      rows, warnings: [...(result?.warnings || [])], manual: false, showAll: false, source,
    };
    mode = 'review';
    render(store.get());
    window.scrollTo(0, 0);
    return true;
  }

  function cancelReview() {
    review = null;
    cleanupPhotos();
    mode = 'home';
    render(store.get());
    window.scrollTo(0, 0);
  }

  // Filas con clave, diff y estado actuales
  function computeRows(state) {
    const n = daysInMonth(review.year, review.month);
    const days = [];
    const list = review.showAll ? Array.from({ length: n }, (_, i) => i + 1) : [...review.rows.keys()].sort((a, b) => a - b);
    for (const day of list) {
      if (day > n) continue;
      const r = review.rows.get(day) || { day, codes: [], confidence: 1, fromScan: false, edited: false, accepted: null, alternatives: [] };
      const key = makeKey(review.year, review.month, day);
      days.push({ ...r, key });
    }
    const diffs = diffScan(state, days.map((d) => ({ key: d.key, codes: d.codes, confidence: d.confidence })));
    return days.map((d, i) => {
      const df = diffs[i];
      const doubtful = !d.edited && d.fromScan && (d.confidence < LOW_CONFIDENCE || d.conflict);
      const present = d.fromScan || d.edited;
      let accepted = d.accepted;
      if (accepted === null) accepted = present && df.type !== 'same' && !doubtful && !(review.manual && !d.edited);
      if (!present || df.type === 'same') accepted = false;
      return { ...d, type: df.type, before: df.before, after: df.after, doubtful, present, accepted };
    });
  }

  function editRow(r) {
    ctx.openDay(r.key, {
      draft: { codes: r.codes },
      confirmLabel: 'Listo',
      onDone: (codes) => {
        const prev = review.rows.get(r.day) || { day: r.day, confidence: 1, fromScan: false, alternatives: [] };
        // Un día vacío que no existía ni se leyó no cuenta
        if (!codes.length && !prev.fromScan && !store.get().days[r.key]) review.rows.delete(r.day);
        else review.rows.set(r.day, { ...prev, codes, edited: true, accepted: true, confidence: 1, conflict: false });
        render(store.get());
      },
    });
  }

  function statusPill(r) {
    if (!r.present) return review.manual ? null : h('span', { class: 'pill pill-muted' }, 'No leído');
    if (r.doubtful) return h('span', { class: 'pill pill-alert' }, '¿Seguro?');
    if (r.type === 'new') return h('span', { class: 'pill pill-ok' }, 'Nuevo');
    if (r.type === 'changed') return h('span', { class: 'pill pill-warn' }, `Cambia: ${codesText(r.before)} → ${codesText(r.after)}`);
    return h('span', { class: 'pill pill-muted' }, 'Sin cambios');
  }

  function renderReview(state) {
    const rows = computeRows(state);
    const counts = {
      total: rows.filter((r) => r.present).length,
      new: rows.filter((r) => r.present && r.type === 'new').length,
      changed: rows.filter((r) => r.present && r.type === 'changed').length,
      doubtful: rows.filter((r) => r.doubtful).length,
    };
    const accepted = rows.filter((r) => r.accepted);
    const newCodes = [...new Set(rows.filter((r) => r.present).flatMap((r) => r.codes))].filter((c) => !state.codes[c]);
    const unconfirmed = [...new Set(rows.filter((r) => r.present).flatMap((r) => r.codes))]
      .filter((c) => state.codes[c] && state.codes[c].confirmed === false && ['shift', 'event', 'other'].includes(state.codes[c].kind));

    const header = h('header', { class: 'page-head review-head' },
      h('div', { class: 'review-top' },
        h('h1', { class: 'large-title' }, review.manual ? 'Plan a mano' : 'Revisa el plan'),
        h('button', { class: 'btn btn-plain btn-sm', type: 'button', on: { click: askCancel } }, 'Cancelar')),
      h('p', { class: 'page-sub' }, review.manual
        ? 'Toca cada día y elige su turno. Solo se guardan los días que rellenes.'
        : 'Comprueba que todo está bien. Toca un día para corregirlo.'));

    const monthCard = h('div', { class: 'card review-month' },
      h('div', { class: 'review-month-row' },
        h('span', { class: 'label' }, review.manual || review.detectedMonth ? 'Mes del plan' : 'No se vio el mes: elígelo'),
        monthPicker(() => render(store.get()))),
      !review.manual ? h('p', { class: 'review-counts' },
        h('span', {}, h('b', {}, String(counts.total)), counts.total === 1 ? ' día leído' : ' días leídos'),
        counts.new ? h('span', { class: 'rc rc-new' }, `${counts.new} nuevos`) : null,
        counts.changed ? h('span', { class: 'rc rc-changed' }, `${counts.changed} cambian`) : null,
        counts.doubtful ? h('span', { class: 'rc rc-doubt' }, `${counts.doubtful} dudosos`) : null) : null);

    const notices = [];
    for (const w of review.warnings || []) notices.push(h('div', { class: 'notice notice-info' }, icon('info'), h('p', {}, w)));
    for (const c of newCodes) {
      const g = getCode(state, c);
      notices.push(h('div', { class: 'notice notice-warn' }, icon('warning'), h('p', {},
        h('b', {}, `Código nuevo: ${c}. `),
        g.kind === 'shift' ? `La app supone ${g.start}–${g.end} (como ${c[0]}1). Confirma su horario después en Ajustes → Códigos.`
          : g.kind === 'place' ? 'La app lo guarda como un lugar.' : 'La app no sabe qué es. Explícaselo después en Ajustes → Códigos.')));
    }
    for (const c of unconfirmed) {
      notices.push(h('div', { class: 'notice notice-warn' }, icon('warning'), h('p', {}, `El horario de ${c} es supuesto. Confírmalo en Ajustes → Códigos.`)));
    }
    if (counts.doubtful) {
      notices.push(h('div', { class: 'notice notice-alert' }, icon('help'), h('p', {},
        h('b', {}, `${counts.doubtful} ${counts.doubtful === 1 ? 'día dudoso' : 'días dudosos'}. `),
        'No se guardan hasta que los compruebes: tócalos y pulsa «Listo», o márcalos.')));
    }

    const list = h('ul', { class: 'card list-card review-list' }, rows.map((r) => {
      const check = h('input', {
        type: 'checkbox', class: 'check', checked: r.accepted, disabled: !r.present || r.type === 'same',
        'aria-label': `Guardar el día ${r.day}`,
        on: { change: () => {
          const row = review.rows.get(r.day);
          if (row) { row.accepted = check.checked; render(store.get()); }
        } },
      });
      return h('li', { class: ['review-row', `t-${r.present ? r.type : 'none'}`, r.doubtful && 'doubtful', !r.accepted && r.present && 'unchecked', review.manual && 'manual'], dataset: { day: String(r.day) } },
        review.manual ? null : h('label', { class: 'review-check' }, check),
        h('button', { class: 'review-main', type: 'button', 'aria-label': `Editar el día ${r.day}`, on: { click: () => editRow(r) } },
          h('span', { class: 'd-num small' }, h('span', { class: 'd-day' }, String(r.day).padStart(2, '0')), h('span', { class: 'd-dow' }, weekdayShort(r.key))),
          h('span', { class: 'review-codes' },
            r.codes.length ? badgeRow(state, r.codes) : h('span', { class: 'faint' }, r.present ? 'Vacío' : review.manual ? 'Tocar para añadir' : '—'),
            h('span', { class: 'review-status' }, statusPill(r),
              r.conflict && r.alternatives?.length && !r.edited ? h('span', { class: 'alt-hint' }, `otra foto: ${r.alternatives.map(codesText).join(' / ')}`) : null)),
          h('span', { class: ['row-chevron', !r.present && 'row-add'], 'aria-hidden': 'true' }, icon(r.present ? 'pencil' : 'plus'))));
    }));

    const showAllBtn = !review.manual ? h('button', {
      class: 'btn btn-plain btn-block', type: 'button',
      on: { click: () => { review.showAll = !review.showAll; render(store.get()); } },
    }, review.showAll ? 'Mostrar solo los días leídos' : `Mostrar todos los días de ${monthName(review.month)}`) : null;

    const n = accepted.length;
    const saveBtn = h('button', {
      class: 'btn btn-primary btn-lg grow', type: 'button', disabled: n === 0, 'data-testid': 'review-save',
      on: { click: () => save(rows) },
    }, n === 0 ? (review.manual ? 'Rellena algún día' : 'Nada que guardar') : `Guardar ${n} ${n === 1 ? 'día' : 'días'}`);

    setChildren(el, 
      header,
      review.manual && photos.length ? h('details', { class: 'card photo-ref', open: true }, h('summary', {}, 'Tu foto'), photoStrip()) : null,
      monthCard,
      ...notices,
      list,
      showAllBtn,
      counts.total && !n && !review.manual && !counts.doubtful ? h('p', { class: 'muted center small' }, 'Tu plan ya estaba al día. 👍') : null,
      h('div', { class: 'review-bar' },
        h('button', { class: 'btn btn-secondary btn-lg', type: 'button', on: { click: askCancel } }, 'Cancelar'),
        saveBtn),
    );
  }

  async function askCancel() {
    const touched = [...(review?.rows.values() || [])].some((r) => r.edited);
    if (touched) {
      const ok = await confirmDialog({ title: '¿Salir sin guardar?', text: 'Se perderán los cambios de esta revisión.', ok: 'Salir', danger: true, cancel: 'Seguir revisando' });
      if (!ok) return;
    }
    cancelReview();
  }

  function save(rows) {
    const accepted = rows.filter((r) => r.accepted);
    if (!accepted.length) return;
    const { year, month } = review;
    const result = {
      layout: review.layout, year, month,
      // Todos los días leídos (para el historial); acceptedKeys decide cuáles se guardan
      days: rows.filter((r) => r.present).map((r) => ({ day: r.day, codes: r.codes, confidence: r.edited ? 1 : r.confidence })),
      warnings: [],
    };
    const keys = accepted.map((r) => r.key);
    if (review.manual) {
      // Escrito a mano: días con origen 'manual' y sin registrar un escaneo
      store.set((s) => accepted.reduce((st, r) => setDay(st, r.key, r.codes, { source: 'manual' }), s));
    } else {
      store.set((s) => applyScan(s, result, { acceptedKeys: keys, year, month }));
    }
    const n = accepted.length;
    ctx.toast(`Guardados ${n} ${n === 1 ? 'día' : 'días'} de ${monthName(month)}`, { type: 'ok' });
    review = null;
    cleanupPhotos();
    mode = 'home';
    render(store.get());
    ctx.go('calendario', { key: keys.includes(toKey(ctx.now())) ? toKey(ctx.now()) : keys[0] });
  }

  function render(state) {
    if (mode === 'processing') renderProcessing();
    else if (mode === 'review' && review) renderReview(state);
    else if (mode === 'fallback' && review) renderFallback();
    else renderHome(state);
  }

  return {
    el,
    render,
    showReview,
    onShow() { return mode !== 'home'; },
    get mode() { return mode; },
  };
}

function codesText(list) {
  if (!list || !list.length) return 'vacío';
  return list.map((c) => (c === '-' ? 'libre' : c)).join(' ');
}

// Ilustración: hoja del plan con un visor de cámara
function scanArt() {
  const s = document.createElement('span');
  s.innerHTML = `<svg viewBox="0 0 220 120" width="220" height="120" role="presentation">
    <defs><linearGradient id="sa-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFB45C"/><stop offset="1" stop-color="#EF8A17"/></linearGradient></defs>
    <rect x="58" y="10" width="104" height="100" rx="10" fill="var(--card)" stroke="var(--line-strong)" stroke-width="1.5"/>
    <rect x="58" y="10" width="104" height="20" rx="10" fill="url(#sa-g)"/><rect x="58" y="22" width="104" height="8" fill="url(#sa-g)"/>
    <text x="110" y="24" text-anchor="middle" font-size="8.5" font-weight="700" fill="#3B2405" font-family="-apple-system,system-ui,sans-serif">Oktober 2026</text>
    <g font-family="-apple-system,system-ui,sans-serif" font-size="7" font-weight="700" text-anchor="middle">
      <text x="72" y="46" fill="var(--text-2)" font-size="8">12</text><ellipse cx="92" cy="43" rx="9" ry="6.5" fill="#F2E500"/><text x="92" y="45.5" fill="#1F1F1F">F1</text><ellipse cx="113" cy="43" rx="10" ry="6.5" fill="#E31CE0"/><text x="113" y="45.5" fill="#fff">F52</text>
      <text x="72" y="66" fill="var(--text-2)" font-size="8">13</text><ellipse cx="92" cy="63" rx="9" ry="6.5" fill="#8DC47E"/><text x="92" y="65.5" fill="#1F1F1F">S1</text><ellipse cx="113" cy="63" rx="10" ry="6.5" fill="#E31CE0"/><text x="113" y="65.5" fill="#fff">S51</text>
      <text x="72" y="86" fill="var(--text-2)" font-size="8">14</text><rect x="86" y="81.5" width="10" height="2.6" rx="1.3" fill="#D21F1F"/>
      <text x="72" y="104" fill="var(--text-2)" font-size="8">15</text><ellipse cx="92" cy="101" rx="9" ry="6.5" fill="#3D63B8"/><text x="92" y="103.5" fill="#fff">N1</text>
    </g>
    <g stroke="var(--line)" stroke-width="1"><path d="M64 53h92M64 73h92M64 92h92"/></g>
    <g fill="none" stroke="var(--accent)" stroke-width="3.2" stroke-linecap="round">
      <path d="M44 22v-12h12M176 22v-12h-12M44 98v12h12M176 98v12h-12"/>
    </g>
  </svg>`;
  return s.firstElementChild;
}
