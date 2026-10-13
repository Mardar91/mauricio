// Geometría pura: rectas, homografías y ajustes robustos (sin DOM).

// Resuelve A·x = b (Gauss con pivoteo parcial). A: array de filas.
export function solve(A, b) {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// Homografía (array de 9) que lleva src[i] → dst[i] (4 puntos [x, y]).
export function homography(src, dst) {
  const A = []; const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]; const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d];
  return r.map((v) => v / det);
}

export function intersect(l1, l2) {
  const det = l1.nx * l2.ny - l1.ny * l2.nx;
  if (Math.abs(det) < 1e-12) return null;
  return [(l1.c * l2.ny - l1.ny * l2.c) / det, (l1.nx * l2.c - l1.c * l2.nx) / det];
}

// Ajuste robusto s = a·t + b (RANSAC sobre pares + mínimos cuadrados). pts: [{t, s, w}]. Devuelve {a, b, inliers, rms} o null.
export function fitRobust(pts, tol) {
  if (pts.length < 2) return null;
  let best = null;
  const n = pts.length;
  const pairs = [];
  if (n <= 40) { for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]); }
  else { let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); for (let k = 0; k < 600; k++) { const i = Math.floor(rnd() * n), j = Math.floor(rnd() * n); if (i !== j) pairs.push([i, j]); } }
  for (const [i, j] of pairs) {
    const p = pts[i], q = pts[j];
    if (Math.abs(q.t - p.t) < 1e-6) continue;
    const a = (q.s - p.s) / (q.t - p.t), b = p.s - a * p.t;
    let score = 0;
    for (const r of pts) if (Math.abs(r.s - (a * r.t + b)) <= tol) score += r.w;
    if (!best || score > best.score) best = { a, b, score };
  }
  if (!best) return null;
  // refinamiento por mínimos cuadrados ponderados sobre inliers
  let { a, b } = best; let inl = [];
  for (let it = 0; it < 3; it++) {
    inl = pts.filter((r) => Math.abs(r.s - (a * r.t + b)) <= tol);
    if (inl.length < 2) break;
    const f = linReg(inl);
    if (!f) break;
    a = f.a; b = f.b;
  }
  const rms = Math.sqrt(inl.reduce((s, r) => s + (r.s - (a * r.t + b)) ** 2, 0) / Math.max(1, inl.length));
  return { a, b, inliers: inl.length, weight: inl.reduce((s, r) => s + r.w, 0), rms };
}

export function linReg(pts) {
  let sw = 0, st = 0, ss = 0, stt = 0, sts = 0;
  for (const p of pts) { const w = p.w ?? 1; sw += w; st += w * p.t; ss += w * p.s; stt += w * p.t * p.t; sts += w * p.t * p.s; }
  const den = sw * stt - st * st;
  if (Math.abs(den) < 1e-9) return null;
  const a = (sw * sts - st * ss) / den;
  return { a, b: (ss - a * st) / sw };
}

export function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

export function weightedMedian(vals, ws) {
  const idx = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]);
  const tot = ws.reduce((a, b) => a + b, 0); let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= tot / 2) return vals[i]; }
  return vals[idx[idx.length - 1]];
}
