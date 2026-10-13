// Lector A del móvil ("color-first", copiado de test/lab/approaches/color-first): primero color y forma,
// después OCR dirigido. Contrato: SPEC §5 → recognize(input, options) y dispose().
// Extra para el conjunto (index.js): result.unread = días vistos pero no leídos con seguridad.
import { hsv, makeCanvas, ctx2d, freeCanvas, tick, loadInput, scaledCopy, getPixels, estimateWhite, applyGains, classifyAll, classifyPx, localWhite,
  labelComponents, shapeOf, C_Y, C_G, C_B, C_M, C_P, C_R, C_O, C_K, C_W, C_NONE, CLASS_NAMES } from './img.js';
import { badgeCandidates, estimateBadgeSize, estimateTilt, toFrame, robustLine, median } from './geom.js';
import { getWorker, dispose as disposeOcr, ocr, rotatedCrop, lumOf, maskToCanvas, maskComponents, otsuMask, topHat } from './ocr.js';
import { parseMonthYear, matchWeekday, alignRows, daysInMonth, weekdayOf, WEEKDAYS } from './calendar.js';
import { DEFAULT_CODES, snapCode, WHITELIST } from './codes.js';
import { defaultPaths } from '../ocr-pool.js';

export async function dispose() { await disposeOcr(); }

const defaultTess = () => defaultPaths();

export async function recognize(input, options = {}) {
  try {
    return await run(input, options);
  } catch (e) {
    // nunca lanza: devuelve un resultado vacío con el aviso
    console.warn('[phone-a]', e);
    const msg = e && e.code === 'imagen' ? 'No pude abrir la imagen. Prueba con otra foto.' : 'Algo falló al leer la foto. Prueba otra vez.';
    return { layout: 'unknown', month: null, year: null, days: [], warnings: [msg] };
  }
}

async function run(input, options) {
  const progress = (f, l) => { try { options.onProgress && options.onProgress(f, l); } catch (e) { /* nada */ } };
  const warnings = [];
  const known = [...new Set([...(options.knownCodes || []), ...DEFAULT_CODES])];
  const tess = options.tesseract || defaultTess();
  progress(0.02, 'Abriendo la foto…');
  const t0 = performance.now();
  const workerP = getWorker(tess); // se crea en paralelo
  workerP.catch(() => {});
  let src;
  try { src = await loadInput(input); } catch (e) { e.code = 'imagen'; throw e; }
  const dbg = { D: null, rows: [], notes: [], texts: [], comps: [] };
  const mkCtx = (st) => ({ ...st, dbg, debug: !!options.debug, t0, late: () => performance.now() - t0 > 4000 });
  let ctx = mkCtx(await analyze(src, null));
  progress(0.12, 'Buscando la lista…');
  let geo = findRows(ctx);
  // 2ª pasada: si la lista ocupa poca parte de una foto grande, recorta esa zona con más resolución
  if (geo) {
    const roi = listROI(ctx, geo, src);
    const sNow = ctx.full.w / src.w, s2 = Math.min(1, 2000 / Math.max(roi.w, roi.h));
    if (s2 > 1.3 * sNow) {
      dbg.notes.push(`ROI ${roi.x | 0},${roi.y | 0} ${roi.w | 0}x${roi.h | 0} escala ${sNow.toFixed(2)}→${s2.toFixed(2)}`);
      const ctx2 = mkCtx(await analyze(src, roi));
      const geo2 = findRows(ctx2);
      if (geo2 && geo2.rows.length >= 0.8 * geo.rows.length) { freeCanvas(ctx.ana.canvas); freeCanvas(ctx.full.canvas); ctx = ctx2; geo = geo2; }
      else { freeCanvas(ctx2.ana.canvas); freeCanvas(ctx2.full.canvas); geo = findRows(ctx); }
    }
  }
  src.close();
  const { W, H, px, cls, ana, full, wb } = ctx;
  dbg.W = W; dbg.H = H; dbg.wb = wb;
  const result = { layout: 'unknown', month: null, year: null, days: [], warnings };
  const finish = async () => {
    if (options.debug) {
      const { drawOverlay } = await import('./debug.js');
      result.debug = { overlay: await drawOverlay(ana.canvas, px, cls, dbg), notes: dbg.notes };
    }
    freeCanvas(ana.canvas); freeCanvas(full.canvas);
    progress(1, 'Listo');
    return result;
  };

  const hdr0 = geo ? findHeaderBand(ctx, geo) : null;
  if (!hdr0 && looksLikeGrid(ctx)) {
    // tabla mensual del PC: este prototipo no la lee (solo el mes del título)
    result.layout = 'pc-grid';
    warnings.push('Parece la tabla mensual del PC: aquí solo leo la lista del móvil.');
    try {
      progress(0.5, 'Leyendo el mes…');
      const mc = await readGridTitle(ctx, await workerP);
      const Y0 = new Date().getFullYear();
      if (mc.length && mc[0].month && mc[0].year && Math.abs(mc[0].year - Y0) <= 1) { result.month = mc[0].month; result.year = mc[0].year; }
    } catch (e) { /* sin mes */ }
    return finish();
  }
  if (!geo) { warnings.push('No encontré la lista de turnos en la foto.'); return finish(); }
  result.layout = 'phone-list';
  const { D, fr, line, rows } = geo;

  let worker;
  try { worker = await workerP; } catch (e) { warnings.push('No pude cargar el lector de texto (OCR).'); return finish(); }
  // --- cabecera: mes y año
  progress(0.25, 'Leyendo el mes…');
  const hdr = hdr0;
  const tm = (l) => dbg.notes.push(`t ${l} ${Math.round(performance.now() - t0)}ms`);
  tm('análisis');
  let monthCands = [];
  if (hdr) {
    const t = await readHeader(ctx, geo, hdr, worker);
    const Y0 = new Date().getFullYear();
    monthCands = parseMonthYear(t, [Y0 - 1, Y0, Y0 + 1]);
    dbg.notes.push('cabecera: ' + JSON.stringify(t).slice(0, 80));
  } else dbg.notes.push('sin cabecera');
  await tick();

  tm('cabecera');
  // --- números y días de la semana
  progress(0.4, 'Leyendo los días…');
  for (const r of rows) {
    r.cell = await readDayCell(ctx, geo, r, worker);
  }
  await tick();
  tm('celdas');
  // --- insignias
  progress(0.6, 'Leyendo los turnos…');
  let nItems = rows.reduce((a, r) => a + r.items.length, 0), done = 0;
  for (const r of rows) {
    for (const it of r.items) {
      it.Dl = r.Dl;
      it.code = await readItem(ctx, geo, it, worker, known);
      done++; progress(0.6 + 0.3 * done / Math.max(1, nItems), 'Leyendo los turnos…');
    }
  }

  tm('insignias');
  // --- calendario: índices por paso de fila y alineación
  progress(0.92, 'Comprobando el calendario…');
  const ks = rowIndices(rows, D);
  const obs = rows.map((r) => ({ num: r.cell.num, wd: r.cell.wd, red: r.cell.red }));
  const choice = chooseMonth(obs, ks, monthCands);
  dbg.notes.push(`mes: ${JSON.stringify(monthCands.slice(0, 3))} → ${choice ? choice.month + '/' + choice.year + ' s=' + choice.s + ' sc=' + choice.score.toFixed(1) + ' marg=' + choice.margin.toFixed(1) + ' hits=' + choice.hits : '—'}`);
  dbg.notes.push('opciones: ' + choice.opts4);
  if (choice && choice.month) { result.month = choice.month; result.year = choice.year; }
  if (!result.month) warnings.push('No pude leer el mes con seguridad: elígelo a mano.');

  if (choice && choice.ok) {
    const firstHit = ks.findIndex((k, i) => obs[i].num && obs[i].num.text === pad2(choice.s + k));
    let lastHit = -1; ks.forEach((k, i) => { if (obs[i].num && obs[i].num.text === pad2(choice.s + k)) lastHit = i; });
    const calY = choice.by, calM = choice.bm;
    const dim = calY && calM ? daysInMonth(calY, calM) : 31;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const d = choice.s + ks[i];
      if (d < 1 || d > dim) { r.status = 'fuera'; continue; }
      const numOk = obs[i].num && obs[i].num.text === pad2(d);
      const numBad = obs[i].num && obs[i].num.text.length === 2 && !numOk && obs[i].num.q > 0.6;
      const wdBad = calM && obs[i].wd && obs[i].wd.q >= 1 && obs[i].wd.wd !== weekdayOf(calY, calM, d);
      const interior = i > firstHit && i < lastHit;
      r.day = d;
      if (!r.complete) { r.status = 'incompleta'; continue; }
      if (r.dirty) { r.status = 'sucia'; continue; }
      if (r.odd) { r.status = 'rara'; continue; }
      if (numBad || wdBad) { r.status = 'contradice'; continue; }
      if (!numOk && !interior) { r.status = 'sin número'; continue; }
      const codes = []; let conf = numOk ? 0.95 : 0.7; let bad = false;
      for (const it of r.items) {
        if (!it.code || !it.code.code) { bad = true; break; }
        codes.push(it.code.code); conf = Math.min(conf, it.code.conf);
      }
      if (bad) { r.status = 'ilegible'; continue; }
      if (!codes.length) { r.status = 'vacía'; continue; }
      r.status = 'ok';
      result.days.push({ day: d, codes: orderCodes(codes), confidence: +conf.toFixed(2) });
    }
    // filas vacías: posiciones que faltan entre filas detectadas (o en los extremos)
    progress(0.95, 'Comprobando días vacíos…');
    const empties = await probeEmptyRows(ctx, geo, rows, ks, choice, hdr, worker, dim);
    for (const e of empties) if (!result.days.some((d) => d.day === e.day)) result.days.push({ day: e.day, codes: [], confidence: 0.6 });
    result.days.sort((a, b) => a.day - b.day);
    const skippedRows = rows.filter((r) => r.status && !['ok', 'fuera'].includes(r.status));
    const skipped = skippedRows.length;
    result.unread = [...new Set(skippedRows.map((r) => r.day).filter((d) => d >= 1 && d <= dim && !result.days.some((x) => x.day === d)))];
    result.unreadWhy = Object.fromEntries(skippedRows.filter((r) => result.unread.includes(r.day)).map((r) => [r.day, r.status]));
    if (skipped) warnings.push(skipped === 1 ? 'No pude leer bien 1 día de la foto: revísalo a mano.' : `No pude leer bien ${skipped} días de la foto: revísalos a mano.`);
  } else warnings.push('No pude ordenar los días con seguridad.');
  for (const r of rows) r.label = `${r.day || '?'} ${r.status || ''} [${r.cell ? (r.cell.num ? r.cell.num.text : '·') + '/' + (r.cell.wd ? WEEKDAYS[r.cell.wd.wd] : '·') + (r.cell.red ? '/R' : '') : ''}] ${r.items.map((it) => it.code ? (it.code.code || '?') + (it.code.raw ? '(' + it.code.raw + ')' : '') : '').join(' ')}`;
  if (options.debug) { for (const r of rows) console.log('FILA ' + r.label + (r.dirty ? ' sucia=' + r.dirtyPx.toFixed(2) : '')); for (const n of dbg.notes) console.log('NOTA ' + n); }
  return finish();
}

