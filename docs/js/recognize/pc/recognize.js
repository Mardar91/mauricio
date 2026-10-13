// Lector de la tabla del PC ("pc-grid", copiado de test/lab/approaches/pc-grid): impresión mensual de euregon
// ("Dienstplan <Monat> <Jahr>") fotografiada del monitor.
// Fases: rejilla (Hough) → homografía → tabla rectificada → cabecera (OCR días) → título (mes/año)
// → fila del empleado → insignias por color + OCR → días.
import { loadInput, planes, ctx2d, tick, median, percentile, makeCanvas, freeCanvas, flattenGray, components } from './img.js';
import { detectSegments } from './lines.js';
import { findTable, tableHomography } from './table.js';
import { warp, mul, apply } from './geom.js';
import { analyzeGrid } from './grid.js';
import { whiteGains, cellGains, regionHSV, cellComponents, colorClass, badgeInk, inkCanvas, isBadge } from './badges.js';
import { matchCodes, inkSignature } from './tmatch.js';
import { decideAll } from './decide.js';
import { grayCrop, strip, readStrip } from './cells.js';
import { daysInMonth, weekdayIdx, monthCandidates, yearCandidates, dateCandidates, weekdayFromText, DEFAULT_EMPLOYEE, nameLabel, nameTokens, matchName, normName, otherSheetWarning, checkSingleRow, chooseRow } from './calendar.js';
import { DEFAULT_KNOWN, classCandidates, normalizeRead, exactNewCode } from './codes.js';
import { disposeOcr, ocr, prewarm } from './ocr.js';

export async function dispose() { await disposeOcr(); }

// Confianza máxima de los días de una hoja que parece de otra persona (la revisión no los marca: < 0,7)
export const OTHER_SHEET_CONF = 0.4;

let sheet = null; // recortes de insignias para la superposición de depuración

export async function recognize(input, options = {}) {
  const prog = (f, l) => { try { options.onProgress?.(f, l); } catch (e) { /* nada */ } };
  sheet = options.debug ? [] : null;
  const res = { layout: 'unknown', month: null, year: null, days: [], warnings: [] };
  const D = options.debug ? { extra: [], info: {}, lib: await import('./debug.js') } : null;

  prog(0.02, 'Cargando la foto');
  const L = await loadInput(input, 2000);
  try { return await run(L, options, prog, res, D); } finally { L.release(); }
}

