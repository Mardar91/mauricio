// Reconocimiento de fotos del plan de turnos (contrato: SPEC §5).
// Conjunto de tres lectores que comparten un worker de Tesseract (ocr-pool.js):
//   phone-a ("color-first"): rápido; también reconoce la tabla del PC.
//   phone-b ("rectify-rows"): segunda lectura de la lista del móvil, solo si la de A parece incompleta.
//   pc      ("pc-grid"): tabla mensual impresa de euregon.
// Días de A y B: unión; si los dos leen el mismo día distinto, ese día se omite (mejor un hueco que un error).
// Diseño y medidas: test/lab/ensemble/NOTES.md.
import { defaultPaths, disposePool, prewarm, setPoolSize } from './ocr-pool.js';

const DEFAULT_CODES = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];

// B se ejecuta si A parece incompleto: avisos, sin mes/año o menos de minDaysA días (una foto muestra 10-11 filas).
// Fusión: un día que solo lee un lector (habiendo leído los dos) se descarta si el otro vio esa fila y la
// marcó como sospechosa (vetoWhy), si la vio sin poder leerla y la confianza es < contestedMinConf, o si
// su confianza es < soloMinConf. placeNeedsShift: un lugar (F51, S31…) sin turno ese día no es creíble (la
// insignia del turno se ha perdido: reflejo, dedo) → se omite. Valores elegidos con test/lab/ensemble/analyze.mjs.
export const RULES = { minDaysA: 11, soloMinConf: 0, contestedMinConf: 0.55, vetoWhy: [], placeNeedsShift: true };

const isShift = (c) => /^[FSNZ]\d$/.test(c);
const isPlace = (c) => /^[A-Z]\d\d$/.test(c);

const L_PHOTO = 'Leyendo la foto…';
const L_DAYS = 'Buscando los días…';
const L_SHIFTS = 'Leyendo los turnos…';
const L_CHECK = 'Comprobando…';

const mods = {};
// Carga perezosa de cada lector (B y la tabla del PC solo cuando hacen falta)
function load(name) {
  if (!mods[name]) {
    const p = name === 'a' ? import('./phone-a/recognize.js') : name === 'b' ? import('./phone-b/recognize.js') : import('./pc/recognize.js');
    mods[name] = p.catch((e) => { delete mods[name]; throw e; });
  }
  return mods[name];
}

const emptyResult = (warning) => ({ layout: 'unknown', month: null, year: null, days: [], warnings: [warning] });

export async function recognize(input, options = {}) {
  const opts = options || {};
  const prog = progressReporter(opts.onProgress);
  let img = null;
  try {
    prog(0, L_PHOTO);
    if (!globalThis.Tesseract || !globalThis.Tesseract.createWorker) {
      console.warn('[recognize] Tesseract no está cargado');
      return emptyResult('No se pudo abrir el lector de texto. Comprueba la conexión y vuelve a probar.');
    }
    if (opts.ocrWorkers) setPoolSize(opts.ocrWorkers);
    const tess = { ...defaultPaths() };
    if (opts.tesseract) for (const k of ['workerPath', 'corePath', 'langPath']) if (opts.tesseract[k]) tess[k] = String(opts.tesseract[k]);
    prewarm(tess); // el OCR arranca mientras se decodifica la foto
    try { img = await decodeInput(input); } catch (e) {
      console.warn('[recognize] imagen', e);
      return emptyResult('No pude abrir la imagen. Prueba con otra foto.');
    }
    prog(0.03, L_PHOTO);
    const known = [...new Set([...(Array.isArray(opts.knownCodes) ? opts.knownCodes : []), ...DEFAULT_CODES])];
    const sub = (from, to, label) => ({
      tesseract: tess, knownCodes: known, employeeName: opts.employeeName, debug: !!opts.debug, now: opts.now,
      onProgress: (f, l) => { const x = Math.min(1, Math.max(0, Number(f) || 0)); prog(from + (to - from) * x, label(x, l)); },
    });
    const run = async (name, o) => {
      try {
        const m = await load(name);
        const r = await m.recognize(img.src, o);
        return sanitize(r) || failed(name);
      } catch (e) {
        console.warn(`[recognize] lector ${name}`, e);
        return failed(name);
      }
    };
    const landscape = img.w > 1.1 * img.h;
    const dbg = opts.debug ? { ran: [] } : null;

    // 1) Lector A
    const a = await run('a', sub(0.03, 0.55, stageLabel));
    if (dbg) dbg.ran.push('a');
    // 2) ¿Tabla del PC?
    let pcTried = false;
    if (a.layout === 'pc-grid' || (!a.days.length && landscape)) {
      pcTried = true;
      const p = await run('pc', sub(0.55, 0.97, stageLabel));
      if (dbg) dbg.ran.push('pc');
      if (p.layout === 'pc-grid') return finish(p, prog, dbg, { a, pc: p });
    }
    // 3) Lector B si A parece incompleto
    const mode = opts.phoneB || 'auto';
    let b = null;
    if (mode === 'always' || (mode !== 'never' && !a.ocrFailed && looksIncomplete(a))) {
      b = await run('b', sub(pcTried ? 0.75 : 0.55, 0.97, () => L_CHECK));
      if (dbg) dbg.ran.push('b');
    }
    prog(0.97, L_CHECK);
    const res = mergePhone(a, b, known);
    // 4) Último recurso: ningún día → ¿tabla del PC? (si no hay tabla, este lector termina en < 0,3 s)
    if (!res.days.length && !pcTried && !a.ocrFailed) {
      const p = await run('pc', sub(0.97, 0.99, () => L_CHECK));
      if (dbg) dbg.ran.push('pc');
      if (p.layout === 'pc-grid') return finish(p, prog, dbg, { a, b, pc: p });
    }
    return finish(res, prog, dbg, { a, b });
  } catch (e) {
    console.warn('[recognize]', e);
    return emptyResult('Algo falló al leer la foto. Prueba otra vez o rellena el plan a mano.');
  } finally {
    if (img) img.release();
  }
}