// Copia (recortada) de la fuente con lado mayor ≤ 2000 y análisis de color completo
async function analyze(src, roi) {
  const r = roi || { x: 0, y: 0, w: src.w, h: src.h };
  const k = Math.min(1, 2000 / Math.max(r.w, r.h));
  const full = cropScaled(src.src, r, k);
  const ana = scaledCopy(full.canvas, full.w, full.h, 1400);
  const ak = ana.w / full.w; // escala análisis/completa
  const W = ana.w, H = ana.h;
  const raw = getPixels(ana.canvas);
  await tick();
  const wb = estimateWhite(raw, W, H);
  // balance local: bloques de ~1.6 insignias (estimadas con el balance global) o 1/14 de la imagen
  let px = applyGains(raw, wb.gains);
  let cls = classifyAll(px, W, H);
  const lw = wb.ref ? localWhite(raw, W, H, wb.ref, (() => { const c0 = labelComponents(cls, W, H, { minArea: 30, skip: (q) => !(q === C_Y || q === C_M || q === C_B) }).comps; const d0 = estimateBadgeSize(badgeCandidates(c0, W * H)); return d0 ? 1.6 * d0 : Math.min(W, H) / 14; })()) : null;
  if (lw) { px = lw.apply(); cls = classifyAll(px, W, H); wb.gainsAt = lw.gainsAt; }
  else wb.gainsAt = () => wb.gains;
  const { comps, labels } = labelComponents(cls, W, H, { minArea: 6 });
  await tick();
  return { W, H, px, cls, comps, labels, ak, full, ana, wb };
}

function cropScaled(src, r, k) {
  const w = Math.max(1, Math.round(r.w * k)), h = Math.max(1, Math.round(r.h * k));
  if (k < 0.5) {
    // reducción en dos pasos para no perder detalle
    const mid = cropScaled(src, r, Math.min(1, k * 2));
    const out = scaledCopy(mid.canvas, mid.w, mid.h, Math.max(w, h)); freeCanvas(mid.canvas);
    return { canvas: out.canvas, w: out.w, h: out.h };
  }
  const c = makeCanvas(w, h); const g = ctx2d(c);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, w, h);
  return { canvas: c, w, h };
}