async function run(L, options, prog, res, D) {
  const tess = options.tesseract;
  const known = options.knownCodes && options.knownCodes.length ? options.knownCodes : DEFAULT_KNOWN;
  // empleado: nombre del plan («Ducuara Ana»); sin nombre, el apellido de siempre
  const given = nameLabel(options.employeeName);
  const who = { label: given || DEFAULT_EMPLOYEE, tokens: nameTokens(given || DEFAULT_EMPLOYEE), given: !!given };
  const { canvas } = L;
  const T0 = performance.now(); const tm = (k) => { if (D) D.info['t_' + k] = Math.round(performance.now() - T0); };
  const P = planes(canvas);
  await tick();

  // 1. Rejilla de la tabla
  prog(0.1, 'Buscando la tabla');
  const seg = detectSegments(P.Y, P.w, P.h);
  const tb = findTable(seg.hs, seg.vs, P.w, P.h);
  if (D) { D.ov = D.lib.makeOverlay(canvas); for (const l of seg.hs) D.lib.drawLine(D.ov, l, 'rgba(255,0,0,0.2)', 1); }
  if (!tb) return finish(res, D, 'No se encontró la tabla del plan mensual.');
  prewarm(options.tesseract); // el OCR se necesitará: cargarlo mientras se endereza la tabla
  const xs = tb.span.map((s) => s.pT[0]).sort((a, b) => a - b); const gaps = [];
  for (let i = 0; i + 1 < xs.length; i++) gaps.push(xs[i + 1] - xs[i]);
  const scale = Math.min(3, Math.max(1, 48 / (median(gaps) || 30)));
  const { H, Wr, Hr } = tableHomography(tb, scale);
  if (!H) return finish(res, D, 'No se pudo enderezar la tabla.');
  // región rectificada ampliada alrededor de la banda (nombre a la izquierda, Soll/Ist a la derecha, filas debajo)
  const cwR = (median(gaps) || 30) * scale;
  const ox = Math.round(5.5 * cwR); const oy = Math.round(7 * cwR);
  const RW = Math.round(Wr + ox + 8 * cwR); const RH = Math.round(Hr + oy + Math.min(1600, Math.max(3 * Hr, 12 * cwR)));
  const src = ctx2d(canvas).getImageData(0, 0, P.w, P.h).data;
  const toImg = (u, v) => apply(H, u - ox, v - oy); // píxel rectificado → imagen
  const rc = warp(src, P.w, P.h, mul(H, [1, 0, -ox, 0, 1, -oy, 0, 0, 1]), RW, RH);
  const G = analyzeGrid(rc, cwR);
  if (D) { D.lib.drawPoly(D.ov, [[0, 0], [Wr, 0], [Wr, Hr], [0, Hr]].map(([u, v]) => apply(H, u, v)), 'lime', 2); D.rc = rc; }
  await tick();
  if (!G.days) return finish(res, D, 'No se encontraron las columnas de los días.');
  const RP = G.P; const b = G.days.borders; const cw = G.days.width; const nCols = b.length - 1;

  tm('rejilla');
  // 2. Filas (líneas horizontales) y cabecera
  prog(0.25, 'Leyendo la cabecera');
  const rows = buildRows(G.hlines);
  if (rows.length < 3) return finish(res, D, 'Tabla incompleta.');
  const rh = median(rows.map((r) => r[1] - r[0]));
  if (D) D.crop = [Math.max(0, b[0] - 5 * cw), Math.max(0, rows[0][0] - 10), Math.min(rc.width, b[nCols] + 7 * cw), Math.min(rc.height, rows[rows.length - 1][1] + 10)];
  // números de día: tira rápida; si no basta, tira más grande; por último celda a celda
  let head = null;
  const strong = () => head && head.votes >= Math.max(4, nCols * 0.4);
  for (const mode of ['tira', 'tira-grande', 'celdas']) {
    for (const ri of mode === 'celdas' ? [1, 0] : [1, 0, 2]) {
      if (ri >= rows.length) continue;
      const nums = await readNumbers(tess, RP, b, rows[ri], cw, mode);
      if (D && nums.strip) D.extra.push(nums.strip);
      if (D) (D.info.headTries ||= []).push(`${mode}/${ri}: ${nums.texts.join(' ')}`);
      if (!head || nums.votes > head.votes) head = { ...nums, row: ri };
      if (strong()) break;
    }
    if (strong()) break;
  }
  if (D) D.info.head = head && { off: head.off, votes: head.votes, row: head.row, texts: head.texts.join(' ') };
  if (!head || head.votes < 3) return finish(res, D, 'No se pudieron leer los números de los días.');
  res.layout = 'pc-grid';
  const dayOf = (j) => j + head.off; // j = índice de columna
  // días de la semana (fila sobre los números)
  let wds = null;
  if (head.row >= 1) wds = await readWeekdays(tess, RP, b, rows[head.row - 1], cw);
  if (D) D.info.wds = wds && wds.join(',');
  // fines de semana: texto rojo en la cabecera
  const redHead = weekendRed(RP, b, rows[head.row], head.row >= 1 ? rows[head.row - 1] : null);
  if (D) D.info.redHead = redHead.join('');

  tm('cabecera');
  // 3. Mes y año (título sobre la tabla)
  prog(0.4, 'Leyendo el mes');
  const tx = b[0] - 5 * cw; const ty = rows[0][0] - 5.5 * rh;
  const titleCanvas = warp(src, P.w, P.h, mul(H, [1, 0, tx - ox, 0, 1, ty - oy, 0, 0, 1]), Math.round(b[nCols] - b[0] + 12 * cw), Math.round(5.3 * rh));
  const ctxM = { nCols, wds, redHead, dayOf, complete: chainComplete(G, b, cw) };
  let my = null; const titleTexts = [];
  for (const cv of [flattenGray(titleCanvas, Math.round(1.5 * rh)), titleCanvas]) {
    const t = await ocr(tess, cv, { psm: 11 });
    titleTexts.push(t.text.replace(/\s+/g, ' ').slice(0, 160));
    const r = resolveMonth(t, ctxM);
    if (r && (!my || r.score > my.score)) my = r;
    if (my && !my.weak) break;
  }
  if (D) { D.extra.push(titleCanvas); D.info.title = titleTexts; }
  if (!my) {
    // respaldo: zona más alta sobre la tabla (el título puede estar más arriba); más barato que toda la foto
    const ty2 = rows[0][0] - 10 * rh;
    const big = warp(src, P.w, P.h, mul(H, [1, 0, tx - ox, 0, 1, ty2 - oy, 0, 0, 1]), Math.round(b[nCols] - b[0] + 12 * cw), Math.round(10 * rh));
    const t = await ocr(tess, flattenGray(big, Math.round(1.5 * rh)), { psm: 11 });
    if (D) D.info.title.push(t.text.replace(/\s+/g, ' ').slice(0, 160));
    my = resolveMonth(t, ctxM);
  }
  // último recurso: el calendario (nº de días, días de la semana) cerca de la fecha actual
  if (!my) my = calendarGuess(ctxM, options.now ? new Date(options.now) : new Date());
  if (D) D.info.month = my;
  // comprobación: los días de la semana leídos deben cuadrar con el mes elegido
  if (my && wds) {
    const nd = daysInMonth(my.year, my.month); let ag = 0; let di = 0;
    wds.forEach((wd, j) => { const d = dayOf(j); if (wd < 0 || d < 1 || d > nd) return; if (weekdayIdx(my.year, my.month, d) === wd) ag++; else di++; });
    if (ag + di >= 5 && di > 0.25 * (ag + di)) my = null;
  }
  if (my) { res.month = my.month; res.year = my.year; if (my.weak) res.warnings.push('Revisa el mes: no se leyó con claridad.'); } else res.warnings.push('No se pudo leer el mes del plan.');

  tm('mes');
  // 4. Fila del empleado
  prog(0.5, 'Buscando tu fila');
  const pk = await pickBlock(tess, RP, G, b, rows, head.row, who, D);
  if (D) D.info.pick = { hits: pk.hits, otherName: !!pk.otherName, nameMismatch: pk.nameMismatch || null, needFullName: !!pk.needFullName };
  if (!pk.blk) {
    if (pk.needFullName) {
      res.warnings.push(`Hay varias filas en la hoja y con «${who.label}» no se sabe cuál es la tuya. Pon tu nombre como sale en el plan (Ajustes → Tu nombre).`);
      return finish(res, D);
    }
    res.warnings.push(`No se encontró la fila de ${who.label}.`);
    if (pk.hits > 1) res.warnings.push(who.tokens.length > 1 ? `Hay varias filas parecidas a ${who.label} en la tabla y no se sabe cuál es la tuya.` : `Hay varias filas de ${who.label} en la tabla: pon tu nombre completo, como sale en el plan.`);
    else if (pk.hits === 0 && who.given && who.tokens.length) res.warnings.push('Comprueba que tu nombre esté escrito como en el plan y que se vea en la foto.');
    return finish(res, D);
  }
  const blk = pk.blk;
  // tabla de una sola fila con otro nombre (p. ej. la impresión filtrada de otra persona): se lee, pero
  // si se ve el apellido y falta el nombre de pila, los días quedan «por revisar» (confianza baja)
  if (pk.nameMismatch) res.warnings.push(otherSheetWarning(who.label, pk.nameMismatch));
  else if (pk.otherName) res.warnings.push(`Revisa que el plan sea de ${who.label}: no se lee ese nombre en la fila.`);
  const confCap = pk.nameMismatch ? OTHER_SHEET_CONF : 1;

  // 5. Insignias por celda
  prog(0.6, 'Leyendo los turnos');
  const top = Math.round(blk.v0 + 2); const bot = Math.round(blk.v1 - 2);
  const gains = whiteGains(RP, Math.round(b[0]), top, Math.round(b[nCols]), bot);
  const maxDay = my ? daysInMonth(my.year, my.month) : 31;
  // filas a ignorar (líneas de la rejilla dentro del bloque, ±4 px)
  const skip = skipRows(bot - top + 1, [blk.v0, ...blk.sub, blk.v1].map((v) => v - top), 4);
  // factor de alta resolución: píxeles de la foto original por píxel rectificado
  const hiF = L.orig ? Math.min(2.5, 1 / (scale * L.scale)) : 1;
  if (D) D.info.hiF = +hiF.toFixed(2);
  const days = [];
  for (let j = 0; j < nCols; j++) {
    const day = dayOf(j); if (day < 1 || day > maxDay) continue;
    const x0 = Math.round(b[j] + 3); const x1 = Math.round(b[j + 1] - 3);
    // la columna debe estar dentro de la foto
    const corners = [[b[j], blk.v0], [b[j + 1], blk.v0], [b[j], blk.v1], [b[j + 1], blk.v1]].map(([u, v]) => toImg(u, v));
    if (corners.some(([x, y]) => x < 1 || y < 1 || x > P.w - 2 || y > P.h - 2)) continue;
    let cell;
    if (hiF > 1.2) {
      // celda remuestreada desde la foto original (más resolución para el texto de las insignias)
      const PP = hiPatch(L, H, ox, oy, x0, top, x1 - x0 + 1, bot - top + 1, hiF);
      const C = regionHSV(PP, 0, 0, PP.w - 1, PP.h - 1, cellGains(PP, 0, 0, PP.w - 1, PP.h - 1) || gains);
      cell = await readCell(tess, PP, C, { cw: cw * hiF, rh: rh * hiF, known, sub: blk.sub.map((v) => (v - top) * hiF), skip: skipRows(PP.h, [blk.v0, ...blk.sub, blk.v1].map((v) => (v - top) * hiF), 4 * hiF) });
    } else {
      const C = regionHSV(RP, x0, top, x1, bot, cellGains(RP, x0, top, x1, bot) || gains);
      cell = await readCell(tess, RP, C, { cw, rh, known, sub: blk.sub.map((v) => v - top), skip });
    }
    Object.assign(cell, { day, j, x0, y0: top, F: hiF > 1.2 ? hiF : 1, contrast: cellContrast(RP, b[j], b[j + 1], top, bot) });
    days.push(cell);
    prog(0.6 + (0.36 * (j + 1)) / nCols, 'Leyendo los turnos');
  }
  // celdas con la rejilla casi invisible (reflejo, dedo): no se pueden leer con seguridad
  const medC = median(days.map((d) => d.contrast));
  for (const d of days) if (d.contrast < 0.45 * medC) { d.lowVis = true; d.items.push({ code: null, conf: 0, cls: 'reflejo', comp: { x0: 0, y0: 0, x1: 4, y1: 4 }, raw: [d.contrast.toFixed(2)] }); }
  tm('celdas');
  // decisión conjunta de las insignias (con consenso entre insignias iguales)
  const badges = []; for (const d of days) for (const it of d.items) if (it.ev) { it.ev.day = d.day; badges.push(it); }
  const dec = decideAll(badges.map((it) => it.ev), options.decide);
  badges.forEach((it, i) => { it.code = dec[i].code; it.conf = dec[i].conf; it.isNew = !!dec[i].isNew; });
  for (const d of days) {
    d.ok = d.items.every((i) => i.code);
    d.conf = Math.min(1, ...d.items.filter((i) => i.code).map((i) => i.conf));
    d.codes = [...new Set(d.items.filter((i) => i.code).map((i) => i.code))];
    if (d.items.some((i) => i.isNew)) res.warnings.push(`Código nuevo: ${d.items.filter((i) => i.isNew).map((i) => i.code).join(', ')}`);
  }
  for (const d of days) if (d.ok) res.days.push({ day: d.day, codes: d.codes, confidence: +Math.min(d.conf, confCap).toFixed(2) });
  if (days.some((d) => !d.ok)) res.warnings.push('Algunos días no se pudieron leer con seguridad.');
  res.warnings = [...new Set(res.warnings)];
  if (D) {
    D.days = days; D.info.blk = { v0: blk.v0, v1: blk.v1, sub: blk.sub }; D.blkBottom = blk.v1;
    if (D.crop) D.crop[3] = Math.min(D.rc.height, Math.max(D.crop[3], blk.v1 + 22));
    D.info.cells = days.map((d) => `${d.day}:${d.ok ? '' : '?'}c${d.contrast.toFixed(2)} ${d.items.map((i) => `${i.cls}=${i.code}${i.raw ? '[' + i.raw.join('/') + ']' : ''}`).join(' ')}`);
    D.info.badges = badges.map((it) => it.ev);
  }
  prog(1, 'Listo');
  return finish(res, D);
}

