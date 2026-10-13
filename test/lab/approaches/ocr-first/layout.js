// Región de interés (pantalla / lista) y estimación de inclinación.
import { rgbToHsv } from './img.js';

// Rejilla gruesa: color medio y desviación de luminancia por celda.
export function cellGrid(rgba, w, h, f) {
  const W = Math.floor(w / f), H = Math.floor(h / f), n = W * H;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), S = new Float32Array(n);
  const k = 1 / (f * f);
  for (let Y = 0; Y < H; Y++) {
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, b = 0, l2 = 0, l1 = 0;
      for (let dy = 0; dy < f; dy++) {
        let j = ((Y * f + dy) * w + X * f) * 4;
        for (let dx = 0; dx < f; dx++, j += 4) {
          const rr = rgba[j], gg = rgba[j + 1], bb = rgba[j + 2]; r += rr; g += gg; b += bb;
          const L = 0.3 * rr + 0.59 * gg + 0.11 * bb; l1 += L; l2 += L * L;
        }
      }
      const i = Y * W + X; R[i] = r * k; G[i] = g * k; B[i] = b * k; S[i] = Math.sqrt(Math.max(0, l2 * k - (l1 * k) ** 2));
    }
  }
  return { f, W, H, R, G, B, S };
}

function otsu(values) {
  const hist = new Float64Array(256); for (const v of values) hist[Math.max(0, Math.min(255, v | 0))]++;
  const total = values.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF; const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Componentes conexas (4-vecinos) de una máscara; devuelve etiquetas y estadísticas.
export function components(mask, W, H) {
  const lab = new Int32Array(W * H).fill(-1); const comps = []; const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const id = comps.length; let n = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sx = 0, sy = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop(); const x = p % W, y = (p / W) | 0; n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && lab[p - 1] < 0) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < W - 1 && mask[p + 1] && lab[p + 1] < 0) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && mask[p - W] && lab[p - W] < 0) { lab[p - W] = id; stack.push(p - W); }
      if (y < H - 1 && mask[p + W] && lab[p + W] < 0) { lab[p + W] = id; stack.push(p + W); }
    }
    comps.push({ id, n, x0, y0, x1, y1, cx: sx / n, cy: sy / n });
  }
  return { lab, comps };
}

// Busca la zona clara y poco saturada más grande (la lista) y la cabecera naranja encima.
export function findROI(rgba, w, h) {
  const f = Math.max(4, Math.round(Math.max(w, h) / 220));
  const g = cellGrid(rgba, w, h, f); const { W, H } = g; const n = W * H;
  const V = new Uint8Array(n), Sat = new Float32Array(n), Hue = new Float32Array(n);
  for (let i = 0; i < n; i++) { const [hh, s, v] = rgbToHsv(g.R[i], g.G[i], g.B[i]); Hue[i] = hh; Sat[i] = s; V[i] = Math.round(v * 255); }
  // Umbral de brillo: Otsu, pero sin pasar del 75 % del brillo alto (las filas grises del fin de
  // semana no deben quedar fuera en capturas limpias).
  const sv = Array.from(V).sort((a, b) => a - b); const p90 = sv[Math.floor(sv.length * 0.9)];
  const thr = Math.max(90, Math.min(otsu(V), 0.75 * p90));
  // Candidatas: claras y lisas. El color de referencia (cromaticidad mediana) admite pantallas
  // teñidas (luz azulada o amarillenta) sin depender de una saturación absoluta.
  const chroma = (i) => { const t = g.R[i] + g.G[i] + g.B[i] + 1e-3; return [g.R[i] / t, g.G[i] / t]; };
  const cr = [], cg = [];
  for (let i = 0; i < n; i++) if (V[i] >= thr && g.S[i] < 40 && Sat[i] < 0.5) { const [a, b] = chroma(i); cr.push(a); cg.push(b); }
  const med = (a) => { const s2 = a.sort((x, y) => x - y); return s2.length ? s2[s2.length >> 1] : 1 / 3; };
  const refR = med(cr), refG = med(cg);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (V[i] < thr || g.S[i] >= 40) continue;
    const [a, b] = chroma(i);
    mask[i] = Sat[i] < 0.25 || (Sat[i] < 0.5 && Math.hypot(a - refR, b - refG) < 0.035) ? 1 : 0;
  }
  const { comps } = components(mask, W, H);
  comps.sort((a, b) => b.n - a.n);
  const big = comps[0];
  if (!big || big.n < n * 0.04) return { x: 0, y: 0, w, h, f, ok: false, grid: g };
  let { x0, y0, x1, y1 } = big;
  // Extiende hacia arriba por la cabecera naranja.
  const isOrange = (i) => Hue[i] >= 12 && Hue[i] <= 50 && Sat[i] >= 0.42 && V[i] >= 70;
  // (se toleran 2 filas de celdas no naranjas al principio: mezcla en el borde)
  const maxUp = Math.round((y1 - y0) * 0.4); let up = 0, miss = 0;
  for (let k = 1; k <= maxUp && y0 - k >= 0; k++) {
    const y = y0 - k; let c = 0; for (let x = x0; x <= x1; x++) if (isOrange(y * W + x)) c++;
    if (c >= (x1 - x0 + 1) * 0.3) { up = k; miss = 0; } else if (++miss > 2) break;
  }
  y0 -= up;
  const pad = 1;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
  return { x: x0 * f, y: y0 * f, w: (x1 - x0 + 1) * f, h: (y1 - y0 + 1) * f, f, ok: true, headerCells: up, grid: g };
}

// Inclinación dominante (grados) de las estructuras horizontales dentro de un rectángulo.
export function estimateSkew(rgba, w, h, roi, maxDeg = 16) {
  const s = Math.max(1, Math.round(roi.w / 420)); // submuestreo
  const W = Math.floor(roi.w / s), H = Math.floor(roi.h / s);
  const L = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const j = ((roi.y + y * s) * w + roi.x + x * s) * 4; L[y * W + x] = 0.3 * rgba[j] + 0.59 * rgba[j + 1] + 0.11 * rgba[j + 2];
    }
  }
  const pts = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 0; x < W; x++) {
      const gy = L[(y + 1) * W + x] - L[(y - 1) * W + x];
      const gx = x > 0 && x < W - 1 ? L[y * W + x + 1] - L[y * W + x - 1] : 0;
      const a = Math.abs(gy);
      if (a > 14 && a > 1.5 * Math.abs(gx)) pts.push(x, y, Math.min(a, 80));
    }
  }
  if (pts.length < 300) return 0;
  const score = (deg) => {
    const t = deg * Math.PI / 180, c = Math.cos(t), sn = Math.sin(t);
    const off = W * Math.abs(sn) + 2; const bins = new Float64Array(Math.ceil(H + 2 * off) + 2);
    for (let i = 0; i < pts.length; i += 3) { const r = pts[i + 1] * c - pts[i] * sn + off; bins[r | 0] += pts[i + 2]; }
    let q = 0; for (let i = 0; i < bins.length; i++) q += bins[i] * bins[i];
    return q;
  };
  let best = 0, bs = -1;
  for (let d = -maxDeg; d <= maxDeg; d += 0.5) { const v = score(d); if (v > bs) { bs = v; best = d; } }
  let fine = best;
  for (let d = best - 0.5; d <= best + 0.5; d += 0.1) { const v = score(d); if (v > bs) { bs = v; fine = d; } }
  return Math.round(fine * 10) / 10;
}