// Zona de la lista (columna de días, insignias, cabecera) en coordenadas de la fuente
function listROI(ctx, geo, src) {
  const { ak, full } = ctx; const { D, fr, line, rows } = geo;
  const v0 = rows[0].v - 5.5 * D, v1 = rows[rows.length - 1].v + 6 * D;
  const pts = [];
  for (const v of [v0, v1]) for (const u of [line.at(v) - 2.6 * D, line.at(v) + 9 * D]) pts.push(fr.xy(u, v));
  const toSrc = src.w / full.w / ak;
  let x0 = Math.min(...pts.map((p) => p[0])) * toSrc, x1 = Math.max(...pts.map((p) => p[0])) * toSrc;
  let y0 = Math.min(...pts.map((p) => p[1])) * toSrc, y1 = Math.max(...pts.map((p) => p[1])) * toSrc;
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(src.w, x1); y1 = Math.min(src.h, y1);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

const pad2 = (d) => String(d).padStart(2, '0');
// Copia de un recorte para la superposición de depuración
function keepCrop(ctx, canvas, label) {
  if (!ctx.debug) return;
  const k = Math.min(1, 60 / canvas.height); const c = makeCanvas(canvas.width * k, canvas.height * k);
  ctx2d(c).drawImage(canvas, 0, 0, c.width, c.height); (ctx.dbg.crops ||= []).push({ canvas: c, label });
}
const ORDER = { shift: 0, event: 1, other: 2, place: 3 };
function orderCodes(codes) {
  const kind = (c) => (/^[FSNZ]\d$/.test(c) ? 'shift' : c === 'TS' ? 'event' : /^[A-Z]\d\d$/.test(c) ? 'place' : 'other');
  return [...new Set(codes)].sort((a, b) => ORDER[kind(a)] - ORDER[kind(b)]);
}

// Fracción de píxeles claros y neutros en un anillo (¿está sobre la pantalla?)
function ringBright(ctx, cx, cy, r) {
  const { W, H, cls } = ctx; let ok = 0, n = 0;
  for (let a = 0; a < 32; a++) {
    const t = a / 32 * Math.PI * 2; const x = Math.round(cx + Math.cos(t) * r), y = Math.round(cy + Math.sin(t) * r);
    if (x < 0 || y < 0 || x >= W || y >= H) { n++; continue; }
    n++; if (cls[y * W + x] === C_W) ok++;
  }
  return ok / n;
}

// Color medio (tono, saturación) de una componente
function meanColor(ctx, cc) {
  const { W, labels, px } = ctx; let r = 0, g = 0, b = 0, n = 0;
  for (let y = cc.miny; y <= cc.maxy; y++) for (let x = cc.minx; x <= cc.maxx; x++) {
    const p = y * W + x; if (labels[p] !== cc.id) continue; r += px[p * 4]; g += px[p * 4 + 1]; b += px[p * 4 + 2]; n++;
  }
  return n ? hsv(r / n, g / n, b / n) : [0, 0, 0, 0];
}

// Detecta insignias/guiones/U, estima inclinación, columna y filas
function findRows(ctx) {
  const { W, H, comps, dbg } = ctx;
  const cands = badgeCandidates(comps, W * H);
  let D = estimateBadgeSize(cands.filter((c) => ringBright(ctx, c.cx, c.cy, c.major / 2 + Math.max(3, c.major * 0.12)) > 0.45));
  // sin insignias: escala a partir de guiones rojos sobre fondo claro
  const reds = [];
  for (const cc of comps) {
    if (cc.cls !== C_R || cc.area < 6) continue;
    const s = shapeOf(cc); reds.push({ cc, ...s, major: 4 * Math.sqrt(s.l1), minor: 4 * Math.sqrt(s.l2) });
  }
  if (!D) {
    const dashes = reds.filter((r) => r.elong >= 2 && r.cc.area >= 10 && ringBright(ctx, r.cx, r.cy, r.major * 0.9) > 0.8);
    if (dashes.length >= 3) { D = median(dashes.map((r) => r.major)) / 0.27; dbg.notes.push('D por guiones'); }
  }
  dbg.D = D;
  if (!D) return null;
  const items = [];
  for (const c of cands) {
    if (c.size < 0.68 * D || c.size > 1.5 * D) continue;
    const ring = ringBright(ctx, c.cx, c.cy, c.major / 2 + 0.12 * D);
    if (ring < 0.45) continue;
    items.push({ kind: 'badge', cls: c.cc.cls, ...c, ring, ref: meanColor(ctx, c.cc) });
  }
  // rojos pequeños: agrupa piezas cercanas (una U puede partirse en dos trazos) → decide readRed
  const smallReds = reds.filter((r) => r.major < 0.75 * D && r.cc.area >= 5);
  const grp = smallReds.map((_, i) => i);
  const root = (i) => (grp[i] === i ? i : (grp[i] = root(grp[i])));
  for (let i = 0; i < smallReds.length; i++) for (let j = i + 1; j < smallReds.length; j++) {
    const p = smallReds[i].cc, q = smallReds[j].cc;
    const gx = Math.max(0, Math.max(p.minx, q.minx) - Math.min(p.maxx, q.maxx)), gy = Math.max(0, Math.max(p.miny, q.miny) - Math.min(p.maxy, q.maxy));
    if (Math.hypot(gx, gy) < 0.2 * D) grp[root(i)] = root(j);
  }
  const clusters = new Map();
  smallReds.forEach((r, i) => { const k = root(i); if (!clusters.has(k)) clusters.set(k, []); clusters.get(k).push(r); });
  for (const parts of clusters.values()) {
    const area = parts.reduce((t, r) => t + r.cc.area, 0);
    const cx = parts.reduce((t, r) => t + r.cx * r.cc.area, 0) / area, cy = parts.reduce((t, r) => t + r.cy * r.cc.area, 0) / area;
    const x0 = Math.min(...parts.map((r) => r.cc.minx)), x1 = Math.max(...parts.map((r) => r.cc.maxx));
    const y0 = Math.min(...parts.map((r) => r.cc.miny)), y1 = Math.max(...parts.map((r) => r.cc.maxy));
    const ext = Math.hypot(x1 - x0 + 1, y1 - y0 + 1) / D;
    if (ext < 0.1 || ext > 0.75 || area < 10) continue;
    const ring = ringBright(ctx, cx, cy, ext * D * 0.5 + 0.15 * D);
    if (ctx.debug && area > 15) dbg.notes.push(`rojo ${Math.round(cx)},${Math.round(cy)} a=${area} ext=${ext.toFixed(2)} piezas=${parts.length} ring=${ring.toFixed(2)}`);
    if (ring < 0.6) continue;
    const single = parts.length === 1 ? parts[0] : null;
    items.push({ kind: 'red', cls: C_R, cc: parts[0].cc, parts, cx, cy, size: ext * D, major: ext * D, ang: single ? single.ang : 0, elong: single ? single.elong : 1, ring });
  }
  const tilt = estimateTilt(items, D);
  dbg.tilt = tilt;
  const fr = toFrame(tilt.theta);
  for (const it of items) [it.u, it.v] = fr.uv(it.cx, it.cy);
  const group = (list) => {
    const rs = []; const sorted = [...list].sort((a, b) => a.v - b.v);
    for (const it of sorted) {
      const last = rs[rs.length - 1];
      if (last && it.v - last.v0 < 0.5 * D) last.items.push(it);
      else rs.push({ v0: it.v, items: [it] });
    }
    for (const r of rs) { r.items.sort((a, b) => a.u - b.u); r.v = median(r.items.map((x) => x.v)); r.uFirst = r.items[0].u; }
    return rs;
  };
  const line = fitColumn(items, D);
  if (!line) return null;
  // filtra por columna: el primer elemento en la columna, los demás a su derecha y seguidos
  const kept = items.filter((it) => it.u > line.at(it.v) - 0.65 * D && it.u < line.at(it.v) + 5 * D);
  let rows = group(kept);
  rows = rows.filter((r) => Math.abs(r.uFirst - line.at(r.v)) < 0.55 * D);
  for (const r of rows) {
    // cadena de insignias contiguas
    const chain = [r.items[0]];
    for (let i = 1; i < r.items.length; i++) {
      const prev = chain[chain.length - 1], it = r.items[i];
      if (it.u - prev.u < 1.75 * D && it.kind === 'badge' && prev.kind === 'badge') chain.push(it);
    }
    r.extra = r.items.filter((it) => !chain.includes(it));
    r.items = chain;
    // elementos sueltos en la franja (p. ej. guion + insignia, hueco entre insignias) → fila dudosa
    r.odd = r.extra.length > 0;
  }
  // tamaño local de insignia (perspectiva): ajuste lineal tamaño ~ v
  const bs = rows.flatMap((r) => r.items.filter((it) => it.kind === 'badge').map((it) => [it.v, it.size]));
  const sizeLine = bs.length >= 3 ? robustLine(bs.map((b) => b[0]), bs.map((b) => b[1]), 0.15 * D) : { at: () => D };
  for (const r of rows) {
    r.Dl = Math.max(0.6 * D, Math.min(1.6 * D, sizeLine.at(r.v)));
    r.complete = r.items.every((it) => it.kind !== 'badge' || it.size > 0.85 * r.Dl);
  }
  // fila "sucia": píxeles de color u oscuros sin explicar en la franja de insignias
  const dirtyCls = new Set([C_Y, C_G, C_B, C_M, C_P, C_R, C_K, C_O]);
  const areaOf = new Map(ctx.comps.map((c) => [c.id, c.area]));
  const minA = 0.012 * D * D;
  for (const r of rows) {
    const Dl = r.Dl, st = Math.max(1, 0.06 * Dl); let n = 0, where = null;
    const ul = line.at(r.v);
    for (let v = r.v - 0.42 * Dl; v <= r.v + 0.42 * Dl; v += st) {
      for (let u = ul - 0.55 * Dl; u <= ul + 4.5 * Dl; u += st) {
        const [x, y] = fr.xy(u, v); const xi = Math.round(x), yi = Math.round(y);
        if (xi < 0 || yi < 0 || xi >= W || yi >= H) { n++; continue; }
        const k = ctx.cls[yi * W + xi];
        // gris medio (sombra, dedo) cuenta la mitad; colores y tinta, entero si no son motas
        if (k === C_NONE) { if (!kept.some((it) => Math.hypot(it.cx - x, it.cy - y) < (it.kind === 'badge' ? 0.62 * it.major : 0.32 * Dl))) n += 0.5; continue; }
        if (!dirtyCls.has(k)) continue;
        if ((areaOf.get(ctx.labels[yi * W + xi]) || 0) < minA) continue; // motas (moiré, ruido)
        if (kept.some((it) => Math.hypot(it.cx - x, it.cy - y) < (it.kind === 'badge' ? 0.62 * it.major : 0.32 * Dl))) continue;
        n++; where = [xi, yi];
      }
    }
    r.dirtyPx = n * st * st / (Dl * Dl);
    r.dirty = r.dirtyPx > 0.05;
    if (r.dirty) dbg.notes.push(`sucia v=${Math.round(r.v)} ${r.dirtyPx.toFixed(2)} en ${where}`);
  }
  // hueco siguiente: ¿hay una insignia "fantasma" (borrada por un reflejo) tras la última?
  const sp = median(rows.filter((r) => r.items.length >= 2 && r.items[1].kind === 'badge').map((r) => (r.items[1].u - r.items[0].u) / r.Dl));
  const step = Number.isFinite(sp) ? sp : 1.2;
  const discChroma = (u, v, rad) => {
    let s = 0, n = 0;
    for (let dv = -rad; dv <= rad; dv += Math.max(1, rad / 6)) for (let du = -rad; du <= rad; du += Math.max(1, rad / 6)) {
      if (du * du + dv * dv > rad * rad) continue;
      const [x, y] = fr.xy(u + du, v + dv); const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
      const p = (yi * W + xi) * 4; const px = ctx.px;
      s += Math.max(px[p], px[p + 1], px[p + 2]) - Math.min(px[p], px[p + 1], px[p + 2]); n++;
    }
    return n ? s / n : 0;
  };
  for (const r of rows) {
    const last = r.items[r.items.length - 1];
    if (last.kind !== 'badge') continue;
    const cNext = discChroma(last.u + step * r.Dl, r.v, 0.3 * r.Dl), cBg = discChroma(last.u + (step + 1.6) * r.Dl, r.v, 0.3 * r.Dl);
    r.ghost = cNext > cBg + 12;
    if (r.ghost) { r.odd = true; dbg.notes.push(`fantasma v=${Math.round(r.v)} ${cNext.toFixed(0)}>${cBg.toFixed(0)}`); }
  }
  dbg.rows = rows; dbg.line = line; dbg.frame = fr;
  dbg.notes.push(`filas=${rows.length} items=${kept.length}`);
  if (rows.length < 2) return null;
  return { D, fr, line, rows, theta: tilt.theta, sizeLine };
}

// Columna de la primera insignia: RANSAC sobre pares de elementos (u = a + b·v),
// prefiriendo la línea más a la izquierda si tiene apoyo de insignias
function fitColumn(items, D) {
  if (items.length < 2) return null;
  const score = (a, b) => { let s = 0; for (const it of items) if (Math.abs(it.u - (a + b * it.v)) < 0.3 * D) s += it.kind === 'badge' ? 1 : 0.8; return s; };
  let best = null;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const p = items[i], q = items[j]; const dv = q.v - p.v;
    if (Math.abs(dv) < 0.9 * D) continue;
    const b = (q.u - p.u) / dv; if (Math.abs(b) > 0.2) continue;
    const a = p.u - b * p.v; const sc = score(a, b);
    if (!best || sc > best.sc + 1e-9 || (Math.abs(sc - best.sc) < 1e-9 && a + b * 500 < best.a + best.b * 500)) best = { a, b, sc };
  }
  if (!best || best.sc < 2) return null;
  // ¿hay una columna paralela a la izquierda (1ª insignia) con insignias?
  const left = items.filter((it) => it.kind === 'badge').map((it) => it.u - (best.a + best.b * it.v)).filter((d) => d < -0.8 * D && d > -1.7 * D);
  if (left.length >= 2) { const off = median(left); if (score(best.a + off, best.b) >= 2) best = { a: best.a + off, b: best.b, sc: score(best.a + off, best.b) }; }
  // ajuste final por mínimos cuadrados sobre los inliers
  const inl = items.filter((it) => Math.abs(it.u - (best.a + best.b * it.v)) < 0.3 * D);
  const ln = robustLine(inl.map((it) => it.v), inl.map((it) => it.u), 0.3 * D);
  return ln;
}

