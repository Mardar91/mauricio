// Análisis de cada fila rectificada: balance de blancos local, clases de color, columna de texto,
// insignias (círculos, hexágono, etiqueta), guion rojo, "U" y comprobación de contenido sin explicar.
import { hsv, components, filledMask } from './raster.js';
import { median } from './geom.js';

// Clases de píxel
export const C = { BG: 0, DARK: 1, RED: 2, PINK: 3, YELLOW: 4, GREEN: 5, BLUE: 6, MAGENTA: 7, OTHER: 8 };
export const CLS_NAME = ['bg', 'dark', 'red', 'pink', 'yellow', 'green', 'blue', 'magenta', 'other'];
export const REF = 235; // nivel al que se lleva el fondo

// Clasifica un color ya balanceado (fondo ≈ REF gris). Admite valores > 255.
export function classify(r, g, b) {
  const [h, s, v] = hsv(r, g, b);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (s < 0.15 || chroma < 26) return lum < 150 ? C.DARK : C.BG;
  if (h >= 40 && h < 78) return s >= 0.33 ? C.YELLOW : (lum < 150 ? C.DARK : C.BG);
  if (h >= 78 && h < 175) return s >= 0.24 ? C.GREEN : (lum < 150 ? C.DARK : C.BG);
  if (h >= 175 && h < 265) return s >= 0.3 ? C.BLUE : (lum < 150 ? C.DARK : C.BG);
  if (h >= 265 && h < 335) return s >= 0.3 ? C.MAGENTA : C.PINK;
  if (h >= 335 || h < 22) {
    if (s >= 0.42) return C.RED;
    return v >= 150 ? C.PINK : C.DARK;
  }
  return C.OTHER; // naranja/piel
}

// Fondo de la franja: mediana de los píxeles claros, refinada con los cercanos a ella.
function estimateBg(d, W, valid, ja, jb) {
  const px = []; let nInvalid = 0;
  for (let j = ja; j <= jb; j += 2) for (let i = 0; i < W; i += 2) {
    const p = j * W + i; if (!valid[p]) { nInvalid++; continue; }
    const q = p * 4; px.push([d[q], d[q + 1], d[q + 2], 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2]]);
  }
  if (!px.length || nInvalid > 0.02 * (px.length + nInvalid)) return null;
  const lt = median(px.map((p) => p[3]));
  const hi = px.filter((p) => p[3] >= lt);
  let bg = [0, 1, 2].map((c) => median(hi.map((p) => p[c])));
  for (let it = 0; it < 2; it++) {
    const near = px.filter((p) => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) < 40);
    if (near.length < 20) break;
    bg = [0, 1, 2].map((c) => median(near.map((p) => p[c])));
  }
  return bg;
}

