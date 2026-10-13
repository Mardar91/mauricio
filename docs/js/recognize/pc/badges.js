// Detección de insignias de color y marcas rojas dentro de la fila del empleado (imagen rectificada).
import { components, rgb2hsv, percentile, makeCanvas, ctx2d, otsu } from './img.js';

// Ganancias de balance de blancos a partir de los píxeles claros de una región
export function whiteGains(P, x0, y0, x1, y1) {
  const rs = []; const gs = []; const bs = [];
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
    const p = y * P.w + x; rs.push(P.R[p]); gs.push(P.G[p]); bs.push(P.B[p]);
  }
  const r = percentile(rs, 0.8); const g = percentile(gs, 0.8); const b = percentile(bs, 0.8);
  const ref = Math.max(r, g, b, 1);
  return [ref / Math.max(r, 1), ref / Math.max(g, 1), ref / Math.max(b, 1), ref];
}

// Balance de blancos local de una celda: mediana de los píxeles de fondo (poco croma y claros)
export function cellGains(P, x0, y0, x1, y1) {
  const px = [];
  for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
    const p = y * P.w + x; const r = P.R[p]; const g = P.G[p]; const b = P.B[p];
    px.push([r, g, b, Math.max(r, g, b) - Math.min(r, g, b), P.Y[p]]);
  }
  const cs = px.map((q) => q[3]).sort((a, b) => a - b); const ys = px.map((q) => q[4]).sort((a, b) => a - b);
  const cT = cs[Math.floor(cs.length * 0.4)]; const yT = ys[Math.floor(ys.length * 0.5)];
  const bg = px.filter((q) => q[3] <= cT && q[4] >= yT);
  if (bg.length < 10) return null;
  const med = (k) => { const a = bg.map((q) => q[k]).sort((x, y) => x - y); return a[a.length >> 1]; };
  const r = med(0); const g = med(1); const b = med(2); const ref = Math.max(r, g, b, 1);
  return [ref / Math.max(r, 1), ref / Math.max(g, 1), ref / Math.max(b, 1), ref];
}

// HSV corregido de una región (x0..x1, y0..y1 inclusive); Rd = rojez r − (g+b)/2
export function regionHSV(P, x0, y0, x1, y1, gains) {
  const w = x1 - x0 + 1; const h = y1 - y0 + 1; const n = w * h;
  const S = new Float32Array(n); const Hh = new Float32Array(n); const V = new Float32Array(n); const L = new Float32Array(n); const Rd = new Float32Array(n);
  const k = 255 / gains[3];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y + y0) * P.w + x + x0; const q = y * w + x;
    const r = Math.min(255, P.R[p] * gains[0] * k); const g = Math.min(255, P.G[p] * gains[1] * k); const b = Math.min(255, P.B[p] * gains[2] * k);
    const o = rgb2hsv(r, g, b); S[q] = o.s; Hh[q] = o.h; V[q] = o.v; L[q] = (0.299 * r + 0.587 * g + 0.114 * b) / 255; Rd[q] = r - (g + b) / 2;
  }
  const sl = Array.from(L).sort((a, b) => a - b);
  return { x0, y0, w, h, S, H: Hh, V, L, Rd, bgL: sl[Math.floor(n * 0.6)] || 1 };
}

// Componentes coloreados de una celda con estadísticas (hue medio circular, saturación, valor, forma)
// y componentes rojos pequeños (guion, U) con la caja de su núcleo oscuro.
// skip: Uint8Array(h) con las filas que caen sobre líneas de la rejilla (se ignoran).
// ¿Es una insignia? (forma de elipse/etiqueta de tamaño suficiente, no un trazo de texto rojo)
export function isBadge(c, cw, rh) {
  return c.kind === 'col' && c.area >= 0.12 * cw * cw && c.bw >= 0.45 * cw && c.bh >= 0.4 * rh && c.fill >= 0.5;
}

