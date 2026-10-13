// Reconstrucción de filas a partir de tokens de OCR (números de día + días de la semana).
import { matchWeekday, parseDayNumber, matchMonth, parseYear } from './calendar.js';

const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export { median };

// Clasifica palabras del OCR en tokens con tipo.
export function classifyTokens(words) {
  const out = [];
  for (const w of words) {
    const t = { ...w, w: w.x1 - w.x0, h: w.y1 - w.y0, cx: (w.x0 + w.x1) / 2, cy: (w.y0 + w.y1) / 2, kind: 'other' };
    const text = String(w.text || '').trim();
    const d = parseDayNumber(text); const wd = matchWeekday(text); const m = matchMonth(text); const y = parseYear(text);
    if (d && t.h > 4) { t.kind = 'day'; t.day = d; }
    else if (wd) { t.kind = 'wd'; t.wd = wd; }
    else if (y) { t.kind = 'year'; t.year = y; }
    else if (m) { t.kind = 'month'; t.month = m; }
    out.push(t);
  }
  return out;
}

// Distribución pc-grid: muchos días de la semana en una misma línea horizontal.
export function looksLikeGrid(tokens) {
  const wds = tokens.filter((t) => t.kind === 'wd' && t.conf >= 50);
  let best = 0;
  for (const a of wds) {
    const same = wds.filter((b) => Math.abs(b.cy - a.cy) < Math.max(a.h, b.h) * 0.8);
    if (same.length > best) best = same.length;
  }
  const kw = tokens.some((t) => /mitarbeiter|unterschrift|euregon|erstellung/i.test(t.text));
  return best >= 6 || (best >= 4 && kw);
}

// Ajuste robusto x = a + b·y (columna de días).
function fitColumn(pts, tol) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i; j < pts.length; j++) {
      const p = pts[i], q = pts[j];
      let b = 0; if (j !== i) { if (Math.abs(q.y - p.y) < 1) continue; b = (q.x - p.x) / (q.y - p.y); }
      if (Math.abs(b) > 0.35) continue;
      const a = p.x - b * p.y;
      let score = 0; for (const r of pts) if (Math.abs(r.x - (a + b * r.y)) < tol) score += r.wt;
      if (!best || score > best.score) best = { a, b, score };
    }
  }
  if (!best) return null;
  // Refinado por mínimos cuadrados ponderados con inliers.
  const inl = pts.filter((r) => Math.abs(r.x - (best.a + best.b * r.y)) < tol);
  if (inl.length >= 3) {
    let sw = 0, sy = 0, sx = 0, syy = 0, sxy = 0;
    for (const r of inl) { sw += r.wt; sy += r.wt * r.y; sx += r.wt * r.x; syy += r.wt * r.y * r.y; sxy += r.wt * r.x * r.y; }
    const den = sw * syy - sy * sy;
    if (Math.abs(den) > 1e-6) { const b = (sw * sxy - sy * sx) / den; if (Math.abs(b) <= 0.35) { best.b = b; best.a = (sx - b * sy) / sw; } }
  }
  return best;
}

// Modelo y(v) = c0 + c1·v + c2·v² (perspectiva suave) ajustado por mínimos cuadrados.
function fitPoly(pts, deg) {
  const n = deg + 1; const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (const p of pts) {
    const pw = [1, p.v, p.v * p.v];
    for (let r = 0; r < n; r++) { for (let c = 0; c < n; c++) A[r][c] += p.wt * pw[r] * pw[c]; A[r][n] += p.wt * pw[r] * p.y; }
  }
  for (let i = 0; i < n; i++) {
    let piv = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]]; if (Math.abs(A[i][i]) < 1e-9) return null;
    for (let r = 0; r < n; r++) { if (r === i) continue; const f = A[r][i] / A[i][i]; for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c]; }
  }
  const c = [0, 0, 0]; for (let i = 0; i < n; i++) c[i] = A[i][n] / A[i][i];
  return c;
}
export const evalModel = (c, v) => c[0] + c[1] * v + c[2] * v * v;
export const pitchAt = (c, v) => c[1] + 2 * c[2] * v;