// Analiza la franja de la fila [j0, j1] de la imagen canónica.
export function analyzeRow(img, valid, row, P) {
  const W = img.w; const d = img.data;
  const m = Math.max(1, Math.round(0.06 * P));
  const ja = Math.max(0, Math.ceil(row.j0 + m)), jb = Math.min(img.h - 1, Math.floor(row.j1 - m));
  const h = jb - ja + 1;
  if (h < 8) return null;
  const bg = estimateBg(d, W, valid, ja, jb);
  if (!bg) return { invalid: true };
  const kr = REF / Math.max(30, bg[0]), kg = REF / Math.max(30, bg[1]), kb = REF / Math.max(30, bg[2]);
  // color balanceado, clase y distancia al fondo por píxel
  const cls = new Uint8Array(W * h); const dist = new Float32Array(W * h); const lumB = new Float32Array(W * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < W; i++) {
    const q = ((ja + j) * W + i) * 4; const r = d[q] * kr, g = d[q + 1] * kg, b = d[q + 2] * kb; const p = j * W + i;
    cls[p] = classify(r, g, b);
    dist[p] = Math.hypot(r - REF, g - REF, b - REF);
    lumB[p] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  const res = { ja, jb, bg, bgLum: 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2], items: [], text: [], foreign: 0, residual: 0, k: [kr, kg, kb] };
  const box = (c, extra) => ({ x0: c.x0, x1: c.x1, y0: c.y0 + ja, y1: c.y1 + ja, cx: c.cx, cy: c.cy + ja, area: c.area, ...extra });

  // 1) columna de texto (número + día): tinta oscura, roja o rosada, umbral tolerante (texto gris claro)
  const textMask = new Uint8Array(W * h); const iT = Math.round(0.24 * W);
  for (let j = 0; j < h; j++) for (let i = 0; i < iT; i++) {
    const p = j * W + i; const c = cls[p];
    if (c === C.DARK || c === C.RED || c === C.PINK || (c === C.BG && lumB[p] < 185)) textMask[p] = 1;
  }
  const tc = components(textMask, W, h, 3);
  for (const c of tc.comps) {
    const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
    if (c.x0 < 0.15 * W && c.x1 < 0.22 * W && ch >= 0.06 * P && ch <= 0.5 * P && cw <= 0.2 * W) {
      let red = 0, sl = 0; for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const p = y * W + x; if (tc.labels[p] === c.id) { sl += lumB[p]; if (cls[p] === C.RED || cls[p] === C.PINK) red++; } }
      res.text.push(box(c, { red: red / c.area, lum: sl / c.area }));
    }
  }
  const textRight = res.text.length ? Math.max(...res.text.map((t) => t.x1)) : Math.round(0.12 * W);

  // 2) insignias por clase de color
  for (const k of [C.RED, C.PINK, C.YELLOW, C.GREEN, C.BLUE, C.MAGENTA]) {
    const mk = new Uint8Array(W * h); let any = 0;
    for (let p = 0; p < W * h; p++) if (cls[p] === k) { mk[p] = 1; any++; }
    if (any < 10) continue;
    const cc = components(mk, W, h, 6);
    for (const c of cc.comps) {
      const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
      if (c.x0 <= textRight) continue; // columna de texto / marcador de hoy
      if (ch >= 0.35 * P && cw >= 0.3 * P && ch <= 1.0 * P && cw <= 1.6 * P) {
        const fm = filledMask(cc.labels, W, c);
        const shape = shapeOf(fm);
        if (shape.fill < 0.62 || shape.aspect < 0.65 || shape.aspect > 1.7) continue;
        if (c.area < 0.45 * shape.fArea) continue; // anillo antialias alrededor de otra insignia
        res.items.push(box(c, { type: 'badge', cls: k, ...shape, fm, fmOy: ja }));
      }
    }
  }
  dedupe(res.items);
  // 2b) insignias pálidas (poco saturadas): regiones redondas lejos del color del fondo
  const inItems = (i, y, pad = 2) => res.items.some((t) => i >= t.x0 - pad && i <= t.x1 + pad && y >= t.y0 - pad && y <= t.y1 + pad);
  {
    const mk = new Uint8Array(W * h);
    for (let j = 0; j < h; j++) for (let i = textRight + 1; i < W; i++) { const p = j * W + i; if (dist[p] >= 32 && !inItems(i, j + ja)) mk[p] = 1; }
    const cc = components(mk, W, h, 20);
    for (const c of cc.comps) {
      const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
      if (!(ch >= 0.4 * P && cw >= 0.35 * P && ch <= 1.0 * P && cw <= 1.6 * P)) continue;
      if (c.cx > 0.72 * W || c.x1 > 0.9 * W) continue; // las insignias van a la izquierda; lo demás lo juzga el residuo
      const fm = filledMask(cc.labels, W, c); const shape = shapeOf(fm);
      if (shape.fill < 0.65 || shape.aspect < 0.7 || shape.aspect > 1.6) continue;
      // color dominante (píxeles de la región sin el texto: los más claros)
      const cols = [];
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) { const p = y * W + x; if (cc.labels[p] === c.id && lumB[p] >= 150) { const q = ((y + ja) * W + x) * 4; cols.push([d[q] * kr, d[q + 1] * kg, d[q + 2] * kb]); } }
      if (cols.length < 0.3 * c.area) continue;
      const mcol = [0, 1, 2].map((t) => median(cols.map((v) => v[t])));
      const [hh, ss] = hsv(mcol[0], mcol[1], mcol[2]);
      const k = (hh >= 285 || hh < 25) && ss >= 0.08 ? C.PINK : null;
      if (k == null) { res.items.push(box(c, { type: 'unknown', cls: C.OTHER, mean: mcol })); continue; }
      res.items.push(box(c, { type: 'badge', cls: k, faint: true, ...shape, fm, fmOy: ja, mean: mcol }));
    }
  }
  // 3) marcas pequeñas (guion, "U", texto suelto) en la zona de contenido, fuera de las insignias
  const badges = res.items.slice();
  const inBadge = (i, y) => badges.some((t) => i >= t.x0 - 2 && i <= t.x1 + 2 && y >= t.y0 - 2 && y <= t.y1 + 2);
  const mm = new Uint8Array(W * h);
  const iMax = Math.round(0.96 * W); // sin la barra de desplazamiento del borde derecho
  // contraste respecto al entorno (media local sin insignias ni texto): los reflejos tiñen zonas enteras
  const Rm = Math.max(2, Math.round(0.2 * P));
  const wt0 = new Uint8Array(W * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < W; i++) wt0[j * W + i] = i <= textRight + 1 || inBadge(i, j + ja) ? 0 : 1;
  const locM = localMean(d, W, ja, h, Rm, [kr, kg, kb], wt0);
  const ldist = (p) => { const q = ((ja + ((p / W) | 0)) * W + (p % W)) * 4; return Math.hypot(d[q] * kr - locM[p * 3], d[q + 1] * kg - locM[p * 3 + 1], d[q + 2] * kb - locM[p * 3 + 2]); };
  for (let j = 0; j < h; j++) for (let i = textRight + 2; i < iMax; i++) {
    const p = j * W + i; const c = cls[p];
    if ((c === C.RED || c === C.DARK || (c === C.PINK && lumB[p] < 200)) && !inBadge(i, j + ja) && ldist(p) >= 35) mm[p] = 1;
  }
  const mc = components(mm, W, h, 4);
  for (const c of mc.comps) {
    const ch = c.y1 - c.y0 + 1, cw = c.x1 - c.x0 + 1;
    if (ch > 0.45 * P || cw > 0.6 * P) continue; // grandes: los juzga el control de residuos
    let sr = 0, sg = 0, sb = 0, red = 0, lr = 0, lg = 0, lb = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const p = y * W + x; if (mc.labels[p] !== c.id) continue;
      const q = ((y + ja) * W + x) * 4; sr += d[q] * kr; sg += d[q + 1] * kg; sb += d[q + 2] * kb; if (cls[p] === C.RED) red++;
      lr += locM[p * 3]; lg += locM[p * 3 + 1]; lb += locM[p * 3 + 2];
    }
    const mean = [sr / c.area, sg / c.area, sb / c.area];
    // color relativo al entorno (corrige el tinte local de un reflejo)
    const rel = [mean[0] * REF / Math.max(30, lr / c.area), mean[1] * REF / Math.max(30, lg / c.area), mean[2] * REF / Math.max(30, lb / c.area)];
    const extra = { cls: C.RED, red: red / c.area, mean: rel, fill: c.area / (cw * ch), reddish: isReddish(rel) };
    const contrast = Math.hypot(rel[0] - REF, rel[1] - REF, rel[2] - REF);
    if (contrast < 55) continue; // manchas tenues (reflejos), no son tinta
    if (cw >= 1.3 * ch && ch <= 0.14 * P && cw >= 0.08 * P && cw <= 0.35 * P && extra.reddish && extra.fill >= 0.6) res.items.push(box(c, { type: 'dash', ...extra }));
    else if (c.area >= 0.004 * P * P || ch >= 0.09 * P) res.items.push(box(c, { type: 'glyph', ...extra }));
  }
  // 4) contenido sin explicar: contraste local (quita reflejos suaves) fuera de texto/insignias/marcas;
  //    solo cuentan manchas compactas (tamaño de insignia o marca), no bordes largos de reflejos
  let resid = 0, foreign = 0, tot = 0;
  {
    const R = Math.max(2, Math.round(0.2 * P));
    const padB = Math.max(2, Math.round(0.06 * P));
    const wt = new Uint8Array(W * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < W; i++) wt[j * W + i] = inItems(i, j + ja, padB) || i <= textRight + 1 ? 0 : 1;
    const loc = localMean(d, W, ja, h, R, [kr, kg, kb], wt);
    const mk = new Uint8Array(W * h); const iEnd = Math.round(0.96 * W);
    for (let j = 0; j < h; j++) for (let i = textRight + 2; i < iEnd; i++) {
      const p = j * W + i; tot++;
      const q = ((ja + j) * W + i) * 4;
      const dl = Math.hypot(d[q] * kr - loc[p * 3], d[q + 1] * kg - loc[p * 3 + 1], d[q + 2] * kb - loc[p * 3 + 2]);
      if (dl < 40 || inItems(i, j + ja, padB)) continue;
      mk[p] = 1;
      if (cls[p] === C.DARK || cls[p] === C.OTHER) foreign++;
    }
    const cc = components(mk, W, h, 1);
    for (const c of cc.comps) {
      const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
      // lo que toca el borde superior/inferior de la franja es de los separadores o cruza filas (reflejo)
      if (c.y0 <= 0 || c.y1 >= h - 1) continue;
      if (cw <= 0.9 * P && ch <= 0.8 * P && c.area > resid) { resid = c.area; res.residBox = [c.x0, c.y0, cw, ch]; }
    }
    // tinta ajena también en la columna de texto (dedo sobre el número)
    for (let j = 0; j < h; j++) for (let i = Math.round(0.03 * W); i <= textRight + 1; i++) {
      const p = j * W + i; tot++;
      if ((cls[p] === C.DARK || cls[p] === C.OTHER) && !res.text.some((t) => i >= t.x0 - 1 && i <= t.x1 + 1 && j + ja >= t.y0 - 1 && j + ja <= t.y1 + 1)) foreign++;
    }
  }
  // 5) oclusión lateral (dedo/mano que entra por el borde): región grande distinta del fondo que llega
  //    desde el borde derecho hasta el hueco donde podría haber otra insignia.
  let occl = 0;
  {
    const iEnd = Math.round(0.97 * W); const padB = Math.max(2, Math.round(0.06 * P));
    const lastRight = Math.max(textRight, ...res.items.map((t) => t.x1));
    const mk = new Uint8Array(W * h);
    for (let j = 0; j < h; j++) for (let i = textRight + 2; i < iEnd; i++) { const p = j * W + i; if (dist[p] >= 30 && !inItems(i, j + ja, padB)) mk[p] = 1; }
    const cc = components(mk, W, h, 1);
    for (const c of cc.comps) {
      if (c.area < 0.3 * P * P || c.x1 < 0.9 * W) continue;
      if (c.x0 <= lastRight + 0.9 * P) occl = Math.max(occl, c.area);
    }
  }
  res.residual = resid / (P * P);
  res.foreign = foreign / Math.max(1, tot);
  res.occl = occl / (P * P);
  return res;
}

