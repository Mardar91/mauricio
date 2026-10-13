// Detección de las líneas separadoras de filas (finas, oscuras, casi horizontales) y de los
// bordes izquierdo/derecho de la pantalla, para construir el cuadrilátero de rectificación.
import { median, percentile, fitRobust, linReg, intersect, weightedMedian } from './geom.js';
import { sampleGray } from './raster.js';

const DEG = Math.PI / 180;

// Respuesta relativa de "línea fina más oscura que arriba y abajo"; adelgazada a 1 px en vertical.
export function lineResponse(g, w, h, d = 2) {
  // suavizado: 5 px en horizontal (a lo largo de la línea) y [1 2 1] en vertical
  const sh = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      let a = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const xx = x + k; if (xx >= 0 && xx < w) { a += g[r + xx]; n++; } }
      sh[r + x] = a / n;
    }
  }
  const sm = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    sm[i] = y > 0 && y < h - 1 ? (sh[i - w] + 2 * sh[i] + sh[i + w]) / 4 : sh[i];
  }
  // dos escalas (líneas finas y líneas algo borrosas): se queda la mayor respuesta
  const raw = new Float32Array(w * h); const bg = new Float32Array(w * h);
  for (const dd of [d, d + 2]) {
    for (let y = dd + 1; y < h - dd - 1; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x; const c = Math.min(sm[i], (sm[i - w] + sm[i] + sm[i + w]) / 3 + 1);
        const up = Math.max(sm[i - dd * w], sm[i - (dd + 1) * w]), dn = Math.max(sm[i + dd * w], sm[i + (dd + 1) * w]);
        const m = Math.min(up, dn);
        if (m > c) { const v = (m - c) / Math.max(m, 40); if (v > raw[i]) { raw[i] = v; bg[i] = m; } }
      }
    }
  }
  // supresión de no-máximos en vertical
  const resp = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const v = raw[i];
    if (v > 0 && v >= raw[i - w] && v > raw[i + w]) resp[i] = v;
  }
  return { resp, bg, sm };
}

// Transformada de Hough restringida a rectas casi horizontales.
function hough(pts, w, h, maxDeg = 24, stepDeg = 0.25) {
  const cx = w / 2, cy = h / 2; const R = Math.ceil(Math.hypot(w, h) / 2) + 2; const NR = 2 * R + 1;
  const NT = Math.round((2 * maxDeg) / stepDeg) + 1;
  const sinT = new Float32Array(NT), cosT = new Float32Array(NT);
  for (let t = 0; t < NT; t++) { const a = (-maxDeg + t * stepDeg) * DEG; sinT[t] = Math.sin(a); cosT[t] = Math.cos(a); }
  const acc = new Float32Array(NT * NR);
  const { xs, ys, ws } = pts;
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k] - cx, y = ys[k] - cy, wt = ws[k];
    for (let t = 0; t < NT; t++) {
      const rho = -x * sinT[t] + y * cosT[t];
      acc[t * NR + Math.round(rho) + R] += wt;
    }
  }
  return { acc, NT, NR, R, cx, cy, maxDeg, stepDeg };
}

// Recorre la recta y = a·x + b sobre la respuesta: segmento con soporte (huecos ≤ gap).
function support(hitMap, w, h, a, b, gap) {
  let best = null; let cur = null; let lastHit = -1e9;
  for (let x = 0; x < w; x++) {
    const y = Math.round(a * x + b);
    if (y < 1 || y >= h - 1) { continue; }
    const i = y * w + x;
    const hit = hitMap[i] || hitMap[i - w] || hitMap[i + w];
    if (!hit) continue;
    if (!cur || x - lastHit > gap) { if (cur && (!best || cur.n > best.n)) best = cur; cur = { x0: x, x1: x, n: 0 }; }
    cur.x1 = x; cur.n++; lastHit = x;
  }
  if (cur && (!best || cur.n > best.n)) best = cur;
  return best;
}

