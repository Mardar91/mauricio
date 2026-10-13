// Insignias de color dentro de la banda de una fila: segmentación por clase de color,
// forma, y renders de recorte para el OCR (texto oscuro sobre blanco).
import { rgbToHsv, makeCanvas, ctx2d, boxBlur as boxBlurF } from './img.js';
import { components } from './layout.js';

export const CLASSES = ['yellow', 'green', 'blue', 'magenta', 'red', 'pink'];
const CID = Object.fromEntries(CLASSES.map((c, i) => [c, i + 1]));

// Clase de color de un píxel ya equilibrado (fondo local → gris 200). 0 = ninguna.
export function pixelClass(h, s, v) {
  if (s < 0.1 || v < 0.22) return 0;
  if (h >= 36 && h < 72) return s >= 0.42 && v >= 0.45 ? CID.yellow : (s >= 0.16 && h >= 62 ? CID.green : 0);
  if (h >= 72 && h < 175) return s >= 0.14 ? CID.green : 0;
  if (h >= 190 && h < 268) return s >= 0.22 ? CID.blue : 0;
  if (h >= 268 && h < 338) return s >= 0.32 ? CID.magenta : (s >= 0.12 && v >= 0.6 ? CID.pink : 0);
  if (h >= 338 || h < 24) {
    if (s >= 0.5) return CID.red;
    if (s >= 0.1 && v >= 0.6) return CID.pink;
    return 0;
  }
  return 0;
}

// Color del fondo neutro local (para el equilibrio de color: fondo → gris 200).
function bgAt(bg, x, y) {
  const cx = Math.min(bg.W - 1, Math.max(0, Math.floor(x / bg.f))); const cy = Math.min(bg.H - 1, Math.max(0, Math.floor(y / bg.f)));
  const k = cy * bg.W + cx; return [bg.R[k], bg.G[k], bg.B[k]];
}

// Dilatación binaria con caja (2r+1)² (separable).
function dilate(m, W, H, r) {
  const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let last = -1e9;
    for (let x = 0; x < W; x++) { if (m[y * W + x]) last = x; if (x - last <= r) t[y * W + x] = 1; }
    last = 1e9;
    for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) last = x; if (last - x <= r) t[y * W + x] = 1; }
  }
  for (let x = 0; x < W; x++) {
    let last = -1e9;
    for (let y = 0; y < H; y++) { if (t[y * W + x]) last = y; if (y - last <= r) o[y * W + x] = 1; }
    last = 1e9;
    for (let y = H - 1; y >= 0; y--) { if (t[y * W + x]) last = y; if (last - y <= r) o[y * W + x] = 1; }
  }
  return o;
}