// Media local (caja de radio R) del color balanceado, ignorando píxeles con peso 0 (objetos ya explicados).
function localMean(d, W, ja, h, R, k, wt) {
  const out = new Float32Array(W * h * 3); const t = new Float32Array(W * h * 4);
  const rowAcc = new Float64Array(4);
  for (let j = 0; j < h; j++) {
    const row = (ja + j) * W; rowAcc.fill(0);
    const add = (i, sgn) => { if (i < 0 || i >= W) return; const w = wt[j * W + i]; if (!w) return; const q = (row + i) * 4; rowAcc[0] += sgn * d[q] * k[0]; rowAcc[1] += sgn * d[q + 1] * k[1]; rowAcc[2] += sgn * d[q + 2] * k[2]; rowAcc[3] += sgn; };
    for (let i = -R; i <= R; i++) add(i, 1);
    for (let i = 0; i < W; i++) { const o = (j * W + i) * 4; t[o] = rowAcc[0]; t[o + 1] = rowAcc[1]; t[o + 2] = rowAcc[2]; t[o + 3] = rowAcc[3]; add(i + R + 1, 1); add(i - R, -1); }
  }
  const acc = new Float64Array(4);
  for (let i = 0; i < W; i++) {
    acc.fill(0);
    const add = (j, sgn) => { if (j < 0 || j >= h) return; const o = (j * W + i) * 4; acc[0] += sgn * t[o]; acc[1] += sgn * t[o + 1]; acc[2] += sgn * t[o + 2]; acc[3] += sgn * t[o + 3]; };
    for (let j = -R; j <= R; j++) add(j, 1);
    for (let j = 0; j < h; j++) {
      const p = (j * W + i) * 3; const n = acc[3];
      if (n > 0.5) { out[p] = acc[0] / n; out[p + 1] = acc[1] / n; out[p + 2] = acc[2] / n; } else { out[p] = out[p + 1] = out[p + 2] = REF; }
      add(j + R + 1, 1); add(j - R, -1);
    }
  }
  return out;
}

