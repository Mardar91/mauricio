// Reconocedor "rectify-rows": localiza la lista de la app Dienstplan, la rectifica (homografía),
// ajusta una rejilla uniforme de filas y lee cada fila (día + insignias) con OCR y color.
// Contrato: SPEC §5 — recognize(input, options) y dispose().
import { loadRGBA, toCanvas, tick } from './img.js';
import { downscale, toGray, warp, rotateQuarter } from './raster.js';
import { detectSeparators, selectFamily, buildQuad } from './lines.js';
import { homography, applyH, invertH, median } from './geom.js';
import { analyzeCanon, buildRows } from './canon.js';
import { analyzeRow, CLS_NAME, REF } from './rows.js';
import { renderCanon, binarizeDark, maskToImage, dropBorderBlobs, blackHatMask } from './crops.js';
import { readBadge, printSim } from './badgeocr.js';
import { ensureWorkers, disposeWorkers, ocr } from './ocr.js';
import { parseHeader, snapWeekday, bestOffset, daysInMonth, weekday, MONTHS, lev } from './calendar.js';
import { DEFAULT_KNOWN } from './codes.js';
import { drawOverlay, drawCrops } from './debug.js';
import { looksLikePcGrid } from './layout.js';

const NUM_WL = '0123456789';
const WD_WL = 'MoDiFrSa';
const HDR_WL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzäÄ0123456789 ';

