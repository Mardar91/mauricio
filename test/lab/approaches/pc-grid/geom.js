// Geometría: homografías, rectas y remuestreo.
import { makeCanvas, ctx2d } from './img.js';

// Resuelve A·x = b (Gauss con pivoteo parcial). A: array de filas.
export function solve(A, b) {
  const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function normT(pts) {
  let mx = 0; let my = 0; for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let d = 0; for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
  d = d / pts.length || 1; const s = Math.SQRT2 / d;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

export function mul(A, B) {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
}

export function inv(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h; const B = -(d * i - f * g); const C = d * h - e * g;
  const det = a * A + b * B + c * C; if (Math.abs(det) < 1e-15) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function apply(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

// Homografía (mínimos cuadrados, h33=1, coordenadas normalizadas) que lleva src → dst
export function homography(src, dst) {
  if (src.length < 4) return null;
  const Ts = normT(src); const Td = normT(dst);
  const s = src.map(([x, y]) => apply(Ts, x, y)); const d = dst.map(([x, y]) => apply(Td, x, y));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)); const Atb = new Array(8).fill(0);
  const add = (row, v) => { for (let i = 0; i < 8; i++) { Atb[i] += row[i] * v; for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]; } };
  for (let k = 0; k < s.length; k++) {
    const [x, y] = s[k]; const [u, v] = d[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb); if (!h) return null;
  const Hn = [...h, 1];
  const Tdi = inv(Td); if (!Tdi) return null;
  const H = mul(Tdi, mul(Hn, Ts));
  const k = H[8]; return H.map((v) => v / k);
}

export function intersect(l1, l2) {
  const det = l1.a * l2.b - l2.a * l1.b; if (Math.abs(det) < 1e-12) return null;
  return [(l1.c * l2.b - l2.c * l1.b) / det, (l1.a * l2.c - l2.a * l1.c) / det];
}

// Ajuste de recta por mínimos cuadrados totales a puntos [[x,y],...] (con pesos opcionales)
export function fitLine(pts, wts) {
  let sw = 0; let mx = 0; let my = 0;
  for (let i = 0; i < pts.length; i++) { const w = wts ? wts[i] : 1; sw += w; mx += w * pts[i][0]; my += w * pts[i][1]; }
  if (!sw) return null; mx /= sw; my /= sw;
  let sxx = 0; let syy = 0; let sxy = 0;
  for (let i = 0; i < pts.length; i++) { const w = wts ? wts[i] : 1; const dx = pts[i][0] - mx; const dy = pts[i][1] - my; sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy); // dirección principal
  const dx = Math.cos(th); const dy = Math.sin(th);
  return { a: -dy, b: dx, c: -dy * mx + dx * my, mx, my, dx, dy };
}

// Remuestrea la imagen fuente (ImageData) con una homografía destino→fuente. Devuelve un lienzo w×h.
export function warp(srcData, sw, sh, Hds, w, h) {
  const out = makeCanvas(w, h); const g = ctx2d(out); const id = g.createImageData(w, h); const o = id.data; const s = srcData;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const den = Hds[6] * u + Hds[7] * v + Hds[8];
      const x = (Hds[0] * u + Hds[1] * v + Hds[2]) / den; const y = (Hds[3] * u + Hds[4] * v + Hds[5]) / den;
      const oi = (v * w + u) * 4;
      if (!(x >= 0 && y >= 0 && x <= sw - 1 && y <= sh - 1)) { o[oi] = o[oi + 1] = o[oi + 2] = 255; o[oi + 3] = 255; continue; }
      const x0 = Math.floor(x); const y0 = Math.floor(y); const fx = x - x0; const fy = y - y0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0; const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const i00 = (y0 * sw + x0) * 4; const i10 = (y0 * sw + x1) * 4; const i01 = (y1 * sw + x0) * 4; const i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy); const w10 = fx * (1 - fy); const w01 = (1 - fx) * fy; const w11 = fx * fy;
      o[oi] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
      o[oi + 1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
      o[oi + 2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
      o[oi + 3] = 255;
    }
  }
  g.putImageData(id, 0, 0);
  return out;
}