// Analiza un rectángulo (banda de códigos de una fila). Devuelve componentes clasificadas.
export function analyzeBand(rgba, w, h, bgL, rect, H) {
  const x0 = Math.max(0, Math.round(rect.x0)), x1 = Math.min(w - 1, Math.round(rect.x1));
  const y0 = Math.max(0, Math.round(rect.y0)), y1 = Math.min(h - 1, Math.round(rect.y1));
  const W = x1 - x0 + 1, Hh = y1 - y0 + 1; if (W < 4 || Hh < 4) return { comps: [], W, H: Hh, x0, y0, dark: 0, darkMask: new Uint8Array(0), cls: new Uint8Array(0) };
  const cls = new Uint8Array(W * Hh); const hue = new Float32Array(W * Hh); const sat = new Float32Array(W * Hh); const val = new Float32Array(W * Hh);
  const darkMask = new Uint8Array(W * Hh); let dark = 0;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const X = x0 + x, Y = y0 + y; const j = (Y * w + X) * 4; const b = bgAt(bgL, X, Y);
      const r = Math.min(255, rgba[j] * 200 / Math.max(30, b[0])), g = Math.min(255, rgba[j + 1] * 200 / Math.max(30, b[1])), bl = Math.min(255, rgba[j + 2] * 200 / Math.max(30, b[2]));
      const [hh, s, v] = rgbToHsv(r, g, bl); const i = y * W + x;
      hue[i] = hh; sat[i] = s; val[i] = v * 255 / 200;
      cls[i] = pixelClass(hh, s, v * 255 / 200);
      if (!cls[i] && val[i] < 0.5) { dark++; darkMask[i] = 1; }
    }
  }
  // El halo rosado de las insignias magenta no es "rosa": se quita junto a ellas.
  // (No alrededor del rojo: los trazos finos de la U y del guion son en gran parte "rosa".)
  const k = Math.max(2, Math.round(H * 0.1));
  const hot = new Uint8Array(W * Hh);
  for (let i = 0; i < hot.length; i++) hot[i] = cls[i] === CID.magenta ? 1 : 0;
  const near = dilate(hot, W, Hh, k);
  for (let i = 0; i < cls.length; i++) if (cls[i] === CID.pink && near[i]) cls[i] = 0;
  const comps = [];
  for (let c = 1; c <= CLASSES.length; c++) {
    const mask = new Uint8Array(W * Hh); let any = false;
    for (let i = 0; i < mask.length; i++) if (cls[i] === c) { mask[i] = 1; any = true; }
    if (!any) continue;
    const { lab, comps: cc } = components(mask, W, Hh);
    for (const k of cc) {
      if (k.n < Math.max(6, H * H * 0.02)) continue;
      const bw = k.x1 - k.x0 + 1, bh = k.y1 - k.y0 + 1;
      // Área rellena por filas (tapa los huecos del texto) y esquinas.
      let filled = 0; const rowSpan = []; const rowSegs = [];
      for (let y = k.y0; y <= k.y1; y++) {
        let a = -1, b = -1; const segs = []; let sa = -1;
        for (let x = k.x0; x <= k.x1 + 1; x++) {
          const on = x <= k.x1 && lab[y * W + x] === k.id;
          if (on) { if (a < 0) a = x; b = x; if (sa < 0) sa = x; } else if (sa >= 0) { segs.push([x0 + sa, x0 + x - 1]); sa = -1; }
        }
        rowSpan.push([a, b]); rowSegs.push(segs.length ? segs : null); if (a >= 0) filled += b - a + 1;
      }
      const corner = (fx, fy) => {
        const cw = Math.max(1, Math.round(bw * 0.22)), ch = Math.max(1, Math.round(bh * 0.22)); let m = 0;
        const sx = fx ? k.x1 - cw + 1 : k.x0, sy = fy ? k.y1 - ch + 1 : k.y0;
        for (let y = sy; y < sy + ch; y++) { const [a, b] = rowSpan[y - k.y0]; for (let x = sx; x < sx + cw; x++) if (a >= 0 && x >= a && x <= b) m++; }
        return m / (cw * ch);
      };
      // Color medio del relleno (original y equilibrado).
      let sr = 0, sg = 0, sb = 0, shs = 0, shc = 0, ss = 0, sv = 0, n = 0;
      for (let y = k.y0; y <= k.y1; y++) for (let x = k.x0; x <= k.x1; x++) {
        const i = y * W + x; if (lab[i] !== k.id) continue;
        const j = ((y0 + y) * w + x0 + x) * 4; sr += rgba[j]; sg += rgba[j + 1]; sb += rgba[j + 2];
        const a = hue[i] * Math.PI / 180; shs += Math.sin(a); shc += Math.cos(a); ss += sat[i]; sv += val[i]; n++;
      }
      let mh = Math.atan2(shs, shc) * 180 / Math.PI; if (mh < 0) mh += 360;
      comps.push({
        cls: CLASSES[c - 1], x0: x0 + k.x0, y0: y0 + k.y0, x1: x0 + k.x1, y1: y0 + k.y1, w: bw, h: bh, n: k.n, filled,
        fill: filled / (bw * bh), solidity: k.n / Math.max(1, filled),
        corners: [corner(0, 0), corner(1, 0), corner(0, 1), corner(1, 1)],
        rgb: [sr / n, sg / n, sb / n], hue: mh, sat: ss / n, val: sv / n,
        touches: { top: k.y0 === 0, bottom: k.y1 === Hh - 1, left: k.x0 === 0, right: k.x1 === W - 1 },
        rowSpan: rowSpan.map(([a, b]) => (a < 0 ? null : [x0 + a, x0 + b])), rowSegs,
      });
    }
  }
  return { comps, W, H: Hh, x0, y0, dark: dark / (W * Hh), darkMask, cls };
}

// Une fragmentos rojos/rosados pequeños que se tocan (el núcleo rojo de un guion o de una U
// y su halo menos saturado salen como componentes distintas).
export function mergeReddish(comps, H) {
  const red = (c) => (c.cls === 'red' || c.cls === 'pink') && c.h < 1.4 * H && c.w < 2 * H;
  const rest = comps.filter((c) => !red(c)); let marks = comps.filter(red);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const a = marks[i], b = marks[j];
        if (a.x0 > b.x1 + 2 || b.x0 > a.x1 + 2 || a.y0 > b.y1 + 2 || b.y0 > a.y1 + 2) continue;
        marks[i] = unite(a, b); marks.splice(j, 1); changed = true; break outer;
      }
    }
  }
  return [...rest, ...marks];
}