// ¿Tabla del PC? insignias pequeñas en tiras horizontales largas (≥ 5 seguidas) y sin cabecera naranja
function looksLikeGrid(ctx) {
  const { W, H, comps } = ctx;
  const cands = badgeCandidates(comps, W * H).filter((c) => ringBright(ctx, c.cx, c.cy, c.major / 2 + 3) > 0.4);
  const D = estimateBadgeSize(cands);
  if (!D || D > Math.max(W, H) * 0.045) return false;
  const bs = cands.filter((c) => c.size > 0.7 * D && c.size < 1.4 * D);
  if (bs.length < 6) return false;
  const tilt = estimateTilt(bs.map((c) => ({ kind: 'badge', ...c })), D); const fr = toFrame(tilt.theta);
  const pts = bs.map((c) => fr.uv(c.cx, c.cy)).sort((p, q) => p[1] - q[1]);
  let best = 0;
  for (const p of pts) {
    const lineP = pts.filter((q) => Math.abs(q[1] - p[1]) < 0.4 * D).map((q) => q[0]).sort((x, y) => x - y);
    // tramo más largo con huecos regulares
    let run = 1;
    for (let i = 1; i < lineP.length; i++) { const g = lineP[i] - lineP[i - 1]; run = g > 0.8 * D && g < 3 * D ? run + 1 : 1; best = Math.max(best, run); }
  }
  return best >= 5;
}

// Mes del título de la tabla del PC ("Dienstplan Juni 2026"): OCR de la parte de arriba
async function readGridTitle(ctx, worker) {
  const { full } = ctx;
  const h = Math.round(full.h * 0.45); const k = Math.min(1, 1400 / full.w);
  const c = makeCanvas(full.w * k, h * k); const g = ctx2d(c); g.drawImage(full.canvas, 0, 0, full.w, h, 0, 0, c.width, c.height);
  const r = await ocr(worker, c, { psm: '11', whitelist: '' }); freeCanvas(c);
  const m = /dienstplan\s+([a-zäöü]+)\s+(20\d\d)/i.exec(r.text);
  return m ? parseMonthYear(m[1] + ' ' + m[2]) : [];
}

// Borde inferior de la cabecera naranja por encima de la primera fila
function findHeaderBand(ctx, geo) {
  const { W, H, cls, dbg } = ctx; const { D, fr, line, rows } = geo;
  const top = rows[0];
  const vs = [];
  for (const du of [0.8, 1.6, 2.4, 3.2, 4.0, 4.8]) {
    for (let v = top.v - 0.3 * D; v > top.v - 6 * D; v -= 0.05 * D) {
      const u = line.at(v) + du * D; const [x, y] = fr.xy(u, v);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) break;
      if (cls[yi * W + xi] === C_O) {
        // confirma con varios píxeles por encima
        let n = 0;
        for (let k = 1; k <= 5; k++) { const [x2, y2] = fr.xy(u, v - k * 0.06 * D); const i2 = Math.round(y2) * W + Math.round(x2); if (cls[i2] === C_O) n++; }
        if (n >= 3) { vs.push(v); break; }
      }
    }
  }
  if (vs.length < 3) return null;
  const vb = median(vs);
  // extensión horizontal del naranja en la franja de la cabecera
  const vMid = vb - 0.35 * D;
  const scan = (dir) => {
    let last = line.at(vMid), gap = 0;
    for (let u = line.at(vMid); Math.abs(u - line.at(vMid)) < 14 * D; u += dir * 0.05 * D) {
      const [x, y] = fr.xy(u, vMid); const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= W || yi >= H) break;
      if (cls[yi * W + xi] === C_O) { last = u; gap = 0; } else if (++gap > 0.8 * D / (0.05 * D)) break;
    }
    return last;
  };
  // la pantalla mide ~10 insignias de ancho: no salir de ella
  const u0 = Math.max(scan(-1), line.at(vMid) - 3 * D), u1 = Math.min(scan(1), line.at(vMid) + 10 * D);
  dbg.header = { vb, u0, u1 };
  return { vb, u0, u1 };
}

