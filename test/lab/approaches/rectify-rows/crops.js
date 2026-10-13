// Recortes para OCR: se remuestrean desde la foto original vía la homografía (una sola interpolación)
// y se binarizan a texto negro sobre blanco.
import { warp, otsu, makeImage } from './raster.js';

// Caja en píxeles canónicos (i0, j0, i1, j1) → imagen con alto targetH.
export function renderCanon(src, canon, i0, j0, i1, j1, targetH) {
  const hu = (j1 - j0) * canon.step; const sc = targetH / hu; // px de salida por unidad canónica
  const outW = Math.max(4, Math.round((i1 - i0) * canon.step * sc)), outH = Math.max(4, Math.round(targetH));
  const img = warp(src, canon.H, outW, outH, i0 * canon.step, canon.v0 + j0 * canon.step, 1 / sc);
  return { img, sc: sc * canon.step }; // sc: px de salida por px canónico
}

// Texto oscuro sobre fondo claro → máscara binaria (1 = tinta) por Otsu de luminancia.
export function binarizeDark(img) {
  const n = img.w * img.h; const L = new Float32Array(n); const d = img.data;
  for (let i = 0, q = 0; i < n; i++, q += 4) L[i] = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
  const t = otsu(L, 0, 255);
  const m = new Uint8Array(n); for (let i = 0; i < n; i++) m[i] = L[i] < t ? 1 : 0;
  return m;
}

// Máscara binaria → imagen RGBA blanco/negro con margen (para Tesseract).
export function maskToImage(mask, w, h, pad) {
  const W = w + 2 * pad, H = h + 2 * pad; const out = makeImage(W, H); out.data.fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { const q = ((y + pad) * W + x + pad) * 4; out.data[q] = out.data[q + 1] = out.data[q + 2] = 0; }
  return out;
}

// Quita componentes de tinta que tocan el borde del recorte (restos de vecinos/separadores).
export function dropBorderBlobs(mask, w, h) {
  const seen = new Uint8Array(w * h); const st = [];
  const push = (p) => { if (mask[p] && !seen[p]) { seen[p] = 1; st.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (st.length) {
    const p = st.pop(); const x = p % w, y = (p / w) | 0;
    if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (y > 0) push(p - w); if (y < h - 1) push(p + w);
  }
  let inside = 0, border = 0;
  for (let i = 0; i < w * h; i++) if (mask[i]) { if (seen[i]) border++; else inside++; }
  // si casi todo toca el borde, se deja como está (glifo grande bien encuadrado)
  if (inside < 0.25 * (inside + border)) return mask;
  const m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = mask[i] && !seen[i] ? 1 : 0;
  return m;
}

// Texto de una insignia: trazos finos más oscuros (o más claros) que su entorno inmediato,
// por "black-hat" morfológico (cierre − imagen) dentro de la forma erosionada. Así un reflejo
// o degradado sobre la insignia no se confunde con texto.
// item.fm: máscara rellena en coords de fila (ox, oy relativos a la franja; fmOy = ja).
export function badgeTextMask(img, sc, i0, j0, item, k, opts = {}) {
  const { mask, bw, bh, ox, oy } = item.fm; const offY = item.fmOy;
  const dist = chamfer(mask, bw, bh);
  const bhC = item.y1 - item.y0 + 1; // alto de la insignia en px canónicos
  const er = Math.max(1, 0.12 * bhC);
  const n = img.w * img.h; const d = img.data; const W = img.w, H = img.h;
  const inside = new Uint8Array(n); let nIn = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const mi = Math.round(i0 + x / sc - ox), mj = Math.round(j0 + y / sc - offY - oy);
    if (mi < 0 || mj < 0 || mi >= bw || mj >= bh) continue;
    if (dist[mj * bw + mi] >= er) { inside[y * W + x] = 1; nIn++; }
  }
  if (nIn < 20) return null;
  // canal con más contraste: magenta → (R+B)/2; resto → luminancia. Texto claro → se invierte.
  const v = new Float32Array(n);
  for (let p = 0, q = 0; p < n; p++, q += 4) {
    const r = d[q] * k[0], g = d[q + 1] * k[1], b = d[q + 2] * k[2];
    let x = opts.channel === 'rb' ? (r + b) / 2 : 0.299 * r + 0.587 * g + 0.114 * b;
    if (opts.light) x = 300 - x;
    v[p] = x;
  }
  const rw = Math.max(2, Math.round(0.1 * bhC * sc));
  const clo = minFilter(maxFilter(v, W, H, rw), W, H, rw);
  const bh2 = new Float32Array(n); const vals = [];
  for (let p = 0; p < n; p++) if (inside[p]) { bh2[p] = clo[p] - v[p]; vals.push(bh2[p]); }
  let t = Math.max(22, otsu(vals, 0, 200));
  // opción "fino": umbral más alto para que la tinta no pase de inkMax (trazos más delgados)
  if (opts.inkMax) { const s = Float32Array.from(vals).sort(); t = Math.max(t, s[Math.floor((1 - opts.inkMax) * (s.length - 1))]); }
  const m = new Uint8Array(n); let ink = 0;
  for (let p = 0; p < n; p++) if (inside[p] && bh2[p] > t) { m[p] = 1; ink++; }
  return { mask: m, ink: ink / nIn, thr: t };
}

export function maxFilter(src, W, H, r) { return morph(src, W, H, r, Math.max); }
export function minFilter(src, W, H, r) { return morph(src, W, H, r, Math.min); }
// Filtro separable de máximo/mínimo en ventana cuadrada (2r+1).
function morph(src, W, H, r, f) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = src[y * W + x];
    for (let i = Math.max(0, x - r); i <= Math.min(W - 1, x + r); i++) a = f(a, src[y * W + i]);
    tmp[y * W + x] = a;
  }
  for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
    let a = tmp[y * W + x];
    for (let j = Math.max(0, y - r); j <= Math.min(H - 1, y + r); j++) a = f(a, tmp[j * W + x]);
    out[y * W + x] = a;
  }
  return out;
}

