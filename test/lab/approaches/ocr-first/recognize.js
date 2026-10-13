// Reconocedor "ocr-first" para la lista del móvil (app Dienstplan).
// 1) normaliza la foto (reducción, región de pantalla, enderezado) y crea un render de "tinta"
//    donde todo texto (oscuro o claro, sobre cualquier color) queda negro sobre blanco;
// 2) OCR disperso (PSM 11) → números de día, días de la semana, mes/año;
// 3) reconstruye las filas con la secuencia de días (perspectiva) y el calendario;
// 4) por fila: insignias por color + OCR de cada recorte (lista blanca por clase) → códigos.
import * as I from './img.js';
import { ocr, ensureWorkers, disposeWorkers } from './ocr.js';
import { findROI, estimateSkew } from './layout.js';
import { classifyTokens, looksLikeGrid, buildRows, evalModel, pitchAt, invModel, findMonthYear, median } from './rows.js';
import { weekdayOf, daysInMonth, matchWeekday, parseDayNumber, editDistance, MONTHS as MONTHS_DE } from './calendar.js';
import { analyzeBand, shapeOf, renderBadge, looksLikeU, mergeReddish } from './badges.js';
import { CLASS_INFO, DEFAULT_KNOWN, decodeBadge } from './codes.js';
import { drawOverlay } from './debug.js';

// Ruta por defecto de tesseract (relativa a este módulo).
const VENDOR = new URL('../../../../docs/vendor/tesseract/', import.meta.url).href;
const defaultPaths = () => ({ workerPath: VENDOR + 'worker.min.js', corePath: VENDOR + 'core/', langPath: VENDOR + 'lang/best_int/', langPathLegacy: VENDOR + 'lang/legacy/' });

export async function dispose() { await disposeWorkers(); }