export function cellComponents(C, satThr, minArea, skip, cw = Infinity, rh = Infinity) {
  const n = C.w * C.h; const col = new Uint8Array(n); const red = new Uint8Array(n);
  for (let y = 0; y < C.h; y++) {
    const sk = skip && skip[y];
    for (let x = 0; x < C.w; x++) {
      const q = y * C.w + x;
      if (C.S[q] > satThr && C.V[q] > 0.3) col[q] = 1;
      // rojo "de verdad": la rojez explica buena parte del oscurecimiento (descarta líneas grises teñidas)
      const dark = (C.bgL - C.L[q]) * 255;
      if (!sk && C.Rd[q] > 12 && dark > 8 && C.Rd[q] >= 0.45 * dark) red[q] = 1;
    }
  }
  const out = [];
  const { comps, labels } = components(col, C.w, C.h, minArea);
  for (const c of comps) {
    let sx = 0; let sy = 0; let ss = 0; let sv = 0; let nn = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const q = y * C.w + x; if (labels[q] !== c.id) continue;
      const a = (C.H[q] * Math.PI) / 180; sx += Math.cos(a) * C.S[q]; sy += Math.sin(a) * C.S[q]; ss += C.S[q]; sv += C.V[q]; nn++;
    }
    let hue = (Math.atan2(sy, sx) * 180) / Math.PI; if (hue < 0) hue += 360;
    c.hue = hue; c.sat = ss / nn; c.val = sv / nn;
    c.bw = c.x1 - c.x0 + 1; c.bh = c.y1 - c.y0 + 1; c.fill = c.area / (c.bw * c.bh);
    c.labels = labels; c.kind = 'col';
    out.push(c);
  }
  // los rojos junto a una insignia (halo de su borde) no cuentan
  for (const c of out) {
    if (!isBadge(c, cw, rh)) continue;
    for (let y = Math.max(0, c.y0 - 3); y <= Math.min(C.h - 1, c.y1 + 3); y++) for (let x = Math.max(0, c.x0 - 3); x <= Math.min(C.w - 1, c.x1 + 3); x++) red[y * C.w + x] = 0;
  }
  // rojos: se etiqueta la máscara dilatada para unir trazos partidos
  const dil = new Uint8Array(n);
  for (let y = 0; y < C.h; y++) for (let x = 0; x < C.w; x++) {
    if (!red[y * C.w + x]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy; const xx = x + dx; if (yy >= 0 && yy < C.h && xx >= 0 && xx < C.w) dil[yy * C.w + xx] = 1; }
  }
  const R = components(dil, C.w, C.h, 6);
  for (const c of R.comps) {
    c.kind = 'red'; c.labels = R.labels;
    // caja y núcleo oscuro con los píxeles rojos reales
    let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1; let area = 0; let maxRd = 0; let maxDark = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const q = y * C.w + x; if (R.labels[q] !== c.id || !red[q]) continue;
      area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (C.Rd[q] > maxRd) maxRd = C.Rd[q];
      const dk = C.bgL - C.L[q]; if (dk > maxDark) maxDark = dk;
    }
    if (!area) continue;
    // núcleo del trazo: píxeles con al menos la mitad del oscurecimiento máximo (umbral adaptativo)
    let cx0 = Infinity; let cy0 = Infinity; let cx1 = -1; let cy1 = -1; let cn = 0; let sRd = 0; let sDk = 0;
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
      const q = y * C.w + x; if (R.labels[q] !== c.id || !red[q]) continue;
      const dk = C.bgL - C.L[q];
      if (dk >= 0.5 * maxDark) { cn++; sRd += C.Rd[q]; sDk += dk * 255; if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; }
    }
    c.redRatio = sDk ? sRd / sDk : 0; // ~1 para rojo puro, ~0.4 para texto gris rosado
    Object.assign(c, { x0, y0, x1, y1, area, bw: x1 - x0 + 1, bh: y1 - y0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, maxRd });
    c.fill = area / (c.bw * c.bh);
    c.core = cn >= 3 ? { w: cx1 - cx0 + 1, h: cy1 - cy0 + 1, n: cn } : null;
    out.push(c);
  }
  return out;
}