// Termina los workers de Tesseract (la UI lo llama tras cada tanda de fotos: libera memoria en iPhone)
export async function dispose() {
  try { await disposePool(); } catch (e) { console.warn('[recognize] dispose', e); }
}

// ---------- decisión ----------

// ¿Merece la pena una segunda lectura con B?
export function looksIncomplete(a, rules = RULES) {
  if (a.layout !== 'phone-list') return true;
  if (a.month == null || a.year == null) return true;
  if (a.failed || (a.unread && a.unread.length)) return true;
  if (a.warnings.length) return true;
  return a.days.length < rules.minDaysA;
}

const sameCodes = (x, y) => [...new Set(x)].sort().join('|') === [...new Set(y)].sort().join('|');

// Une los resultados de A y B (B puede ser null)
export function mergePhone(a, b, known = DEFAULT_CODES, rules = RULES) {
  const warnings = [];
  const parts = b ? [a, b] : [a];
  const pick = (k) => {
    const vals = parts.map((r) => r[k]).filter((v) => v != null);
    if (!vals.length) return { v: null, conflict: false };
    return vals.every((v) => v === vals[0]) ? { v: vals[0], conflict: false } : { v: null, conflict: true };
  };
  const m = pick('month'); const y = pick('year');
  const dateConflict = m.conflict || y.conflict;
  const byA = new Map(a.days.map((d) => [d.day, d]));
  const byB = new Map((b ? b.days : []).map((d) => [d.day, d]));
  const conflicts = []; const agreed = new Set();
  for (const [day, da] of byA) {
    const db = byB.get(day);
    if (!db) continue;
    if (sameCodes(da.codes, db.codes)) agreed.add(day); else conflicts.push(day);
  }
  // si las dos lecturas no cuadran (varios días distintos, o mes distinto) solo vale lo que coincide
  const strict = conflicts.length >= 2 || (dateConflict && (conflicts.length > 0 || (byA.size > 0 && byB.size > 0 && agreed.size === 0)));
  const days = []; const dropped = []; const vetoed = [];
  for (const day of [...new Set([...byA.keys(), ...byB.keys()])].sort((p, q) => p - q)) {
    if (conflicts.includes(day)) continue;
    const da = byA.get(day); const db = byB.get(day);
    const codes = (da || db).codes;
    if (rules.placeNeedsShift && codes.some(isPlace) && !codes.some(isShift)) { vetoed.push(day); continue; }
    if (strict && !agreed.has(day)) { dropped.push(day); continue; }
    if (da && db) { days.push({ day, codes: [...da.codes], confidence: Math.max(da.confidence, db.confidence) }); continue; }
    const d = da || db;
    if (b) {
      // solo lo lee uno de los dos: ¿qué vio el otro en esa fila?
      const other = da ? b : a;
      const why = other.unreadWhy && other.unreadWhy[day];
      const seen = why || (other.unread || []).includes(day);
      if ((why && rules.vetoWhy.includes(why)) || (seen && d.confidence < rules.contestedMinConf) || d.confidence < rules.soloMinConf) { vetoed.push(day); continue; }
    }
    days.push({ day, codes: [...d.codes], confidence: d.confidence });
  }
  const got = new Set(days.map((d) => d.day));
  const layout = days.length || parts.some((r) => r.layout === 'phone-list') ? 'phone-list'
    : (parts.find((r) => r.layout !== 'unknown') || a).layout;
  const res = { layout, month: m.v, year: y.v, days, warnings };

  // avisos (en español, sin repetir los de cada lector)
  if (m.conflict) warnings.push('No estoy seguro del mes: elígelo tú.');
  else if (m.v == null && layout === 'phone-list') warnings.push('No pude leer el mes con seguridad: elígelo a mano.');
  if (y.conflict) warnings.push('No estoy seguro del año: elígelo tú.');
  else if (y.v == null && m.v != null) warnings.push('No estoy seguro del año: confírmalo.');
  const unsure = [...conflicts, ...dropped].filter((d) => !got.has(d)).sort((p, q) => p - q);
  if (unsure.length) warnings.push(`${dayList(unsure, true)}: dos lecturas distintas de la foto, ${unsure.length === 1 ? 'revísalo' : 'revísalos'} a mano.`);
  const unread = [...new Set([...parts.flatMap((r) => r.unread || []), ...vetoed])].filter((d) => !got.has(d) && !unsure.includes(d)).sort((p, q) => p - q);
  if (unread.length) warnings.push(`No pude leer bien ${dayList(unread, false)}: ${unread.length === 1 ? 'revísalo' : 'revísalos'} a mano.`);
  const novel = [...new Set(days.flatMap((d) => d.codes).filter((c) => !known.includes(c)))];
  if (novel.length) warnings.push(`Código nuevo: ${novel.join(', ')} — confirma su horario.`);
  if (parts.some((r) => r.ocrFailed)) warnings.push('No se pudo iniciar el lector de texto. Comprueba la conexión y vuelve a probar.');
  if (!days.length) {
    // por qué no hay días: el aviso más útil de cada lector (sin los de "solo leo la lista del móvil")
    const why = parts.flatMap((r) => r.warnings).filter((w) => !/solo (leo|lee) la lista|lector de texto|el mes|del año|Código nuevo|No pude leer bien \d/.test(w));
    warnings.push(...why);
    if (!why.length && !unread.length && !unsure.length) warnings.push('No pude leer ningún día con seguridad.');
  }
  res.warnings = [...new Set(warnings)];
  return res;
}

