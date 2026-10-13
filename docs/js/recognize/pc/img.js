// Utilidades de imagen en JS puro sobre <canvas> (OffscreenCanvas si existe).

let offscreenOk = null;
function hasOffscreen() {
  if (offscreenOk === null) {
    try { offscreenOk = typeof OffscreenCanvas !== 'undefined' && !!new OffscreenCanvas(1, 1).getContext('2d'); } catch (e) { offscreenOk = false; }
  }
  return offscreenOk;
}

export function makeCanvas(w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  if (hasOffscreen()) return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

export function ctx2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

// Libera memoria del lienzo (importante en Safari iOS)
export function freeCanvas(c) { if (c) { c.width = 1; c.height = 1; } }

export const tick = () => new Promise((r) => setTimeout(r, 0));

// Carga la entrada (Blob, File, ImageBitmap, <img>, <canvas>) en un lienzo de lado mayor ≤ maxSide.
// Si la foto es más grande se conserva el original (orig) para recortes de alta resolución; release() lo libera.
export async function loadInput(input, maxSide = 2000) {
  let src = input; let w; let h; let bmp = null;
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    try { bmp = await createImageBitmap(input, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(input); }
    src = bmp; w = bmp.width; h = bmp.height;
  } else if (typeof ImageBitmap !== 'undefined' && input instanceof ImageBitmap) {
    w = input.width; h = input.height;
  } else if (input && input.naturalWidth) {
    if (input.decode) { try { await input.decode(); } catch (e) { /* ya cargada */ } }
    w = input.naturalWidth; h = input.naturalHeight;
  } else if (input && input.width) {
    w = input.width; h = input.height;
  } else throw new Error('Entrada de imagen no válida');
  const k = Math.min(1, maxSide / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)); const H = Math.max(1, Math.round(h * k));
  // reducción por mitades (Safari filtra mal las reducciones grandes de un solo paso)
  let cur = src; let cw = w; let ch = h; const tmp = [];
  while (cw / 2 >= W * 1.05) {
    const nw = Math.round(cw / 2); const nh = Math.round(ch / 2);
    const c2 = makeCanvas(nw, nh); const g2 = ctx2d(c2); g2.imageSmoothingEnabled = true; g2.imageSmoothingQuality = 'high';
    g2.drawImage(cur, 0, 0, nw, nh); tmp.push(c2); cur = c2; cw = nw; ch = nh;
  }
  const c = makeCanvas(W, H); const g = ctx2d(c);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(cur, 0, 0, W, H);
  for (const t of tmp) freeCanvas(t);
  const orig = k < 0.95 ? src : null;
  const release = () => { if (bmp && bmp.close) bmp.close(); };
  if (!orig) release();
  return { canvas: c, scale: k, origW: w, origH: h, orig, release };
}

// RGBA → planos R, G, B y luminancia (Uint8)
export function planes(canvas) {
  const w = canvas.width; const h = canvas.height;
  const d = ctx2d(canvas).getImageData(0, 0, w, h).data;
  const n = w * h;
  const R = new Uint8ClampedArray(n); const G = new Uint8ClampedArray(n); const B = new Uint8ClampedArray(n); const Y = new Uint8ClampedArray(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
    R[p] = r; G[p] = g; B[p] = b; Y[p] = (77 * r + 150 * g + 29 * b) >> 8;
  }
  return { w, h, R, G, B, Y };
}

// Imagen integral (Float64 para evitar desbordes)
export function integral(a, w, h) {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0; const ro = (y + 1) * (w + 1); const rp = y * (w + 1); const ai = y * w;
    for (let x = 0; x < w; x++) { s += a[ai + x]; I[ro + x + 1] = I[rp + x + 1] + s; }
  }
  return I;
}

export function boxMean(I, w, h, x0, y0, x1, y1) {
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > w - 1) x1 = w - 1; if (y1 > h - 1) y1 = h - 1;
  if (x1 < x0 || y1 < y0) return 0;
  const W = w + 1;
  const s = I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
  return s / ((x1 - x0 + 1) * (y1 - y0 + 1));
}

// Percentil de un array numérico (copia)
export function percentile(arr, q) {
  if (!arr.length) return 0;
  const a = Array.from(arr).sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
  return a[i];
}

export function median(arr) { return percentile(arr, 0.5); }

// Umbral de Otsu sobre un histograma de 256 niveles
export function otsu(hist) {
  let total = 0; let sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0; let wB = 0; let best = 0; let thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB; const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = i; }
  }
  return thr;
}

// RGB → HSV (h en grados 0-360, s y v 0-1)
export function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx / 255 };
}

// Componentes conexas (8-conectividad) de una máscara Uint8; devuelve estadísticas por componente
export function components(mask, w, h, minArea = 1) {
  const lab = new Int32Array(w * h); const out = []; const stack = new Int32Array(w * h);
  let n = 0;
  for (let p0 = 0; p0 < w * h; p0++) {
    if (!mask[p0] || lab[p0]) continue;
    n++; let sp = 0; stack[sp++] = p0; lab[p0] = n;
    let area = 0; let sx = 0; let sy = 0; let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
    while (sp) {
      const p = stack[--sp]; const x = p % w; const y = (p - x) / w;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (mask[q] && !lab[q]) { lab[q] = n; stack[sp++] = q; }
        }
      }
    }
    if (area >= minArea) out.push({ id: n, area, cx: sx / area, cy: sy / area, x0, y0, x1, y1 });
  }
  return { comps: out, labels: lab };
}

export async function canvasToDataURL(c, type = 'image/png', q) {
  if (c.convertToBlob) {
    const blob = await c.convertToBlob({ type, quality: q });
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  }
  return c.toDataURL(type, q);
}

// Gris "aplanado" para OCR: divide por el fondo local (media en una ventana de radio r) para quitar
// degradados, reflejos y texturas suaves; el texto oscuro queda negro sobre blanco.
export function flattenGray(canvas, r) {
  const P = planes(canvas); const { w, h } = P;
  const L = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) L[i] = Math.min(P.R[i], P.G[i], P.B[i]) * 0.4 + P.Y[i] * 0.6;
  const I = integral(L, w, h);
  const out = makeCanvas(w, h); const g = ctx2d(out); const id = g.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const m = boxMean(I, w, h, x - r, y - r, x + r, y + r);
    const v = Math.max(0, Math.min(255, Math.round(((L[y * w + x] / Math.max(m, 8)) - 0.55) * 255 / 0.4)));
    const i = (y * w + x) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  return out;
}