function unite(a, b) {
  const x0 = Math.min(a.x0, b.x0), y0 = Math.min(a.y0, b.y0), x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1; const rowSpan = [], rowSegs = []; let filled = 0;
  for (let y = y0; y <= y1; y++) {
    const segs = [];
    for (const c of [a, b]) { const k = y - c.y0; if (k >= 0 && k < c.h && c.rowSegs[k]) segs.push(...c.rowSegs[k].map((s) => [...s])); }
    segs.sort((p, q) => p[0] - q[0]); const m = [];
    for (const sg of segs) { if (m.length && sg[0] <= m[m.length - 1][1] + 1) m[m.length - 1][1] = Math.max(m[m.length - 1][1], sg[1]); else m.push(sg); }
    rowSegs.push(m.length ? m : null); rowSpan.push(m.length ? [m[0][0], m[m.length - 1][1]] : null);
    if (m.length) filled += m[m.length - 1][1] - m[0][0] + 1;
  }
  const n = a.n + b.n; const wa = a.n / n, wb = b.n / n;
  const main = a.n * a.sat >= b.n * b.sat ? a : b;
  return {
    ...main, cls: a.cls === 'red' || b.cls === 'red' ? 'red' : main.cls, x0, y0, x1, y1, w, h, n, filled, fill: filled / (w * h), solidity: n / Math.max(1, filled),
    rgb: a.rgb.map((v, i) => v * wa + b.rgb[i] * wb), sat: a.sat * wa + b.sat * wb, val: a.val * wa + b.val * wb, hue: main.hue,
    touches: { top: a.touches.top || b.touches.top, bottom: a.touches.bottom || b.touches.bottom, left: a.touches.left || b.touches.left, right: a.touches.right || b.touches.right },
    rowSpan, rowSegs, corners: main.corners,
  };
}

// Clasifica una componente como insignia, guion, U, o ruido.
export function shapeOf(c, H) {
  const asp = c.w / c.h;
  // Marcas rojas finas (guion, U): los trazos finos pierden saturación → admite rosa con tono rojo.
  const reddish = c.cls === 'red' || (c.cls === 'pink' && (c.hue >= 330 || c.hue < 25) && c.sat >= 0.15);
  if (reddish && c.h <= 0.5 * H && c.w >= 0.22 * H && c.w <= 1.6 * H && asp >= 1.2 && c.fill >= 0.55) return 'dash';
  if (reddish && c.h >= 0.55 * H && c.h <= 1.25 * H && c.w >= 0.3 * H && asp >= 0.45 && asp <= 1.4) return 'letter';
  if (c.h >= 0.95 * H && c.h <= 3.2 * H && c.w >= 0.9 * H && c.w <= 4 * H && asp >= 0.65 && asp <= 2.2 && c.fill >= 0.5) {
    const [tl, tr, bl, br] = c.corners;
    if (tl > 0.55 && bl > 0.55 && tr < 0.45 && br < 0.45 && asp > 1.05) return 'tag';
    return 'badge';
  }
  return 'noise';
}

// ¿Es una "U"? Dos trazos verticales unidos abajo y abierta arriba: en la mitad superior,
// el centro de la caja no tiene píxeles de la marca.
export function looksLikeU(c) {
  const top = Math.max(1, Math.round(c.h * 0.45)); let open = 0, rows = 0, both = 0;
  const cx0 = c.x0 + c.w * 0.38, cx1 = c.x0 + c.w * 0.62;
  for (let i = 0; i < top; i++) {
    const segs = c.rowSegs[i]; if (!segs) continue; rows++;
    if (!segs.some(([a, b]) => b >= cx0 && a <= cx1)) open++;
    if (segs.some(([a]) => a <= c.x0 + c.w * 0.35) && segs.some(([, b]) => b >= c.x0 + c.w * 0.65)) both++;
  }
  const bottom = c.rowSegs[c.h - 2] || c.rowSegs[c.h - 1];
  const closed = bottom && bottom.some(([a, b]) => a <= c.x0 + c.w * 0.5 && b >= c.x0 + c.w * 0.5);
  return rows > 0 && open / rows >= 0.6 && both / rows >= 0.5 && !!closed;
}