export async function recognize(input, options = {}) {
  const prog = (f, l) => { try { options.onProgress && options.onProgress(f, l); } catch { /* ignorar */ } };
  const known = Array.isArray(options.knownCodes) && options.knownCodes.length ? options.knownCodes : DEFAULT_KNOWN;
  const result = { layout: 'unknown', month: null, year: null, days: [], warnings: [] };
  const dbg = { tokens: [], rows: [], comps: [], notes: [] };
  const T0 = performance.now(); const tm = {}; const mark = (k) => { tm[k] = Math.round(performance.now() - T0); };

  prog(0.02, 'Cargando la foto');
  const workersReady = ensureWorkers(options.tesseract || defaultPaths(), 2);
  workersReady.catch(() => {});
  const work = await I.loadToCanvas(input, 2000);
  mark('carga');
  await I.yieldUI();

  // --- Región de la pantalla y enderezado ---
  prog(0.08, 'Buscando la pantalla');
  let rgba = I.getRGBA(work); let roi = findROI(rgba, work.width, work.height);
  const angle = estimateSkew(rgba, work.width, work.height, roi);
  let src = work;
  if (Math.abs(angle) >= 0.4) { src = I.rotateCanvas(work, -angle); rgba = I.getRGBA(src); roi = findROI(rgba, src.width, src.height); }
  dbg.angle = angle; dbg.roi = roi;
  // Escala: ancho de la región ≈ 800 px (texto de tamaño cómodo para Tesseract).
  // (en apaisado —tabla del PC— no se reduce: el texto es pequeño)
  const scale = Math.max(roi.w > roi.h * 1.2 ? 1 : 0.5, Math.min(2.5, 800 / roi.w));
  mark('roi');
  const crop = I.cropCanvas(src, roi.x, roi.y, roi.w, roi.h, scale);
  const cw = crop.width, ch = crop.height; const crgba = I.getRGBA(crop);
  await I.yieldUI();

  // --- Renders: "tinta" (texto de cualquier color → negro) y luminancia aplanada ---
  prog(0.15, 'Preparando la imagen');
  const bg = I.backgroundModel(crgba, cw, ch, 3, 2);
  const ink = I.inkMap(crgba, cw, ch, bg, 1);
  const inkGray = I.inkToGray(ink, cw, ch, Math.max(6, Math.round(cw / 80)));
  const inkCanvas = I.grayToCanvas(inkGray, cw, ch);
  const flatCanvas = I.grayToCanvas(I.unsharp(I.flatLuminance(crgba, cw, ch, bg), cw, ch, 2, 0.8), cw, ch);
  mark('renders');
  await I.yieldUI();

  // --- OCR disperso de toda la región (dos renders en paralelo) ---
  prog(0.25, 'Leyendo el texto');
  await workersReady;
  const [w1, w2] = await Promise.all([ocr(inkCanvas, { psm: 11 }), ocr(flatCanvas, { psm: 11 })]);
  const tokens = mergeTokens(classifyTokens(w1), classifyTokens(w2));
  mark('ocr');
  dbg.tokens = tokens;
  prog(0.5, 'Ordenando las filas');

  const finish = async () => {
    if (options.debug) {
      dbg.notes.push('ms ' + Object.entries(tm).map(([k, v]) => `${k}:${v}`).join(' '));
      try {
        result.debug = { overlay: await drawOverlay(crop, dbg), angle, roi: [roi.x, roi.y, roi.w, roi.h], scale, notes: dbg.notes, H: dbg.H,
          comps: (dbg.comps || []).map((c) => ({ row: c.row, cls: c.cls, shape: c.shape, box: [c.x0, c.y0, c.w, c.h], n: c.n, fill: +c.fill.toFixed(2), hue: Math.round(c.hue), sat: +c.sat.toFixed(2), val: +c.val.toFixed(2), code: c.decoded && c.decoded.code, rd: (c.readings || []).map((x) => `${x.text}:${Math.round(x.conf)}${x.src ? ':' + x.src : ''}`).join(' ') })),
          rows: (dbg.rows || []).map((r) => ({ v: r.v, reject: r.reject, issues: r.issues, codes: r.codes, dark: r.dark && +r.dark.toFixed(3), gap0: r.gap0 && +r.gap0.toFixed(2), gaps: r.gaps && r.gaps.map((g) => +g.toFixed(2)), ink: r.ink && Math.round(r.ink), dt: r.dayTok && [Math.round(r.dayTok.x0), Math.round(r.dayTok.y0), Math.round(r.dayTok.x1), Math.round(r.dayTok.y1), r.dayTok.text] })) };
        if (dbg.headerImg) result.debug.header = await I.canvasToDataURL(dbg.headerImg);
        if (dbg.renders) result.debug.renders = await Promise.all(dbg.renders.map(async (r) => ({ row: r.row, cls: r.cls, mode: r.mode, img: await I.canvasToDataURL(r.img), raw: await I.canvasToDataURL(r.raw) })));
      } catch (e) { result.debug = { error: String(e) }; }
    }
    prog(1, 'Listo');
    return result;
  };

  // Mes y año (cabecera).
  let my = findMonthYear(tokens);

  // ¿Tabla del PC?
  if (looksLikeGrid(tokens)) {
    result.layout = 'pc-grid';
    if (my.best) { result.month = my.best.month; result.year = my.best.year || my.yearOnly; }
    result.warnings.push('Parece la tabla mensual del PC: este lector solo entiende la lista del móvil. Haz una foto de la app o introduce los turnos a mano.');
    return finish();
  }

  const R = buildRows(tokens);
  if (!R || !R.model) {
    result.warnings.push('No encuentro la lista de días en la foto. Intenta una foto más recta y cercana.');
    dbg.notes.push('sin modelo de filas');
    return finish();
  }
  const { H, col, model } = R;
  const colX = (y) => col.a + col.b * y;
  const cOff = R.offY / 2; // centro de fila = número + medio desplazamiento hasta el día de la semana
  dbg.H = H; dbg.col = col; dbg.model = model;

  // Borde inferior de la cabecera naranja (límite superior de la lista).
  const headerBottom = findHeaderBottom(crgba, cw, ch);
  dbg.headerBottom = headerBottom;

  // Si falta el mes o el año, OCR específico de la cabecera.
  if (!my.best || !(my.best.year || my.yearOnly)) {
    const firstY = evalModel(model, Math.min(...R.inliers.map((p) => p.v))) - 0.6 * Math.abs(pitchAt(model, 1));
    const hy1 = Math.max(10, Math.min(ch, headerBottom > 0 ? headerBottom + 4 : firstY));
    const hy0 = Math.max(0, hy1 - Math.max(4 * H, hy1 * 0.9));
    const extra = await headerOcr([flatCanvas, inkCanvas], crop, cw, hy0, hy1, options.debugRenders ? dbg : null);
    const my2 = findMonthYear(classifyTokens(extra));
    dbg.notes.push('cabecera: ' + extra.map((w) => `${w.text}:${Math.round(w.conf)}`).join(' '));
    if (my2.best && (!my.best || my2.best.score > my.best.score || (!my.best.year && my2.best.year))) my = { ...my2, yearOnly: my2.yearOnly || my.yearOnly };
    else if (!my.yearOnly && my2.yearOnly) my.yearOnly = my2.yearOnly;
  }

  // --- Filas: asignar v (día) a cada ancla ---
  const rows = new Map();
  const getRow = (v) => { if (!rows.has(v)) rows.set(v, { v, dayTok: null, wdTok: null, dayAlt: null }); return rows.get(v); };
  for (const a of R.anchors) {
    const m = invModel(model, a.y); const p = Math.abs(pitchAt(model, m.v));
    if (m.d > 0.3 * p) continue;
    const r = getRow(m.v);
    if (a.day) {
      if (a.day.day.value === m.v) { if (!r.dayTok || a.day.conf > r.dayTok.conf) r.dayTok = a.day; }
      else if (!r.dayAlt || a.day.conf > r.dayAlt.conf) r.dayAlt = a.day;
    }
    if (a.wd && (!r.wdTok || a.wd.conf > r.wdTok.conf)) r.wdTok = a.wd;
  }
  // Huecos interiores y una fila más en cada extremo: OCR dirigido del número.
  const vs = [...rows.keys()]; const vmin = Math.min(...vs), vmax = Math.max(...vs);
  for (let v = vmin - 1; v <= vmax + 1; v++) {
    if (v < 1 || v > 31) continue;
    const y = evalModel(model, v); if (y < 0 || y > ch) continue;
    if (!rows.has(v)) getRow(v);
  }
  const reocr = [];
  for (const r of rows.values()) {
    const y = evalModel(model, r.v), x = colX(y);
    if (!r.dayTok) {
      const rect = { x0: x - 1.4 * H, x1: x + 1.4 * H, y0: y - 0.8 * H, y1: y + 0.8 * H };
      if (rect.y0 >= 0 && rect.y1 <= ch) {
        reocr.push(readCrop(crop, rect, 'digits').then((ws) => {
          for (const w of ws) {
            const d = parseDayNumber(w.text);
            if (d && d.value === r.v && w.conf >= 60) r.dayTok = boxTok({ ...w, conf: w.conf, day: d, kind: 'day', reocr: true }, rect);
          }
        }));
      }
    }
    if (!r.wdTok) {
      const wy = y + R.offY, wx = x + R.offX;
      const wrect = { x0: wx - 1.2 * H, x1: wx + 1.2 * H, y0: wy - 0.65 * H, y1: wy + 0.65 * H };
      if (wrect.y1 <= ch && wrect.y0 >= 0) {
        reocr.push(readCrop(crop, wrect, 'weekday').then((ws) => {
          for (const w of ws) { const m = matchWeekday(w.text); if (m && w.conf >= 60) r.wdTok = boxTok({ ...w, wd: m, kind: 'wd', reocr: true }, wrect); }
        }));
      }
    }
  }
  await Promise.all(reocr);
  mark('filas');
  prog(0.6, 'Comprobando el calendario');

  // --- Mes/año con el calendario: el patrón de días de la semana debe encajar ---
  const rowList = [...rows.values()].sort((a, b) => a.v - b.v);
  const cal = resolveMonth(my, rowList);
  result.month = cal.month; result.year = cal.year; dbg.notes.push(...cal.notes);
  if (!cal.month) result.warnings.push(cal.conflict ? 'El mes que leo no cuadra con los días de la semana: elígelo a mano.' : 'No he podido leer el mes. Elígelo a mano.');
  // Sin días de la semana coherentes no es (o no se ve bien) la lista del plan: no se devuelve nada.
  if (cal.wdOffset == null) {
    result.warnings.push('No reconozco los días de la semana de la lista. Haz otra foto más recta y nítida.');
    dbg.rows = rowList; dbg.notes.push('sin patrón semanal');
    return finish();
  }
  result.layout = 'phone-list';

  // --- Visibilidad y validez de cada fila ---
  const inkRef = median(rowList.filter((r) => r.dayTok && !r.dayTok.reocr).map((r) => tokenInk(ink, cw, r.dayTok)));
  for (const r of rowList) {
    const p = Math.abs(pitchAt(model, r.v));
    r.y = evalModel(model, r.v) + cOff; r.x = colX(r.y - cOff); r.p = p;
    r.top = evalModel(model, r.v - 0.5) + cOff; r.bot = evalModel(model, r.v + 0.5) + cOff;
    if (r.top > r.bot) [r.top, r.bot] = [r.bot, r.top];
    const why = [];
    const dim = cal.month ? daysInMonth(cal.year || 2026, cal.month) : 31;
    if (r.v < 1 || r.v > dim) why.push('fuera del mes');
    const expWd = cal.month && cal.year ? weekdayOf(cal.year, cal.month, r.v) : (cal.wdOffset != null ? (r.v + cal.wdOffset) % 7 : null);
    r.wdOk = r.wdTok && expWd != null ? (r.wdTok.wd.alts || [r.wdTok.wd.wd]).includes(expWd) : null;
    if (r.wdOk && r.wdTok.wd.ambiguous) r.wdOk = null; // empate: ni confirma ni contradice
    r.dayOk = !!r.dayTok;
    if (r.dayAlt && r.dayAlt.conf >= 85 && !r.dayTok) why.push('número contradictorio');
    if (!r.dayOk && !(r.wdOk && rows.get(r.v - 1)?.dayTok && rows.get(r.v + 1)?.dayTok)) why.push('sin número');
    if (r.wdOk === false && !(r.dayTok && r.dayTok.conf >= 90 && r.wdTok.conf < 70)) why.push('día de semana no cuadra');
    // Tapada por la cabecera: el número empieza por encima del borde naranja o sale recortado (bajo).
    if (r.top < headerBottom - 0.08 * p && (!r.dayTok || r.dayTok.y0 < headerBottom - 0.1 * H || r.dayTok.h < 0.8 * H)) why.push('tapada por la cabecera');
    if (r.bot > ch - 2) why.push('cortada abajo');
    if (!r.wdTok && r.bot > ch - 1.2 * p) why.push('última fila sin día de semana');
    if (r.dayTok) r.ink = tokenInk(ink, cw, r.dayTok);
    if (r.dayTok && inkRef > 0 && r.ink < 0.42 * inkRef) why.push('borrosa');
    r.reject = why;
  }

  // --- Insignias: segmentación de color en la columna de códigos (una sola vez) ---
  prog(0.65, 'Leyendo los turnos');
  const cand = rowList.filter((r) => !r.reject.length);
  const newCodes = {};
  if (cand.length) {
    await I.yieldUI();
    const offs = rowList.filter((r) => r.dayTok && r.wdTok).map((r) => Math.max(r.dayTok.x1, r.wdTok.x1) - r.x);
    const offR = Math.max(0.6 * H, Math.min(2 * H, offs.length ? median(offs) : 1.2 * H));
    for (const r of cand) {
      // Borde derecho de la columna de días: desplazamiento mediano respecto a la recta de la
      // columna (robusto: un token demasiado ancho no debe esconder una insignia).
      const leftEdge = r.x + offR + 0.2 * H;
      r.band = { x0: leftEdge, x1: Math.min(cw - 1, leftEdge + 10 * H), y0: r.top, y1: r.bot };
    }
    const reg = {
      x0: Math.min(...cand.map((r) => r.band.x0)), x1: Math.max(...cand.map((r) => r.band.x1)),
      y0: Math.max(0, headerBottom, Math.min(...cand.map((r) => r.top)) - 0.4 * H), y1: Math.min(ch - 1, Math.max(...cand.map((r) => r.bot)) + 0.4 * H),
    };
    const bgN = I.neutralBackground(crgba, cw, ch, Math.max(3, Math.round(H / 3)), 6, reg);
    const an = analyzeBand(crgba, cw, ch, bgN, reg, H);
    const comps = suppressOverlaps(mergeReddish(an.comps, H)).map((c) => ({ ...c, shape: shapeOf(c, H) }));
    // Todas las insignias de la app miden lo mismo respecto a la altura de fila (también con
    // perspectiva): las que se salen de la proporción típica son ruido.
    const pAt = (c) => Math.abs(pitchAt(model, invModel(model, (c.y0 + c.y1) / 2 - cOff).v));
    const ratio = median(comps.filter((c) => c.shape === 'badge' || c.shape === 'tag').map((c) => c.h / pAt(c)));
    for (const c of comps) {
      if (c.shape !== 'badge' && c.shape !== 'tag') continue;
      const bh = ratio * pAt(c); const asp = c.w / c.h;
      const okH = c.h >= 0.7 * bh && c.h <= 1.35 * bh, okW = c.shape === 'tag' ? asp >= 1 && asp <= 2.1 : asp >= 0.75 && asp <= 1.6;
      if (!okH || !okW || c.fill < 0.62 || c.fill > 0.95) { c.shape = 'noise'; c.why = 'tamaño/forma'; }
    }
    dbg.comps = comps;
    for (const r of cand) {
      const overlaps = (c, t) => t && c.x0 <= t.x1 + 2 && c.x1 >= t.x0 - 2 && c.y0 <= t.y1 + 2 && c.y1 >= t.y0 - 2;
      r.comps = comps.filter((c) => {
        const cy = (c.y0 + c.y1) / 2;
        return cy >= r.top && cy < r.bot && c.x1 >= r.band.x0 && !(c.shape === 'letter' || c.shape === 'noise' ? overlaps(c, r.dayTok) || overlaps(c, r.wdTok) : false);
      });
      for (const c of r.comps) c.row = r.v;
      // Fracción oscura (dedo, sombra) en la banda, fuera de las insignias.
      let dk = 0, tot = 0;
      for (let y = Math.round(r.top + 0.1 * r.p); y <= Math.round(r.bot - 0.1 * r.p); y++) {
        const yy = y - an.y0; if (yy < 0 || yy >= an.H) continue;
        for (let x = Math.round(r.band.x0); x <= Math.round(r.band.x1); x++) {
          const xx = x - an.x0; if (xx < 0 || xx >= an.W) continue;
          if (r.comps.some((c) => c.shape !== 'noise' && x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1)) continue;
          tot++; if (an.darkMask[yy * an.W + xx]) dk++;
        }
      }
      r.dark = tot ? dk / tot : 0;
    }
    // OCR de cada insignia, por etapas: 2 renders primero; si coinciden con nitidez en un código
    // conocido de la clase, basta; si no, se leen los demás renders (más votos).
    const readBadge = async (r, c, variants) => {
      const wl = CLASS_INFO[c.cls]?.whitelist || '';
      await Promise.all(variants.map(async ([mode, th, psm]) => {
        const img = renderBadge(crgba, cw, ch, c, ink, bg, th, mode);
        if (options.debug && mode === 'lum' && th === 84 && !c.render) c.render = img;
        if (options.debugRenders && psm === 7) (dbg.renders ||= []).push({ row: r.v, cls: c.cls, mode, img, raw: I.cropCanvas(crop, c.x0 - 4, c.y0 - 4, c.w + 8, c.h + 8, 2) });
        try {
          const ws = await ocr(img, { psm, whitelist: wl });
          const text = ws.map((w) => w.text).join(''); const syms = ws.flatMap((w) => w.syms);
          const conf = syms.length ? Math.min(...syms.map((x) => x.conf)) : 0;
          if (text) c.readings.push({ text, conf, syms, weight: 1, src: `${mode}${th}/${psm}` });
        } catch { /* lectura fallida: se ignora */ }
      }));
    };
    const STAGE1 = [['lum', 84, 7], ['ink', 84, 7]];
    const STAGE2 = [['sharp', 84, 7], ['soft', 72, 7], ['lum', 84, 13], ['ink', 84, 13], ['sharp', 84, 13], ['soft', 72, 13]];
    const jobs = [];
    for (const r of cand) {
      for (const c of r.comps) {
        if (c.shape !== 'badge' && c.shape !== 'tag') continue;
        c.readings = [];
        for (const t of tokens) {
          if (t.cx >= c.x0 && t.cx <= c.x1 && t.cy >= c.y0 && t.cy <= c.y1 && t.kind !== 'day') c.readings.push({ text: t.text, conf: t.conf, syms: t.syms, weight: 0.7, src: 'global' });
        }
        jobs.push(readBadge(r, c, STAGE1).then(() => {
          const rd = c.readings.filter((x) => x.src !== 'global');
          const same = rd.length === 2 && rd[0].text === rd[1].text && known.includes(rd[0].text) && CLASS_INFO[c.cls]?.pattern.test(rd[0].text) && rd.every((x) => x.conf >= 85);
          const contra = c.readings.some((x) => x.src === 'global' && x.conf >= 85 && x.text !== rd[0]?.text && CLASS_INFO[c.cls]?.pattern.test(x.text));
          if (!same || contra) return readBadge(r, c, STAGE2);
        }));
      }
    }
    // Letras rojas (U): OCR de un carácter sobre el recorte (PSM 10; si no es una "U" nítida, más).
    for (const r of cand) {
      for (const c of r.comps) {
        if (c.shape !== 'letter') continue;
        c.readings = [];
        for (const t of tokens) if (t.cx >= c.x0 - 2 && t.cx <= c.x1 + 2 && t.cy >= c.y0 - 2 && t.cy <= c.y1 + 2) c.readings.push({ text: t.text, conf: t.conf, src: 'global' });
        const rect = { x0: c.x0 - 0.45 * H, x1: c.x1 + 0.45 * H, y0: c.y0 - 0.3 * H, y1: c.y1 + 0.3 * H };
        const read = (psm) => readCrop(crop, rect, 'letter', psm, Math.max(2, 64 / c.h)).then((ws) => {
          const text = ws.map((w) => w.text).join(''); if (text) c.readings.push({ text, conf: Math.min(...ws.map((w) => w.conf)) });
        }).catch(() => {});
        jobs.push(read(10).then(() => (c.readings.some((x) => String(x.text).toUpperCase() === 'U' && x.conf >= 70) ? null : Promise.all([read(8), read(7)]))));
      }
    }
    mark('color');
    await Promise.all(jobs);
    mark('insignias');
    prog(0.9, 'Revisando');

    // --- Códigos por fila ---
    for (const r of cand) {
      const codes = []; const issues = [];
      for (const c of r.comps) {
        const out = c.y0 < r.top - 0.12 * r.p || c.y1 > r.bot + 0.12 * r.p;
        const cut = c.y0 <= an.y0 + 1 || c.y1 >= an.y0 + an.H - 2;
        if (c.shape === 'dash') { codes.push({ code: '-', x: c.x0, x1: c.x1, conf: 0.9 }); continue; }
        if (c.shape === 'letter') {
          // U: alguna lectura "U" (o la forma de U) y ninguna lectura distinta con confianza.
          // Voto ponderado entre lecturas de un carácter (las del OCR global pesan menos y la
          // basura de varios símbolos no cuenta). U solo si gana con claridad.
          const votes = {}; let nU = 0, bestU = 0;
          for (const x of c.readings) {
            const t = String(x.text).replace(/[^A-Za-z0-9]/g, '').toUpperCase(); if (t.length !== 1) continue;
            votes[t] = (votes[t] || 0) + (x.src === 'global' ? 0.7 : 1) * Math.max(0.3, x.conf / 100);
            if (t === 'U') { nU++; bestU = Math.max(bestU, x.conf); }
          }
          const vU = votes.U || 0, vO = Math.max(0, ...Object.entries(votes).filter(([k]) => k !== 'U').map(([, v]) => v));
          if ((vU > 1.5 * vO && (nU >= 2 || bestU >= 60)) || (!vO && !vU && looksLikeU(c))) codes.push({ code: 'U', x: c.x0, x1: c.x1, conf: nU >= 2 ? 0.85 : 0.7 });
          else issues.push('marca roja rara');
          continue;
        }
        if (c.shape === 'badge' || c.shape === 'tag') {
          if (cut || out) { issues.push('insignia cortada'); continue; }
          const dec = decodeBadge(c.cls, c.shape, c.readings, known);
          c.decoded = dec;
          if (!dec.code) { issues.push(`insignia ${c.cls} ilegible`); continue; }
          codes.push({ code: dec.code, x: c.x0, x1: c.x1, conf: dec.conf, isNew: dec.isNew });
          continue;
        }
        // Manchas grandes con color (dedo, insignia tapada); los reflejos poco saturados se ignoran.
        if (c.n > 0.6 * H * H && (c.sat >= 0.2 || c.cls !== 'green')) issues.push('objeto extraño');
      }
      if (r.dark > 0.12) issues.push('zona oscura (¿dedo?)');
      // Fila vacía: solo si la banda está limpia de verdad (sin tinta tras la ganancia local, sin
      // píxeles de color y sin texto leído por el OCR global).
      if (!codes.length && !issues.length) {
        const y0 = Math.round(r.top + 0.15 * r.p), y1 = Math.round(r.bot - 0.15 * r.p);
        let inkPx = 0, colPx = 0;
        for (let y = y0; y <= y1; y++) for (let x = Math.round(r.band.x0); x <= Math.round(r.band.x1); x++) {
          if (inkGray[y * cw + x] < 150) inkPx++;
          const yy = y - an.y0, xx = x - an.x0;
          if (yy >= 0 && yy < an.H && xx >= 0 && xx < an.W && an.cls[yy * an.W + xx]) colPx++;
        }
        const txt = tokens.some((t) => t.conf >= 40 && /[A-Za-z0-9]/.test(t.text) && t.cy > y0 && t.cy < y1 && t.cx > r.band.x0 && t.cx < r.band.x1);
        if (inkPx > 0.02 * H * H || colPx > 0.05 * H * H || txt) issues.push('banda con marcas sin identificar');
      }
      codes.sort((a, b) => a.x - b.x);
      r.codes = [...new Set(codes.map((c) => c.code))];
      // Huecos: la primera marca empieza junto a la columna y las insignias van seguidas.
      if (codes.length) {
        const hl = r.dayTok && r.dayTok.h > 0.6 * H && r.dayTok.h < 1.6 * H ? r.dayTok.h : H; // altura local (perspectiva)
        r.gap0 = (codes[0].x - r.band.x0) / hl;
        r.gaps = codes.slice(1).map((c, i) => (c.x - codes[i].x1) / hl);
        const mark = codes[0].code === '-' || codes[0].code === 'U';
        if (r.gap0 > (mark ? 2.6 : 1.6)) issues.push('hueco antes de la primera marca');
        if (r.gaps.some((g) => g > 1)) issues.push('hueco entre insignias');
      }
      // Un lugar (letra + 2 cifras) siempre acompaña a un turno.
      if (r.codes.some((c) => /^[FSN]\d\d$/.test(c) && c !== 'S31') && !r.codes.some((c) => /^[FSNZ]\d$/.test(c))) issues.push('lugar sin turno');
      r.issues = issues;
      if (issues.length) continue;
      // Coherencia: el guion y la U van solos.
      if ((r.codes.includes('-') || r.codes.includes('U')) && r.codes.length > 1) { r.issues.push('mezcla incoherente'); continue; }
      let rc = 0.6 + (r.dayOk ? 0.2 : 0) + (r.wdOk ? 0.2 : 0);
      if (r.dayTok && r.dayTok.reocr) rc -= 0.1;
      const cc = codes.length ? Math.min(...codes.map((c) => c.conf)) : 0.7;
      result.days.push({ day: r.v, codes: [...new Set(r.codes)], confidence: Math.round(Math.max(0.05, Math.min(1, rc * cc)) * 100) / 100 });
      for (const c of codes) if (c.isNew) (newCodes[c.code] ||= []).push(r.v);
    }
  }
  result.days.sort((a, b) => a.day - b.day);
  for (const [code, ds] of Object.entries(newCodes)) result.warnings.push(`Código nuevo: ${code} (${ds.length === 1 ? 'día' : 'días'} ${ds.join(', ')}). Confirma su horario.`);
  const omitted = rowList.filter((r) => (r.reject.length === 0 && r.issues && r.issues.length));
  if (omitted.length) result.warnings.push(`No he podido leer bien ${omitted.length === 1 ? 'el día' : 'los días'} ${omitted.map((r) => r.v).join(', ')}: revísalos a mano.`);
  dbg.rows = rowList;
  return finish();
}

