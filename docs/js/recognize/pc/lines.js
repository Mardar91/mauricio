// Detección de líneas finas oscuras (rejilla de la tabla) con transformada de Hough y trazado de segmentos.
import { fitLine } from './geom.js';

// Mapas de "cresta oscura": píxel más oscuro que sus vecinos a ±R en vertical (líneas horizontales)
// o en horizontal (líneas verticales). Devuelve intensidades Uint8 (0 = nada).
export function ridgeMaps(Y, w, h, R, T) {
  const n = w * h;
  const sh = new Uint8ClampedArray(n); const sv = new Uint8ClampedArray(n);
  // suavizado 1×3 a lo largo de la dirección de la línea
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 1; x < w - 1; x++) sh[o + x] = (Y[o + x - 1] + 2 * Y[o + x] + Y[o + x + 1]) >> 2;
    sh[o] = Y[o]; sh[o + w - 1] = Y[o + w - 1];
  }
  for (let y = 1; y < h - 1; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) sv[o + x] = (Y[o + x - w] + 2 * Y[o + x] + Y[o + x + w]) >> 2;
  }
  for (let x = 0; x < w; x++) { sv[x] = Y[x]; sv[(h - 1) * w + x] = Y[(h - 1) * w + x]; }
  const mH = new Uint8ClampedArray(n); const mV = new Uint8ClampedArray(n);
  const rs = R > 2 ? [2, R] : [R];
  for (let y = R; y < h - R; y++) {
    const o = y * w;
    for (let x = R; x < w - R; x++) {
      const p = o + x;
      let bh = 0; let bv = 0;
      for (const r of rs) {
        const a = sh[p - r * w]; const b = sh[p + r * w]; const dh = (a < b ? a : b) - sh[p];
        if (dh > bh) bh = dh;
        const c = sv[p - r]; const d = sv[p + r]; const dv = (c < d ? c : d) - sv[p];
        if (dv > bv) bv = dv;
      }
      if (bh >= T) mH[p] = bh;
      if (bv >= T) mV[p] = bv;
    }
  }
  return { mH, mV };
}

// Hough para rectas casi horizontales (vertical=false: y = c + t·(x − xc)) o casi verticales
// (vertical=true: x = c + t·(y − yc)). Devuelve picos {t, c, votes}.
export function hough(m, w, h, { vertical = false, maxDeg = 25, stepDeg = 0.25, minVotes = 50, step = 1, maxPeaks = 200, nmsDeg = 1.5, nmsC = 4 } = {}) {
  const L = vertical ? h : w; const S = vertical ? w : h; const mid = L / 2;
  const nT = Math.round((2 * maxDeg) / stepDeg) + 1;
  const ts = new Float32Array(nT);
  for (let k = 0; k < nT; k++) ts[k] = Math.tan(((-maxDeg + k * stepDeg) * Math.PI) / 180);
  const off = Math.ceil(mid * Math.tan((maxDeg * Math.PI) / 180)) + 2; const nC = S + 2 * off;
  const acc = new Uint16Array(nT * nC);
  for (let y = 0; y < h; y += vertical ? 1 : step) {
    const o = y * w;
    for (let x = 0; x < w; x += vertical ? step : 1) {
      if (!m[o + x]) continue;
      const along = (vertical ? y : x) - mid; const across = (vertical ? x : y) + off;
      for (let k = 0; k < nT; k++) {
        const c = (across - ts[k] * along + 0.5) | 0;
        acc[k * nC + c]++;
      }
    }
  }
  // supresión de no máximos
  const cand = [];
  for (let k = 0; k < nT; k++) {
    const ro = k * nC;
    for (let c = 1; c < nC - 1; c++) {
      const v = acc[ro + c];
      if (v >= minVotes && v >= acc[ro + c - 1] && v >= acc[ro + c + 1]) cand.push(k, c, v);
    }
  }
  const idx = []; for (let i = 0; i < cand.length; i += 3) idx.push(i);
  idx.sort((a, b) => cand[b + 2] - cand[a + 2]);
  const peaks = []; const nk = Math.round(nmsDeg / stepDeg);
  for (const i of idx) {
    const k = cand[i]; const c = cand[i + 1];
    let ok = true;
    for (const p of peaks) {
      if (Math.abs(p.k - k) <= nk) {
        // distancia entre rectas medida en los extremos del rango
        const c1 = c - off; const c2 = p.c;
        const d0 = Math.abs((c1 - ts[k] * mid) - (c2 - ts[p.k] * mid)); const d1 = Math.abs((c1 + ts[k] * mid) - (c2 + ts[p.k] * mid));
        if (Math.min(d0, d1) <= nmsC || Math.abs(c1 - c2) <= nmsC) { ok = false; break; }
      }
    }
    if (ok) { peaks.push({ k, t: ts[k], c: c - off, votes: cand[i + 2], vertical, mid }); if (peaks.length >= maxPeaks) break; }
  }
  return peaks;
}