// Umbral de Otsu sobre valores reales (histograma de 64 cubetas entre min y max).
function otsuF(vals) {
  if (vals.length < 4) return 0;
  let mn = Infinity, mx = -Infinity; for (const v of vals) { if (v < mn) mn = v; if (v > mx) mx = v; }
  if (mx - mn < 1e-6) return mx;
  const B = 64, hist = new Float64Array(B); const k = (B - 1) / (mx - mn);
  for (const v of vals) hist[Math.round((v - mn) * k)]++;
  let sum = 0; for (let i = 0; i < B; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = -1, thr = 0;
  for (let t = 0; t < B; t++) {
    wB += hist[t]; if (!wB) continue; const wF = vals.length - wB; if (!wF) break;
    sB += t * hist[t]; const d = (sB / wB - (sum - sB) / wF) ** 2 * wB * wF;
    if (d > best) { best = d; thr = t; }
  }
  return mn + (thr + 0.5) / k;
}

// Limpieza del render: (1) borra lo gris/oscuro conectado al borde de la máscara (restos del aro
// más oscuro de la insignia); (2) quita motas pequeñas frente al mayor trazo (texto).
function cleanRender(gv, ins, W, H) {
  const seen = new Uint8Array(W * H); const st = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!ins[i] || gv[i] > 170) continue;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !ins[i - 1] || !ins[i + 1] || !ins[i - W] || !ins[i + W];
    if (edge && !seen[i]) { seen[i] = 1; st.push(i); }
  }
  while (st.length) {
    const i = st.pop(); gv[i] = 255; const x = i % W, y = (i / W) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = yy * W + xx; if (!seen[j] && ins[j] && gv[j] <= 170) { seen[j] = 1; st.push(j); }
    }
  }
  // Componentes oscuras (8-vecinos).
  const lab = new Int32Array(W * H).fill(-1); const areas = []; const q = [];
  for (let i = 0; i < W * H; i++) {
    if (gv[i] > 200 || lab[i] >= 0) continue;
    const id = areas.length; let n = 0; lab[i] = id; q.push(i);
    while (q.length) {
      const p = q.pop(); n++; const x = p % W, y = (p / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx; if (lab[j] < 0 && gv[j] <= 200) { lab[j] = id; q.push(j); }
      }
    }
    areas.push(n);
  }
  const big = Math.max(0, ...areas); const minA = Math.max(3, big * 0.06);
  for (let i = 0; i < W * H; i++) if (lab[i] >= 0 && areas[lab[i]] < minA) gv[i] = 255;
  // Gris suelto (no tocado por ninguna componente oscura) → blanco.
  for (let i = 0; i < W * H; i++) if (gv[i] > 200 && gv[i] < 255) {
    const x = i % W, y = (i / W) | 0; let nearInk = false;
    for (let dy = -1; dy <= 1 && !nearInk; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (lab[yy * W + xx] >= 0 && areas[lab[yy * W + xx]] >= minA) { nearInk = true; break; }
    }
    if (!nearInk) gv[i] = 255;
  }
}