// Quita componentes solapadas con otra más fuerte (píxeles × saturación): p. ej. el halo rosado
// de una insignia magenta o de un guion rojo.
function suppressOverlaps(comps) {
  const kept = [];
  for (const c of [...comps].sort((a, b) => b.n * b.sat - a.n * a.sat)) {
    const dup = kept.some((k) => {
      const ix = Math.max(0, Math.min(k.x1, c.x1) - Math.max(k.x0, c.x0) + 1), iy = Math.max(0, Math.min(k.y1, c.y1) - Math.max(k.y0, c.y0) + 1);
      if (ix * iy > 0.5 * c.w * c.h) return true;
      // Fragmento pequeño pegado al borde de una componente mucho mayor (antialias del borde).
      const touch = c.x0 <= k.x1 + 3 && c.x1 >= k.x0 - 3 && c.y0 <= k.y1 + 3 && c.y1 >= k.y0 - 3;
      return touch && c.h < 0.6 * k.h && c.n < 0.25 * k.n;
    });
    if (!dup) kept.push(c);
  }
  return kept;
}

// Token de un recorte → coordenadas del recorte grande (con caja, centro y tamaño).
function boxTok(t, rect) {
  const x0 = rect.x0 + t.x0, x1 = rect.x0 + t.x1, y0 = rect.y0 + t.y0, y1 = rect.y0 + t.y1;
  return { ...t, x0, x1, y0, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

// Une tokens de dos pasadas de OCR: misma caja y mismo significado → una sola (confianza máxima).
function mergeTokens(A, B) {
  const out = [...A];
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const i = ix * iy; return i / ((a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i || 1);
  };
  const key = (t) => (t.kind === 'day' ? 'd' + t.day.value : t.kind === 'wd' ? 'w' + t.wd.wd : t.kind + ':' + t.text);
  for (const b of B) {
    const a = out.find((a) => iou(a, b) > 0.4);
    if (!a) { out.push(b); continue; }
    if (key(a) === key(b)) { if (b.conf > a.conf) Object.assign(a, { conf: b.conf }); a.votes = (a.votes || 1) + 1; continue; }
    if (a.kind === 'other' && b.kind !== 'other') { out[out.indexOf(a)] = b; continue; }
    if (b.kind !== 'other') out.push(b);
  }
  return out;
}

// --- Auxiliares ---

// OCR de un recorte (número de día o día de la semana) ampliado.
async function readCrop(canvas, rect, kind, psm = 7, s = 2) {
  const c = I.cropCanvas(canvas, rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0, s);
  const g = I.luminance(I.getRGBA(c));
  // Estirado de contraste (percentiles) para texto oscuro sobre claro.
  const sorted = Array.from(g).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.03)], hi = sorted[Math.floor(sorted.length * 0.85)];
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = hi > lo ? Math.max(0, Math.min(255, Math.round((g[i] - lo) * 255 / (hi - lo)))) : g[i];
  const img = I.grayToCanvas(out, c.width, c.height);
  const wl = kind === 'digits' ? '0123456789' : kind === 'weekday' ? 'MDFSoiraMo' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const ws = await ocr(img, { psm, whitelist: wl });
  return ws.map((w) => ({ ...w, x0: w.x0 / s, x1: w.x1 / s, y0: w.y0 / s, y1: w.y1 / s }));
}

