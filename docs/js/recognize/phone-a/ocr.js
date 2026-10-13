// OCR dirigido con Tesseract: worker compartido, recortes girados y binarizados.
import { makeCanvas, ctx2d, freeCanvas, otsu } from './img.js';
import { ready, recognizeImage, disposePool } from '../ocr-pool.js';

// Worker compartido (../ocr-pool.js): el "worker" que se devuelve son solo las rutas.
export async function getWorker(tess) {
  await ready(tess);
  return { tess };
}

export async function dispose() { await disposePool(); }

// Reconoce un lienzo con un modo de segmentación y una lista blanca
export async function ocr(worker, canvas, { psm = '7', whitelist = '' } = {}) {
  const data = await recognizeImage(worker && worker.tess, canvas, { psm, whitelist }, { text: true, blocks: psm !== '7' && psm !== '8' ? true : false });
  return { text: (data.text || '').trim(), conf: data.confidence || 0, data };
}

// Recorte girado: centro (cx, cy) en coordenadas de la imagen origen, ángulo theta de las filas,
// tamaño (w, h) en píxeles de origen, escala k. Devuelve un lienzo de (w·k × h·k).
export function rotatedCrop(src, cx, cy, theta, w, h, k) {
  const cw = Math.max(4, Math.round(w * k)), ch = Math.max(4, Math.round(h * k));
  const c = makeCanvas(cw, ch); const g = ctx2d(c);
  g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.translate(cw / 2, ch / 2); g.scale(k, k); g.rotate(-theta); g.translate(-cx, -cy);
  g.drawImage(src, 0, 0);
  return c;
}

// Luminancia, máximo y mínimo de canal (con ganancias de balance de blancos) de un lienzo
export function lumOf(c, gains = [1, 1, 1]) {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  const n = c.width * c.height; const y = new Uint8ClampedArray(n), mx = new Uint8ClampedArray(n), mn = new Uint8ClampedArray(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = Math.min(255, d[i] * gains[0]), g = Math.min(255, d[i + 1] * gains[1]), b = Math.min(255, d[i + 2] * gains[2]);
    y[p] = 0.299 * r + 0.587 * g + 0.114 * b; mx[p] = r > g ? (r > b ? r : b) : (g > b ? g : b); mn[p] = r < g ? (r < b ? r : b) : (g < b ? g : b);
  }
  return { y, mx, mn, rgba: d, w: c.width, h: c.height };
}

// Lienzo binario (texto negro sobre blanco) a partir de una máscara
export function maskToCanvas(mask, w, h, box, pad, outH) {
  const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
  const k = outH ? outH / bh : 1;
  const cw = Math.round((bw + 2 * pad) * k), chh = Math.round((bh + 2 * pad) * k);
  const small = makeCanvas(bw + 2 * pad, bh + 2 * pad); const g = ctx2d(small);
  const id = g.createImageData(small.width, small.height);
  id.data.fill(255);
  for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) {
    if (!mask[y * w + x]) continue;
    const i = ((y - box.y0 + pad) * small.width + (x - box.x0 + pad)) * 4;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = 0;
  }
  g.putImageData(id, 0, 0);
  if (k === 1) return small;
  const c = makeCanvas(cw, chh); const g2 = ctx2d(c);
  g2.imageSmoothingEnabled = true; g2.imageSmoothingQuality = 'high';
  g2.drawImage(small, 0, 0, cw, chh); freeCanvas(small);
  return c;
}

// Componentes conexas simples (4-conectividad) de una máscara binaria
export function maskComponents(mask, w, h, minArea = 3) {
  const lab = new Int32Array(w * h); const out = []; let n = 0;
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    n++; let area = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack.push(i); lab[i] = n;
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p - x) / w;
      area++; sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !lab[p - 1]) { lab[p - 1] = n; stack.push(p - 1); }
      if (x < w - 1 && mask[p + 1] && !lab[p + 1]) { lab[p + 1] = n; stack.push(p + 1); }
      if (y > 0 && mask[p - w] && !lab[p - w]) { lab[p - w] = n; stack.push(p - w); }
      if (y < h - 1 && mask[p + w] && !lab[p + w]) { lab[p + w] = n; stack.push(p + w); }
    }
    if (area >= minArea) out.push({ id: n, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area });
  }
  return { comps: out, lab };
}

// Binarización por Otsu dentro de una región (sel) → máscara de "texto" (minoría o lado oscuro)
export function otsuMask(vals, w, h, sel, { dark = null } = {}) {
  const hist = new Float64Array(256); let tot = 0;
  for (let p = 0; p < w * h; p++) if (!sel || sel[p]) { hist[vals[p]]++; tot++; }
  const { thr, sep } = otsu(hist, tot);
  let below = 0; for (let t = 0; t <= thr; t++) below += hist[t];
  const textDark = dark === null ? below <= tot - below : dark;
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (!sel || sel[p]) mask[p] = textDark ? (vals[p] <= thr ? 1 : 0) : (vals[p] > thr ? 1 : 0);
  // contraste: diferencia de medias normalizada
  let s0 = 0, n0 = 0, s1 = 0, n1 = 0;
  for (let t = 0; t < 256; t++) { if (t <= thr) { s0 += t * hist[t]; n0 += hist[t]; } else { s1 += t * hist[t]; n1 += hist[t]; } }
  const contrast = n0 && n1 ? (s1 / n1 - s0 / n0) : 0;
  // separabilidad: varianza entre clases / varianza total
  const mean = (s0 + s1) / Math.max(1, tot); let vt = 0;
  for (let t = 0; t < 256; t++) vt += hist[t] * (t - mean) * (t - mean);
  vt /= Math.max(1, tot);
  return { mask, thr, sep, eta: vt > 0 ? sep / vt : 0, textDark, contrast, fracText: textDark ? below / Math.max(1, tot) : 1 - below / Math.max(1, tot) };
}

// Máximo/mínimo deslizante 1D (van Herk / Gil-Werman), ventana 2r+1
function slide(src, dst, n, stride, off, r, isMax) {
  const k = 2 * r + 1; const g = new Float32Array(n), hh = new Float32Array(n);
  const op = isMax ? Math.max : Math.min;
  for (let i = 0; i < n; i++) { const v = src[off + i * stride]; g[i] = i % k === 0 ? v : op(g[i - 1], v); }
  for (let i = n - 1; i >= 0; i--) { const v = src[off + i * stride]; hh[i] = (i % k === k - 1 || i === n - 1) ? v : op(hh[i + 1], v); }
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
    dst[off + i * stride] = op(hh[a], g[b]);
  }
}
export function morph(arr, w, h, r, isMax) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) slide(arr, tmp, w, 1, y * w, r, isMax);
  for (let x = 0; x < w; x++) slide(tmp, out, h, w, x, r, isMax);
  return out;
}
// Top-hat: respuesta del texto oscuro (cierre − original) o claro (original − apertura), 0-255
export function topHat(arr, w, h, r, dark) {
  const a = morph(arr, w, h, r, dark), b = morph(a, w, h, r, !dark);
  const out = new Uint8ClampedArray(w * h);
  for (let p = 0; p < w * h; p++) out[p] = dark ? b[p] - arr[p] : arr[p] - b[p];
  return out;
}