// Intervalos de fila a partir de las líneas horizontales (corrige líneas perdidas o espurias)
function buildRows(hl) {
  const ls = hl.slice().sort((a, b) => a - b);
  if (ls.length < 2) return [];
  const hs = []; for (let i = 0; i + 1 < ls.length; i++) hs.push(ls[i + 1] - ls[i]);
  const rh = median(hs.filter((h) => h > 8));
  // quitar líneas demasiado cercanas
  const keep = [ls[0]];
  for (let i = 1; i < ls.length; i++) if (ls[i] - keep[keep.length - 1] >= 0.45 * rh) keep.push(ls[i]); else if (i === ls.length - 1) keep[keep.length - 1] = ls[i];
  const rows = [];
  for (let i = 0; i + 1 < keep.length; i++) {
    const a = keep[i]; const z = keep[i + 1]; const k = Math.max(1, Math.round((z - a) / rh));
    for (let s = 0; s < k; s++) rows.push([a + ((z - a) * s) / k, a + ((z - a) * (s + 1)) / k, k > 1]);
  }
  return rows;
}

// OCR de los números de día de una fila → desplazamiento (día = índice + off)
async function readNumbers(tess, RP, b, row, cw, mode = 'tira') {
  const rhh = row[1] - row[0];
  const k = Math.min(3, Math.max(0.8, (mode === 'tira' ? 26 : 36) / (0.5 * rhh)));
  const crops = [];
  for (let j = 0; j + 1 < b.length; j++) {
    const c = grayCrop(RP, b[j] + 0.1 * cw, row[0] + 0.12 * rhh, b[j + 1] - 0.1 * cw, row[1] - 0.12 * rhh, k);
    crops.push(c && c.contrast > 25 ? c.canvas : null);
  }
  let per; let st = null;
  if (mode === 'celdas') {
    per = [];
    for (const c of crops) {
      if (!c) { per.push({ text: '' }); continue; }
      const one = strip([c], 0, 12);
      per.push(await ocr(tess, one.canvas, { psm: 7, whitelist: '0123456789' }));
    }
  } else {
    st = strip(crops, Math.round(cw * k * (mode === 'tira' ? 0.4 : 0.7)));
    per = await readStrip(tess, st, { whitelist: '0123456789', psm: 7 });
  }
  const votes = new Map(); const texts = [];
  per.forEach((p, j) => {
    const t = p.text.replace(/\D/g, ''); texts.push(t || '_');
    if (!t || t.length > 2) return;
    const n = Number(t); if (n < 1 || n > 31) return;
    const off = n - j; votes.set(off, (votes.get(off) || 0) + 1);
  });
  let best = { off: 0, votes: 0 }; for (const [off, v] of votes) if (v > best.votes) best = { off, votes: v };
  return { ...best, texts, strip: st && st.canvas };
}

