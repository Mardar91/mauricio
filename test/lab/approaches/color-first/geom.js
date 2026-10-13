// Geometría: escala de insignias, inclinación, filas y columna de insignias.
import { C_Y, C_G, C_B, C_M, C_P, C_R, shapeOf } from './img.js';

const BADGE_CLASSES = new Set([C_Y, C_G, C_B, C_M, C_P, C_R]);

export const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Modo por densidad de núcleo (valores con peso), ancho de banda bw
export function kdeMode(vals, bw, weights) {
  if (!vals.length) return { x: NaN, score: 0 };
  let best = vals[0], bs = -1;
  for (let i = 0; i < vals.length; i++) {
    let s = 0;
    for (let j = 0; j < vals.length; j++) { const d = (vals[i] - vals[j]) / bw; s += (weights ? weights[j] : 1) * Math.exp(-0.5 * d * d); }
    if (s > bs) { bs = s; best = vals[i]; }
  }
  // media ponderada cerca del pico
  let sw = 0, sx = 0;
  for (let j = 0; j < vals.length; j++) { const d = (vals[j] - best) / bw; if (Math.abs(d) < 1.5) { const ww = (weights ? weights[j] : 1) * Math.exp(-0.5 * d * d); sw += ww; sx += ww * vals[j]; } }
  return { x: sw ? sx / sw : best, score: bs };
}

// Candidatas a insignia (círculo/hexágono/etiqueta rellenos) con forma
export function badgeCandidates(comps, imgArea) {
  const out = [];
  for (const cc of comps) {
    if (!BADGE_CLASSES.has(cc.cls) || cc.area < 60 || cc.area > imgArea * 0.02) continue;
    const s = shapeOf(cc);
    // tamaño "equivalente" a partir de los momentos (invariante a la rotación)
    const major = 4 * Math.sqrt(s.l1), minor = 4 * Math.sqrt(s.l2);
    const fillEll = cc.area / (Math.PI / 4 * major * minor);
    if (s.elong > 1.9 || fillEll < 0.6) continue;
    out.push({ cc, ...s, major, minor, size: Math.sqrt(major * minor), fillEll });
  }
  return out;
}

// Diámetro típico D de las insignias (moda de tamaños con apoyo ≥ 2)
export function estimateBadgeSize(cands) {
  if (cands.length < 2) return null;
  const logs = cands.map((c) => Math.log(c.size));
  const m = kdeMode(logs, 0.08);
  const support = logs.filter((v) => Math.abs(v - m.x) < 0.22).length;
  if (support < 2) return null;
  return Math.exp(m.x);
}

// Ángulo de las filas a partir de pares de insignias vecinas en la misma fila
// y, si no hay, de la columna de insignias (vectores casi verticales).
export function estimateTilt(items, D) {
  const rowAngles = [], colAngles = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const a = items[i], b = items[j];
      const dx = b.cx - a.cx, dy = b.cy - a.cy, dist = Math.hypot(dx, dy);
      if (a.kind === 'badge' && b.kind === 'badge' && dx > 0 && dist > 0.85 * D && dist < 1.9 * D && Math.abs(dy) < 0.47 * dx) {
        const r = a.size / b.size; if (r > 0.75 && r < 1.33) rowAngles.push(Math.atan2(dy, dx));
      }
      if (dy > 0.9 * D && dy < 6 * D && Math.abs(dx) < 0.45 * dy && a.kind === b.kind) colAngles.push(-Math.atan2(dx, dy));
    }
  }
  const deg = Math.PI / 180;
  if (rowAngles.length >= 2) { const m = kdeMode(rowAngles, 1.5 * deg); return { theta: m.x, src: 'pares', n: rowAngles.length }; }
  if (colAngles.length >= 3) { const m = kdeMode(colAngles, 1.5 * deg); return { theta: m.x, src: 'columna', n: colAngles.length }; }
  if (rowAngles.length === 1) return { theta: rowAngles[0], src: 'par', n: 1 };
  return { theta: 0, src: 'ninguno', n: 0 };
}

export function toFrame(theta) {
  const c = Math.cos(theta), s = Math.sin(theta);
  return {
    uv: (x, y) => [x * c + y * s, -x * s + y * c],
    xy: (u, v) => [u * c - v * s, u * s + v * c],
  };
}

// Ajuste lineal robusto u = a + b·v (mínimos cuadrados iterados con recorte)
export function robustLine(vs, us, tol) {
  let idx = vs.map((_, i) => i);
  let a = median(us), b = 0;
  for (let it = 0; it < 4; it++) {
    if (idx.length >= 3) {
      let sv = 0, su = 0, svv = 0, svu = 0; const n = idx.length;
      for (const i of idx) { sv += vs[i]; su += us[i]; svv += vs[i] * vs[i]; svu += vs[i] * us[i]; }
      const den = n * svv - sv * sv;
      b = den > 1e-9 ? (n * svu - sv * su) / den : 0; a = (su - b * sv) / n;
      if (Math.abs(b) > 0.25) { b = 0; a = median(idx.map((i) => us[i])); }
    } else { b = 0; a = median(idx.map((i) => us[i])); }
    const keep = vs.map((_, i) => i).filter((i) => Math.abs(us[i] - (a + b * vs[i])) < tol);
    if (keep.length === idx.length && keep.every((v, k) => v === idx[k])) break;
    if (keep.length < 2) break;
    idx = keep;
  }
  return { a, b, at: (v) => a + b * v };
}