function defaultPaths() {
  const base = new URL('../../../../docs/vendor/tesseract/', import.meta.url).href;
  return { workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang/best_int/', langPathLegacy: base + 'lang/legacy/' };
}

export async function recognize(input, options = {}) {
  const progress = (f, l) => { try { options.onProgress?.(f, l); } catch { /* nada */ } };
  const known = Array.isArray(options.knownCodes) && options.knownCodes.length ? options.knownCodes : DEFAULT_KNOWN;
  const result = { layout: 'unknown', month: null, year: null, days: [], warnings: [] };
  const dbg = {}; const notes = [];
  // contexto de la llamada (permite llamadas simultáneas)
  const cropLog = options.debug ? [] : null;
  const ctx = { known, ocrMask: makeOcrMask(cropLog) };
  // los workers de Tesseract arrancan mientras se procesa la imagen
  const workersReady = options.skipOcr ? Promise.resolve(null) : ensureWorkers(options.tesseract || defaultPaths(), 2).then(() => null, (e) => e);

  progress(0.02, 'Cargando la foto');
  const src0 = await loadRGBA(input, 2000);
  await tick();
  progress(0.1, 'Buscando la pantalla');
  // orientación: derecha primero; si no aparece la lista con su cabecera, se prueba girada
  let geo = null, an = null;
  for (const rot of [0, 1, 3, 2]) {
    const img = rot ? rotateQuarter(src0, rot) : src0;
    const g = findScreen(img);
    const a = g.canon ? analyzeCanon(g.canon, g.famJ) : null;
    const ok = a && a.jHb != null && a.grid;
    if (!geo || ok) { geo = g; an = a; ctx.src = img; dbg.rotation = rot * 90; }
    if (ok) break;
    await tick();
  }
  let rows = [];
  const finish = async () => {
    if (options.debug) {
      const rd = geo.canon ? rowsDebug(geo.canon, rows) : [];
      try { dbg.overlay = await drawOverlay({ ana: geo.ana, sep: geo.sep, fam: geo.fam, quad: geo.quad, canon: geo.canon, rows: rd, header: geo.headerDbg, notes }); } catch (e) { dbg.overlayError = String(e); }
      dbg.rows = rd.map((r) => r.label); dbg.notes = notes;
      if (cropLog && cropLog.length) try { dbg.crops = await drawCrops(cropLog); } catch (e) { dbg.cropsError = String(e); }
      result.debug = dbg;
    }
    progress(1, 'Listo');
    return result;
  };
  // sin lista del móvil: ¿es la tabla del PC? (este lector no la lee, solo la identifica)
  const noList = (msg, note) => {
    if (looksLikePcGrid(geo.ana)) { result.layout = 'pc-grid'; result.warnings.push('Parece la tabla del ordenador: este lector solo lee la lista del móvil.'); }
    else result.warnings.push(msg);
    notes.push(note); return finish();
  };
  if (!geo.canon) return noList('No encuentro la lista de turnos en la foto. Haz la foto recta y que se vea la pantalla entera.', 'sin pantalla');
  if (an.jHb == null || !an.grid) return noList('No reconozco la app de turnos (falta la cabecera naranja). ¿Es una foto de la lista del móvil?', 'sin cabecera o sin rejilla');

  progress(0.2, 'Enderezando la imagen');
  const { canon } = geo; ctx.canon = canon;
  canon.peaks = an.peaks.map((p) => ({ v: canon.v0 + p.j * canon.step }));
  geo.headerDbg = { vBottom: canon.v0 + an.jHb * canon.step, text: '' };
  dbg.grid = { P: +an.grid.P.toFixed(2), phase: +an.grid.phase.toFixed(1), jHb: an.jHb };
  const P = an.grid.P;
  rows = buildRows(an);
  for (let i = 0; i < rows.length; i++) { rows[i].an = analyzeRow(canon.img, an.valid, rows[i], P); if (i % 4 === 3) await tick(); }
  result.layout = 'phone-list';
  // control: en las filas con contenido debe verse la columna del número a la izquierda
  const withContent = rows.filter((r) => r.complete && r.an && !r.an.invalid && r.an.items.length && r.an.foreign < 0.04);
  const withText = withContent.filter((r) => r.an.text.some((t) => t.x0 < 0.12 * canon.img.w));
  if (withContent.length >= 3 && withText.length < 0.6 * withContent.length) {
    result.warnings.push('La foto está cortada o torcida: no veo los números de los días. Haz otra foto con la pantalla entera.');
    notes.push(`sin columna de días (${withText.length}/${withContent.length})`); return finish();
  }

  const wErr = await workersReady;
  if (wErr) { result.warnings.push('No se pudo iniciar el lector de texto (OCR).'); notes.push(String(wErr)); return finish(); }
  if (options.skipOcr) return finish();

  // 1) Mes y año de la cabecera
  progress(0.3, 'Leyendo el mes');
  const hdr = await readHeader(ctx, an, P);
  geo.headerDbg.text = hdr.text; geo.headerDbg.monthBox = hdr.box;
  dbg.header = { text: hdr.text, months: hdr.parsed?.months.slice(0, 3), year: hdr.parsed?.year };

  // 2) Número de día y día de la semana de cada fila candidata
  progress(0.45, 'Leyendo los días');
  const cand = rows.filter((r) => r.an && !r.an.invalid && r.an.text.length);
  await Promise.all(cand.map((r) => readDayText(ctx, r, P)));
  // filas para la asignación: completas y sin dedo encima
  const obsRows = cand.filter((r) => r.complete && r.an.foreign < 0.04 && r.num);
  const obs = obsRows.map((r) => ({ k: r.k, num: r.num, wd: r.wd, weekend: r.weekend }));
  // Mes: candidatos de la cabecera. Año: alrededor de la fecha del teléfono; en 3 años seguidos un mismo
  // mes nunca tiene los días de la semana colocados igual, así que los días leídos deciden el año.
  const nowY = (options.now ? new Date(options.now) : new Date()).getFullYear();
  const years = [nowY - 1, nowY, nowY + 1];
  const ocrY = hdr.parsed?.year;
  const mCands = hdr.parsed ? hdr.parsed.months.filter((m) => m.score >= 0.5).slice(0, 3) : [];
  let best = null; const all = [];
  for (const y of years) for (const mc of mCands) {
    const b = bestOffset(obs, y, mc.month); if (!b) continue;
    const tot = b.score + 4 * mc.score + (ocrY === y ? 2.5 : 0);
    all.push({ y, m: mc.month, tot });
    if (!best || tot > best.tot) best = { ...b, y, m: mc.month, mScore: mc.score, tot };
  }
  if (ocrY && !years.includes(ocrY)) notes.push(`año leído ${ocrY} fuera de rango`);
  dbg.assign = best ? { y: best.y, m: best.m, d0: best.d0, score: +best.score.toFixed(2), margin: +best.margin.toFixed(2), digitHits: best.digitHits, wdHits: best.wdHits, conflicts: best.conflicts } : null;
  if (!best || best.mScore < 0.6) {
    result.warnings.push('No pude leer el mes de la cabecera. Elige el mes a mano.');
    notes.push('mes no leído: ' + hdr.text); return finish();
  }
  // ¿año dudoso? (otro año con el mismo mes casi igual de bueno)
  const altYear = Math.max(-Infinity, ...all.filter((a) => a.m === best.m && a.y !== best.y).map((a) => a.tot));
  const yearSure = best.tot - altYear >= 1.5;
  result.month = best.m; result.year = yearSure ? best.y : null;
  if (!yearSure) result.warnings.push('No estoy seguro del año: confírmalo.');
  // fiable: la mitad de las lecturas de 2 dígitos coinciden, margen claro y pocos conflictos
  const n2 = obs.filter((o) => (o.num?.text || '').replace(/\D/g, '').length === 2).length;
  const reliable = best.digitHits >= Math.max(2, Math.ceil(0.5 * n2)) && best.margin >= 2 && best.conflicts <= Math.max(1, 0.25 * obs.length);
  if (!reliable) {
    result.warnings.push('No pude leer bien los números de los días. Revisa la foto o elige los días a mano.');
    notes.push(`asignación dudosa d0=${best.d0} margen=${best.margin.toFixed(1)} hits=${best.digitHits}`); return finish();
  }

  // 3) Insignias de las filas aceptadas
  progress(0.6, 'Leyendo los turnos');
  const dim = daysInMonth(best.y, best.m);
  best.medContrast = median(obsRows.map((r) => r.textContrast || 0));
  const outRows = [];
  for (const r of cand) {
    const d = best.d0 + r.k;
    if (d < 1 || d > dim) continue;
    r.day = d;
    if (acceptRow(r, best, P)) outRows.push(r);
  }
  let done = 0;
  await Promise.all(outRows.map((r) => readBadges(ctx, r).then(() => progress(0.6 + 0.35 * (++done / outRows.length), 'Leyendo los turnos'))));
  consensus(outRows, known);
  for (const r of outRows) {
    finalizeRow(r);
    if (r.codes) result.days.push({ day: r.day, codes: r.codes, confidence: +Math.max(0.05, Math.min(1, r.conf)).toFixed(2) });
  }
  result.days.sort((a, b) => a.day - b.day);
  const novel = [...new Set(result.days.flatMap((d) => d.codes).filter((c) => !known.includes(c)))];
  if (novel.length) result.warnings.push('Código nuevo: ' + novel.join(', ') + ' — confirma su horario.');
  if (!result.days.length) result.warnings.push('No pude leer ningún día con seguridad.');
  notes.push(`${MONTHS[best.m - 1]} ${best.y} d0=${best.d0} margen=${best.margin.toFixed(1)} filas=${outRows.length}`);
  return finish();
}

export async function dispose() { await disposeWorkers(); }

const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// Geometría: separadores → cuadrilátero → homografía → imagen canónica.
function findScreen(src) {
  const a = findScreenAt(src, 1200);
  // lista pequeña en la foto (teléfono lejos): se repite a resolución completa
  const qw = a.quad ? dist(a.quad.TR, a.quad.TL) : 0;
  if (Math.max(src.w, src.h) > 1250 && (!a.quad || qw < 420)) {
    const b = findScreenAt(src, 2000);
    if (b.canon) return b;
  }
  return a;
}

function findScreenAt(src, maxSide) {
  const as = Math.min(1, maxSide / Math.max(src.w, src.h));
  const ana = downscale(src, as);
  const g = toGray(ana);
  const sep = detectSeparators(g, ana.w, ana.h);
  const fam = sep.lines.length ? selectFamily(sep.lines, ana.w, ana.h, sep.bright) : null;
  const quad = fam && fam.lines.length >= 3 ? buildQuad(g, ana.w, ana.h, fam) : null;
  const out = { ana, sep, fam, quad, canon: null };
  if (!quad) return out;
  const k = 1 / as;
  const Pq = [quad.TL, quad.TR, quad.BR, quad.BL].map((p) => [p[0] * k, p[1] * k]);
  const Wc = (dist(Pq[0], Pq[1]) + dist(Pq[3], Pq[2])) / 2, Hc = (dist(Pq[0], Pq[3]) + dist(Pq[1], Pq[2])) / 2;
  if (Wc < 80 || Hc < 40) return out;
  const H = homography([[0, 0], [Wc, 0], [Wc, Hc], [0, Hc]], Pq);
  if (!H) return out;
  const Hi = invertH(H);
  const step = Wc / Math.max(400, Math.min(900, Wc)); // ancho canónico 400–900 px
  const famV = fam.lines.map((L) => applyH(Hi, fam.xc * k, L.yc * k)[1]);
  const dv = famV.slice(1).map((v, i) => v - famV[i]).filter((d) => d > 2);
  const pitch = Math.max(10, dv.length ? median(dv) : Wc / 7);
  // margen amplio arriba (cabecera) y abajo; lo que cae fuera de la foto queda inválido (alfa 0)
  const vmin = -Math.max(6 * pitch, 0.45 * Hc, 0.9 * Wc), vmax = Hc + Math.max(4 * pitch, 0.3 * Hc);
  const outW = Math.round(Wc / step), outH = Math.round((vmax - vmin) / step);
  if (outW * outH > 6e6) return out;
  const img = warp(src, H, outW, outH, 0, vmin, step);
  out.canon = { img, H, W: Wc, Hc, u0: 0, v0: vmin, step };
  out.famJ = famV.map((v) => (v - vmin) / step);
  return out;
}

// OCR de una máscara binaria (texto negro sobre blanco con margen); en depuración guarda el recorte.
function makeOcrMask(cropLog) {
  return async (mask, w, h, pad, opts) => {
    const im = maskToImage(mask, w, h, pad);
    const o = await ocr(toCanvas(im), opts);
    if (cropLog) cropLog.push({ im, label: `${o.text.replace(/\s+/g, ' ')} (${Math.round(o.conf)}) psm${opts.psm}` });
    return o;
  };
}

// Cabecera: bandas de texto dentro de la franja naranja (perfil de black-hat, insensible al degradado),
// de abajo arriba; la primera que contenga un mes válido gana ("Oktober 2026").
async function readHeader(ctx, an, P) {
  const { src, canon } = ctx; const { img } = canon; const W = img.w;
  const jb = an.jHb, ja = Math.max(an.jHt ?? 0, Math.round(an.jHb - 2.6 * P));
  const i0 = Math.round(0.15 * W), i1 = Math.round(0.85 * W);
  const sub = { w: i1 - i0, h: jb - ja, data: new Uint8ClampedArray((i1 - i0) * (jb - ja) * 4) };
  for (let j = 0; j < sub.h; j++) sub.data.set(img.data.subarray(((ja + j) * W + i0) * 4, ((ja + j) * W + i1) * 4), j * sub.w * 4);
  const ink = blackHatMask(sub, Math.max(2, Math.round(0.1 * P)), 10);
  const prof = []; for (let j = 0; j < sub.h; j++) { let n = 0; for (let i = 0; i < sub.w; i++) n += ink[j * sub.w + i]; prof.push(n / sub.w); }
  const bands = []; let cur = null;
  for (let t = prof.length - 1; t >= 0; t--) {
    if (prof[t] >= 0.015) { if (!cur) cur = { b: t, a: t }; else cur.a = t; } else if (cur) { if (cur.b - cur.a >= 0.08 * P) bands.push(cur); cur = null; }
  }
  if (cur && cur.b - cur.a >= 0.08 * P) bands.push(cur);
  const tries = bands.slice(0, 3).map((b) => {
    const bh = b.b - b.a + 1; let c0 = sub.w, c1 = -1;
    for (let j = b.a; j <= b.b; j++) for (let i = 0; i < sub.w; i++) if (ink[j * sub.w + i]) { if (i < c0) c0 = i; if (i > c1) c1 = i; }
    return { box: { i0: Math.max(0, i0 + c0 - 0.6 * bh), i1: Math.min(W - 1, i0 + c1 + 0.6 * bh), j0: ja + b.a - 0.35 * bh, j1: ja + b.b + 0.35 * bh }, bh, psm: 7 };
  });
  // respaldo: toda la parte baja de la cabecera
  tries.push({ box: { i0: 0.15 * W, i1: 0.85 * W, j0: an.jHb - 1.1 * P, j1: an.jHb }, bh: 0.3 * P, psm: 6 });
  let best = { text: '', parsed: null, sc: -1 };
  for (const t of tries) {
    const { box: bx, bh } = t;
    const target = Math.min(160, Math.max(30, 38 * (bx.j1 - bx.j0) / bh));
    const r = renderCanon(src, canon, bx.i0, bx.j0, bx.i1, bx.j1, target);
    const m = dropBorderBlobs(blackHatMask(r.img, 13, 10), r.img.w, r.img.h);
    const o = await ctx.ocrMask(m, r.img.w, r.img.h, 14, { psm: t.psm, whitelist: HDR_WL });
    const parsed = parseHeader(o.text);
    const sc = parsed.months[0].score + (parsed.year ? 0.3 : 0);
    if (sc > best.sc) best = { text: o.text, parsed, sc, box: { u0: bx.i0 * canon.step, u1: bx.i1 * canon.step, v0: canon.v0 + bx.j0 * canon.step, v1: canon.v0 + bx.j1 * canon.step } };
    if (parsed.months[0].score >= 0.8 && parsed.year) break;
  }
  return best;
}

// Separa la columna de texto en número (arriba) y día de la semana (abajo) y los lee.
async function readDayText(ctx, r, P) {
  const t = r.an.text.slice().sort((a, b) => a.cy - b.cy);
  const split = r.j0 + 0.58 * P;
  const top = t.filter((c) => c.cy < split), bot = t.filter((c) => c.cy >= split);
  const area = Math.max(1, top.reduce((s, c) => s + c.area, 0));
  const red = top.reduce((s, c) => s + c.red * c.area, 0) / area;
  r.weekend = red >= 0.3 ? 1 : 0; // número rojo → sábado/domingo
  r.textContrast = top.length ? REF - top.reduce((s, c) => s + c.lum * c.area, 0) / area : 0;
  r.wdBottom = bot.length ? Math.max(...bot.map((c) => c.y1)) : null;
  const jobs = [];
  if (top.length) jobs.push(readText(ctx, box(top), NUM_WL, 7).then((o) => { r.num = o; }));
  if (bot.length) jobs.push(readText(ctx, box(bot), WD_WL, 8).then((o) => { r.wd = o; o.snap = snapWeekday(o.text); }));
  await Promise.all(jobs);
}

function box(cs) {
  return { x0: Math.min(...cs.map((c) => c.x0)), x1: Math.max(...cs.map((c) => c.x1)) + 1, y0: Math.min(...cs.map((c) => c.y0)), y1: Math.max(...cs.map((c) => c.y1)) + 1 };
}

// Texto oscuro de la columna izquierda: recorte con letra de ~40 px, Otsu, OCR con lista blanca.
async function readText(ctx, b, wl, psm) {
  const gh = b.y1 - b.y0; const padX = 0.35 * gh, padY = 0.25 * gh;
  const i0 = b.x0 - padX, i1 = b.x1 + padX, j0 = b.y0 - padY, j1 = b.y1 + padY;
  const r = renderCanon(ctx.src, ctx.canon, Math.max(0, i0), j0, i1, j1, Math.min(140, 40 * (j1 - j0) / gh));
  const m = dropBorderBlobs(binarizeDark(r.img), r.img.w, r.img.h);
  const o = await ctx.ocrMask(m, r.img.w, r.img.h, 12, { psm, whitelist: wl });
  return { text: o.text.replace(/\s+/g, ''), conf: o.words.length ? Math.min(...o.words.map((w) => w.conf)) : o.conf };
}

// ¿Se acepta la fila? Completa, sin oclusión ni contenido sin explicar, número coherente con la asignación.
function acceptRow(r, best, P) {
  const a = r.an;
  if (!a || a.invalid) return false;
  if (a.foreign >= 0.04 || a.occl > 0) { r.why = 'tapada'; return false; }
  if (a.residual >= 0.006) { r.why = 'contenido sin explicar'; return false; }
  if (a.items.some((t) => t.type === 'unknown')) { r.why = 'insignia desconocida'; return false; }
  const want = String(r.day).padStart(2, '0'); const t = (r.num?.text || '').replace(/\D/g, '');
  if (!r.complete) {
    // fila del borde: solo si se lee perfectamente (número exacto, día de la semana entero, contraste normal)
    const ok = r.edge && t === want && (r.num.conf || 0) >= 90 && r.wdBottom != null && r.wdBottom <= r.j1 - 0.06 * P &&
      r.textContrast >= 0.8 * best.medContrast && a.residual < 0.002 && a.foreign < 0.01 && a.items.every((it) => it.y1 <= r.j1 - 0.05 * P && it.y0 >= r.j0 + 0.05 * P);
    if (!ok) { r.why = 'cortada'; return false; }
    r.conf = 0.8; return true;
  }
  if (t === want) r.conf = 1;
  else if (t.length === 2 && (r.num.conf || 0) >= 75) { r.why = 'número contradice'; return false; }
  else r.conf = 0.7;
  if (r.wd?.snap && r.wd.snap.dist === 0 && r.wd.snap.wd !== weekday(best.y, best.m, r.day) && (r.wd.conf || 0) >= 75) { r.why = 'día semana contradice'; return false; }
  return true;
}

// Lee las insignias / marcas de la fila → r.parts (una entrada por elemento, con código o fallo).
async function readBadges(ctx, r) {
  const items = r.an.items.slice().sort((a, b) => a.x0 - b.x0);
  const notes = []; r.ocrNotes = notes; r.parts = [];
  for (const it of items) {
    if (it.type === 'dash') { r.parts.push({ it, code: '-', conf: 0.95 }); continue; }
    if (it.type === 'glyph') {
      const g = await readGlyph(ctx, it);
      notes.push('g:' + g.text);
      r.parts.push(g.code ? { it, code: g.code, conf: g.conf } : { it, fail: 'marca desconocida' });
      continue;
    }
    const b = await readBadge(ctx.src, ctx.canon, it, r.an.k, ctx.known, ctx.ocrMask);
    notes.push(CLS_NAME[it.cls] + '/' + b.shape + ':' + (b.reads || []).map((x) => x.text + '(' + Math.round(x.conf) + ')').join(','));
    r.parts.push({ it, ...b, fail: b.fail ? 'insignia ' + b.fail : null });
  }
}

// Consenso dentro de la foto: una insignia ilegible toma el código de otra insignia del mismo color y
// forma leída con seguridad si sus glifos son casi idénticos (IoU ≥ 0,66, margen 0,1 sobre otros
// códigos; calibrado: mismo código ≥ 0,63, distinto ≤ 0,57) y alguna lectura OCR está a distancia ≤ 1.
function consensus(rows, known) {
  const parts = rows.flatMap((r) => r.parts || []).filter((p) => p.it.type === 'badge');
  const refs = parts.filter((p) => !p.fail && p.code && p.why !== 'nuevo' && p.conf >= 0.75 && p.prints);
  for (const p of parts) {
    const novel = !p.fail && p.why === 'nuevo';
    if (!(novel || (p.fail && /ilegible/.test(p.fail))) || !p.prints) continue;
    const sims = new Map();
    for (const q of refs) {
      if (q.it.cls !== p.it.cls || q.shape !== p.shape) continue;
      const s = printSim(p.prints, q.prints);
      if (s > (sims.get(q.code) || 0)) sims.set(q.code, s);
    }
    const arr = [...sims.entries()].sort((a, b) => b[1] - a[1]);
    if (!arr.length) continue;
    const [code, sBest] = arr[0]; const sOther = arr[1] ? arr[1][1] : 0;
    const near = (p.reads || []).some((x) => { const t = String(x.text).toUpperCase().replace(/[^A-Z0-9-]/g, ''); return lev(t, code) <= 1 && !(/^[A-Z]/.test(t) && t[0] !== code[0]); });
    p.consensus = { code, sBest: +sBest.toFixed(2), sOther: +sOther.toFixed(2) };
    if (sBest >= 0.66 && sBest - sOther >= 0.1 && near && known.includes(code)) { p.code = code; p.conf = 0.7; p.fail = null; p.why = 'consenso'; }
    else if (novel && sBest >= 0.66) { p.fail = 'insignia parecida a ' + code; p.code = null; } // código "nuevo" idéntico a uno conocido: dudoso
  }
}

// Códigos finales de la fila a partir de sus partes (o null si alguna es dudosa).
function finalizeRow(r) {
  const failed = (r.parts || []).find((p) => p.fail);
  if (failed) { r.codes = null; r.why = failed.fail; return; }
  const parts = (r.parts || []).slice().sort((a, b) => a.it.x0 - b.it.x0);
  const list = parts.map((p) => p.code);
  if (new Set(list).size !== list.length) { r.codes = null; r.why = 'códigos repetidos'; return; }
  if (list.includes('-') && list.length > 1) { r.codes = null; r.why = 'guion con otros códigos'; return; }
  r.codes = list; r.conf = Math.min(r.conf, ...parts.map((p) => p.conf));
}

// Marca pequeña: "U" roja (vacaciones); cualquier otra cosa hace dudosa la fila.
async function readGlyph(ctx, it) {
  const h = it.y1 - it.y0 + 1, w = it.x1 - it.x0 + 1;
  if (!it.reddish) return { text: 'oscuro' };
  const pad = 0.35 * h;
  const rr = renderCanon(ctx.src, ctx.canon, it.x0 - pad, it.y0 - pad, it.x1 + 1 + pad, it.y1 + 1 + pad, 70);
  const m = dropBorderBlobs(binarizeDark(rr.img), rr.img.w, rr.img.h);
  const o = await ctx.ocrMask(m, rr.img.w, rr.img.h, 14, { psm: 10, whitelist: 'UVWJLOD0' });
  const t = o.text.replace(/\s+/g, '');
  if (t === 'U' && w <= 1.3 * h) return { code: 'U', conf: Math.max(0.6, Math.min(1, o.conf / 100)), text: t };
  return { text: t || '?' };
}

// Etiquetas de depuración por fila (se dibujan en el overlay y se devuelven en debug.rows).
function rowsDebug(canon, rows) {
  const cv = (j) => canon.v0 + j * canon.step, cu = (i) => i * canon.step;
  return rows.map((r) => {
    const a = r.an && !r.an.invalid ? r.an : null;
    const blobs = a ? [...a.text.map((t) => ({ kind: 'text', u0: cu(t.x0), u1: cu(t.x1 + 1), v0: cv(t.y0), v1: cv(t.y1 + 1) })),
      ...a.items.map((t) => ({ kind: t.type, u0: cu(t.x0), u1: cu(t.x1 + 1), v0: cv(t.y0), v1: cv(t.y1 + 1) }))] : [];
    let lab = `k${r.k}${r.complete ? '' : '·cut'}`;
    if (r.num) lab += ` n:${r.num.text}(${Math.round(r.num.conf)})`;
    if (r.wd) lab += ` w:${r.wd.text}`;
    if (a) {
      lab += ` f${(a.foreign * 100).toFixed(1)} r${(a.residual * 1000).toFixed(1)}` + (a.residBox ? '@' + a.residBox.join(',') : '') + ` o${(a.occl * 100).toFixed(0)}`;
      lab += ' {' + a.items.map((t) => `${t.type[0]}:${CLS_NAME[t.cls]}@${t.x0},${t.y0 - a.ja} ${t.x1 - t.x0 + 1}x${t.y1 - t.y0 + 1}`).join('; ') + '}';
    }
    if (r.day) lab += ` → ${r.day}`;
    if (r.codes) lab += ' [' + r.codes.join(',') + ']';
    if (r.why) lab += ' ✗' + r.why;
    if (r.ocrNotes) lab += ' ' + r.ocrNotes.join(' ');
    for (const p of r.parts || []) if (p.consensus) lab += ` cons:${p.consensus.code}/${p.consensus.sBest}/${p.consensus.sOther}`;
    return { v0: cv(r.j0), v1: cv(r.j1), ok: !!r.codes, blobs, label: lab };
  });
}