async function readWeekdays(tess, RP, b, row, cw) {
  const rhh = row[1] - row[0];
  const k = Math.min(3, Math.max(0.8, 26 / (0.5 * rhh)));
  const crops = [];
  for (let j = 0; j + 1 < b.length; j++) {
    const c = grayCrop(RP, b[j] + 0.08 * cw, row[0] + 0.1 * rhh, b[j + 1] - 0.08 * cw, row[1] - 0.1 * rhh, k);
    crops.push(c && c.contrast > 25 ? c.canvas : null);
  }
  const st = strip(crops, Math.round(cw * k * 0.4));
  const per = await readStrip(tess, st, { whitelist: 'MoDiMiDoFrSa', psm: 7 });
  return per.map((p) => weekdayFromText(p.text));
}

// Columnas con texto rojo en la cabecera (sábados y domingos): 1 = rojo, 0 = no, -1 = sin datos.
// Se compara la rojez de la tinta de cada columna con la mediana (inmune a la luz cálida).
function weekendRed(RP, b, numRow, wdRow) {
  const vals = [];
  for (let j = 0; j + 1 < b.length; j++) {
    const px = [];
    for (const row of [numRow, wdRow]) {
      if (!row) continue;
      for (let v = Math.round(row[0] + 3); v < row[1] - 3; v++) for (let u = Math.round(b[j] + 3); u < b[j + 1] - 3; u++) px.push(v * RP.w + u);
    }
    const ys = px.map((p) => RP.Y[p]).sort((a, c) => a - c);
    const bg = ys[Math.floor(ys.length * 0.8)] || 0;
    let sr = 0; let n = 0;
    for (const p of px) if (RP.Y[p] < bg - 40) { sr += RP.R[p] - (RP.G[p] + RP.B[p]) / 2; n++; }
    vals.push(n > 6 ? sr / n : null);
  }
  const ok = vals.filter((v) => v !== null).sort((a, c) => a - c);
  if (ok.length < 5) return vals.map(() => -1);
  const med = ok[ok.length >> 1]; const mx = ok[ok.length - 1];
  const thr = med + Math.max(12, 0.4 * (mx - med));
  return vals.map((v) => (v === null ? -1 : v > thr ? 1 : 0));
}

// ¿La cadena de días está completa? (columna ancha del nombre a la izquierda y Soll a la derecha)
function chainComplete(G, b, cw) {
  const vb = G.vborders.map((p) => p.pos);
  const left = vb.some((x) => x < b[0] - 1.6 * cw);
  const right = !vb.some((x) => x > b[b.length - 1] + 0.5 * cw && x < b[b.length - 1] + 1.4 * cw);
  return left && right;
}