// Si dos insignias se solapan mucho, se queda la de más píxeles propios.
function dedupe(items) {
  items.sort((a, b) => b.area - a.area);
  for (let i = 0; i < items.length; i++) for (let j = items.length - 1; j > i; j--) {
    const a = items[i], b = items[j];
    const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix > 0 && iy > 0 && ix * iy > 0.4 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0))) items.splice(j, 1);
  }
}

export function isReddish(mean) {
  const [h, s] = hsv(mean[0], mean[1], mean[2]);
  return (h >= 330 || h < 25) && s >= 0.22;
}

// Rasgos de forma de la máscara rellena: relleno, aspecto, rectitud de los lados.
function shapeOf(fm) {
  const { mask, bw, bh } = fm; let area = 0, x0 = bw, x1 = -1, y0 = bh, y1 = -1;
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (mask[y * bw + x]) { area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  let straightL = 0, straightR = 0, n = 0;
  for (let y = Math.round(y0 + 0.1 * h); y <= y1 - 0.1 * h; y++) {
    let l = -1, r = -1; for (let x = x0; x <= x1; x++) if (mask[y * bw + x]) { if (l < 0) l = x; r = x; }
    if (l < 0) continue; n++;
    if (l - x0 <= 0.035 * w + 0.5) straightL++;
    if (x1 - r <= 0.035 * w + 0.5) straightR++;
  }
  return { fill: area / (w * h), aspect: w / h, straightL: n ? straightL / n : 0, straightR: n ? straightR / n : 0, fArea: area };
}