// Distancia chamfer 3-4 al exterior de la máscara (en píxeles aprox.).
function chamfer(mask, w, h) {
  const INF = 1e9; const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = mask[i] ? INF : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + 1); else v = Math.min(v, 1);
    if (y > 0) v = Math.min(v, d[i - w] + 1); else v = Math.min(v, 1);
    if (x > 0 && y > 0) v = Math.min(v, d[i - w - 1] + 1.4);
    if (x < w - 1 && y > 0) v = Math.min(v, d[i - w + 1] + 1.4);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + 1); else v = Math.min(v, 1);
    if (y < h - 1) v = Math.min(v, d[i + w] + 1); else v = Math.min(v, 1);
    if (x < w - 1 && y < h - 1) v = Math.min(v, d[i + w + 1] + 1.4);
    if (x > 0 && y < h - 1) v = Math.min(v, d[i + w - 1] + 1.4);
    d[i] = v;
  }
  return d;
}

// Texto oscuro sobre fondo de color variable (cabecera naranja, reflejos): black-hat de la luminancia
// con ventana de radio rw y umbral de Otsu (mínimo minT). Devuelve máscara (1 = tinta).
export function blackHatMask(img, rw, minT = 12) {
  const n = img.w * img.h; const d = img.data; const v = new Float32Array(n);
  for (let p = 0, q = 0; p < n; p++, q += 4) v[p] = 0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2];
  const clo = minFilter(maxFilter(v, img.w, img.h, rw), img.w, img.h, rw);
  const bh = new Float32Array(n); const vals = [];
  for (let p = 0; p < n; p++) { bh[p] = clo[p] - v[p]; if (p % 3 === 0) vals.push(bh[p]); }
  const t = Math.max(minT, otsu(vals, 0, 160));
  const m = new Uint8Array(n); for (let p = 0; p < n; p++) m[p] = bh[p] > t ? 1 : 0;
  return m;
}