async function readHeader(ctx, geo, hdr, worker) {
  const { full, ak, wb } = ctx; const { D, fr, theta } = geo;
  const uc = (hdr.u0 + hdr.u1) / 2; const wid = Math.max(4 * D, hdr.u1 - hdr.u0);
  // banda → recorte binarizado (texto oscuro sobre naranja)
  const band = (v0, v1, f, c0) => {
    const [cx, cy] = fr.xy(uc, (v0 + v1) / 2);
    const k = Math.min(5, Math.max(0.6, 40 / (0.3 * D / ak))); // texto ≈ 0.3·D → ~40 px
    const crop = rotatedCrop(full.canvas, cx / ak, cy / ak, theta, wid / ak, (v1 - v0) / ak, k);
    const L = lumOf(crop, wb.gainsAt(cx, cy)); freeCanvas(crop);
    const tH = 0.3 * D / ak * k;
    const mask = adaptiveDark(L.y, L.w, L.h, Math.round(1.2 * tH), f, c0);
    // fuera motas (ruido)
    const { comps: cc, lab } = maskComponents(mask, L.w, L.h, 1);
    const keep = new Set(cc.filter((c) => c.area >= 0.02 * tH * tH && (c.y1 - c.y0 + 1) >= 0.25 * tH).map((c) => c.id));
    for (let p = 0; p < mask.length; p++) mask[p] = keep.has(lab[p]) ? 1 : 0;
    return { c: maskToCanvas(mask, L.w, L.h, { x0: 0, y0: 0, x1: L.w - 1, y1: L.h - 1 }, 10, 0), n: keep.size };
  };
  const Y0 = new Date().getFullYear();
  const ok = (t) => parseMonthYear(t, [Y0 - 1, Y0, Y0 + 1]).some((c) => c.month && c.year);
  // 1) solo la línea del mes ("‹ Oktober 2026 ›"), justo encima del borde inferior, con umbral relativo
  //    y absoluto; 2) toda la cabecera
  const tries = [[hdr.vb - 1.05 * D, hdr.vb - 0.1 * D, 0.8, 10, '7'], [hdr.vb - 1.05 * D, hdr.vb - 0.1 * D, 1, 14, '7'], [hdr.vb - 2.6 * D, hdr.vb + 0.05 * D, 1, 16, '6']];
  let text = '';
  for (const [v0, v1, f, c0, psm] of tries) {
    const b = band(v0, v1, f, c0);
    if (psm === '7' || b.n < 400) { const r = await ocr(worker, b.c, { psm, whitelist: '' }); text += (text ? '\n' : '') + r.text; }
    freeCanvas(b.c);
    if (ok(text)) break;
  }
  return text;
}

// Umbral adaptativo relativo con imagen integral: oscuro si y < f·media local y la diferencia > c
function adaptiveDark(y, w, h, rad, f, c) {
  rad = Math.max(4, rad);
  const I = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) { let s = 0; for (let i = 0; i < w; i++) { s += y[j * w + i]; I[(j + 1) * (w + 1) + i + 1] = I[j * (w + 1) + i + 1] + s; } }
  const m = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x0 = Math.max(0, i - rad), x1 = Math.min(w, i + rad + 1), y0 = Math.max(0, j - rad), y1 = Math.min(h, j + rad + 1);
    const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    const mean = s / ((x1 - x0) * (y1 - y0)); const v = y[j * w + i];
    m[j * w + i] = v < f * mean && mean - v > c ? 1 : 0;
  }
  return m;
}

// Celda del día: número arriba, día de la semana abajo
async function readDayCell(ctx, geo, r, worker) {
  const { full, ak, wb, dbg } = ctx; const { fr, line, theta } = geo;
  const D = r.Dl; const ul = line.at(r.v);
  const u0 = ul - 2.05 * D, u1 = ul - 0.5 * D, v0 = r.v - 0.85 * D, v1 = r.v + 0.95 * D;
  const [cx, cy] = fr.xy((u0 + u1) / 2, (v0 + v1) / 2);
  const k = 90 / (D / ak); // D → 90 px
  const crop = rotatedCrop(full.canvas, cx / ak, cy / ak, theta, (u1 - u0) / ak, (v1 - v0) / ak, k);
  const gl = wb.gainsAt(cx, cy); const L = lumOf(crop, gl); const w = L.w, h = L.h;
  let om = otsuMask(L.y, w, h, null, { dark: true });
  {
    // quita manchas oscuras que tocan los bordes (marco del móvil, insignias) y repite Otsu
    const { comps: bc, lab: bl } = maskComponents(om.mask, w, h, 1);
    const drop = new Set(bc.filter((c) => c.x0 <= 0 || c.x1 >= w - 1 || c.y0 <= 0 || c.y1 >= h - 1).map((c) => c.id));
    if (drop.size) {
      const sel = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) sel[p] = drop.has(bl[p]) ? 0 : 1;
      const o2 = otsuMask(L.y, w, h, sel, { dark: true });
      if (o2.contrast >= 40) om = o2;
    }
  }
  const out = { num: null, wd: null, red: null, contrast: om.contrast };
  r.boxes = [{ pts: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => fr.xy(u, v)), color: '#0aa' }];
  if (om.contrast < 40) { freeCanvas(crop); return out; }
  const { comps: cc, lab } = maskComponents(om.mask, w, h, 6);
  const S = 90; // píxeles por D en el recorte
  const glyphs = cc.filter((c) => (c.y1 - c.y0 + 1) < 0.75 * S && (c.x1 - c.x0 + 1) < 0.9 * S && (c.y1 - c.y0 + 1) > 0.05 * S);
  // dos líneas: número (≈ v-0.2D) y día de la semana (≈ v+0.45D)
  const yNum = (r.v - 0.2 * D - v0) / D * S, yWd = (r.v + 0.45 * D - v0) / D * S;
  let cN = yNum, cW = yWd;
  for (let it = 0; it < 4; it++) {
    const a = [], b = [];
    for (const g of glyphs) (Math.abs(g.cy - cN) <= Math.abs(g.cy - cW) ? a : b).push(g);
    if (a.length) cN = a.reduce((s, g) => s + g.cy * g.area, 0) / a.reduce((s, g) => s + g.area, 0);
    if (b.length) cW = b.reduce((s, g) => s + g.cy * g.area, 0) / b.reduce((s, g) => s + g.area, 0);
  }
  let numG = glyphs.filter((g) => Math.abs(g.cy - cN) <= Math.abs(g.cy - cW) && Math.abs(g.cy - cN) < 0.3 * S && (g.y1 - g.y0) > 0.2 * S);
  if (numG.length) {
    // dígitos: misma altura y misma base
    const hMax = Math.max(...numG.map((g) => g.y1 - g.y0)); const base = median(numG.map((g) => g.y1));
    numG = numG.filter((g) => (g.y1 - g.y0) > 0.7 * hMax && Math.abs(g.y1 - base) < 0.12 * S);
  }
  const wdG = glyphs.filter((g) => Math.abs(g.cy - cW) < Math.abs(g.cy - cN) && Math.abs(g.cy - cW) < 0.3 * S);
  const boxOf = (gs) => gs.reduce((b, g) => ({ x0: Math.min(b.x0, g.x0), y0: Math.min(b.y0, g.y0), x1: Math.max(b.x1, g.x1), y1: Math.max(b.y1, g.y1) }), { x0: 1e9, y0: 1e9, x1: -1, y1: -1 });
  const maskOf = (gs) => { const ids = new Set(gs.map((g) => g.id)); const m = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) if (ids.has(lab[p])) m[p] = 1; return m; };
  if (numG.length) {
    const b = boxOf(numG);
    // ¿rojo? color medio de los píxeles del número
    let sr = 0, sg = 0, sb = 0, n = 0; const ids = new Set(numG.map((g) => g.id));
    for (let p = 0; p < w * h; p++) if (ids.has(lab[p])) { sr += L.rgba[p * 4] * gl[0]; sg += L.rgba[p * 4 + 1] * gl[1]; sb += L.rgba[p * 4 + 2] * gl[2]; n++; }
    sr /= n; sg /= n; sb /= n;
    out.red = sr > 1.35 * Math.max(sg, sb) && sr - Math.max(sg, sb) > 30;
    const touches = b.y0 <= 1 || b.y1 >= h - 2;
    const hh = b.y1 - b.y0 + 1;
    if (!touches && hh > 0.28 * S && hh < 0.7 * S) {
      const c = maskToCanvas(maskOf(numG), w, h, b, 12, 44);
      const o = await ocr(worker, c, { psm: '7', whitelist: '0123456789' });
      keepCrop(ctx, c, 'n:' + o.text + ' ' + Math.round(o.conf));
      const t = o.text.replace(/\D/g, '');
      if (t) out.num = { text: t.slice(0, 2), q: Math.max(0.2, Math.min(1, o.conf / 90)), raw: o.text, conf: o.conf };
      freeCanvas(c);
    }
    r.boxes.push({ pts: boxPts(fr, ak, u0, v0, b, S, D), color: out.red ? '#f00' : '#00f' });
  }
  if (wdG.length) {
    const b = boxOf(wdG);
    const touches = b.y0 <= 1 || b.y1 >= h - 2;
    const hh = b.y1 - b.y0 + 1;
    if (!touches && hh > 0.15 * S && hh < 0.6 * S) {
      const c = maskToCanvas(maskOf(wdG), w, h, b, 12, 40);
      let o = await ocr(worker, c, { psm: '7', whitelist: 'MoDiFrSa' });
      if (!matchWeekday(o.text)) o = await ocr(worker, c, { psm: '8', whitelist: 'MoDiFrSa' });
      keepCrop(ctx, c, 'w:' + o.text + ' ' + Math.round(o.conf));
      out.wd = matchWeekday(o.text); if (out.wd) out.wd.raw = o.text;
      freeCanvas(c);
    }
    r.boxes.push({ pts: boxPts(fr, ak, u0, v0, b, S, D), color: '#a0a' });
  }
  freeCanvas(crop);
  return out;
}