// Construye anclas (posición de cada número de día) y el modelo de secuencia de días.
export function buildRows(tokens) {
  const days = tokens.filter((t) => t.kind === 'day' && t.conf >= 25);
  const wds = tokens.filter((t) => t.kind === 'wd' && t.conf >= 40);
  if (!days.length) return null;
  // Altura típica de los números (2 cifras, buena confianza).
  const good = days.filter((t) => t.day.twoDigits && t.conf >= 70);
  const H = median((good.length >= 2 ? good : days).map((t) => t.h));
  // Emparejar número con día de la semana debajo.
  const pairs = [];
  const usedW = new Set();
  for (const d of days) {
    if (d.h < H * 0.6 || d.h > H * 1.6) continue;
    let best = null;
    for (const w of wds) {
      const dy = w.cy - d.cy, dx = w.cx - d.cx;
      if (dy < 0.7 * H || dy > 2.3 * H || Math.abs(dx) > 1.6 * H) continue;
      const cost = Math.abs(dy - 1.45 * H) + Math.abs(dx) * 0.7;
      if (!best || cost < best.cost) best = { w, cost };
    }
    pairs.push({ d, w: best ? best.w : null });
    if (best) usedW.add(best.w);
  }
  const paired = pairs.filter((p) => p.w);
  const offY = paired.length ? median(paired.map((p) => p.w.cy - p.d.cy)) : 1.45 * H;
  const offX = paired.length ? median(paired.map((p) => p.w.cx - p.d.cx)) : 0.2 * H;
  // Anclas: posición (cx, cy) del número de día (real o implícita por el día de la semana).
  const anchors = pairs.map((p) => ({ x: p.d.cx, y: p.d.cy, day: p.d, wd: p.w, wt: p.w ? 2 : 1 }));
  for (const w of wds) if (!usedW.has(w) && w.h > H * 0.4 && w.h < H * 1.3) anchors.push({ x: w.cx - offX, y: w.cy - offY, day: null, wd: w, wt: 1 });
  const col = fitColumn(anchors, 0.9 * H);
  if (!col) return null;
  const inCol = anchors.filter((a) => Math.abs(a.x - (col.a + col.b * a.y)) < 0.9 * H);
  // Modelo de secuencia con los números leídos.
  const pts = inCol.filter((a) => a.day).map((a) => ({ v: a.day.day.value, y: a.y, wt: (a.wd ? 1.5 : 1) * Math.max(0.2, a.day.conf / 100), a }));
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const p = pts[i], q = pts[j]; if (p.v === q.v) continue;
      const pitch = (q.y - p.y) / (q.v - p.v);
      if (pitch < 1.8 * H || pitch > 6 * H) continue;
      const c = [p.y - pitch * p.v, pitch, 0];
      const inl = pts.filter((r) => Math.abs(r.y - evalModel(c, r.v)) < 0.3 * pitch);
      const score = inl.reduce((s, r) => s + r.wt, 0);
      if (!best || score > best.score) best = { c, score, inl };
    }
  }
  if (!best) return { H, col, anchors: inCol, model: null, offY, offX };
  // Refinar iterativamente (cuadrático si hay suficientes puntos).
  let c = best.c; let inl = best.inl;
  for (let it = 0; it < 4; it++) {
    const vs = new Set(inl.map((r) => r.v));
    const deg = vs.size >= 5 ? 2 : vs.size >= 2 ? 1 : 0; if (!deg) break;
    const nc = fitPoly(inl, deg); if (!nc) break;
    const nInl = pts.filter((r) => Math.abs(r.y - evalModel(nc, r.v)) < 0.3 * Math.abs(pitchAt(nc, r.v)));
    c = nc; if (nInl.length === inl.length) { inl = nInl; break; } inl = nInl;
  }
  return { H, col, anchors: inCol, model: c, inliers: inl, offY, offX, support: inl.reduce((s, r) => s + r.wt, 0) };
}

// v (día) más cercano a una coordenada y según el modelo.
export function invModel(c, y, vmin = -5, vmax = 40) {
  let best = null;
  for (let v = vmin; v <= vmax; v++) { const d = Math.abs(evalModel(c, v) - y); if (!best || d < best.d) best = { v, d }; }
  return best;
}

// Mes/año a partir de tokens (texto de cabecera "Oktober 2026").
export function findMonthYear(tokens) {
  const months = tokens.filter((t) => t.kind === 'month' || (t.kind === 'other' && matchMonth(t.text)));
  const years = tokens.filter((t) => t.kind === 'year');
  const cands = [];
  for (const m of months) {
    const mm = m.month || matchMonth(m.text);
    let yr = null;
    for (const y of years) {
      if (Math.abs(y.cy - m.cy) < Math.max(m.h, y.h) && y.x0 > m.cx && y.x0 - m.x1 < 4 * m.h) { yr = y; break; }
    }
    cands.push({ month: mm.month, score: mm.score * (m.conf / 100) + (yr ? 0.5 : 0), year: yr ? yr.year : null, tok: m, ytok: yr, alts: mm });
  }
  // Mes y año pegados ("Oktober2026").
  for (const t of tokens) {
    const mt = String(t.text).match(/^([A-Za-zäÄ]{3,10})[^A-Za-z0-9]?(20\d\d)$/);
    if (mt) { const mm = matchMonth(mt[1]); if (mm) cands.push({ month: mm.month, score: mm.score * (t.conf / 100) + 0.5, year: Number(mt[2]), tok: t }); }
  }
  cands.sort((a, b) => b.score - a.score);
  const yearOnly = years.length ? years.sort((a, b) => b.conf - a.conf)[0].year : null;
  return { best: cands[0] || null, cands, yearOnly };
}
