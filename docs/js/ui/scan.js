// Pestaña "Escanear": fotos → reconocimiento → revisión → guardar. Con plan B a mano.
// La revisión se guarda como borrador (sobrevive a que iOS recargue la app o a «Actualizar»).
import {
  applyScan, daysInMonth, diffScan, formatMonth, getCode, makeKey, mergeScans, monthName, setDay, toKey, weekdayShort,
} from '../core/index.js';
import { badgeRow } from './badge.js';
import { ago, cap, h, listText, plural, safeStorage, setChildren } from './dom.js';
import { icon } from './icons.js';
import { banners, saveFailedToast } from './banners.js';
import { confirmDialog, openSheet } from './sheet.js';
import { dayTimes, rangeText } from './times.js';

const LOW_CONFIDENCE = 0.7;
const EMPLOYEE = 'Ducuara';
export const DRAFT_KEY = 'turnos-mauricio:scan-draft';
const DRAFT_MAX_AGE = 24 * 3600 * 1000;
const KIND_WORDS = { vacation: 'vacaciones', off: 'libre', wish: 'libre deseado', sick: 'enfermedad', event: 'reunión' };

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

// Año más cercano a hoy para un mes leído sin año (en diciembre, «enero» es del año siguiente)
export function guessYear(month, now = new Date()) {
  const y = now.getFullYear(), here = y * 12 + now.getMonth();
  let best = y, bestD = Infinity;
  for (const c of [y - 1, y, y + 1]) {
    const d = Math.abs(c * 12 + (month - 1) - here);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

// Días que el lector vio pero no pudo leer: result.unread o, si no viene, los de sus avisos
const UNREAD_RE = /no pude leer bien|dos lecturas distintas/i;
export function daysFromWarnings(warnings) {
  const out = [];
  for (const w of warnings || []) {
    if (typeof w !== 'string' || !UNREAD_RE.test(w)) continue;
    const m = /d[ií]as?\s+([\d\s,y]+)/i.exec(w);
    if (m) for (const n of m[1].match(/\d+/g) || []) out.push(Number(n));
  }
  return out;
}

function unreadDays(results, merged) {
  const read = new Set((merged?.days || []).map((d) => Number(d.day)));
  const out = new Set();
  for (const r of results) {
    if (!r) continue;
    if (r.month && merged?.month && r.month !== merged.month) continue;
    for (const d of Array.isArray(r.unread) ? r.unread : []) out.add(Number(d));
    for (const d of daysFromWarnings(r.warnings)) out.add(d);
  }
  return [...out].filter((d) => Number.isInteger(d) && d >= 1 && d <= 31 && !read.has(d)).sort((a, b) => a - b);
}

function codesText(list) {
  if (!Array.isArray(list) || !list.length) return 'vacío';
  return list.map((c) => (c === '-' ? 'libre' : c)).join(' ');
}

const sameCodes = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

export function createScan(ctx) {
  const { store } = ctx;
  const ls = safeStorage();
  const el = h('section', { 'aria-label': 'Escanear' });
  let mode = 'home';     // home | processing | review | fallback | ocrfail
  let photos = [];       // [{ file, url, progress, label, status, found }]
  let review = null;     // { layout, year, month, monthKnown, yearKnown, rows: Map(day → row), warnings, unread, manual, showAll, source }
  let runId = 0;
  let lastFiles = null;  // para «Reintentar»
  let recognizer = null; // módulo del reconocedor (dispose)
  let draftAt = null;

  // ---------- Selectores de archivo (se crean una vez: re-pintar no los cambia con la cámara abierta) ----------
  const makeInput = (id, attrs) => {
    const input = h('input', {
      type: 'file', accept: 'image/*', class: 'visually-hidden', tabindex: '-1', id, ...attrs,
      on: { change: () => { const files = [...input.files]; input.value = ''; if (files.length) process(files); } },
    });
    return input;
  };
  const camInput = makeInput('scan-camera-input', { capture: 'environment', 'data-testid': 'scan-camera', 'aria-label': 'Tomar foto' });
  const pickInput = makeInput('scan-pick-input', { multiple: true, 'data-testid': 'scan-pick', 'aria-label': 'Elegir fotos' });
  document.body.append(h('div', { class: 'file-inputs' }, camInput, pickInput));

  function fileButton(input, label, iconName, cls) {
    return h('label', {
      class: ['btn', cls], for: input.id, role: 'button', tabindex: '0',
      on: { keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
    }, icon(iconName), h('span', {}, label));
  }

  // ---------- Borrador ----------
  function saveDraft() {
    if (!ls || !review || (mode !== 'review' && mode !== 'fallback')) return;
    try {
      ls.setItem(DRAFT_KEY, JSON.stringify({ v: 1, at: draftAt || Date.now(), mode, review: { ...review, rows: [...review.rows.entries()] } }));
      if (!draftAt) draftAt = Date.now();
    } catch { /* sin espacio: no pasa nada */ }
  }

  function clearDraft() {
    draftAt = null;
    try { ls?.removeItem(DRAFT_KEY); } catch { /* nada */ }
  }

  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(ls?.getItem(DRAFT_KEY) || 'null'); } catch { d = null; }
    if (!d) return;
    const r = d.review;
    const okNum = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
    if (!r || !Array.isArray(r.rows) || !okNum(r.year, 2000, 2100) || !okNum(r.month, 1, 12) || !(Date.now() - d.at < DRAFT_MAX_AGE)) {
      clearDraft();
      return;
    }
    const rows = new Map();
    for (const [day, row] of r.rows) {
      if (!okNum(day, 1, 31) || !row || !Array.isArray(row.codes)) continue;
      rows.set(day, { ...row, day, codes: row.codes.filter((c) => typeof c === 'string'), alternatives: Array.isArray(row.alternatives) ? row.alternatives : [] });
    }
    review = {
      layout: r.layout || 'unknown', year: r.year, month: r.month, monthKnown: r.monthKnown !== false, yearKnown: r.yearKnown !== false,
      rows, warnings: (r.warnings || []).filter((w) => typeof w === 'string'), unread: (r.unread || []).filter((n) => okNum(n, 1, 31)),
      manual: Boolean(r.manual), showAll: Boolean(r.showAll), source: r.source || 'scan',
    };
    mode = d.mode === 'fallback' ? 'fallback' : 'review';
    draftAt = d.at;
  }
  restoreDraft();

  // ---------- Inicio ----------
  function renderHome(state) {
    const scans = [...(state.scans || [])].reverse().slice(0, 3);
    setChildren(el,
      h('header', { class: 'page-head' },
        h('h1', { class: 'large-title' }, 'Escanear'),
        h('p', { class: 'page-sub' }, 'Toma una foto de tu plan y la app anota tus turnos.')),
      banners(ctx, state, 'escanear'),
      h('div', { class: 'card scan-hero' },
        h('div', { class: 'scan-illus', 'aria-hidden': 'true' }, scanArt()),
        h('ul', { class: 'tips' },
          tip('Foto recta, con buena luz y sin reflejos'),
          tip('Que se vea el mes arriba (p. ej. «Oktober 2026»)'),
          tip('Puedes tomar varias fotos del mismo mes'),
          tip('También sirve la hoja impresa del PC'))),
      h('div', { class: 'scan-actions' },
        fileButton(camInput, 'Tomar foto', 'camera', 'btn-primary btn-lg btn-block'),
        fileButton(pickInput, 'Elegir fotos', 'photos', 'btn-secondary btn-lg btn-block'),
        h('button', { class: 'btn btn-plain btn-block', type: 'button', 'data-testid': 'scan-manual', on: { click: () => startManual() } }, icon('pencil'), 'Escribir el plan a mano')),
      scans.length ? h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, 'Últimos escaneos'),
        h('ul', { class: 'card list-card' }, scans.map((s) => h('li', { class: 'list-row' },
          h('span', { class: 'row-icon', 'aria-hidden': 'true' }, s.layout === 'pc-grid' ? '🖥️' : '📱'),
          h('span', { class: 'row-main' },
            h('span', { class: 'row-title' }, s.month && s.year ? cap(formatMonth(s.year, s.month)) : 'Mes desconocido'),
            h('span', { class: 'row-sub' }, `${plural(s.daysFound, 'día leído', 'días leídos')} · ${ago(s.at, ctx.now())}`)))))) : null,
    );
  }

  function tip(text) {
    return h('li', {}, h('span', { class: 'tip-check', 'aria-hidden': 'true' }, icon('check')), h('span', {}, text));
  }

  // ---------- Procesando ----------
  function renderProcessing() {
    const n = photos.length;
    const done = photos.filter((p) => p.status === 'done' || p.status === 'error').length;
    setChildren(el,
      h('header', { class: 'page-head' },
        h('h1', { class: 'large-title' }, 'Leyendo…'),
        h('p', { class: 'page-sub', 'aria-live': 'polite' }, n > 1 ? `Foto ${Math.min(done + 1, n)} de ${n}. Esto tarda unos segundos.` : 'Esto tarda unos segundos. No cierres la app.')),
      h('ul', { class: 'photo-list' }, photos.map((p, i) => h('li', { class: ['photo-item', `st-${p.status}`] },
        h('img', { class: 'photo-thumb', src: p.url, alt: `Foto ${i + 1}` }),
        h('div', { class: 'photo-info' },
          h('p', { class: 'photo-title' }, `Foto ${i + 1}`),
          h('p', { class: 'photo-label' }, p.status === 'done' ? (p.found ? `${plural(p.found, 'día encontrado', 'días encontrados')}` : 'No se encontraron días') : p.status === 'error' ? 'No se pudo leer' : (p.label || 'En espera…')),
          h('div', { class: 'progress progress-sm', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(p.progress * 100)), 'aria-label': `Progreso de la foto ${i + 1}` },
            h('div', { class: 'progress-fill', style: { width: `${Math.round(p.progress * 100)}%` } }))),
        h('span', { class: 'photo-state', 'aria-hidden': 'true' }, p.status === 'done' ? icon('check') : p.status === 'working' ? h('span', { class: 'spinner' }) : null)))),
      h('button', { class: 'btn btn-secondary btn-block', type: 'button', on: { click: cancelProcessing } }, 'Cancelar'),
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
    Promise.resolve().then(() => recognizer?.dispose?.()).catch(() => {});
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
    clearDraft();
    cleanupPhotos();
    lastFiles = files;
    review = null;
    photos = files.map((file) => ({ file, url: URL.createObjectURL(file), progress: 0, label: '', status: 'waiting', found: 0 }));
    mode = 'processing';
    render(store.get());
    window.scrollTo(0, 0);
    try {
      await loadTesseract();
      recognizer = await import('../recognize/index.js');
    } catch (e) {
      console.warn(e?.message || e);
      if (id !== runId) return;
      showOcrFail('No se pudo abrir el lector de fotos. La primera vez hace falta internet.');
      return;
    }
    const state = store.get();
    const codeKinds = Object.fromEntries(Object.entries(state.codes || {}).map(([c, d]) => [c, d.kind]));
    const results = [];
    for (let i = 0; i < photos.length; i++) {
      if (id !== runId) return;
      const p = photos[i];
      p.status = 'working'; p.label = 'Preparando la foto…';
      renderProcessing();
      let res;
      try {
        res = await recognizer.recognize(p.file, {
          tesseract: tesseractPaths(),
          knownCodes: Object.keys(state.codes || {}),
          codeKinds,
          employeeName: EMPLOYEE,
          onProgress: (f, label) => {
            if (id !== runId) return;
            p.progress = Math.max(p.progress, Math.min(1, Number(f) || 0));
            if (label) p.label = label;
            updatePhoto(i);
          },
        });
      } catch (e) {
        console.warn(e);
        res = null;
      }
      if (id !== runId) return;
      if (!res || typeof res !== 'object') {
        p.status = 'error';
        res = { layout: 'unknown', month: null, year: null, days: [], warnings: [`No pude leer la foto ${i + 1}.`] };
      } else {
        p.status = 'done';
      }
      p.found = res.days?.length || 0;
      p.progress = 1;
      results.push(res);
      renderProcessing();
    }
    // Libera la memoria del lector (en iPhone es importante)
    Promise.resolve().then(() => recognizer?.dispose?.()).catch(() => {});
    if (id !== runId) return;
    const anyDays = results.some((r) => r.days?.length);
    if (!anyDays && results.some((r) => r.ocrFailed)) { showOcrFail(); return; }
    const merged = results.length === 1 ? { ...results[0], warnings: [...(results[0].warnings || [])] } : mergeScans(results);
    const unread = unreadDays(results, merged);
    if (!merged.days?.length) { showFallback(merged, merged.warnings); return; }
    showReview(merged, { source: 'scan', unread });
  }

  // ---------- El lector no arrancó (sin internet la primera vez) ----------
  let ocrText = '';
  function showOcrFail(text) {
    ocrText = text || 'Comprueba que tienes internet (la primera vez hace falta) y toca «Reintentar».';
    mode = 'ocrfail';
    render(store.get());
    window.scrollTo(0, 0);
  }

  async function retryOcr() {
    if (!lastFiles?.length) { cancelReview(); return; }
    try { await recognizer?.dispose?.(); } catch { /* nada */ }
    const files = lastFiles;
    process(files);
  }

  function renderOcrFail() {
    setChildren(el,
      h('div', { class: 'fallback', 'data-testid': 'ocr-failed' },
        h('div', { class: 'fallback-emoji', 'aria-hidden': 'true' }, '📡'),
        h('h1', { class: 'fallback-title' }, 'No se pudo iniciar el lector de texto'),
        h('p', { class: 'fallback-text' }, ocrText),
        photoStrip(),
        h('div', { class: 'fallback-more' },
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'ocr-retry', on: { click: retryOcr } }, icon('refresh'), 'Reintentar'),
          h('button', { class: 'btn btn-secondary btn-block', type: 'button', on: { click: () => showFallback(null, []) } }, icon('pencil'), 'Escribir el plan a mano'),
          h('button', { class: 'btn btn-plain btn-block', type: 'button', on: { click: cancelReview } }, 'Cancelar'))),
    );
  }

  // ---------- Plan B: a mano ----------
  function showFallback(result, warnings = []) {
    const now = ctx.now();
    const month = result?.month || now.getMonth() + 1;
    review = {
      layout: result?.layout || 'unknown',
      year: result?.year || (result?.month ? guessYear(result.month, now) : now.getFullYear()), month,
      monthKnown: Boolean(result?.month), yearKnown: Boolean(result?.year),
      rows: new Map(), warnings: [...(warnings || [])], unread: [], manual: true, showAll: true, source: 'scan',
    };
    mode = 'fallback';
    render(store.get());
    window.scrollTo(0, 0);
  }

  function startManual() {
    clearDraft();
    cleanupPhotos();
    const now = ctx.now();
    review = {
      layout: 'unknown', year: now.getFullYear(), month: now.getMonth() + 1, monthKnown: true, yearKnown: true,
      rows: new Map(), warnings: [], unread: [], manual: true, showAll: true, source: 'manual',
    };
    mode = 'review';
    render(store.get());
    window.scrollTo(0, 0);
  }

  function monthPicker(onChange) {
    // Elegir a mano el mes o el año confirma los dos (se ven juntos)
    const mSel = h('select', { class: 'input select', 'aria-label': 'Mes', on: { change: () => { review.month = +mSel.value; review.monthKnown = review.yearKnown = true; onChange(); } } }, monthOptions(review.month));
    const ySel = h('select', { class: 'input select', 'aria-label': 'Año', on: { change: () => { review.year = +ySel.value; review.monthKnown = review.yearKnown = true; onChange(); } } }, yearOptions(review.year, ctx.now().getFullYear()));
    return h('div', { class: 'month-picker' }, mSel, ySel);
  }

  // Foto en grande dentro de la app (un enlace blob: no se abre en la app instalada)
  function showPhoto(i = 0) {
    const p = photos[i];
    if (!p) return;
    const img = h('img', { src: p.url, alt: `Foto ${i + 1} del plan`, class: 'photo-full' });
    const box = h('div', { class: 'photo-view', on: { click: () => box.classList.toggle('zoomed') } }, img);
    openSheet({
      title: photos.length > 1 ? `Foto ${i + 1} de ${photos.length}` : 'Tu foto',
      subtitle: 'Toca la foto para ampliarla',
      body: h('div', {}, box,
        photos.length > 1 ? h('div', { class: 'photo-strip photo-strip-center' }, photos.map((q, j) => j === i ? null
          : h('button', { class: 'photo-strip-item', type: 'button', 'aria-label': `Ver la foto ${j + 1}`, on: { click: () => showPhoto(j) } }, h('img', { src: q.url, alt: '' })))) : null),
      className: 'sheet-photo',
    });
  }

  function photoStrip() {
    if (!photos.length) return null;
    return h('div', { class: 'photo-strip' }, photos.map((p, i) => h('button', {
      class: 'photo-strip-item', type: 'button', 'aria-label': `Ver la foto ${i + 1} en grande`, on: { click: () => showPhoto(i) },
    }, h('img', { src: p.url, alt: '' }))));
  }

  function renderFallback() {
    const warn = (review.warnings || []).filter((w) => !/No se pudo leer la foto automáticamente|^No pude leer ningún día/i.test(w));
    setChildren(el,
      h('div', { class: 'fallback' },
        h('div', { class: 'fallback-emoji', 'aria-hidden': 'true' }, '🤔'),
        h('h1', { class: 'fallback-title' }, 'No pude leer la foto'),
        h('p', { class: 'fallback-text' }, 'No pasa nada: elige el mes y completa tus turnos a mano mirando la foto.'),
        ...warn.map((w) => h('div', { class: 'notice notice-info small' }, icon('info'), h('p', {}, w))),
        photoStrip(),
        h('div', { class: 'card fallback-card' },
          h('p', { class: 'label' }, '¿De qué mes es el plan?'),
          monthPicker(() => render(store.get())),
          h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', 'data-testid': 'fallback-manual', on: { click: () => { mode = 'review'; render(store.get()); window.scrollTo(0, 0); } } }, icon('pencil'), 'Completar a mano')),
        h('div', { class: 'fallback-more' },
          fileButton(camInput, 'Probar con otra foto', 'camera', 'btn-secondary btn-block'),
          h('button', { class: 'btn btn-plain btn-block', type: 'button', on: { click: cancelReview } }, 'Cancelar'))),
    );
  }

  // ---------- Revisión ----------
  // result: RecognizeResult (o uno inyectado en tests). opts.unread: días vistos sin leer
  function showReview(result, { source = 'scan', unread } = {}) {
    const now = ctx.now();
    const rows = new Map();
    for (const d of result?.days || []) {
      const day = Number(d.day);
      if (!Number.isInteger(day) || day < 1 || day > 31 || !Array.isArray(d.codes)) continue;
      const conf = Number.isFinite(Number(d.confidence)) ? Number(d.confidence) : 1;
      rows.set(day, {
        day, codes: d.codes.filter((c) => typeof c === 'string'), confidence: conf, conflict: Boolean(d.conflict),
        alternatives: Array.isArray(d.alternatives) ? d.alternatives : [], fromScan: true, edited: false,
        accepted: null, // null → por defecto según el tipo
      });
    }
    const month = Number.isInteger(result?.month) && result.month >= 1 && result.month <= 12 ? result.month : null;
    const year = Number.isInteger(result?.year) ? result.year : null;
    review = {
      layout: result?.layout || 'unknown',
      year: year || (month ? guessYear(month, now) : now.getFullYear()), month: month || now.getMonth() + 1,
      monthKnown: Boolean(month), yearKnown: Boolean(year),
      rows, warnings: [...(result?.warnings || [])].filter((w) => typeof w === 'string'),
      unread: unread || unreadDays([result], result), manual: false, showAll: false, source,
    };
    clearDraft();
    mode = 'review';
    render(store.get());
    window.scrollTo(0, 0);
    return true;
  }

  function cancelReview() {
    review = null;
    clearDraft();
    cleanupPhotos();
    mode = 'home';
    render(store.get());
    window.scrollTo(0, 0);
  }

  // Filas con clave, diff y estado actuales
  function computeRows(state) {
    const n = daysInMonth(review.year, review.month);
    const unread = new Set(review.unread || []);
    const list = review.showAll || review.manual
      ? Array.from({ length: n }, (_, i) => i + 1)
      : [...new Set([...review.rows.keys(), ...unread])].sort((a, b) => a - b);
    const days = [];
    for (const day of list) {
      if (day > n) continue;
      const key = makeKey(review.year, review.month, day);
      const saved = state.days[key];
      const r = review.rows.get(day) || {
        day, codes: [...(saved?.codes || [])], stored: Boolean(saved), confidence: 1, fromScan: false, edited: false, accepted: null, alternatives: [],
      };
      days.push({ ...r, key, unread: unread.has(day) && !r.fromScan && !r.edited });
    }
    const diffs = diffScan(state, days.map((d) => ({ key: d.key, codes: d.codes, confidence: d.confidence })));
    return days.map((d, i) => {
      const df = diffs[i];
      const doubtful = !d.edited && d.fromScan && (d.confidence < LOW_CONFIDENCE || d.conflict);
      const present = d.fromScan || d.edited;
      let accepted = d.accepted;
      if (accepted === null) accepted = present && df.type !== 'same' && !doubtful && !(review.manual && !d.edited);
      if (!present || df.type === 'same') accepted = false;
      // Pendiente: se vio y no se leyó, o es dudoso y no está marcado
      const pending = (d.unread && !present) || (present && doubtful && !accepted && df.type !== 'same');
      return { ...d, type: df.type, before: df.before, after: df.after, doubtful, present, accepted, pending };
    });
  }

  function applyEdit(r, codes) {
    if (!review) return;
    const prev = review.rows.get(r.day) || { day: r.day, confidence: 1, fromScan: false, alternatives: [] };
    const saved = store.get().days[r.key];
    // Nada elegido en un día sin plan (ni leído): sigue como estaba
    if (!codes.length && !prev.fromScan && !saved) { if (!r.unread) review.rows.delete(r.day); return; }
    // Sin cambios en un día guardado que no se leyó: igual (salvo si estaba «sin leer»: queda comprobado)
    if (!r.unread && !prev.fromScan && !prev.edited && saved && sameCodes(codes, saved.codes)) return;
    review.rows.set(r.day, { ...prev, codes, edited: true, accepted: true, confidence: 1, conflict: false });
  }

  function editRow(r) {
    if (!review) return;
    const list = computeRows(store.get());
    const idx = list.findIndex((x) => x.day === r.day);
    const next = review.manual && idx >= 0 ? list[idx + 1] : null;
    ctx.openDay(r.key, {
      draft: { codes: r.codes },
      confirmLabel: 'Listo',
      onDone: (codes) => { applyEdit(r, codes); render(store.get()); },
      onNext: next ? (codes) => {
        applyEdit(r, codes);
        render(store.get());
        setTimeout(() => { if (review) editRow(computeRows(store.get()).find((x) => x.day === next.day) || next); }, 60);
      } : null,
      nextLabel: next ? `Día ${next.day} ›` : null,
      onPhoto: photos.length ? () => showPhoto(0) : null,
    });
  }

  function statusPill(r) {
    if (!r.present) {
      if (r.unread) return h('span', { class: 'pill pill-alert' }, 'No se pudo leer');
      if (r.stored) return review.manual ? null : h('span', { class: 'pill pill-muted' }, 'Ya guardado');
      return review.manual ? null : h('span', { class: 'pill pill-muted' }, 'No leído');
    }
    if (r.doubtful && r.type !== 'same') return h('span', { class: 'pill pill-alert' }, 'Revisar');
    if (r.type === 'new') return h('span', { class: 'pill pill-ok' }, 'Nuevo');
    if (r.type === 'changed') return h('span', { class: 'pill pill-warn' }, `Cambia: ${codesText(r.before)} → ${codesText(r.after)}`);
    return h('span', { class: 'pill pill-muted' }, 'Sin cambios');
  }

  function altText(state, alts) {
    return alts.map((a) => {
      const list = Array.isArray(a) ? a : [a];
      const words = list.map((c) => KIND_WORDS[getCode(state, c).kind]).filter(Boolean);
      return `${codesText(list)}${words.length ? ` (${words.join(', ')})` : ''}`;
    }).join(' / ');
  }

  function dayNames(rows) {
    return listText(rows.map((r) => `${weekdayShort(r.key)} ${r.day}`));
  }

  function renderReview(state) {
    const rows = computeRows(state);
    const present = rows.filter((r) => r.present);
    const counts = {
      total: rows.filter((r) => r.fromScan).length,
      new: present.filter((r) => r.type === 'new' && !r.doubtful).length,
      changed: present.filter((r) => r.type === 'changed' && !r.doubtful).length,
      doubtful: rows.filter((r) => r.present && r.doubtful && r.type !== 'same').length,
      unread: rows.filter((r) => r.unread && !r.present).length,
    };
    const accepted = rows.filter((r) => r.accepted);
    const n = accepted.length;
    const upToDate = !review.manual && counts.total > 0 && n === 0 && !counts.doubtful && !counts.unread;
    const usedCodes = [...new Set(present.flatMap((r) => r.codes))];
    const newCodes = usedCodes.filter((c) => !state.codes[c]);
    const unconfirmed = usedCodes.filter((c) => state.codes[c] && state.codes[c].confirmed === false && ['shift', 'event', 'other'].includes(state.codes[c].kind));
    const monthWarn = (w) => /\bmes\b|\baño\b/i.test(w);
    const shownWarnings = (review.warnings || []).filter((w) => !UNREAD_RE.test(w) && !/^Código nuevo/i.test(w) && !monthWarn(w)
      && !/No se pudo leer la foto automáticamente/i.test(w));
    const needsMonth = !review.manual && !review.monthKnown;
    const needsYear = !review.manual && review.monthKnown && !review.yearKnown;

    const header = h('header', { class: 'page-head review-head' },
      h('div', { class: 'review-top' },
        h('h1', { class: 'large-title' }, review.manual ? 'Plan a mano' : 'Revisa el plan'),
        h('button', { class: 'btn btn-plain btn-sm review-cancel', type: 'button', 'data-testid': 'review-cancel', on: { click: askCancel } }, 'Cancelar')),
      h('p', { class: 'page-sub' }, !review.manual
        ? 'Comprueba que todo está bien. Toca un día para corregirlo.'
        : rows.some((r) => state.days[r.key])
          ? 'Aquí ves lo que ya tienes guardado. Toca un día para elegir o cambiar su turno.'
          : 'Toca cada día y elige su turno. Al final, toca «Guardar».'));

    const notices = [];
    if (upToDate) {
      notices.push(h('div', { class: 'notice notice-ok', 'data-testid': 'up-to-date' }, icon('check'), h('p', {},
        h('b', {}, 'Tu plan ya estaba al día. '), 'No hay nada que cambiar.')));
    }

    const monthCard = h('div', { class: ['card', 'review-month', (needsMonth || needsYear) && 'needs-month'], 'data-testid': 'review-month' },
      h('div', { class: 'review-month-row' },
        h('span', { class: 'label' }, needsMonth ? 'No se vio el mes en la foto: elígelo' : needsYear ? 'Comprueba el año del plan' : 'Mes del plan'),
        monthPicker(() => render(store.get()))),
      !review.manual ? h('p', { class: 'review-counts' },
        h('span', {}, h('b', {}, String(counts.total)), counts.total === 1 ? ' día leído' : ' días leídos'),
        counts.new ? h('span', { class: 'rc rc-new' }, plural(counts.new, 'nuevo', 'nuevos')) : null,
        counts.changed ? h('span', { class: 'rc rc-changed' }, `${counts.changed} ${counts.changed === 1 ? 'cambia' : 'cambian'}`) : null,
        counts.doubtful ? h('span', { class: 'rc rc-doubt' }, `${counts.doubtful} por revisar`) : null,
        counts.unread ? h('span', { class: 'rc rc-doubt' }, `${counts.unread} sin leer`) : null) : null);

    for (const w of shownWarnings) notices.push(h('div', { class: 'notice notice-info' }, icon('info'), h('p', {}, w)));
    if (counts.unread) {
      const list = rows.filter((r) => r.unread && !r.present);
      notices.push(h('div', { class: 'notice notice-alert', 'data-testid': 'unread-notice' }, icon('help'), h('p', {},
        h('b', {}, counts.unread === 1 ? `No se pudo leer 1 día (${dayNames(list)}). ` : `No se pudieron leer ${counts.unread} días (${dayNames(list)}). `),
        counts.unread === 1 ? 'Tócalo para completarlo a mano.' : 'Tócalos para completarlos a mano.')));
    }
    if (counts.doubtful) {
      notices.push(h('div', { class: 'notice notice-alert' }, icon('help'), h('p', {},
        h('b', {}, counts.doubtful === 1 ? 'La app no está segura de 1 día (en rojo). ' : `La app no está segura de ${counts.doubtful} días (en rojo). `),
        counts.doubtful === 1 ? 'Tócalo para comprobarlo, o marca su círculo ○ para guardarlo así.' : 'Tócalos para comprobarlos, o marca su círculo ○ para guardarlos así.')));
    }
    for (const c of newCodes) {
      const g = getCode(state, c);
      notices.push(h('div', { class: 'notice notice-warn notice-action' }, icon('warning'), h('div', { class: 'notice-main' },
        h('p', {}, h('b', {}, `Código nuevo: ${c}. `),
          g.kind === 'shift' && g.start ? `La app supone ${g.start}–${g.end} (como ${c[0]}1).`
            : g.kind === 'place' ? 'La app lo guarda como un lugar.' : 'La app no sabe qué es.'),
        g.kind !== 'place' ? h('button', { class: 'btn btn-tinted btn-sm', type: 'button', on: { click: () => ctx.openCode(c, { onSaved: () => render(store.get()) }) } },
          g.kind === 'shift' ? `Poner el horario de ${c}` : `Explicar qué es ${c}`) : null)));
    }
    for (const c of unconfirmed) {
      const g = state.codes[c];
      notices.push(h('div', { class: 'notice notice-warn notice-action' }, icon('warning'), h('div', { class: 'notice-main' },
        h('p', {}, `El horario de ${c} es supuesto${g.start && g.end ? ` (${g.start}–${g.end})` : ''}.`),
        h('button', { class: 'btn btn-tinted btn-sm', type: 'button', on: { click: () => ctx.openCode(c, { onSaved: () => render(store.get()) }) } }, `Confirmar ${c}`))));
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
      const showAlt = r.conflict && r.alternatives?.length && !r.edited;
      // Horario especial guardado para ese día (se mantiene si el código sigue)
      const specials = state.days[r.key] ? r.codes.map((c) => ({ c, t: dayTimes(state, r.key, c) })).filter((x) => x.t.special) : [];
      return h('li', {
        class: ['review-row', `t-${r.present ? r.type : 'none'}`, r.doubtful && r.type !== 'same' && 'doubtful', r.unread && !r.present && 'unread',
          !r.accepted && r.present && 'unchecked', review.manual && 'manual'],
        dataset: { day: String(r.day) },
      },
      review.manual ? null : h('label', { class: 'review-check' }, check),
      h('button', { class: 'review-main', type: 'button', 'aria-label': `Editar el día ${r.day}`, on: { click: () => editRow(r) } },
        h('span', { class: 'd-num small' }, h('span', { class: 'd-day' }, String(r.day).padStart(2, '0')), h('span', { class: 'd-dow' }, weekdayShort(r.key))),
        h('span', { class: 'review-codes' },
          r.codes.length ? badgeRow(state, r.codes) : h('span', { class: 'faint' }, r.present ? 'Vacío' : r.unread ? 'Toca para completarlo' : review.manual ? 'Tocar para elegir' : '—'),
          h('span', { class: 'review-status' }, statusPill(r),
            specials.map((x) => h('span', { class: 'review-special' },
              h('span', { class: 'review-special-time' }, `${x.c} ${rangeText(x.t)}`),
              h('span', { class: 'pill pill-special', 'data-testid': 'special-pill' }, 'horario especial'))),
            showAlt ? h('span', { class: 'alt-hint' }, `En la otra foto pone: ${altText(state, r.alternatives)}`) : null)),
        h('span', { class: ['row-chevron', !r.present && !r.stored && 'row-add'], 'aria-hidden': 'true' }, icon(r.present || r.stored ? 'pencil' : 'plus'))));
    }));

    const showAllBtn = !review.manual ? h('button', {
      class: 'btn btn-plain btn-block', type: 'button',
      on: { click: () => { review.showAll = !review.showAll; render(store.get()); } },
    }, review.showAll ? 'Mostrar solo los días leídos' : `Mostrar todos los días de ${monthName(review.month)}`) : null;

    const saveBtn = upToDate
      ? h('button', { class: 'btn btn-primary btn-lg grow', type: 'button', 'data-testid': 'review-save', on: { click: finishUpToDate } }, icon('check'), 'Listo')
      : h('button', {
        class: 'btn btn-primary btn-lg grow', type: 'button', disabled: n === 0, 'data-testid': 'review-save',
        on: { click: () => save() },
      }, n === 0 ? (review.manual ? 'Toca un día para empezar' : 'Nada marcado para guardar') : `Guardar ${plural(n, 'día', 'días')}`);

    setChildren(el,
      header,
      banners(ctx, state, 'revision'),
      ...notices.splice(0, upToDate ? 1 : 0),
      photos.length ? h('details', { class: 'card photo-ref', open: review.manual, dataset: { fkey: 'photo-ref' } },
        h('summary', {}, icon('photos'), h('span', {}, photos.length > 1 ? `Tus fotos (${photos.length})` : 'Tu foto'), h('span', { class: 'photo-ref-hint' }, 'toca para ver')), photoStrip()) : null,
      monthCard,
      ...notices,
      !review.manual && !upToDate && rows.some((r) => r.present) ? h('p', { class: 'review-legend' }, h('span', { class: 'legend-check', 'aria-hidden': 'true' }), 'Marcado = ese día se guarda') : null,
      list,
      showAllBtn,
      h('div', { class: 'review-bar' }, saveBtn),
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

  // Todo coincide con lo guardado: se anota el escaneo y se va al calendario
  function finishUpToDate() {
    const { year, month, layout } = review;
    const rows = computeRows(store.get());
    store.set((s) => applyScan(s, {
      layout, year, month, warnings: [],
      days: rows.filter((r) => r.present).map((r) => ({ day: r.day, codes: r.codes, confidence: r.confidence })),
    }, { acceptedKeys: [], year, month }));
    ctx.toast('Tu plan ya estaba al día', { type: 'ok' });
    review = null;
    clearDraft();
    cleanupPhotos();
    mode = 'home';
    render(store.get());
    ctx.go('calendario', { year, month });
  }

  async function save() {
    if (!review) return;
    const rows = computeRows(store.get());
    const accepted = rows.filter((r) => r.accepted);
    if (!accepted.length) return;
    const skipped = rows.filter((r) => r.pending);
    if (skipped.length) {
      const names = dayNames(skipped);
      const ok = await confirmDialog({
        icon: '🔎',
        title: skipped.length === 1 ? 'Falta 1 día por comprobar' : `Faltan ${skipped.length} días por comprobar`,
        text: `${cap(names)}: ${skipped.length === 1 ? 'no se guardará' : 'no se guardarán'}. Sin plan no hay avisos esos días.`,
        ok: 'Guardar sin ellos', cancel: 'Revisar',
      });
      if (!ok) {
        const first = el.querySelector(`.review-row[data-day="${skipped[0].day}"]`);
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      if (!review) return;
    }
    const { year, month, manual, layout } = review;
    const keys = accepted.map((r) => r.key);
    if (manual) {
      // Escrito a mano: días con origen 'manual' y sin registrar un escaneo
      store.set((s) => accepted.reduce((st, r) => setDay(st, r.key, r.codes, { source: 'manual' }), s));
    } else {
      const result = {
        layout, year, month, warnings: [],
        // Todos los días leídos (para el historial); acceptedKeys decide cuáles se guardan
        days: rows.filter((r) => r.present).map((r) => ({ day: r.day, codes: r.codes, confidence: r.edited ? 1 : r.confidence })),
      };
      store.set((s) => applyScan(s, result, { acceptedKeys: keys, year, month }));
    }
    const n = accepted.length;
    const okSave = store.saveOk?.() !== false;
    review = null;
    clearDraft();
    cleanupPhotos();
    mode = 'home';
    render(store.get());
    ctx.go('calendario', { key: keys.includes(toKey(ctx.now())) ? toKey(ctx.now()) : keys[0] });
    if (!okSave) {
      saveFailedToast(ctx);
      return;
    }
    const first = skipped[0];
    ctx.toast(`Guardados ${plural(n, 'día', 'días')} de ${monthName(month)}${skipped.length ? `. Sin guardar: ${dayNames(skipped)}` : ''}`, {
      type: 'ok',
      duration: skipped.length ? 9000 : undefined,
      action: first ? { label: 'Completar', run: () => ctx.openDay(first.key) } : undefined,
    });
  }

  function render(state) {
    if (mode === 'processing') renderProcessing();
    else if (mode === 'ocrfail') renderOcrFail();
    else if (mode === 'review' && review) renderReview(state);
    else if (mode === 'fallback' && review) renderFallback();
    else { mode = 'home'; renderHome(state); }
    if (mode === 'review' || mode === 'fallback') saveDraft();
    ctx.updateChrome?.();
  }

  return {
    el,
    render,
    showReview,
    // opts.manual: abrir directamente «Escribir el plan a mano»
    onShow(opts) {
      if (opts?.manual && mode === 'home') { startManual(); return true; }
      return mode !== 'home';
    },
    draftInfo: () => (review && draftAt && (mode === 'review' || mode === 'fallback') ? { at: draftAt } : null),
    get mode() { return mode; },
    // Fotos en memoria (no se guardan en el borrador: se perderían al recargar)
    get photoCount() { return photos.length; },
    // Borrar todos los datos: también la revisión a medias que hay en memoria
    reset() {
      runId++;
      Promise.resolve().then(() => recognizer?.dispose?.()).catch(() => {});
      review = null;
      clearDraft();
      cleanupPhotos();
      mode = 'home';
      render(store.get());
    },
  };
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