// Detecta la familia de separadores. g: gris de la imagen de análisis (w×h).
export function detectSeparators(g, w, h) {
  const { resp, bg, sm } = lineResponse(g, w, h, 2);
  const bright = percentile(subsample(g, 7), 0.97);
  const minBg = 0.5 * bright;
  // umbral adaptado al ruido: σ robusto (MAD) de la segunda diferencia vertical en zonas claras
  const dif = [];
  for (let y = 3; y < h - 3; y += 3) for (let x = 0; x < w; x += 3) { const i = y * w + x; if (g[i] >= minBg) dif.push(Math.abs(sm[i] - (sm[i - 2 * w] + sm[i + 2 * w]) / 2)); }
  const sigma = dif.length ? 1.4826 * percentile(dif, 0.5) / 1.22 : 0;
  const T = Math.max(0.028, 3.5 * sigma / Math.max(60, bright));
  const xs = [], ys = [], ws = []; const hitMap = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const r = resp[i];
    if (r >= T && bg[i] >= minBg) { xs.push(x); ys.push(y); ws.push(Math.min(1, r / 0.08)); hitMap[i] = 1; }
  }
  if (xs.length < 50) return { lines: [], resp, bright, npts: xs.length, T };
  const H = hough({ xs, ys, ws }, w, h);
  const { acc, NT, NR, R, cx, cy, maxDeg, stepDeg } = H;
  // candidatos: máximos locales 3×3 ordenados por votos
  let top = 0; for (let i = 0; i < acc.length; i++) if (acc[i] > top) top = acc[i];
  const minVotes = Math.max(25, 0.1 * top);
  const cands = [];
  for (let t = 0; t < NT; t++) for (let r = 1; r < NR - 1; r++) {
    const v = acc[t * NR + r]; if (v < minVotes) continue;
    let isMax = true;
    for (let dt = -1; dt <= 1 && isMax; dt++) { const tt = t + dt; if (tt < 0 || tt >= NT) continue; for (let dr = -1; dr <= 1; dr++) { if (!dt && !dr) continue; const u = acc[tt * NR + r + dr]; if (u > v || (u === v && (dt < 0 || (dt === 0 && dr < 0)))) { isMax = false; break; } } }
    if (isMax) cands.push({ t, r, v });
  }
  cands.sort((a, b) => b.v - a.v);
  const accepted = [];
  const gap = Math.max(12, 0.05 * w);
  for (const c of cands) {
    if (accepted.length >= 90) break;
    const ang = (-maxDeg + c.t * stepDeg) * DEG; const rho = c.r - R;
    const line0 = lineFromHough(ang, rho, cx, cy);
    // NMS geométrica: ¿cerca de una recta ya aceptada en todo el ancho útil?
    let dup = false;
    for (const L of accepted) {
      const xa = L.x0, xb = L.x1;
      const d1 = Math.abs(line0.a * xa + line0.b - (L.a * xa + L.b)), d2 = Math.abs(line0.a * xb + line0.b - (L.a * xb + L.b));
      if (Math.max(d1, d2) < 7) { dup = true; break; }
    }
    if (dup) continue;
    // refinamiento por mínimos cuadrados con los puntos cercanos
    const ref = refine(xs, ys, ws, line0.a, line0.b, 1.6);
    const la = ref ? ref.a : line0.a, lb = ref ? ref.b : line0.b;
    const sup = support(hitMap, w, h, la, lb, gap);
    if (!sup || sup.n < 20) continue;
    accepted.push({ a: la, b: lb, x0: sup.x0, x1: sup.x1, n: sup.n, votes: c.v });
  }
  // suprime duplicados tras el refinamiento
  const lines = [];
  for (const L of accepted.sort((p, q) => q.n - p.n)) {
    const xm = (L.x0 + L.x1) / 2;
    const xa = Math.max(L.x0, 0), xb = L.x1;
    if (lines.some((M) => overlap(M, L) > 0.3 && Math.abs(M.a * xm + M.b - (L.a * xm + L.b)) < 6 && Math.abs(M.a * xa + M.b - (L.a * xa + L.b)) < 8 && Math.abs(M.a * xb + M.b - (L.a * xb + L.b)) < 8)) continue;
    lines.push(L);
  }
  // brillo a ambos lados (fondo de la lista)
  for (const L of lines) {
    const vals = [];
    for (let x = L.x0; x <= L.x1; x += 3) { const y = L.a * x + L.b; vals.push(Math.min(sampleGray(g, w, h, x, y - 4), sampleGray(g, w, h, x, y + 4))); }
    L.bgLevel = median(vals);
    L.angle = Math.atan(L.a) / DEG;
  }
  return { lines, resp, bright, npts: xs.length, T };
}