// "el día 12" / "los días 3, 4 y 12" (con mayúscula si empieza la frase)
function dayList(days, start) {
  const art = days.length === 1 ? 'el día ' : 'los días ';
  const list = days.length === 1 ? String(days[0]) : `${days.slice(0, -1).join(', ')} y ${days[days.length - 1]}`;
  const s = art + list;
  return start ? s[0].toUpperCase() + s.slice(1) : s;
}

// Resultado de un lector → forma del contrato (o null si no tiene sentido)
export function sanitize(r) {
  if (!r || typeof r !== 'object') return null;
  const layout = ['phone-list', 'pc-grid', 'unknown'].includes(r.layout) ? r.layout : 'unknown';
  const month = Number.isInteger(r.month) && r.month >= 1 && r.month <= 12 ? r.month : null;
  const year = Number.isInteger(r.year) && r.year >= 2000 && r.year <= 2100 ? r.year : null;
  const seen = new Set(); const days = [];
  for (const d of Array.isArray(r.days) ? r.days : []) {
    const day = Number(d && d.day);
    if (!Number.isInteger(day) || day < 1 || day > 31 || seen.has(day) || !Array.isArray(d.codes)) continue;
    if (!d.codes.every((c) => typeof c === 'string' && c)) continue;
    seen.add(day);
    const c = Number(d.confidence);
    days.push({ day, codes: [...new Set(d.codes)], confidence: Number.isFinite(c) ? Math.round(Math.max(0, Math.min(1, c)) * 100) / 100 : 0.5 });
  }
  days.sort((p, q) => p.day - q.day);
  const warnings = (Array.isArray(r.warnings) ? r.warnings : []).filter((w) => typeof w === 'string' && w);
  const out = { layout, month, year, days, warnings };
  if (Array.isArray(r.unread)) out.unread = r.unread.filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  if (r.unreadWhy && typeof r.unreadWhy === 'object') out.unreadWhy = { ...r.unreadWhy };
  if (warnings.some((w) => /lector de texto/.test(w))) out.ocrFailed = true;
  if (r.debug) out.debug = r.debug;
  return out;
}