// OCR de la franja de cabecera para el mes/año: los dos renders ya preparados y la luminancia
// estirada (con el marco oscuro en blanco), ampliados, en paralelo.
async function headerOcr(canvases, crop, cw, y0, y1, dbg = null) {
  const s = 1.5;
  const lumC = I.cropCanvas(crop, 0, y0, cw, y1 - y0, s);
  const g = I.luminance(I.getRGBA(lumC)); const vals = Array.from(g).filter((v) => v >= 60).sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.02)] || 0, hi = vals[Math.floor(vals.length * 0.6)] || 255;
  const out = new Uint8Array(g.length);
  for (let i = 0; i < g.length; i++) out[i] = g[i] < 60 ? 255 : hi > lo ? Math.max(0, Math.min(255, Math.round((g[i] - lo) * 255 / (hi - lo)))) : g[i];
  const lumImg = I.grayToCanvas(out, lumC.width, lumC.height);
  if (dbg) dbg.headerImg = lumImg;
  const fix = (ws) => ws.map((w) => ({ ...w, x0: w.x0 / s, x1: w.x1 / s, y0: y0 + w.y0 / s, y1: y0 + w.y1 / s }));
  // Primero la luminancia; si ya da mes y año, no hace falta más.
  const first = fix(await ocr(lumImg, { psm: 11 }));
  const f = findMonthYear(classifyTokens(first));
  if (f.best && (f.best.year || f.yearOnly)) return first;
  const rest = await Promise.all(canvases.map((cv) => ocr(I.cropCanvas(cv, 0, y0, cw, y1 - y0, s), { psm: 11 })));
  return first.concat(fix(rest.flat()));
}