function overlap(A, B) { const o = Math.min(A.x1, B.x1) - Math.max(A.x0, B.x0); return o / Math.max(1, Math.min(A.x1 - A.x0, B.x1 - B.x0)); }

function lineFromHough(ang, rho, cx, cy) {
  // -sin·(x−cx) + cos·(y−cy) = rho  →  y = tan·x + (rho + cy·cos − cx·sin)/cos
  const s = Math.sin(ang), c = Math.cos(ang);
  return { a: s / c, b: (rho + cy * c - cx * s) / c };
}

function refine(xs, ys, ws, a, b, tol) {
  const pts = [];
  for (let k = 0; k < xs.length; k++) { const d = ys[k] - (a * xs[k] + b); if (Math.abs(d) <= tol) pts.push({ t: xs[k], s: ys[k], w: ws[k] }); }
  if (pts.length < 10) return null;
  return linReg(pts);
}

function subsample(arr, step) { const out = []; for (let i = 0; i < arr.length; i += step) out.push(arr[i]); return out; }

// Elige la familia principal de separadores (paralelos, largos, sobre fondo claro).
export function selectFamily(lines, w, h, bright) {
  let cand = lines.filter((L) => L.bgLevel >= 0.45 * bright);
  if (cand.length < 2) return null;
  const maxN = Math.max(...cand.map((L) => L.n));
  cand = cand.filter((L) => L.n >= Math.max(40, 0.3 * maxN));
  if (cand.length < 2) return null;
  const angMed = weightedMedian(cand.map((L) => L.angle), cand.map((L) => L.n));
  cand = cand.filter((L) => Math.abs(L.angle - angMed) <= 4);
  if (cand.length < 2) return null;
  // eje x de referencia: mediana de los centros de los segmentos
  const xc = median(cand.map((L) => (L.x0 + L.x1) / 2));
  for (const L of cand) L.yc = L.a * xc + L.b;
  cand.sort((p, q) => p.yc - q.yc);
  // agrupa por solape horizontal con la mayoría (descarta líneas de otra zona)
  const x0m = median(cand.map((L) => L.x0)), x1m = median(cand.map((L) => L.x1));
  const span = Math.max(1, x1m - x0m);
  cand = cand.filter((L) => Math.min(L.x1, x1m) - Math.max(L.x0, x0m) >= 0.4 * span);
  if (cand.length < 2) return null;
  // ángulo suave en función de la posición (perspectiva): ajuste robusto ángulo = α + β·yc
  const fit = cand.length >= 4 ? fitRobust(cand.map((L) => ({ t: L.yc, s: L.angle, w: L.n })), 0.8) : null;
  for (const L of cand) {
    const ang = fit && fit.inliers >= 3 ? fit.a * L.yc + fit.b : L.angle;
    L.fitAngle = ang;
    const sl = Math.tan(ang * DEG);
    // recta que pasa por (xc, yc) con la pendiente ajustada
    L.fa = sl; L.fb = L.yc - sl * xc;
  }
  return { lines: cand, xc, angle: angMed };
}

