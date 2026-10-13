// Análisis de la tabla rectificada: bordes de columna, líneas de fila y columnas de días.
import { planes, median } from './img.js';
import { ridgeMaps } from './lines.js';

// Picos de un perfil 1D (máximos locales ≥ thr), con centro subpíxel y separación mínima
export function peaks(prof, thr, minSep) {
  const n = prof.length; const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) sm[i] = ((prof[i - 1] || 0) + 2 * prof[i] + (prof[i + 1] || 0)) / 4;
  const cand = [];
  for (let i = 1; i < n - 1; i++) if (sm[i] >= thr && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) cand.push(i);
  cand.sort((a, b) => sm[b] - sm[a]);
  const out = [];
  for (const i of cand) {
    if (out.some((p) => Math.abs(p.i - i) < minSep)) continue;
    let s = 0; let sw = 0;
    for (let d = -2; d <= 2; d++) { const v = prof[i + d] || 0; s += v * (i + d); sw += v; }
    out.push({ i, pos: sw ? s / sw : i, val: sm[i] });
  }
  return out.sort((a, b) => a.pos - b.pos);
}

// Analiza la rejilla rectificada. unit = ancho aproximado de columna (px rectificados).
// Los bordes de columna se buscan como trazos verticales largos (más altos que una fila) en toda la imagen.
export function analyzeGrid(rc, unit) {
  const P = planes(rc); const { w, h, Y } = P;
  const { mH, mV } = ridgeMaps(Y, w, h, 3, 16);
  const minRun = Math.max(12, Math.round(0.6 * unit)); const maxGap = 4;
  // perfil vertical: suma de tramos largos (huecos ≤ maxGap en los cruces con líneas horizontales)
  const pv = new Float32Array(w);
  for (let u = 1; u < w - 1; u++) {
    let start = -1; let last = -2;
    for (let v = 0; v <= h; v++) {
      const on = v < h && (mV[v * w + u] || mV[v * w + u - 1] || mV[v * w + u + 1]);
      if (on) { if (start < 0 || v - last > maxGap + 1) { if (start >= 0 && last - start + 1 >= minRun) pv[u] += last - start + 1; start = v; } last = v; }
    }
    if (start >= 0 && last - start + 1 >= minRun) pv[u] += last - start + 1;
  }
  const vb = peaks(pv, 2 * minRun, 6);
  const days = dayChain(vb.map((p) => p.pos));
  if (!days) return { P, mH, mV, vborders: vb, days: null, hlines: [] };
  const b = days.borders;
  // extensión vertical de la tabla: filas donde están presentes la mayoría de los bordes de los días
  const cv = new Float32Array(h);
  for (let v = 0; v < h; v++) {
    const o = v * w; let c = 0;
    for (const x of b) { const ui = Math.round(x); if (mV[o + ui] || mV[o + ui - 1] || mV[o + ui + 1] || mV[o + ui - 2] || mV[o + ui + 2]) c++; }
    cv[v] = c / b.length;
  }
  let best = null; let st = -1; let last = -2;
  for (let v = 0; v <= h; v++) {
    const on = v < h && cv[v] >= 0.5;
    if (on) { if (st < 0 || v - last > 7) { if (st >= 0 && (!best || last - st > best[1] - best[0])) best = [st, last]; st = v; } last = v; }
  }
  if (st >= 0 && (!best || last - st > best[1] - best[0])) best = [st, last];
  if (!best) return { P, mH, mV, vborders: vb, days, hlines: [] };
  const [e0, e1] = best;
  // perfil horizontal en el rango de los días, dentro de la extensión
  const u0 = Math.round(b[0]); const u1 = Math.round(b[b.length - 1]);
  const ph = new Float32Array(h);
  for (let v = Math.max(1, e0 - 6); v <= Math.min(h - 2, e1 + 6); v++) { const o = v * w; let s2 = 0; for (let u = u0; u <= u1; u++) if (mH[o + u] || mH[o + u - w] || mH[o + u + w]) s2++; ph[v] = s2; }
  const hlRaw = peaks(ph, (u1 - u0 + 1) * 0.3, 5);
  const rows = rowChain(hlRaw, e0, e1 - e0);
  if (!rows) return { P, mH, mV, vborders: vb, days, hlines: [] };
  const lines = rows.lines.filter((y) => y >= e0 - 0.35 * rows.step && y <= e1 + 0.35 * rows.step);
  return { P, mH, mV, vborders: vb, days, hlines: lines, extent: best, hlRaw: hlRaw.map((p) => Math.round(p.pos)) };
}

// Cadena de líneas horizontales con paso regular (alto de fila). Prueba pasos candidatos y se queda con la
// cadena más larga (rellena líneas perdidas, ignora espurias). Debe tocar la banda [oy, oy+Hr].
export function rowChain(pk, oy, Hr) {
  const pos = pk.map((p) => p.pos);
  if (pos.length < 2) return null;
  const steps = new Set();
  for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length && j <= i + 3; j++) { const d = pos[j] - pos[i]; if (d >= 10) steps.add(Math.round(d)); }
  let best = null;
  for (const c of steps) {
    for (let i = 0; i < pos.length; i++) {
      const chain = [pos[i]]; let last = pos[i]; let real = 1; let miss = 0;
      for (let j = i + 1; j < pos.length; j++) {
        const g = pos[j] - last; const k = Math.round(g / c);
        if (k < 1) continue; // espuria entre dos líneas
        if (k > 2 || Math.abs(g - k * c) > 0.12 * c) { if (g > 2.5 * c) break; continue; }
        if (k === 2) { chain.push(last + g / 2); miss++; }
        chain.push(pos[j]); last = pos[j]; real++;
      }
      const inside = chain.filter((y) => y >= oy - 4 && y <= oy + Hr + 4).length;
      if (inside < 2 || real < 2) continue;
      const score = inside - 0.5 * miss;
      if (!best || score > best.score || (score === best.score && c > best.step)) best = { lines: chain, step: c, score };
    }
  }
  return best;
}

// Cadena de bordes con separación regular (columnas de días). Rellena bordes que falten.
export function dayChain(bs) {
  if (bs.length < 6) return null;
  const gaps = []; for (let i = 0; i + 1 < bs.length; i++) gaps.push(bs[i + 1] - bs[i]);
  const c = median(gaps);
  if (c < 6) return null;
  let best = null;
  let i = 0;
  while (i < bs.length - 1) {
    const chain = [bs[i]]; let j = i; let filled = 0;
    while (j < bs.length - 1) {
      const g = bs[j + 1] - bs[j];
      const k = Math.round(g / c);
      if (k >= 1 && k <= 2 && Math.abs(g - k * c) <= 0.2 * c) {
        if (k === 2) { chain.push(bs[j] + g / 2); filled++; }
        chain.push(bs[j + 1]); j++;
      } else if (g < 0.5 * c && j + 2 < bs.length && Math.abs(bs[j + 2] - bs[j] - c) <= 0.2 * c) {
        // borde espurio entre dos verdaderos
        chain.push(bs[j + 2]); j += 2;
      } else break;
    }
    const n = chain.length - 1 - filled;
    if (!best || n > best.n) best = { borders: chain, n, filled, width: c };
    i = Math.max(j, i + 1);
  }
  if (!best || best.borders.length < 7) return null;
  const b = best.borders; const ws = []; for (let k = 0; k + 1 < b.length; k++) ws.push(b[k + 1] - b[k]);
  best.width = median(ws);
  return best;
}