function boxPts(fr, ak, u0, v0, b, S, D) {
  const U = (x) => u0 + x / S * D, V = (y) => v0 + y / S * D;
  return [[U(b.x0), V(b.y0)], [U(b.x1), V(b.y0)], [U(b.x1), V(b.y1)], [U(b.x0), V(b.y1)]].map(([u, v]) => fr.xy(u, v));
}

// Lee una insignia (o guion/U) → {code, conf, raw}
async function readItem(ctx, geo, it, worker, known) {
  if (it.kind !== 'badge') return readRed(ctx, geo, it);
  const { full, ak, wb } = ctx; const { theta } = geo;
  const S = 110; const sz = it.major * 1.3;
  const k = S / (it.major / ak);
  const crop = rotatedCrop(full.canvas, it.cx / ak, it.cy / ak, theta, sz / ak, sz / ak, k);
  const g = wb.gainsAt(it.cx, it.cy); const L = lumOf(crop, g); const w = L.w, h = L.h; const d = L.rgba;
  // relleno = misma clase o tono parecido al color medio de la insignia (tolerante a reflejos)
  const ref = it.ref || [0, 0, 0, 0];
  const fill = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const r = Math.min(255, d[p * 4] * g[0]), gg = Math.min(255, d[p * 4 + 1] * g[1]), b = Math.min(255, d[p * 4 + 2] * g[2]);
    const c = classifyPx(r, gg, b);
    if (c === it.cls) { fill[p] = 1; continue; }
    if (ref[1] > 0.15) {
      const [hh, ss] = hsv(r, gg, b); let dh = Math.abs(hh - ref[0]); if (dh > 180) dh = 360 - dh;
      if (dh < 25 && ss > 0.45 * ref[1] && ss > 0.12) fill[p] = 1;
    }
  }
  // componente de relleno más cercana al centro
  const { comps: fc, lab } = maskComponents(fill, w, h, 20);
  let main = null, bd = 1e9;
  for (const c of fc) { const dd = Math.hypot(c.cx - w / 2, c.cy - h / 2) - Math.sqrt(c.area); if (dd < bd) { bd = dd; main = c; } }
  if (!main) { freeCanvas(crop); return { code: null, conf: 0, raw: '' }; }
  // interior convexo: entre el primer y el último píxel de relleno por fila y por columna
  const inside = new Uint8Array(w * h);
  const rowL = new Int32Array(h).fill(-1), rowR = new Int32Array(h).fill(-1), colT = new Int32Array(w).fill(-1), colB = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lab[y * w + x] === main.id) { if (rowL[y] < 0) rowL[y] = x; rowR[y] = x; if (colT[x] < 0) colT[x] = y; colB[x] = y; }
  const er = Math.max(3, Math.round(0.06 * S));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rowL[y] < 0 || colT[x] < 0) continue;
    if (x > rowL[y] + er && x < rowR[y] - er && y > colT[x] + er && y < colB[x] - er) inside[y * w + x] = 1;
  }
  // forma: esquinas izquierdas llenas → etiqueta (W-)
  const bw = main.x1 - main.x0 + 1, bh = main.y1 - main.y0 + 1;
  let cornerOn = 0, cornerN = 0;
  for (let y = main.y0; y <= main.y1; y++) for (let x = main.x0; x <= main.x0 + 0.16 * bw; x++) {
    const fy = (y - main.y0) / bh; if (fy > 0.2 && fy < 0.8) continue;
    cornerN++; if (inside[y * w + x] || lab[y * w + x] === main.id) cornerOn++;
  }
  // y borde izquierdo recto (etiqueta) frente a curvo (círculo)
  const lefts = [];
  for (let y = Math.round(main.y0 + 0.15 * bh); y <= main.y0 + 0.85 * bh; y++) if (rowL[y] >= 0) lefts.push(rowL[y]);
  lefts.sort((p, q) => p - q);
  const spread = lefts.length > 4 ? (lefts[Math.floor(lefts.length * 0.9)] - lefts[Math.floor(lefts.length * 0.1)]) / bw : 1;
  const corner = cornerN > 0 ? cornerOn / cornerN : 0;
  // undefined = dudoso → decide el OCR entre Z1 y W-
  const tag = corner > 0.6 && spread < 0.08 ? true : (corner < 0.35 && spread > 0.09 ? false : undefined);
  // texto: top-hat morfológico (oscuro sobre amarillo/verde/rosa/magenta; claro sobre azul/rojo)
  // y Otsu en el interior sobre el canal más separable; el texto es la minoría
  const darkText = !(it.cls === C_B || it.cls === C_R);
  const rad = Math.max(3, Math.round(0.07 * S));
  let om = null, resp = null;
  for (const ch of darkText ? [L.y, L.mx] : [L.mn, L.y]) {
    const th = topHat(ch, w, h, rad, darkText);
    const o = otsuMask(th, w, h, inside, { dark: false });
    if (o.fracText < 0.03 || o.fracText > 0.5) continue;
    if (!om || o.eta > om.eta) { om = o; resp = th; }
  }
  if (!om) { resp = topHat(L.y, w, h, rad, darkText); om = otsuMask(resp, w, h, inside, { dark: false }); }
  const { comps: tc, lab: tl } = maskComponents(om.mask, w, h, Math.max(4, Math.round(S * S * 0.0012)));
  // fuera los arcos del borde: componentes con muchos píxeles junto al exterior del interior
  const nearEdge = (c) => {
    let e = 0, n = 0; const d = Math.max(2, Math.round(0.03 * S));
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      if (tl[y * w + x] !== c.id) continue; n++;
      if (!inside[Math.max(0, y - d) * w + x] || !inside[Math.min(h - 1, y + d) * w + x] || !inside[y * w + Math.max(0, x - d)] || !inside[y * w + Math.min(w - 1, x + d)]) e++;
    }
    return e / Math.max(1, n) > 0.25;
  };
  const glyphs = tc.filter((c) => (c.y1 - c.y0 + 1) > 0.12 * S && (c.y1 - c.y0 + 1) < 0.7 * S && !nearEdge(c));
  let raw = '', reads = [];
  if (!glyphs.length || om.contrast <= 18) keepCrop(ctx, crop, CLASS_NAMES[it.cls] + ' sin texto c=' + Math.round(om.contrast) + ' g=' + glyphs.length);
  if (glyphs.length && om.contrast > 18) {
    const b = glyphs.reduce((bb, c) => ({ x0: Math.min(bb.x0, c.x0), y0: Math.min(bb.y0, c.y0), x1: Math.max(bb.x1, c.x1), y1: Math.max(bb.y1, c.y1) }), { x0: 1e9, y0: 1e9, x1: -1, y1: -1 });
    const ids = new Set(glyphs.map((c) => c.id)); const m = new Uint8Array(w * h); for (let p = 0; p < w * h; p++) if (ids.has(tl[p])) m[p] = 1;
    // variantes: binaria (Otsu), gris (respuesta normalizada) y binaria más fina; dos modos de página
    const near = dilate(m, w, h, 2);
    let hi = 0; { const v = []; for (let p = 0; p < w * h; p++) if (m[p]) v.push(resp[p]); v.sort((x, y) => x - y); hi = v[Math.floor(v.length * 0.8)] || 255; }
    const lo = om.thr * 0.5;
    const gray = new Uint8ClampedArray(w * h).fill(255);
    for (let p = 0; p < w * h; p++) if (near[p]) gray[p] = 255 - Math.max(0, Math.min(255, (resp[p] - lo) * 255 / Math.max(1, hi - lo)));
    const thin = new Uint8Array(w * h); const t2 = om.thr + 0.35 * (hi - om.thr);
    for (let p = 0; p < w * h; p++) thin[p] = m[p] && resp[p] > t2 ? 1 : 0;
    const variants = [() => maskToCanvas(m, w, h, b, 12, 40), () => grayToCanvas(gray, w, h, b, 12, 40), () => maskToCanvas(thin, w, h, b, 12, 40)];
    const wl = WHITELIST[it.cls] || 'FSNZTW0123456789-';
    outer: for (let vi = 0; vi < variants.length; vi++) {
      const c = variants[vi]();
      for (const psm of ['7', '8']) {
        const o = await ocr(worker, c, { psm, whitelist: wl });
        reads.push({ text: o.text, conf: o.conf }); raw += (raw ? '|' : '') + o.text;
        if (psm === '7') keepCrop(ctx, c, CLASS_NAMES[it.cls] + vi + ':' + o.text + ' ' + Math.round(o.conf));
        const sc = snapCode(it.cls, reads, known, { tag });
        if (sc.code && sc.why === 'exacto' && o.conf >= 75 && reads.length >= 2) { freeCanvas(c); break outer; }
        if (sc.code && reads.length >= 4 && (sc.why === 'exacto' || sc.why === 'exacto2')) { freeCanvas(c); break outer; }
        if (ctx.late() && reads.length >= 2) { freeCanvas(c); break outer; } // presupuesto de tiempo
      }
      freeCanvas(c);
    }
  }
  freeCanvas(crop);
  const res = snapCode(it.cls, reads, known, { tag });
  return { ...res, raw, tag };
}