// Render "suave": estiramiento lineal 0..p98 sin umbrales ni limpieza (texto tenue o movido).
function softRender(val, ins, vals, BW, BH, targetH) {
  const sv = [...vals].sort((a, b) => a - b); const hi = Math.max(10, sv[Math.floor(sv.length * 0.98)] || 10);
  const lo = Math.max(0, sv[Math.floor(sv.length * 0.5)] || 0);
  const s = targetH / BH; const pad = Math.round(targetH * 0.25);
  const src = makeCanvas(BW, BH); const g = ctx2d(src); const im = g.createImageData(BW, BH); const d = im.data;
  for (let i = 0; i < BW * BH; i++) {
    let v = 255; if (ins[i]) { const q = (val[i] - lo) / (hi - lo); v = q <= 0 ? 255 : q >= 1 ? 0 : Math.round(255 * (1 - q)); }
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  const out = makeCanvas(Math.round(BW * s) + 2 * pad, Math.round(BH * s) + 2 * pad); const o = ctx2d(out);
  o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.imageSmoothingQuality = 'high';
  o.drawImage(src, pad, pad, Math.round(BW * s), Math.round(BH * s));
  return out;
}

// Luminancia del fondo local (modelo de mediana) con interpolación bilineal.
function bgLum(bg, x, y) {
  const fx = Math.max(0, Math.min(bg.W - 1.001, x / bg.f - 0.5)), fy = Math.max(0, Math.min(bg.H - 1.001, y / bg.f - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
  const L = (i) => 0.3 * bg.R[i] + 0.59 * bg.G[i] + 0.11 * bg.B[i];
  const i00 = y0 * bg.W + x0, i10 = i00 + 1, i01 = i00 + bg.W, i11 = i01 + 1;
  return (L(i00) * (1 - ax) + L(i10) * ax) * (1 - ay) + (L(i01) * (1 - ax) + L(i11) * ax) * ay;
}

// Render del interior de una insignia → texto negro sobre blanco, para el OCR.
// El "relleno" es el fondo local (mediana), así los degradados y reflejos no manchan el render.
// mode 'ink': mapa de tinta (distancia de color); 'lum': diferencia de luminancia con la polaridad del texto.
export function renderBadge(rgba, w, h, c, ink, bg, targetH = 84, mode = 'ink') {
  const padX = Math.round(c.w * 0.04), padY = Math.round(c.h * 0.04);
  const bx0 = Math.max(0, c.x0 - padX), by0 = Math.max(0, c.y0 - padY), bx1 = Math.min(w - 1, c.x1 + padX), by1 = Math.min(h - 1, c.y1 + padY);
  const BW = bx1 - bx0 + 1, BH = by1 - by0 + 1;
  const er = Math.max(1, Math.round(c.h * 0.07));
  const inside = (x, y) => {
    const ry = y - c.y0; if (ry < er || ry > c.h - 1 - er) return false;
    const a = c.rowSpan[ry - er], b = c.rowSpan[ry + er], s = c.rowSpan[ry];
    if (!a || !b || !s) return false;
    return x >= Math.max(a[0], b[0], s[0]) + er && x <= Math.min(a[1], b[1], s[1]) - er;
  };
  const dI = new Float32Array(BW * BH), dL = new Float32Array(BW * BH), ins = new Uint8Array(BW * BH); const dv = [];
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
    const X = bx0 + x, Y = by0 + y; if (!inside(X, Y)) continue;
    const j = (Y * w + X) * 4; const i = y * BW + x; ins[i] = 1;
    dI[i] = ink[Y * w + X]; dL[i] = 0.3 * rgba[j] + 0.59 * rgba[j + 1] + 0.11 * rgba[j + 2] - bgLum(bg, X, Y); dv.push(dI[i]);
  }
  // Píxeles de texto: tinta alta (Otsu); su signo de luminancia da la polaridad.
  const tI = Math.max(15, otsuF(dv));
  let sl = 0, sn = 0; for (let i = 0; i < ins.length; i++) if (ins[i] && dI[i] > tI) { sl += dL[i]; sn++; }
  const sign = sn && sl > 0 ? 1 : -1; // texto claro → +1
  const val = new Float32Array(BW * BH); const vals = [];
  for (let i = 0; i < ins.length; i++) if (ins[i]) val[i] = mode === 'ink' ? dI[i] : sign * dL[i];
  // 'sharp': máscara de enfoque sobre la diferencia de luminancia (texto algo movido o desenfocado).
  if (mode === 'sharp') {
    const r = Math.max(1, Math.round(c.h * 0.05)); const b = boxBlurF(val, BW, BH, r);
    for (let i = 0; i < val.length; i++) if (ins[i]) val[i] = val[i] + 1.2 * (val[i] - b[i]);
  }
  for (let i = 0; i < ins.length; i++) if (ins[i]) vals.push(val[i]);
  if (mode === 'soft') return softRender(val, ins, vals, BW, BH, targetH);
  const t = mode === 'ink' ? tI : Math.max(8, otsuF(vals));
  let hs = 0, hn = 0; for (const v of vals) if (v > t) { hs += v; hn++; }
  const lo = t * 0.5, hi = Math.max(lo + 12, hn ? hs / hn : t * 1.5);
  const s = targetH / BH; const pad = Math.round(targetH * 0.25);
  const gv = new Uint8Array(BW * BH).fill(255);
  for (let i = 0; i < BW * BH; i++) if (ins[i]) { const q = (val[i] - lo) / (hi - lo); gv[i] = q <= 0 ? 255 : q >= 1 ? 0 : Math.round(255 * (1 - q)); }
  cleanRender(gv, ins, BW, BH);
  const src = makeCanvas(BW, BH); const g = ctx2d(src); const im = g.createImageData(BW, BH); const d = im.data;
  for (let i = 0; i < BW * BH; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = gv[i]; d[i * 4 + 3] = 255; }
  g.putImageData(im, 0, 0);
  const out = makeCanvas(Math.round(BW * s) + 2 * pad, Math.round(BH * s) + 2 * pad); const o = ctx2d(out);
  o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.imageSmoothingQuality = 'high';
  o.drawImage(src, pad, pad, Math.round(BW * s), Math.round(BH * s));
  return out;
}