// Avanza sobre la recta y = a·x + b desde xStart (dir = ±1) hasta el borde de la pantalla:
// primera racha de 4 muestras oscuras (< 60 % del brillo de referencia) a ambos lados de la recta.
function marchEdge(g, w, h, a, b, xStart, dir, off, refV) {
  const cs = 1 / Math.hypot(1, a);
  const tx = cs * dir, ty = a * cs * dir; const nx = -a * cs, ny = cs;
  let run = 0; let first = null;
  let x = xStart, y = a * x + b;
  for (let s = 0; s < w * 1.5; s++) {
    x += tx; y += ty;
    if (x < 0 || x > w - 1 || y < 0 || y > h - 1) return { x: Math.max(0, Math.min(w - 1, x)), y, border: true };
    const v = Math.max(sampleGray(g, w, h, x + nx * off, y + ny * off), sampleGray(g, w, h, x - nx * off, y - ny * off));
    if (v < 0.6 * refV) { if (!run) first = [x, y]; run++; if (run >= 4) return { x: first[0], y: first[1], border: false }; }
    else run = 0;
  }
  return null;
}

// Brillo de referencia: mediana cerca del extremo del segmento (hacia dentro).
function refNear(g, w, h, a, b, xStart, dir, off) {
  const cs = 1 / Math.hypot(1, a); const v = [];
  for (let k = 0; k < 40; k += 2) {
    const x = xStart - cs * dir * k, y = a * x + b;
    v.push(Math.max(sampleGray(g, w, h, x, y - off), sampleGray(g, w, h, x, y + off)));
  }
  return median(v);
}

// Construye el cuadrilátero de la lista: bordes izq./der. (desde los extremos de cada separador,
// ajuste robusto) + separadores extremos.
export function buildQuad(g, w, h, fam) {
  const lines = fam.lines; const off = 3;
  const lefts = [], rights = [];
  for (const L of lines) {
    const l = marchEdge(g, w, h, L.fa, L.fb, L.x0, -1, off, refNear(g, w, h, L.fa, L.fb, L.x0, -1, off));
    const r = marchEdge(g, w, h, L.fa, L.fb, L.x1, 1, off, refNear(g, w, h, L.fa, L.fb, L.x1, 1, off));
    L.edgeL = l; L.edgeR = r;
    if (l) lefts.push({ x: l.x, y: l.y, w: l.border ? 0.5 : 1 });
    if (r) rights.push({ x: r.x, y: r.y, w: r.border ? 0.5 : 1 });
  }
  const tol = Math.max(3, 0.012 * w);
  const fl = fitRobust(lefts.map((p) => ({ t: p.y, s: p.x, w: p.w })), tol);
  const fr = fitRobust(rights.map((p) => ({ t: p.y, s: p.x, w: p.w })), tol);
  // recta de borde como {nx, ny, c}: x − a·y = b
  const asLine = (f) => { const n = Math.hypot(1, f.a); return { nx: 1 / n, ny: -f.a / n, c: f.b / n }; };
  // perpendicular a la familia si el ajuste es pobre
  const perp = (pts) => {
    const xm = median(pts.map((p) => p.x)), ym = median(pts.map((p) => p.y));
    const a = -Math.tan(fam.angle * DEG); // x = a·y + b perpendicular a líneas de ángulo θ
    return { a, b: xm - a * ym, inliers: 0 };
  };
  const minInl = Math.max(3, Math.ceil(0.35 * lines.length));
  const L = fl && fl.inliers >= minInl ? fl : (lefts.length ? perp(lefts) : null);
  const R = fr && fr.inliers >= minInl ? fr : (rights.length ? perp(rights) : null);
  if (!L || !R) return null;
  const top = lines[0], bot = lines[lines.length - 1];
  const asH = (Ln) => { const n = Math.hypot(1, Ln.fa); return { nx: -Ln.fa / n, ny: 1 / n, c: Ln.fb / n }; };
  const lL = asLine(L), lR = asLine(R), lT = asH(top), lB = asH(bot);
  const TL = intersect(lL, lT), TR = intersect(lR, lT), BL = intersect(lL, lB), BR = intersect(lR, lB);
  if (!TL || !TR || !BL || !BR) return null;
  return { TL, TR, BL, BR, left: L, right: R, leftFit: fl, rightFit: fr, lefts, rights };
}