function dilate(m, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && xx >= 0 && yy < h && xx < w) out[yy * w + xx] = 1; }
  }
  return out;
}
function grayToCanvas(gray, w, h, box, pad, outH) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1; const k = outH / bh;
  const small = makeCanvas(bw + 2 * pad, bh + 2 * pad); const g = ctx2d(small);
  const id = g.createImageData(small.width, small.height); id.data.fill(255);
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    const i = ((y - box.y0 + pad) * small.width + (x - box.x0 + pad)) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = gray[y * w + x];
  }
  g.putImageData(id, 0, 0);
  const c = makeCanvas(Math.round(small.width * k), Math.round(small.height * k)); const g2 = ctx2d(c);
  g2.imageSmoothingEnabled = true; g2.imageSmoothingQuality = 'high'; g2.drawImage(small, 0, 0, c.width, c.height); freeCanvas(small);
  return c;
}

// Guion o U rojos: forma medida en un recorte enderezado de más resolución
function readRed(ctx, geo, it) {
  const { full, ak, wb } = ctx; const { theta } = geo;
  const D = it.Dl || geo.D; const S = 100; const k = S / (D / ak);
  const crop = rotatedCrop(full.canvas, it.cx / ak, it.cy / ak, theta, 0.8 * D / ak, 0.8 * D / ak, k);
  const g = wb.gainsAt(it.cx, it.cy); const L = lumOf(crop, g); const w = L.w, h = L.h; const d = L.rgba;
  const red = new Uint8ClampedArray(w * h);
  for (let p = 0; p < w * h; p++) { const r = d[p * 4] * g[0], gg = d[p * 4 + 1] * g[1], b = d[p * 4 + 2] * g[2]; red[p] = Math.max(0, r - Math.max(gg, b)); }
  // umbral a media altura del pico de rojo cerca del centro (robusto al desenfoque)
  const vals = [];
  for (let y = Math.round(h * 0.25); y < h * 0.75; y++) for (let x = Math.round(w * 0.2); x < w * 0.8; x++) vals.push(red[y * w + x]);
  vals.sort((a, b) => a - b);
  const peak = vals[Math.floor(vals.length * 0.985)] || 0;
  if (peak < 45) { freeCanvas(crop); return { code: null, conf: 0, raw: 'pálido' }; }
  const om = { mask: new Uint8Array(w * h) };
  for (let p = 0; p < w * h; p++) om.mask[p] = red[p] >= Math.max(30, 0.5 * peak) ? 1 : 0;
  const { comps, lab } = maskComponents(om.mask, w, h, 4);
  const cand = comps.filter((c) => Math.hypot(c.cx - w / 2, c.cy - h / 2) < 0.3 * S).sort((p, q) => q.area - p.area);
  freeCanvas(crop);
  if (!cand.length) return { code: null, conf: 0, raw: 'rojo?' };
  // la pieza principal y las piezas grandes y pegadas a ella (trazos de una U)
  const main = cand[0]; const near = [main];
  for (const c of cand.slice(1)) {
    const gx = Math.max(0, Math.max(c.x0, main.x0) - Math.min(c.x1, main.x1)), gy = Math.max(0, Math.max(c.y0, main.y0) - Math.min(c.y1, main.y1));
    if (c.area >= 0.15 * main.area && Math.hypot(gx, gy) < 0.1 * S) near.push(c);
  }
  const b = near.reduce((bb, c) => ({ x0: Math.min(bb.x0, c.x0), y0: Math.min(bb.y0, c.y0), x1: Math.max(bb.x1, c.x1), y1: Math.max(bb.y1, c.y1) }), { x0: 1e9, y0: 1e9, x1: -1, y1: -1 });
  const bw = (b.x1 - b.x0 + 1) / S, bh = (b.y1 - b.y0 + 1) / S;
  // ¿hueco arriba en el centro? (U)
  const ids = new Set(near.map((c) => c.id)); let mid = 0, midN = 0;
  for (let y = b.y0; y <= b.y0 + 0.55 * (b.y1 - b.y0); y++) for (let x = Math.round(b.x0 + 0.35 * (b.x1 - b.x0)); x <= b.x0 + 0.65 * (b.x1 - b.x0); x++) { midN++; if (ids.has(lab[y * w + x])) mid++; }
  const raw = `${bw.toFixed(2)}x${bh.toFixed(2)}`;
  if (ctx.debug) { const c = maskToCanvas(om.mask, w, h, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, 0, 0); keepCrop(ctx, c, 'rojo ' + raw + ' p=' + Math.round(peak)); freeCanvas(c); }
  // proporción por momentos (ponderada por el rojo) en ejes de fila: robusta al desenfoque
  let sw = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  const cut = 0.3 * peak;
  for (let y = Math.max(0, b.y0 - 6); y <= Math.min(h - 1, b.y1 + 6); y++) for (let x = Math.max(0, b.x0 - 6); x <= Math.min(w - 1, b.x1 + 6); x++) {
    const v = red[y * w + x] - cut; if (v <= 0) continue; sw += v; sx += v * x; sy += v * y; sxx += v * x * x; syy += v * y * y;
  }
  const mr = sw ? Math.sqrt(Math.max(1e-6, sxx / sw - (sx / sw) ** 2) / Math.max(1e-6, syy / sw - (sy / sw) ** 2)) : 0;
  const raw2 = raw + ' m' + mr.toFixed(1);
  const hollow = midN > 0 && mid / midN < 0.25;
  if (!hollow && bh < 0.2 && bw > 0.1 && bw < 0.5 && near.length === 1 && bw / bh >= 1.05 && mr >= 1.0) return { code: '-', conf: 0.9, raw: raw2 };
  if (hollow && bh >= 0.2 && bh <= 0.55 && bw / bh > 0.5 && bw / bh < 1.35) return { code: 'U', conf: 0.85, raw: raw2 };
  return { code: null, conf: 0, raw: raw2 };
}