// Recorre una recta y devuelve los segmentos cubiertos por el mapa (tolerando huecos), con la recta refinada.
export function traceSegments(m, w, h, line, { tol = 1, maxGap = 6, minLen = 30 } = {}) {
  const { vertical, t, c, mid } = line;
  const L = vertical ? h : w; const S = vertical ? w : h;
  const segs = []; let start = -1; let last = -1; let pts = []; let wts = [];
  const flush = () => {
    if (start >= 0 && last - start + 1 >= minLen && pts.length >= minLen * 0.4) {
      const f = fitLine(pts, wts);
      segs.push({ s0: start, s1: last, n: pts.length, cover: pts.length / (last - start + 1), fit: f });
    }
    start = -1; pts = []; wts = [];
  };
  for (let a = 0; a < L; a++) {
    const b0 = c + t * (a - mid);
    const bi = Math.round(b0);
    let best = 0; let bsum = 0; let bw = 0;
    for (let d = -tol - 1; d <= tol + 1; d++) {
      const b = bi + d; if (b < 0 || b >= S) continue;
      const v = vertical ? m[a * w + b] : m[b * w + a];
      if (v) { if (Math.abs(d) <= tol && v > best) best = v; bsum += v * b; bw += v; }
    }
    if (best) {
      if (start < 0) start = a;
      else if (a - last > maxGap) { flush(); start = a; }
      last = a;
      const bc = bsum / bw;
      pts.push(vertical ? [bc, a] : [a, bc]); wts.push(best);
    }
  }
  flush();
  return segs;
}

// Representación de un segmento como recta en forma "b = c + t·(a − mid)" refinada y extremos
export function segToLine(seg, vertical, mid) {
  const f = seg.fit;
  // dirección (dx,dy); para horizontales t = dy/dx; para verticales t = dx/dy
  let t; let c;
  if (!vertical) { t = f.dy / f.dx; c = f.my + t * (mid - f.mx); } else { t = f.dx / f.dy; c = f.mx + t * (mid - f.my); }
  return { vertical, t, c, mid, a0: seg.s0, a1: seg.s1, len: seg.s1 - seg.s0 + 1, cover: seg.cover };
}

// Punto (x,y) de la recta en la coordenada "a" (x para horizontales, y para verticales)
export function at(l, a) { const b = l.c + l.t * (a - l.mid); return l.vertical ? [b, a] : [a, b]; }

// Forma normal a·x + b·y = c
export function toNormal(l) {
  const [x0, y0] = at(l, l.mid - 100); const [x1, y1] = at(l, l.mid + 100);
  const dx = x1 - x0; const dy = y1 - y0; const L = Math.hypot(dx, dy);
  const a = -dy / L; const b = dx / L; return { a, b, c: a * x0 + b * y0 };
}

// Detecta segmentos casi horizontales y casi verticales en la imagen
export function detectSegments(Y, w, h, opts = {}) {
  const long = Math.max(w, h);
  const R = opts.R || Math.max(2, Math.round(long / 650));
  const T = opts.T || 16;
  const { mH, mV } = ridgeMaps(Y, w, h, R, T);
  const minH = Math.max(40, Math.round(long * 0.06));
  const minV = Math.max(14, Math.round(long * 0.012));
  const pH = hough(mH, w, h, { vertical: false, maxDeg: 25, minVotes: Math.round(minH * 0.6), maxPeaks: 150 });
  const pV = hough(mV, w, h, { vertical: true, maxDeg: 30, minVotes: Math.round(minV * 0.8), maxPeaks: 600, nmsC: 3 });
  const gapH = Math.max(5, Math.round(long * 0.006)); const gapV = Math.max(3, Math.round(long * 0.003));
  const hs = []; const vs = [];
  for (const p of pH) for (const s of traceSegments(mH, w, h, p, { tol: 1, maxGap: gapH, minLen: minH })) if (s.cover > 0.5) hs.push(segToLine(s, false, p.mid));
  for (const p of pV) for (const s of traceSegments(mV, w, h, p, { tol: 1, maxGap: gapV, minLen: minV })) if (s.cover > 0.55) vs.push(segToLine(s, true, p.mid));
  return { hs: dedupe(hs), vs: dedupe(vs), mH, mV, R, T };
}

// Elimina segmentos casi idénticos (mismo trazo detectado dos veces)
function dedupe(ls) {
  ls.sort((a, b) => b.len - a.len);
  const out = [];
  for (const l of ls) {
    let dup = false;
    for (const o of out) {
      const a0 = Math.max(l.a0, o.a0); const a1 = Math.min(l.a1, o.a1);
      if (a1 - a0 < 0.5 * l.len) continue;
      const am = (a0 + a1) / 2;
      const d = Math.abs((l.c + l.t * (am - l.mid)) - (o.c + o.t * (am - o.mid)));
      if (d < 2.5) { dup = true; break; }
    }
    if (!dup) out.push(l);
  }
  return out;
}
