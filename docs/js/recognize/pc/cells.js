// Recortes de celdas (imagen rectificada) normalizados para OCR, y tiras de varias celdas.
import { makeCanvas, ctx2d } from './img.js';
import { ocr } from './ocr.js';

// Recorte en gris con contraste estirado (texto oscuro → negro, fondo → blanco), escala k
export function grayCrop(P, x0, y0, x1, y1, k, { loQ = 0.03, hiQ = 0.85 } = {}) {
  x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0)); x1 = Math.min(P.w - 1, Math.round(x1)); y1 = Math.min(P.h - 1, Math.round(y1));
  const w = x1 - x0 + 1; const h = y1 - y0 + 1;
  if (w < 3 || h < 3) return null;
  const ls = new Float32Array(w * h); const sorted = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (y + y0) * P.w + x + x0;
    // mínimo de canales: el texto rojo también queda oscuro
    const l = Math.min(P.R[p], P.G[p], P.B[p]) * 0.5 + P.Y[p] * 0.5;
    ls[y * w + x] = l; sorted.push(l);
  }
  sorted.sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * loQ)]; const hi = sorted[Math.floor(sorted.length * hiQ)];
  const rng = Math.max(20, hi - lo);
  const c = makeCanvas(w, h); const g = ctx2d(c); const id = g.createImageData(w, h);
  for (let q = 0; q < w * h; q++) {
    const v = Math.max(0, Math.min(255, Math.round(((ls[q] - lo) / rng) * 255 * 1.1)));
    id.data[q * 4] = id.data[q * 4 + 1] = id.data[q * 4 + 2] = v; id.data[q * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  if (k === 1) return { canvas: c, contrast: hi - lo };
  const o = makeCanvas(w * k, h * k); const go = ctx2d(o); go.imageSmoothingEnabled = true; go.imageSmoothingQuality = 'high';
  go.drawImage(c, 0, 0, o.width, o.height);
  return { canvas: o, contrast: hi - lo };
}

// Pone recortes en fila con separación blanca; devuelve el lienzo y los rangos x de cada hueco
export function strip(crops, gap, pad = 16) {
  let W = pad; let H = 0;
  for (const c of crops) { if (c) { W += c.width + gap; H = Math.max(H, c.height); } else W += gap; }
  const out = makeCanvas(W + pad, H + 2 * pad); const g = ctx2d(out); g.fillStyle = '#fff'; g.fillRect(0, 0, out.width, out.height);
  const slots = []; let x = pad;
  for (const c of crops) {
    if (c) { g.drawImage(c, x, pad + Math.round((H - c.height) / 2)); slots.push({ x0: x, x1: x + c.width }); x += c.width + gap; } else { slots.push(null); x += gap; }
  }
  return { canvas: out, slots };
}

// OCR de una tira: asigna cada símbolo al hueco más cercano (Tesseract a veces une palabras)
export async function readStrip(tess, st, { whitelist = '', psm = 7 } = {}) {
  const r = await ocr(tess, st.canvas, { psm, whitelist });
  const per = st.slots.map(() => []);
  for (const w of r.words) {
    const syms = w.syms && w.syms.length ? w.syms : [{ text: w.text, conf: w.conf, x0: w.x0, x1: w.x1 }];
    for (const sy of syms) {
      const cx = (sy.x0 + sy.x1) / 2;
      let best = -1; let bd = Infinity;
      st.slots.forEach((s, i) => { if (!s) return; const d = cx < s.x0 ? s.x0 - cx : cx > s.x1 ? cx - s.x1 : 0; if (d < bd) { bd = d; best = i; } });
      if (best >= 0 && bd < 12) per[best].push({ ...sy, wconf: w.conf });
    }
  }
  return per.map((ss) => ({ text: ss.map((s) => s.text).join(''), conf: ss.length ? Math.min(...ss.map((s) => Math.min(s.conf, s.wconf))) : 0, syms: ss }));
}