function failed(name) {
  return { layout: 'unknown', month: null, year: null, days: [], warnings: [], failed: name };
}

async function finish(res, prog, dbg, parts) {
  const out = { layout: res.layout, month: res.month, year: res.year, days: res.days, warnings: res.warnings };
  if (!out.days.length && !out.warnings.length) out.warnings.push('No pude leer ningún día con seguridad.');
  if (dbg) {
    const pick = (r) => (r ? { layout: r.layout, month: r.month, year: r.year, days: r.days.length, warnings: r.warnings } : null);
    const ov = (r) => (r && r.debug && r.debug.overlay) || null;
    out.debug = {
      overlay: ov(parts.pc) || ov(parts.a) || ov(parts.b) || undefined,
      overlayB: ov(parts.b) || undefined,
      ran: dbg.ran, a: pick(parts.a), b: pick(parts.b), pc: pick(parts.pc),
    };
  }
  prog(1, 'Listo');
  return out;
}

// Etiqueta según la fase del lector (fracción 0..1 de su propio progreso)
function stageLabel(f) {
  if (f < 0.1) return L_PHOTO;
  if (f < 0.6) return L_DAYS;
  if (f < 0.92) return L_SHIFTS;
  return L_CHECK;
}

// onProgress siempre creciente; nunca lanza
function progressReporter(cb) {
  let last = -1; let lastLabel = '';
  return (f, label) => {
    if (typeof cb !== 'function') return;
    const x = Math.round(Math.min(1, Math.max(0, f)) * 1000) / 1000;
    if (x < last || (x === last && label === lastLabel)) return;
    last = x; lastLabel = label;
    try { cb(x, label); } catch (e) { /* nada */ }
  };
}

// ---------- entrada ----------

// Decodifica la entrada UNA vez (las fotos de iPhone son de 12 MP) → { src, w, h, release }.
// Blob/File → <img> (respeta la orientación EXIF); sin DOM → createImageBitmap.
async function decodeInput(input) {
  if (!input) throw new Error('Sin imagen');
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    if (typeof document !== 'undefined' && typeof Image !== 'undefined') {
      const url = URL.createObjectURL(input);
      try {
        const im = new Image(); im.decoding = 'async'; im.src = url;
        if (im.decode) await im.decode(); else await new Promise((res, rej) => { im.onload = res; im.onerror = rej; });
        if (im.naturalWidth > 0) return { src: im, w: im.naturalWidth, h: im.naturalHeight, release: () => URL.revokeObjectURL(url) };
      } catch (e) { /* probamos createImageBitmap */ }
      URL.revokeObjectURL(url);
    }
    let bmp;
    try { bmp = await createImageBitmap(input, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(input); }
    return { src: bmp, w: bmp.width, h: bmp.height, release: () => { try { bmp.close(); } catch (e) { /* nada */ } } };
  }
  if (typeof HTMLImageElement !== 'undefined' && input instanceof HTMLImageElement) {
    if (!input.complete || !input.naturalWidth) {
      if (input.decode) await input.decode();
      else await new Promise((res, rej) => { input.onload = res; input.onerror = rej; });
    }
    if (!input.naturalWidth) throw new Error('Imagen vacía');
    return { src: input, w: input.naturalWidth, h: input.naturalHeight, release: () => {} };
  }
  if (input.width > 0 && input.height > 0) return { src: input, w: input.width, h: input.height, release: () => {} };
  throw new Error('Imagen no válida');
}