// Clase de color de una insignia
export function colorClass(c) {
  const h = c.hue; const s = c.sat;
  if (h >= 38 && h < 75 && s > 0.25) return 'yellow';
  if (h >= 75 && h < 175 && s > 0.12) return 'green';
  if (h >= 185 && h < 255 && s > 0.2) return 'blue';
  if (h >= 262 && h < 325 && s > 0.2) return 'magenta';
  if ((h >= 325 || h < 30) && s > 0.45 && c.val < 0.95) return 'red';
  if ((h >= 320 || h < 38)) return 'pink';
  return 'other';
}

// Tinta del texto de una insignia (0..1, resolución nativa): 1 = trazo. mode: 'dark' (texto oscuro),
// 'light' (texto claro, p. ej. N1 azul) o 'auto'.
export function badgeInk(C, comp, mode = 'dark', shrink = 0.8) {
  const x0 = comp.x0; const y0 = comp.y0; const x1 = comp.x1; const y1 = comp.y1;
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  const cx = (x0 + x1) / 2; const cy = (y0 + y1) / 2; const rx = (comp.bw / 2) * shrink + 0.5; const ry = (comp.bh / 2) * shrink + 0.5;
  const ell = (x, y, k) => ((x - cx) / (rx * k)) ** 2 + ((y - cy) / (ry * k)) ** 2 <= 1;
  const stats = (A) => {
    const fill = []; const inner = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!ell(x, y, 0.8)) continue;
      const q = y * C.w + x; const l = A[q] * 255; inner.push(l);
      if (comp.labels[q] === comp.id) fill.push(l);
    }
    inner.sort((a, b) => a - b); fill.sort((a, b) => a - b);
    return { inner, lf: fill.length ? fill[fill.length >> 1] : inner[Math.floor(inner.length * 0.6)] || 255 };
  };
  let invert = mode === 'light';
  if (mode === 'auto') {
    const { inner, lf } = stats(C.L);
    let nd = 0; let nl = 0; for (const l of inner) { if (l < lf - 25) nd++; else if (l > lf + 25) nl++; }
    invert = nl > 1.5 * nd;
  }
  const A = C.L; // la luminancia conserva el detalle fino (en JPEG el color va a media resolución)
  const { inner, lf } = stats(A);
  const lo = invert ? lf : inner[Math.floor(inner.length * 0.04)] || 0;
  const hi = invert ? inner[Math.floor(inner.length * 0.96)] || 255 : lf;
  const ink = new Float32Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!ell(x, y, 1)) continue;
    const l = A[y * C.w + x] * 255;
    let t = (l - lo) / Math.max(8, hi - lo); if (invert) t = 1 - t;
    ink[(y - y0) * w + (x - x0)] = Math.max(0, Math.min(1, 1 - (t - 0.1) * 1.25));
  }
  return { ink, w, h, contrast: hi - lo, invert };
}

// Lienzo para OCR a partir de la tinta: texto negro sobre blanco, ~textH px de alto
export function inkCanvas(I, textH = 34, binarize = false) {
  const { w, h } = I; let ink = I.ink;
  if (binarize) {
    // umbral de Otsu sobre la tinta (trazos nítidos)
    const hist = new Array(256).fill(0); for (const v of ink) if (v > 0.02) hist[Math.round(v * 255)]++;
    const t = otsu(hist) / 255; ink = ink.map((v) => (v > t ? 1 : 0));
  }
  const pw = w + 8; const ph = h + 8;
  const small = makeCanvas(pw, ph); const g = ctx2d(small); const id = g.createImageData(pw, ph); id.data.fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(255 * (1 - ink[y * w + x]));
    const i = ((y + 4) * pw + (x + 4)) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
  }
  g.putImageData(id, 0, 0);
  const k = textH / (h * 0.42);
  const out = makeCanvas(pw * k + 24, ph * k + 24); const go = ctx2d(out);
  go.fillStyle = '#fff'; go.fillRect(0, 0, out.width, out.height);
  go.imageSmoothingEnabled = true; go.imageSmoothingQuality = 'high';
  go.drawImage(small, 12, 12, pw * k, ph * k);
  return out;
}