// Borde inferior de la cabecera naranja (0 si no hay).
function findHeaderBottom(rgba, w, h) {
  let last = -1;
  for (let y = 0; y < h * 0.45; y++) {
    let n = 0;
    for (let x = 0; x < w; x += 2) {
      const j = (y * w + x) * 4; const [hh, s, v] = I.rgbToHsv(rgba[j], rgba[j + 1], rgba[j + 2]);
      if (hh >= 12 && hh <= 50 && s >= 0.42 && v >= 0.3) n++;
    }
    if (n >= w / 2 * 0.35) last = y; else if (last >= 0 && y - last > 6) break;
  }
  return last + 1;
}

// Contraste de tinta de un token (percentil 90 dentro de su caja).
function tokenInk(ink, w, t) {
  const v = [];
  for (let y = Math.max(0, Math.round(t.y0)); y <= Math.round(t.y1); y++) for (let x = Math.max(0, Math.round(t.x0)); x <= Math.min(w - 1, Math.round(t.x1)); x++) v.push(ink[y * w + x]);
  if (!v.length) return 0; v.sort((a, b) => a - b); return v[Math.floor(v.length * 0.9)];
}


// Elige mes/año combinando el texto de la cabecera y el patrón de días de la semana.
// Nunca se inventa un mes distinto del leído: el mes sale del texto (o de una alternativa muy
// parecida, p. ej. Juni/Juli), el año puede corregirse ±1 y el patrón semanal debe cuadrar.
// Si no cuadra nada → mes null (la UI pide elegirlo).
function resolveMonth(my, rows) {
  const notes = [];
  const withWd = rows.filter((r) => r.wdTok && !r.wdTok.wd.ambiguous);
  // Desplazamiento semanal coherente con los días leídos: wd = (v + off) % 7.
  const offVotes = new Array(7).fill(0);
  for (const r of withWd) offVotes[(((r.wdTok.wd.wd - r.v) % 7) + 7) % 7] += r.wdTok.conf / 100;
  const total = offVotes.reduce((a, b) => a + b, 0);
  const off = offVotes.indexOf(Math.max(...offVotes));
  const offOk = withWd.length >= 2 && offVotes[off] >= 0.6 * total;
  const offOf = (y, m) => ((weekdayOf(y, m, 1) - 1) % 7 + 7) % 7;
  const maxV = Math.max(0, ...rows.filter((r) => r.dayTok).map((r) => r.v));
  const cy = new Date().getFullYear();
  const ocrYear = my.best && my.best.year ? my.best.year : my.yearOnly;
  const years = ocrYear ? [ocrYear, ocrYear - 1, ocrYear + 1] : [cy, cy + 1, cy - 1];
  const fits = (y, m) => maxV <= daysInMonth(y, m) && (!offOk || offOf(y, m) === off);
  // Meses candidatos: el leído y alternativas de nombre casi igual.
  const months = [];
  if (my.best) {
    const t = my.best.tok ? my.best.tok.text : '';
    const scored = MONTHS_DE.map((name, i) => ({ m: i + 1, sc: t ? 1 - editDistance(t.toLowerCase().replace(/[^a-zäöü]/g, ''), name) / name.length : 0 }));
    const best = Math.max(...scored.map((x) => x.sc), 0);
    months.push(my.best.month);
    for (const x of scored.sort((a, b) => b.sc - a.sc)) if (x.m !== my.best.month && x.sc >= 0.5 && x.sc >= best - 0.3) months.push(x.m);
  }
  notes.push(`mes OCR=${my.best ? my.best.month : null} año OCR=${ocrYear || null} off=${offOk ? off : '?'}`);
  for (const m of months) for (const y of years) if (fits(y, m)) { if (m !== months[0] || y !== (ocrYear || y)) notes.push(`corregido a ${m}/${y}`); return { month: m, year: y, wdOffset: offOk ? off : null, notes }; }
  if (months.length) { notes.push('el mes leído no cuadra con los días de la semana'); return { month: null, year: null, wdOffset: offOk ? off : null, notes, conflict: true }; }
  // Sin texto de mes: solo si el patrón semanal deja un único mes posible en los años cercanos.
  if (offOk) {
    const opts = []; for (const y of years) for (let m = 1; m <= 12; m++) if (fits(y, m)) opts.push([m, y]);
    if (opts.length === 1) return { month: opts[0][0], year: opts[0][1], wdOffset: off, notes };
  }
  return { month: null, year: ocrYear || null, wdOffset: offOk ? off : null, notes };
}
