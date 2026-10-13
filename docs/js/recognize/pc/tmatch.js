// Comparación con plantillas: el texto de la insignia frente a los códigos candidatos dibujados con Arial.
import { makeCanvas, ctx2d } from './img.js';

const TH = 32; // altura normalizada del texto
const cache = new Map();

// Remuestreo bilineal de una matriz w×h a W×H
function resample(a, w, h, W, H) {
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = ((y + 0.5) * h) / H - 0.5; const y0 = Math.max(0, Math.floor(sy)); const y1 = Math.min(h - 1, y0 + 1); const fy = Math.min(1, Math.max(0, sy - y0));
    for (let x = 0; x < W; x++) {
      const sx = ((x + 0.5) * w) / W - 0.5; const x0 = Math.max(0, Math.floor(sx)); const x1 = Math.min(w - 1, x0 + 1); const fx = Math.min(1, Math.max(0, sx - x0));
      o[y * W + x] = (a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx) * (1 - fy) + (a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx) * fy;
    }
  }
  return o;
}

// Caja de tinta (valores > thr) de una matriz
function inkBox(a, w, h, thr) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (a[y * w + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function crop(a, w, b) {
  const o = new Float32Array(b.w * b.h);
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) o[y * b.w + x] = a[(y + b.y0) * w + x + b.x0];
  return o;
}

// Plantilla de un código (tinta 0..1), reducida a la resolución de origen srcH y vuelta a TH
function template(code, srcH) {
  const key = code + '@' + srcH;
  if (cache.has(key)) return cache.get(key);
  const fs = 64; const c = makeCanvas(fs * 3, fs * 1.6); const g = ctx2d(c);
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#000';
  g.font = `${fs}px Arial, Helvetica, "Liberation Sans", sans-serif`; g.textBaseline = 'middle'; g.fillText(code, fs * 0.3, c.height / 2);
  const d = g.getImageData(0, 0, c.width, c.height).data; const a = new Float32Array(c.width * c.height);
  for (let i = 0; i < a.length; i++) a[i] = 1 - d[i * 4] / 255;
  const b = inkBox(a, c.width, c.height, 0.5);
  const ink = crop(a, c.width, b);
  // simula la pérdida de resolución de la foto
  const sw = Math.max(2, Math.round((b.w * srcH) / b.h)); const lo = resample(ink, b.w, b.h, sw, srcH);
  const W = Math.max(4, Math.round((b.w * TH) / b.h));
  const t = { data: resample(lo, sw, srcH, W, TH), w: W, aspect: b.w / b.h };
  cache.set(key, t);
  return t;
}

function ncc(a, b) {
  const n = a.length; let ma = 0; let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0; let saa = 0; let sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma; const y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

// ink: matriz de tinta (0..1) del texto de la insignia (w×h). Devuelve [{code, score}] ordenado.
export function matchCodes(ink, w, h, cands) {
  const b = inkBox(ink, w, h, 0.45);
  if (!b || b.h < 4 || b.w < 3) return [];
  const src = crop(ink, w, b);
  const out = [];
  for (const code of cands) {
    const t = template(code, b.h);
    // compara con la caja de tinta reescalada al tamaño de la plantilla
    const W = t.w; const s = resample(src, b.w, b.h, W, TH);
    const aspectPen = Math.abs(Math.log(b.w / b.h / t.aspect));
    out.push({ code, score: ncc(s, t.data) - 0.6 * aspectPen, aspect: +(b.w / b.h).toFixed(2), tAspect: +t.aspect.toFixed(2) });
  }
  return out.sort((x, y) => y.score - x.score);
}

// Firma compacta del texto (caja de tinta remuestreada a 36×18) para comparar insignias entre sí
export function inkSignature(ink, w, h) {
  const b = inkBox(ink, w, h, 0.45);
  if (!b || b.h < 3 || b.w < 3) return null;
  const x0 = Math.max(0, b.x0 - 1); const y0 = Math.max(0, b.y0 - 1); const x1 = Math.min(w - 1, b.x1 + 1); const y1 = Math.min(h - 1, b.y1 + 1);
  const bb = { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  return { sig: Array.from(resample(crop(ink, w, bb), bb.w, bb.h, 36, 18), (v) => Math.round(v * 100) / 100), asp: b.w / b.h };
}