// Decide mes y año combinando el título, los días de la semana y el número de columnas
function resolveMonth(o, ctx) {
  const words = o.words.map((w) => w.text);
  const months = []; const years = []; const dates = dateCandidates(o.text);
  words.forEach((w, i) => {
    for (const c of monthCandidates(w)) {
      const nxt = words.slice(i + 1, i + 3).join(' ');
      const y = yearCandidates(nxt);
      months.push({ ...c, year: y[0] || null, conf: c.score + (o.words[i].conf || 0) / 400 });
    }
    for (const y of yearCandidates(w)) years.push(y);
  });
  const now = new Date();
  const cands = new Map();
  const add = (mo, y, s, why) => { const k = y * 100 + mo; const c = cands.get(k) || { month: mo, year: y, score: 0, why: [] }; c.score += s; c.why.push(why); cands.set(k, c); };
  for (const mc of months) {
    const ys = mc.year ? [mc.year] : years.length ? [...new Set(years)] : [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
    for (const y of ys) {
      add(mc.month, y, 3 * mc.conf + (mc.year ? 1 : 0), 'titulo');
      // un dígito del año mal leído (5↔6, 3↔8…): años vecinos con menos peso; decide el calendario
      if (mc.year) { add(mc.month, y - 1, 1.5 * mc.conf, 'titulo±1'); add(mc.month, y + 1, 1.5 * mc.conf, 'titulo±1'); }
    }
  }
  for (const d of dates) {
    for (const [dy, w] of [[0, 1], [-1, 0.4], [1, 0.4]]) {
      add(d.month, d.year + dy, 0.8 * w, 'fecha');
      add(d.month === 12 ? 1 : d.month + 1, (d.month === 12 ? d.year + 1 : d.year) + dy, 0.5 * w, 'fecha+1');
    }
  }
  if (!cands.size) return null;
  // restricciones del calendario
  for (const c of cands.values()) {
    const nd = daysInMonth(c.year, c.month);
    let agree = 0; let dis = 0;
    if (ctx.wds) ctx.wds.forEach((wd, j) => { const d = ctx.dayOf(j); if (wd < 0 || d < 1 || d > nd) return; if (weekdayIdx(c.year, c.month, d) === wd) agree++; else dis++; });
    let ra = 0; let rd = 0;
    ctx.redHead.forEach((r, j) => { const d = ctx.dayOf(j); if (r < 0 || d < 1 || d > nd) return; const we = weekdayIdx(c.year, c.month, d) >= 5; if ((r === 1) === we) ra++; else rd++; });
    Object.assign(c, { wdAgree: agree, wdDis: dis, redAgree: ra, redDis: rd });
    c.score += (2 * (agree - 2 * dis)) / Math.max(1, agree + dis) + (1.5 * (ra - 2 * rd)) / Math.max(1, ra + rd);
    const lastDay = ctx.dayOf(ctx.nCols - 1);
    if (ctx.complete && ctx.dayOf(0) === 1) c.score += lastDay === nd ? 1 : -2;
    else if (lastDay > nd) c.score -= 3;
  }
  const list = [...cands.values()].sort((a, b) => b.score - a.score);
  const best = list[0];
  if (best.score < 1) return null;
  best.weak = best.score < 2.5 || (list[1] && list[1].score > best.score - 0.8);
  return best;
}

// Mes deducido solo del calendario: el único mes cercano a "ahora" (−3…+4) compatible con los días de la semana
// leídos, los fines de semana en rojo y (si la tabla está completa) el número de días. Siempre "débil".
function calendarGuess(ctx, now) {
  const out = [];
  for (let k = -3; k <= 4; k++) {
    const d0 = new Date(now.getFullYear(), now.getMonth() + k, 1); const y = d0.getFullYear(); const mo = d0.getMonth() + 1;
    const nd = daysInMonth(y, mo);
    if (ctx.complete && ctx.dayOf(0) === 1 && ctx.dayOf(ctx.nCols - 1) !== nd) continue;
    if (ctx.dayOf(ctx.nCols - 1) > nd) continue;
    let agree = 0; let dis = 0;
    if (ctx.wds) ctx.wds.forEach((wd, j) => { const d = ctx.dayOf(j); if (wd < 0 || d < 1 || d > nd) return; if (weekdayIdx(y, mo, d) === wd) agree++; else dis++; });
    ctx.redHead.forEach((r, j) => { const d = ctx.dayOf(j); if (r < 0 || d < 1 || d > nd) return; if ((r === 1) === (weekdayIdx(y, mo, d) >= 5)) agree += 0.5; else dis += 0.5; });
    if (agree >= 5 && dis <= 0.1 * agree) out.push({ month: mo, year: y, score: agree, dist: Math.abs(k - 0.5) });
  }
  // solo si es el único mes compatible en la ventana (si no, mejor que el usuario lo elija)
  if (out.length !== 1) return null;
  return { month: out[0].month, year: out[0].year, score: 1, why: ['calendario'], weak: true };
}

// Filas (de una región de alto h) a ±r de las líneas dadas
function skipRows(h, lines, r) {
  const sk = new Uint8Array(h);
  for (const lv of lines) for (let y = Math.round(lv - r); y <= Math.round(lv + r); y++) if (y >= 0 && y < h) sk[y] = 1;
  return sk;
}

// Parche rectificado de alta resolución (factor F respecto a la tabla rectificada) tomado de la foto original
function hiPatch(L, H, ox, oy, x0, y0, w, h, F) {
  const W = Math.round(w * F); const Hh = Math.round(h * F); const k = L.scale;
  const toOrig = (px, py) => { const [x, y] = apply(H, x0 + px / F - ox, y0 + py / F - oy); return [x / k, y / k]; };
  const cs = [[0, 0], [W, 0], [0, Hh], [W, Hh]].map(([a, c]) => toOrig(a, c));
  const bx = Math.max(0, Math.floor(Math.min(...cs.map((p) => p[0])) - 2)); const by = Math.max(0, Math.floor(Math.min(...cs.map((p) => p[1])) - 2));
  const ex = Math.min(L.origW, Math.ceil(Math.max(...cs.map((p) => p[0])) + 2)); const ey = Math.min(L.origH, Math.ceil(Math.max(...cs.map((p) => p[1])) + 2));
  const bw = Math.max(2, ex - bx); const bh = Math.max(2, ey - by);
  const t = makeCanvas(bw, bh); const tg = ctx2d(t); tg.drawImage(L.orig, bx, by, bw, bh, 0, 0, bw, bh);
  const data = tg.getImageData(0, 0, bw, bh).data; freeCanvas(t);
  const Hds = mul([1, 0, -bx, 0, 1, -by, 0, 0, 1], mul([1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1], mul(H, [1 / F, 0, x0 - ox, 0, 1 / F, y0 - oy, 0, 0, 1])));
  const pc = warp(data, bw, bh, Hds, W, Hh);
  const PP = planes(pc); freeCanvas(pc);
  return PP;
}

// Contraste de las líneas de una celda frente a su fondo (el mejor de los bordes izquierdo y derecho): 0..1
function cellContrast(RP, ua, ub, v0, v1) {
  const w = RP.w; const lines = [[], []]; const bg = [];
  for (let v = Math.round(v0); v <= Math.round(v1); v += 2) {
    [ua, ub].forEach((u, k) => { let mn = 255; for (let d = -4; d <= 4; d++) mn = Math.min(mn, RP.Y[v * w + Math.round(u) + d]); lines[k].push(mn); });
    for (let u = Math.round(ua + 0.25 * (ub - ua)); u <= ua + 0.75 * (ub - ua); u += 3) bg.push(RP.Y[v * w + u]);
  }
  const B = Math.max(1, percentile(bg, 0.85)); // fondo: claro (las insignias oscurecen la mediana)
  return Math.max(0, (B - Math.min(median(lines[0]), median(lines[1]))) / B);
}

// Elige el bloque (empleado) debajo de la cabecera. Cada empleado ocupa 3 sub-filas (ausencias, turno, lugar);
// las líneas que también cruzan la columna del nombre separan empleados.
// Con varias filas vale la única cuyo nombre leído contiene TODAS las palabras del nombre (SPEC §11); ninguna o
// varias → sin fila; con solo el apellido, ninguna (needFullName). Con una sola fila (impresión filtrada) se
// usa esa; si hay nombre, se comprueba: aviso, y si falta parte del nombre, nameMismatch (días por revisar).
// → { blk, hits, otherName, nameMismatch, needFullName }
async function pickBlock(tess, RP, G, b, rows, headRow, who, D) {
  const below = rows.slice(headRow + 1);
  if (below.length < 3) return { blk: null, hits: -1 };
  const cw = G.days.width; const w = RP.w;
  const t0 = rows[0][0]; const t1 = rows[rows.length - 1][1];
  // borde izquierdo de la tabla: vertical a la izquierda de los días que recorre toda la tabla
  let nameL = null;
  for (const p of G.vborders) {
    if (p.pos > b[0] - 1.8 * cw) break;
    let c = 0; let n = 0; const u = Math.round(p.pos);
    for (let v = Math.round(t0 + 2); v < t1 - 2; v++) { n++; const o = v * w; if (G.mV[o + u] || G.mV[o + u - 1] || G.mV[o + u + 1] || G.mV[o + u - 2] || G.mV[o + u + 2]) c++; }
    if (n && c / n > 0.7) { nameL = p.pos; break; }
  }
  // columna del nombre (si el borde izquierdo no se ve, se supone de ~4 columnas)
  const nL = nameL !== null ? nameL : Math.max(0, b[0] - 4 * cw);
  let blocks = [];
  {
    const full = [0];
    for (let i = 1; i < below.length; i++) {
      const v = Math.round(below[i][0]); let cov = 0; let n = 0;
      for (let u = Math.round(Math.max(nL, b[0] - 2.5 * cw) + 4); u < b[0] - 4; u++) { n++; for (let d = -2; d <= 2; d++) if (G.mH[(v + d) * w + u]) { cov++; break; } }
      if (n && cov / n > 0.6) full.push(i);
    }
    full.push(below.length);
    for (let i = 0; i + 1 < full.length; i++) blocks.push(below.slice(full[i], full[i + 1]));
  }
  // estructura no fiable: grupos de 3 sub-filas
  if (!blocks.length || blocks.some((bl) => bl.length !== 3)) {
    if (below.length % 3 !== 0) return { blk: null, hits: -1 };
    blocks = []; for (let i = 0; i < below.length; i += 3) blocks.push(below.slice(i, i + 3));
  }
  const mk = (bl) => ({ v0: bl[0][0], v1: bl[bl.length - 1][1], sub: bl.slice(1).map((r) => r[0]) });
  // OCR de la columna del nombre de un bloque → coincidencia con el nombre. flat: 2.ª lectura con el contraste
  // normalizado (foto borrosa o con moaré)
  const readName = async (bl, flat = false) => {
    const c = grayCrop(RP, nL + 3, bl[0][0] + 2, b[0] - 3, bl[bl.length - 1][1] - 2, 2);
    if (!c) return { ok: false, missing: who.tokens, legible: false };
    const cv = flat ? flattenGray(c.canvas, Math.round((2 * (bl[bl.length - 1][1] - bl[0][0])) / 3)) : c.canvas;
    const o = await ocr(tess, cv, { psm: 6 });
    const words = o.words.map((wd) => wd.text);
    const m = matchName(words, who.tokens);
    if (D) (D.info.names ||= []).push(`${flat ? 'flat ' : ''}${o.text.replace(/\s+/g, ' ')} → ${m.ok ? 'ok' : 'falta ' + m.missing.join(',')}`);
    return { ...m, legible: words.some((w) => /^[a-z]{4,}$/.test(normName(w))) };
  };
  if (blocks.length === 1) {
    if (!who.given || !who.tokens.length) return { blk: mk(blocks[0]), hits: 1 };
    const reads = [await readName(blocks[0])];
    if (!reads[0].ok && reads[0].legible) reads.push(await readName(blocks[0], true));
    // solo se avisa si se lee texto (con la columna del nombre fuera de la foto no se puede comprobar);
    // si se lee el apellido y falta el nombre de pila: nameMismatch (palabras que faltan)
    const c = checkSingleRow(reads, who.tokens);
    return { blk: mk(blocks[0]), hits: 1, otherName: c.otherName, nameMismatch: c.nameMismatch };
  }
  // varias filas: la única con todo el nombre (con solo el apellido, ninguna: needFullName)
  const r = await chooseRow(blocks.length, who.tokens, (i, flat) => readName(blocks[i], flat));
  return { blk: r.index >= 0 ? mk(blocks[r.index]) : null, hits: r.hits, needFullName: !!r.needFullName };
}

// Analiza una celda del empleado: insignias de color (con sus evidencias OCR), guion rojo, U roja
async function readCell(tess, RP, C, ctx) {
  const { cw, rh, known } = ctx;
  const items = [];
  const comps = cellComponents(C, 0.12, 12, ctx.skip, cw, rh);
  const badges = comps.filter((c) => isBadge(c, cw, rh));
  for (const c of badges) {
    const cls = colorClass(c);
    const sub = ctx.sub.filter((v) => c.cy > v).length;
    const ev = await badgeEvidence(tess, C, c, cls, known, sub);
    items.push({ cls, comp: c, ev, raw: ev.raw });
  }
  // marcas rojas fuera de las insignias: guion (ancho y fino) o U (letra), solo en la línea de ausencias
  const line0 = ctx.sub.length ? ctx.sub[0] : Infinity;
  for (const r of comps) {
    if (r.kind !== 'red') continue;
    const k = r.core || { w: r.bw, h: r.bh };
    if (r.maxRd < 20) continue;
    // halo rojizo pegado a una insignia (borde de W-/Z1): no es una marca
    if (badges.some((bd) => r.x0 <= bd.x1 + 4 && r.x1 >= bd.x0 - 4 && r.y0 <= bd.y1 + 4 && r.y1 >= bd.y0 - 4)) continue;
    const geo = `${k.w}x${k.h}/${r.bw}x${r.bh} rd${Math.round(r.maxRd)} q${r.redRatio.toFixed(2)}`;
    const inLine0 = r.cy < line0 - 2;
    if (inLine0 && k.w >= 0.12 * cw && k.w <= 0.5 * cw && k.h <= 0.5 * k.w && k.h <= 0.22 * rh && r.maxRd >= 25) { items.push({ code: '-', conf: 0.9, cls: 'dash', comp: r, raw: [geo] }); continue; }
    if (inLine0 && r.maxRd >= 28 && k.h >= 0.24 * rh && k.h <= 0.75 * rh && k.w <= 1.1 * k.h && k.w >= 0.12 * cw) {
      // confirmación por OCR: el texto "W-" de una etiqueta descolorida (reflejo) parece una U roja
      const g = grayCrop(RP, C.x0 + r.x0 - 0.15 * cw, C.y0 + r.y0 - 0.12 * rh, C.x0 + r.x1 + 0.35 * cw, C.y0 + r.y1 + 0.12 * rh, Math.max(1, 34 / Math.max(6, k.h)));
      const o = g ? await ocr(tess, g.canvas, { psm: 7, whitelist: 'UW-' }) : { text: '' };
      if (/W/i.test(o.text) || (r.maxRd < 40 && !/U/i.test(o.text))) { items.push({ code: null, conf: 0, cls: 'U?', comp: r, raw: [geo, o.text] }); continue; }
      items.push({ code: 'U', conf: 0.8, cls: 'U', comp: r, raw: [geo, o.text] }); continue;
    }
    if (r.area >= 0.01 * cw * cw) items.push({ code: null, conf: 0, cls: 'red?', comp: r, raw: [geo] });
  }
  // guion gris (rojo descolorido): marca oscura con forma de guion en la línea de ausencias
  if (Number.isFinite(line0)) {
    const used = items.map((i) => i.comp);
    for (const g of darkMarks(C, ctx.skip, line0)) {
      if (used.some((u) => u.x0 <= g.x1 + 2 && u.x1 >= g.x0 - 2 && u.y0 <= g.y1 + 2 && u.y1 >= g.y0 - 2)) continue;
      if (g.bw >= 0.12 * cw && g.bw <= 0.5 * cw && g.bh <= 0.5 * g.bw && g.bh <= 0.22 * rh && g.area >= 0.5 * g.bw) items.push({ code: '-', conf: 0.7, cls: 'dash-gris', comp: g, raw: [`${g.bw}x${g.bh}`] });
    }
  }
  // la línea de ausencias admite una sola marca (guion, U o W-): si hay varias, la celda es dudosa
  const top0 = items.filter((i) => (i.cls === 'dash' || i.cls === 'dash-gris' || i.cls === 'U' || (i.ev && i.ev.cls === 'pink' && i.ev.sub === 0)));
  if (top0.length > 1) items.push({ code: null, conf: 0, cls: 'varias', comp: top0[1].comp, raw: [top0.map((i) => i.cls).join('+')] });
  // manchas de color que no son insignias ni marcas rojas (insignia cortada, tapada…): celda dudosa
  const marks = items.filter((i) => !i.ev).map((i) => i.comp);
  for (const c of comps) {
    if (c.kind !== 'col' || isBadge(c, cw, rh) || c.area < 0.06 * cw * cw || c.bh < 0.25 * rh || c.bw < 0.2 * cw) continue;
    if (marks.some((r) => r.x0 <= c.x1 + 2 && r.x1 >= c.x0 - 2 && r.y0 <= c.y1 + 2 && r.y1 >= c.y0 - 2)) continue;
    items.push({ code: null, conf: 0, cls: 'col?', comp: c, raw: [`${c.bw}x${c.bh} f${c.fill.toFixed(2)}`] });
  }
  // tinta sin explicar (marca no reconocida): una celda "vacía" solo se acepta si de verdad está limpia
  const ink = residualInk(C, items, ctx.skip);
  if (ink > Math.max(8, 0.006 * C.w * C.h)) items.push({ code: null, conf: 0, cls: 'mancha', comp: { x0: 0, y0: 0, x1: C.w - 1, y1: C.h - 1 }, raw: [String(ink)] });
  return { items };
}

// Componentes oscuros (cualquier color) en la línea de ausencias, fuera de las líneas de la rejilla
function darkMarks(C, skip, line0) {
  const m = new Uint8Array(C.w * C.h);
  for (let y = 1; y < Math.min(C.h - 1, line0 - 2); y++) {
    if (skip && skip[y]) continue;
    for (let x = 1; x < C.w - 1; x++) { const q = y * C.w + x; if (C.bgL - C.L[q] > 0.12) m[q] = 1; }
  }
  return components(m, C.w, C.h, 6).comps.map((c) => ({ ...c, bw: c.x1 - c.x0 + 1, bh: c.y1 - c.y0 + 1 }));
}

// Píxeles oscuros o de color fuera de las líneas y de los elementos detectados
function residualInk(C, items, skip) {
  const boxes = items.map((i) => i.comp);
  let n = 0;
  for (let y = 1; y < C.h - 1; y++) {
    if (skip && (skip[y] || skip[y - 1] || skip[y + 1])) continue;
    for (let x = 1; x < C.w - 1; x++) {
      const q = y * C.w + x;
      if (!(C.bgL - C.L[q] > 0.15 || C.S[q] > 0.2)) continue;
      if (boxes.some((b) => x >= b.x0 - 3 && x <= b.x1 + 3 && y >= b.y0 - 3 && y <= b.y1 + 3)) continue;
      n++;
    }
  }
  return n;
}

// Evidencias de una insignia: lecturas OCR (hasta 4 variantes), plantillas y firma para el consenso
async function badgeEvidence(tess, C, comp, cls, known, sub) {
  const cands = classCandidates(cls, known);
  const ev = { cls, sub, cands, known, reads: [], tm: null, sig: null, asp: 1, raw: [] };
  if (!cands.length) { ev.raw.push('clase ' + cls); return ev; }
  // texto blanco en N1/TS (azul) y S31 (rojo); oscuro en el resto
  const light = cls === 'blue' || cls === 'red';
  const I = badgeInk(C, comp, light ? 'light' : 'dark', light ? 0.72 : 0.8);
  const tm = matchCodes(I.ink, I.w, I.h, cands);
  ev.tm = Object.fromEntries(tm.map((t) => [t.code, +t.score.toFixed(3)]));
  const sg = inkSignature(I.ink, I.w, I.h); if (sg) { ev.sig = sg.sig; ev.asp = +sg.asp.toFixed(3); }
  ev.raw.push('T:' + tm.slice(0, 2).map((t) => `${t.code}${t.score.toFixed(2)}`).join(','));
  const tries = [{ textH: 34, wl: 'FSNZTUW0123456789-' }, { textH: 26, wl: 'FSNZTUW0123456789-' }, { textH: 44, wl: '' }, { textH: 34, wl: 'FSNZTUW0123456789-', bin: true }];
  for (let t = 0; t < tries.length; t++) {
    const cv = inkCanvas(I, tries[t].textH, !!tries[t].bin);
    if (t === 0 && sheet) sheet.push(cv);
    const o = await ocr(tess, cv, { psm: 7, whitelist: tries[t].wl });
    const read = normalizeRead(o.text, cls);
    ev.reads.push({ t: read, c: +(o.conf / 100).toFixed(2) });
    ev.raw.push(read + ':' + Math.round(o.conf));
    if (cands.length === 1 && cands.includes(read.toUpperCase()) && o.conf >= 85) break;
    // dos lecturas iguales, seguras y de un código conocido: basta
    if (t >= 1 && cands.includes(read.toUpperCase()) && ev.reads.filter((r) => r.t === read && r.c >= 0.8).length >= 2) break;
  }
  // plantilla también para los códigos nuevos leídos (para compararlos con los conocidos)
  const fresh = [...new Set(ev.reads.map((r) => exactNewCode(r.t, cls, known)).filter(Boolean))];
  if (fresh.length) for (const t of matchCodes(I.ink, I.w, I.h, fresh)) ev.tm[t.code] = +t.score.toFixed(3);
  return ev;
}

async function finish(res, D, why) {
  if (why) res.warnings.push(why);
  if (D && D.ov) {
    const parts = [D.ov.c];
    if (D.rc) {
      const g = ctx2d(D.rc); g.lineWidth = 2; g.font = 'bold 12px sans-serif';
      if (D.days) for (const d of D.days) {
        for (const it of d.items) {
          const c = it.comp; g.strokeStyle = it.code ? 'rgba(0,150,0,0.9)' : 'rgba(255,0,0,0.9)';
          const F = d.F || 1;
          g.strokeRect(d.x0 + c.x0 / F - 1, d.y0 + c.y0 / F - 1, (c.x1 - c.x0) / F + 3, (c.y1 - c.y0) / F + 3);
          g.fillStyle = it.code ? '#060' : '#c00'; g.fillText(it.code || '?', d.x0 + c.x0 / F, d.y0 + c.y1 / F + 12);
        }
        g.fillStyle = d.ok ? '#060' : '#c00'; g.fillText(String(d.day), d.x0 + 2, (D.blkBottom || D.rc.height - 20) + 16);
      }
      if (D.crop) {
        const [x0, y0, x1, y1] = D.crop.map(Math.round); const c = makeCanvas(x1 - x0, y1 - y0);
        ctx2d(c).drawImage(D.rc, -x0, -y0); parts.push(c);
      } else parts.push(D.rc);
    }
    parts.push(...D.extra);
    if (sheet && sheet.length) {
      const sh = sheet; const cols = 12; const cwd = 150; const chh = 90;
      const c = makeCanvas(cols * cwd, Math.ceil(sh.length / cols) * chh); const g = ctx2d(c); g.fillStyle = '#888'; g.fillRect(0, 0, c.width, c.height);
      sh.forEach((x, i) => g.drawImage(x, (i % cols) * cwd, Math.floor(i / cols) * chh, Math.min(cwd - 4, x.width), Math.min(chh - 4, x.height)));
      parts.push(c);
    }
    res.debug = { overlay: await D.lib.toDataURL(D.lib.stack(parts, 2000)), info: D.info };
  }
  return res;
}
