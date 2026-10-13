// Análisis en el plano rectificado: cabecera naranja, perfil de separadores, rejilla uniforme de filas.
import { toGray, hsv } from './raster.js';
import { median, linReg, percentile } from './geom.js';

export function isOrange(r, g, b) {
  const [h, s, v] = hsv(r, g, b);
  return h >= 14 && h <= 50 && s >= 0.38 && v >= 60;
}

// Perfil vertical: fracción de columnas con línea fina oscura en cada fila j.
// En el plano rectificado los separadores son horizontales: se suaviza en horizontal (9 px) sin perderlos.
function separatorProfile(g, valid, W, H, i0, i1) {
  const gs = new Float32Array(W * H); const R = 4;
  for (let j = 0; j < H; j++) {
    let acc = 0, n = 0; const row = j * W;
    for (let i = 0; i < Math.min(W, R); i++) { acc += g[row + i]; n++; }
    for (let i = 0; i < W; i++) {
      if (i + R < W) { acc += g[row + i + R]; n++; }
      if (i - R - 1 >= 0) { acc -= g[row + i - R - 1]; n--; }
      gs[row + i] = acc / n;
    }
  }
  const prof = new Float32Array(H); const d = 2;
  for (let j = d + 1; j < H - d - 1; j++) {
    let hit = 0, n = 0;
    for (let i = i0; i < i1; i++) {
      const p = j * W + i;
      if (!valid[p - (d + 1) * W] || !valid[p + (d + 1) * W]) continue;
      n++;
      const c = Math.min(gs[p], (gs[p - W] + gs[p] + gs[p + W]) / 3 + 0.5);
      const up = Math.max(gs[p - d * W], gs[p - (d + 1) * W]), dn = Math.max(gs[p + d * W], gs[p + (d + 1) * W]);
      const m = Math.min(up, dn);
      if (m - c > 0.02 * m && m > 50) hit++;
    }
    prof[j] = n > 0.3 * (i1 - i0) ? hit / n : 0;
  }
  return prof;
}

function localPeaks(prof, minVal, rad) {
  const pk = [];
  for (let j = 1; j < prof.length - 1; j++) {
    const v = prof[j]; if (v < minVal) continue;
    let ok = true;
    for (let k = Math.max(0, j - rad); k <= Math.min(prof.length - 1, j + rad); k++) if (prof[k] > v || (prof[k] === v && k < j)) { ok = false; break; }
    if (ok) {
      // centro sub-píxel por parábola
      const a = prof[j - 1], b = prof[j], c = prof[j + 1]; const den = a - 2 * b + c;
      pk.push({ j: den < 0 ? j + 0.5 * (a - c) / den : j, s: v });
    }
  }
  return pk;
}

// Ajuste de rejilla y = φ + k·P a los picos (P en px canónicos). Penaliza posiciones de la rejilla
// sin pico (así P/2 no gana a P) y exige un paso plausible para la anchura de la lista.
function fitGrid(peaks, Pguess, W) {
  if (peaks.length < 2) return null;
  const strong = peaks.slice().sort((a, b) => b.s - a.s).slice(0, 24);
  const medS = median(peaks.map((p) => p.s));
  const cands = new Set();
  for (let a = 0; a < strong.length; a++) for (let b = a + 1; b < strong.length; b++) {
    const d = Math.abs(strong[b].j - strong[a].j);
    for (let n = 1; n <= 6; n++) { const P = d / n; if (W / P >= 3.5 && W / P <= 14 && P >= 0.3 * Pguess && P <= 3 * Pguess) cands.add(Math.round(P * 2) / 2); }
  }
  const jMin = Math.min(...peaks.map((p) => p.j)), jMax = Math.max(...peaks.map((p) => p.j));
  let best = null;
  for (const P of cands) {
    const tol = Math.max(1.5, 0.06 * P);
    for (const anc of strong) {
      let score = 0; const hitK = new Set();
      for (const p of peaks) {
        const k = Math.round((p.j - anc.j) / P); const r = p.j - (anc.j + k * P);
        if (Math.abs(r) <= tol) { score += p.s * (1 - 0.5 * Math.abs(r) / tol); hitK.add(k); }
      }
      const k0 = Math.ceil((jMin - anc.j) / P - 0.2), k1 = Math.floor((jMax - anc.j) / P + 0.2);
      const empties = Math.max(0, k1 - k0 + 1 - hitK.size);
      score -= 0.35 * medS * empties;
      if (!best || score > best.score + 1e-6 || (Math.abs(score - best.score) < 1e-6 && P > best.P)) best = { P, phase: anc.j, score };
    }
  }
  if (!best) return null;
  let { P, phase } = best;
  for (let it = 0; it < 3; it++) {
    const tol = Math.max(1.5, 0.08 * P); const pts = [];
    for (const p of peaks) { const k = Math.round((p.j - phase) / P); if (Math.abs(p.j - (phase + k * P)) <= tol) pts.push({ t: k, s: p.j, w: p.s }); }
    if (new Set(pts.map((q) => q.t)).size < 2) break;
    const f = linReg(pts); if (!f) break;
    P = f.a; phase = f.b;
  }
  return { P, phase, score: best.score };
}