// Franja de insignias vacía: fondo claro uniforme, sin color ni tinta (y no tapada)
function stripStats(ctx, geo, v, Dl, items = []) {
  const { W, H, px } = ctx; const { fr, line } = geo;
  const st = Math.max(1, 0.08 * Dl); const ul = line.at(v); let n = 0, s = 0, s2 = 0;
  for (let vv = v - 0.4 * Dl; vv <= v + 0.4 * Dl; vv += st) for (let u = ul - 0.5 * Dl; u <= ul + 4.5 * Dl; u += st) {
    const [x, y] = fr.xy(u, vv); const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
    if (items.some((it) => Math.hypot(it.cx - x, it.cy - y) < 0.7 * Math.max(it.size, 0.5 * Dl))) continue;
    const p = yi * W + xi; const Y = 0.299 * px[p * 4] + 0.587 * px[p * 4 + 1] + 0.114 * px[p * 4 + 2];
    n++; s += Y; s2 += Y * Y;
  }
  const m = n ? s / n : 0; return { mean: m, std: n ? Math.sqrt(Math.max(0, s2 / n - m * m)) : 0, n };
}
function stripEmpty(ctx, geo, v, Dl) {
  const { W, H, cls, px } = ctx; const { fr, line } = geo;
  const st = Math.max(1, 0.05 * Dl); const ul = line.at(v); let n = 0, white = 0, odd = 0;
  for (let vv = v - 0.42 * Dl; vv <= v + 0.42 * Dl; vv += st) for (let u = ul - 0.55 * Dl; u <= ul + 4.5 * Dl; u += st) {
    const [x, y] = fr.xy(u, vv); const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return false;
    n++; const p = yi * W + xi; if (cls[p] === C_W) white++;
    const r = px[p * 4], g = px[p * 4 + 1], b = px[p * 4 + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 18 || 0.299 * r + 0.587 * g + 0.114 * b < 185) odd++;
  }
  return white / n > 0.93 && odd / n < 0.003;
}

// Busca filas sin insignias en los huecos del paso de filas y en los extremos
async function probeEmptyRows(ctx, geo, rows, ks, choice, hdr, worker, dim) {
  const out = [];
  if (rows.length < 3) return out;
  // paso local P(v) a partir de filas consecutivas detectadas
  const vs = [], ps = [];
  for (let i = 0; i + 1 < rows.length; i++) { const dk = ks[i + 1] - ks[i]; vs.push((rows[i].v + rows[i + 1].v) / 2); ps.push((rows[i + 1].v - rows[i].v) / dk); }
  const pl = robustLine(vs, ps, 0.1 * geo.D);
  const P = (v) => pl.at(v);
  const contrasts = rows.filter((r) => r.cell && r.cell.num).map((r) => r.cell.contrast);
  const cMed = median(contrasts);
  // fondo típico de las filas detectadas (para descartar reflejos que borran insignias)
  const bgs = rows.map((r, i) => ({ ...stripStats(ctx, geo, r.v, r.Dl, r.items), we: choice.bm ? weekdayOf(choice.by, choice.bm, choice.s + ks[i]) >= 5 : null })).filter((b) => b.n > 20);
  const bgStd = median(bgs.map((b) => b.std));
  const probes = [];
  for (let i = 0; i + 1 < rows.length; i++) for (let k = ks[i] + 1; k < ks[i + 1]; k++) {
    const t = (k - ks[i]) / (ks[i + 1] - ks[i]); probes.push({ k, v: rows[i].v + t * (rows[i + 1].v - rows[i].v) });
  }
  for (let j = 1; j <= 3; j++) { probes.push({ k: -j, v: rows[0].v - j * P(rows[0].v) }); probes.push({ k: ks[ks.length - 1] + j, v: rows[rows.length - 1].v + j * P(rows[rows.length - 1].v) }); }
  for (const pr of probes) {
    const d = choice.s + pr.k; if (d < 1 || d > dim) continue;
    const Dl = geo.sizeLine.at(pr.v);
    if (hdr && pr.v - 0.85 * Dl < hdr.vb) continue; // tapada por la cabecera
    if (!stripEmpty(ctx, geo, pr.v, Dl)) continue;
    const ss = stripStats(ctx, geo, pr.v, Dl);
    const we = choice.bm ? weekdayOf(choice.by, choice.bm, d) >= 5 : null;
    const same = bgs.filter((b) => b.we === we);
    if (same.length && Math.abs(ss.mean - median(same.map((b) => b.mean))) > 8) continue;
    if (ss.std > Math.max(6, 1.8 * bgStd)) continue;
    const r = { v: pr.v, Dl, items: [], probe: true };
    const cell = await readDayCell(ctx, geo, r, worker);
    const ok = cell.num && cell.num.text === pad2(d) && cell.num.q >= 0.6 && cell.contrast >= 0.7 * cMed &&
      (!cell.wd || !choice.bm || cell.wd.wd === weekdayOf(choice.by, choice.bm, d));
    r.day = d; r.status = ok ? 'vacía ok' : 'vacía no'; r.label = `${d} ${r.status} [${cell.num ? cell.num.text : '·'}]`;
    ctx.dbg.rows.push(r);
    if (ok) out.push({ day: d });
  }
  return out;
}

// Índices de fila (pasos enteros) según la separación vertical y el tamaño local
function rowIndices(rows, D) {
  const ks = [0];
  // paso típico relativo al tamaño de insignia
  const ratios = [];
  for (let i = 1; i < rows.length; i++) ratios.push((rows[i].v - rows[i - 1].v) / ((rows[i].Dl + rows[i - 1].Dl) / 2));
  const minR = Math.min(...ratios);
  const base = median(ratios.filter((r) => r < minR * 1.35));
  for (let i = 1; i < rows.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round(ratios[i - 1] / base)));
  return ks;
}

// Elige mes/año y día inicial combinando la cabecera con la coherencia del calendario.
// Años plausibles: el del reloj del aparato ±1. Si dos opciones quedan casi empatadas, mes = null.
function chooseMonth(obs, ks, monthCands, now = new Date()) {
  const Y0 = now.getFullYear(); const years = [Y0 - 1, Y0, Y0 + 1];
  const hYear = (monthCands.find((c) => c.year && years.includes(c.year)) || {}).year || null;
  const hMonths = monthCands.filter((c) => c.month);
  const opts = new Map();
  const add = (m, y, prior) => { if (m < 1) { m += 12; y--; } if (m > 12) { m -= 12; y++; } if (!years.includes(y)) return; const k = m + '/' + y; if (!opts.has(k) || opts.get(k).prior < prior) opts.set(k, { m, y, prior }); };
  for (const c of hMonths) for (const y of years) {
    const p = c.score - (c.year ? 2 : 0) + (y === hYear ? 3 : 0);
    add(c.month, y, p); add(c.month - 1, y, p - 5); add(c.month + 1, y, p - 5);
  }
  if (!opts.size) for (const y of years) for (let m = 1; m <= 12; m++) add(m, y, y === hYear ? 3 : 0);
  const res = [];
  // desempate suave: el plan suele ser del mes actual o de los próximos
  const nowIdx = Y0 * 12 + now.getMonth();
  for (const o of opts.values()) {
    const dm = Math.abs(o.y * 12 + o.m - 1 - nowIdx); o.prior += dm <= 6 ? 2 : dm <= 12 ? 1 : 0;
    const a = alignRows(obs, ks, o.y, o.m);
    res.push({ month: o.m, year: o.y, s: a.best.s, score: a.best.score + o.prior, align: a.best.score, hits: a.best.hits, inner: a.best.score - a.second.score });
  }
  res.sort((p, q) => q.score - p.score);
  const best = res[0];
  const rivals = res.filter((r) => r !== best && r.score >= best.score - 4);
  const monthSure = rivals.length === 0;
  const daysSure = best.hits >= 2 && best.inner >= 4 && rivals.every((r) => r.s === best.s);
  const opts4 = res.slice(0, 4).map((r) => `${r.month}/${r.year} s${r.s} ${r.score.toFixed(1)}`).join(' | ');
  return { ...best, opts4, bm: best.month, by: best.year, margin: rivals.length ? best.score - rivals[0].score : (res[1] ? best.score - res[1].score : 99), ok: daysSure, month: monthSure ? best.month : null, year: monthSure ? best.year : null };
}