export function analyzeCanon(canon, famJ) {
  const { img } = canon; const W = img.w, H = img.h;
  const g = toGray(img);
  const valid = new Uint8Array(W * H);
  for (let p = 0, q = 3; p < W * H; p++, q += 4) valid[p] = img.data[q] > 0 ? 1 : 0;
  // blanco de referencia: fondo de la lista (mediana de los píxeles claros entre separadores)
  const i0 = Math.round(0.08 * W), i1 = Math.round(0.92 * W);
  const wb = listWhite(img, valid, W, famJ);
  // fracción naranja por fila (zona central), con el color corregido por ese blanco
  const orange = new Float32Array(H); const d = img.data;
  for (let j = 0; j < H; j++) {
    let n = 0, o = 0;
    for (let i = i0; i < i1; i++) { const p = j * W + i; if (!valid[p]) continue; n++; const q = p * 4; if (isOrange(d[q] * wb[0], d[q + 1] * wb[1], d[q + 2] * wb[2])) o++; }
    orange[j] = n > 0.5 * (i1 - i0) ? o / n : 0;
  }
  // paso aproximado a partir de las líneas de la familia
  const famD = famJ.slice(1).map((v, i) => v - famJ[i]).filter((d) => d > 4);
  const Pfam = famD.length ? median(famD) : W / 7;
  // perfil de separadores (sin la columna de texto); umbral de pico adaptado al ruido
  const prof = separatorProfile(g, valid, W, H, Math.round(0.22 * W), Math.round(0.97 * W));
  const base = median(Array.from(prof).filter((v, j) => v > 0 && orange[j] < 0.3));
  const minVal = Math.max(0.12, 2.5 * (base || 0));
  let jEnd = H - 1; while (jEnd > 0 && !rowValid(valid, W, jEnd, i0, i1)) jEnd--;
  const all = localPeaks(prof, minVal, 3).filter((p) => orange[Math.round(p.j)] < 0.3 && p.j < jEnd - 2);
  const grid0 = fitGrid(all, Pfam, W);
  const P0 = grid0 ? grid0.P : Pfam;
  // cabecera: subiendo desde la primera línea de la familia, primera fila mayormente naranja.
  // Validación: banda naranja alta (≥ 0,8 filas) y unida a la lista solo por filas claras (sin bisel oscuro).
  // Se parte de la línea mediana de la familia (dentro de la lista; la primera puede ser el borde del móvil)
  // y, si un dedo corta el camino, de las líneas de más arriba.
  const rowLum = (j) => { const v = []; for (let i = i0; i < i1; i += 4) { const p = j * W + i; if (valid[p]) { const q = p * 4; v.push(0.299 * d[q] + 0.587 * d[q + 1] + 0.114 * d[q + 2]); } } return v.length ? median(v) : 0; };
  const spanL = []; for (let j = Math.round(famJ[0]); j <= famJ[famJ.length - 1]; j += Math.max(2, Math.round(0.25 * P0))) spanL.push(rowLum(j));
  const listLum = spanL.length ? percentile(spanL, 0.75) : 0;
  const findHeader = (jFrom) => {
    for (let j = Math.min(H - 1, jFrom + Math.round(0.3 * P0)); j >= 0; j--) {
      if (orange[j] >= 0.45 && (j < 2 || orange[j - 1] >= 0.45) && (j < 3 || orange[j - 2] >= 0.4)) {
        const hb = j + 1; let ht = hb - 1;
        while (ht > 0 && orange[ht - 1] >= 0.2 && rowValid(valid, W, ht - 1, i0, i1)) ht--;
        const cutTop = ht <= 1 || !rowValid(valid, W, ht - 1, i0, i1); // cabecera cortada por el borde de la foto
        return hb - ht >= (cutTop ? 0.5 : 0.8) * P0 ? { hb, ht } : null;
      }
      if (j < jFrom && rowLum(j) < 0.55 * listLum) return null; // hueco oscuro: no es la cabecera de esta lista
    }
    return null;
  };
  let jHb = null, jHt = null;
  for (let idx = Math.floor((famJ.length - 1) / 2); idx >= 0 && jHb == null; idx--) {
    const h = findHeader(Math.round(famJ[idx]));
    if (h) { jHb = h.hb; jHt = h.ht; }
  }
  const jStart = jHb != null ? jHb : (() => { let j = 0; while (j < H && !rowValid(valid, W, j, i0, i1)) j++; return j; })();
  // picos de separadores bajo la cabecera (supresión de no-máximos con el paso estimado)
  const peaks = localPeaks(prof, minVal, Math.max(3, Math.round(0.25 * P0))).filter((p) => p.j > jStart + 2 && p.j < jEnd - 2);
  const grid = fitGrid(peaks, P0, W);
  return { g, valid, orange, prof, peaks, grid, jHb, jHt, jStart, jEnd, Pfam: P0 };
}

// Factores para llevar el fondo de la lista a gris neutro (235).
function listWhite(img, valid, W, famJ) {
  const j0 = Math.max(0, Math.round(famJ[0])), j1 = Math.min(img.h - 1, Math.round(famJ[famJ.length - 1]));
  const px = []; const d = img.data;
  for (let j = j0; j <= j1; j += 3) for (let i = Math.round(0.3 * W); i < 0.95 * W; i += 3) {
    const p = j * W + i; if (!valid[p]) continue; const q = p * 4;
    px.push([d[q], d[q + 1], d[q + 2], d[q] + d[q + 1] + d[q + 2]]);
  }
  if (px.length < 50) return [1, 1, 1];
  const lt = median(px.map((v) => v[3])); const hi = px.filter((v) => v[3] >= lt);
  return [0, 1, 2].map((c) => 235 / Math.max(40, median(hi.map((v) => v[c]))));
}

function rowValid(valid, W, j, i0, i1) { let n = 0; for (let i = i0; i < i1; i++) n += valid[j * W + i]; return n > 0.8 * (i1 - i0); }

// Filas completas según la rejilla: límites detectados o interpolados entre detectados.
export function buildRows(an) {
  const { grid, peaks, jStart, jEnd } = an;
  if (!grid) return [];
  const { P, phase } = grid; const tol = Math.max(2, 0.12 * P);
  const kMin = Math.floor((jStart - phase) / P) - 1, kMax = Math.ceil((jEnd - phase) / P) + 1;
  const lines = [];
  for (let k = kMin; k <= kMax; k++) {
    const y = phase + k * P;
    const pk = peaks.reduce((b, p) => (Math.abs(p.j - y) <= tol && (!b || Math.abs(p.j - y) < Math.abs(b.j - y)) ? p : b), null);
    lines.push({ k, y: pk ? pk.j : y, det: !!pk, s: pk ? pk.s : 0 });
  }
  // el borde inferior de la cabecera cuenta como límite detectado si coincide con la rejilla
  if (an.jHb != null) for (const L of lines) if (!L.det && Math.abs(L.y - an.jHb) <= Math.max(3, 0.1 * P)) { L.det = true; L.header = true; }
  const detIdx = lines.map((L, i) => (L.det ? i : -1)).filter((i) => i >= 0);
  if (!detIdx.length) return [];
  const firstDet = detIdx[0], lastDet = detIdx[detIdx.length - 1];
  const rows = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i], b = lines[i + 1];
    const inside = a.y >= jStart - Math.max(2, 0.08 * P) && b.y <= jEnd - 1;
    const bracketed = i >= firstDet && i + 1 <= lastDet;
    // fila contigua al tramo detectado (p. ej. la última sobre la barra de navegación)
    const edge = inside && !bracketed && (i === lastDet || i + 1 === firstDet) ? (i === lastDet ? 'bottom' : 'top') : null;
    rows.push({ k: a.k, j0: a.y, j1: b.y, topDet: a.det, botDet: b.det, complete: inside && bracketed, edge });
  }
  return rows;
}
