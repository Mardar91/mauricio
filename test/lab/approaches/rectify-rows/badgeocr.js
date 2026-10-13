// Lectura de una insignia: máscara de texto normalizada (altura de letra fija), OCR de la palabra
// con lista blanca según el color y, si hace falta, OCR glifo a glifo.
import { components } from './raster.js';
import { renderCanon, badgeTextMask, dropBorderBlobs } from './crops.js';
import { C } from './rows.js';
import { familyOf, snapBadge, digitWidthVeto } from './codes.js';

const TEXT_H = 42;

// Whitelists por clase: [palabra, primer glifo, resto]
function lists(cls, shape) {
  switch (cls) {
    case C.YELLOW: return ['F0123456789', 'F', '0123456789'];
    case C.GREEN: return ['S0123456789', 'S', '0123456789'];
    case C.BLUE: return shape === 'hexagon' ? ['TSN0123456789', 'TN', 'S0123456789'] : ['NTS0123456789', 'NT', 'S0123456789'];
    case C.PINK: return shape === 'tag' ? ['WZ0123456789-', 'WZ', '-0123456789'] : ['ZW0123456789-', 'ZW', '0123456789-'];
    default: return ['FSNZ0123456789', 'FSNZ', '0123456789'];
  }
}

export function badgeShape(it) {
  if (it.cls === C.PINK && it.straightL >= 0.75) return 'tag';
  if (it.cls === C.BLUE && it.straightL < 0.2 && it.aspect > 1.08) return 'hexagon';
  return 'circle';
}

// Texto de la insignia como máscara binaria recortada a la tinta y glifos ordenados.
function textOf(src, canon, it, k, targetH, extra = {}) {
  const pad = 0.08 * (it.y1 - it.y0 + 1);
  const i0 = it.x0 - pad, i1 = it.x1 + 1 + pad, j0 = it.y0 - pad, j1 = it.y1 + 1 + pad;
  const rr = renderCanon(src, canon, i0, j0, i1, j1, targetH);
  const tm = badgeTextMask(rr.img, rr.sc, i0, j0, it, k, { light: it.cls === C.BLUE || it.cls === C.RED, channel: it.cls === C.MAGENTA ? 'rb' : 'lum', ...extra });
  if (!tm) return null;
  const w = rr.img.w, h = rr.img.h;
  const m = dropBorderBlobs(tm.mask, w, h);
  const cc = components(m, w, h, 1);
  const tot = cc.comps.reduce((s, c) => s + c.area, 0);
  const keep = cc.comps.filter((c) => c.area >= Math.max(6, 0.03 * tot));
  if (!keep.length) return null;
  const ids = new Set(keep.map((c) => c.id));
  const x0 = Math.min(...keep.map((c) => c.x0)), x1 = Math.max(...keep.map((c) => c.x1));
  const y0 = Math.min(...keep.map((c) => c.y0)), y1 = Math.max(...keep.map((c) => c.y1));
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (ids.has(cc.labels[(y + y0) * w + x + x0])) mask[y * bw + x] = 1;
  // glifos: componentes agrupadas por solape horizontal
  const gl = keep.map((c) => ({ x0: c.x0 - x0, x1: c.x1 - x0, y0: c.y0 - y0, y1: c.y1 - y0, ids: [c.id], area: c.area })).sort((a, b) => a.x0 - b.x0);
  const glyphs = [];
  for (const g of gl) {
    const last = glyphs[glyphs.length - 1];
    const ov = last ? Math.min(last.x1, g.x1) - Math.max(last.x0, g.x0) : -1;
    if (last && ov > 0.4 * Math.min(last.x1 - last.x0 + 1, g.x1 - g.x0 + 1)) {
      last.x0 = Math.min(last.x0, g.x0); last.x1 = Math.max(last.x1, g.x1); last.y0 = Math.min(last.y0, g.y0); last.y1 = Math.max(last.y1, g.y1); last.ids.push(...g.ids); last.area += g.area;
    } else glyphs.push({ ...g });
  }
  // altura de letra: máxima altura de glifo (sin contar guiones)
  const th = Math.max(...glyphs.map((g) => g.y1 - g.y0 + 1));
  // glifos pegados ("53"): se parten por el mínimo de la proyección vertical
  for (let gi = 0; gi < glyphs.length; gi++) {
    const g = glyphs[gi]; const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
    if (gw < 1.0 * gh || gh < 0.6 * th) continue;
    const ids = new Set(g.ids); const prof = [];
    for (let x = g.x0; x <= g.x1; x++) { let n = 0; for (let y = 0; y < bh; y++) if (ids.has(cc.labels[(y + y0) * w + x + x0])) n++; prof.push(n); }
    let bx = -1, bv = Infinity;
    for (let x = Math.round(0.3 * gw); x <= Math.round(0.7 * gw); x++) if (prof[x] < bv) { bv = prof[x]; bx = x; }
    if (bx < 0 || bv > 0.35 * gh) continue;
    const a = { ...g, x1: g.x0 + bx - 1, split: true }, b = { ...g, x0: g.x0 + bx + 1, split: true };
    glyphs.splice(gi, 1, a, b); gi++;
  }
  return { mask, w: bw, h: bh, glyphs, th, labels: cc.labels, lw: w, ox: x0, oy: y0, ink: tm.ink };
}

function subMask(t, g) {
  const w = g.x1 - g.x0 + 1, h = t.h; const m = new Uint8Array(w * h); const ids = new Set(g.ids); // solo columnas del glifo
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ids.has(t.labels[(y + t.oy) * t.lw + x + g.x0 + t.ox])) m[y * w + x] = 1;
  return { m, w, h };
}

// Reescala una máscara binaria (promedio de área, umbral 0,5).
function scaleMask(m, w, h, f) {
  const W = Math.max(1, Math.round(w * f)), H = Math.max(1, Math.round(h * f)); const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const xa = Math.floor(x / f), xb = Math.max(xa + 1, Math.floor((x + 1) / f)), ya = Math.floor(y / f), yb = Math.max(ya + 1, Math.floor((y + 1) / f));
    let n = 0, s = 0;
    for (let yy = ya; yy < Math.min(h, yb); yy++) for (let xx = xa; xx < Math.min(w, xb); xx++) { n++; s += m[yy * w + xx]; }
    out[y * W + x] = n && s / n >= 0.5 ? 1 : 0;
  }
  return { m: out, w: W, h: H };
}

// Glifos normalizados (16×24, fracción de tinta) para comparar insignias entre filas.
function glyphPrints(t) {
  const GW = 16, GH = 24;
  return t.glyphs.map((g) => {
    const sm = subMask(t, g); const out = new Float32Array(GW * GH);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const xa = Math.floor(x * sm.w / GW), xb = Math.max(xa + 1, Math.floor((x + 1) * sm.w / GW));
      const ya = Math.floor(y * sm.h / GH), yb = Math.max(ya + 1, Math.floor((y + 1) * sm.h / GH));
      let n = 0, v = 0;
      for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) { n++; v += sm.m[yy * sm.w + xx]; }
      out[y * GW + x] = n ? v / n : 0;
    }
    return { m: out, asp: (g.x1 - g.x0 + 1) / (g.y1 - g.y0 + 1) };
  });
}

// Parecido entre dos insignias: mínimo, glifo a glifo, del IoU suave (requiere mismo nº de glifos y anchuras parecidas).
export function printSim(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  let sim = 1;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].asp - b[i].asp) > 0.18) return 0;
    let mn = 0, mx = 0;
    for (let k = 0; k < a[i].m.length; k++) { mn += Math.min(a[i].m[k], b[i].m[k]); mx += Math.max(a[i].m[k], b[i].m[k]); }
    sim = Math.min(sim, mx ? mn / mx : 0);
  }
  return sim;
}

// Devuelve { code, conf, reads, shape } o { fail }
export async function readBadge(src, canon, it, k, known, ocrMask) {
  const shape = badgeShape(it);
  const fam = familyOf(it.cls, shape);
  if (!fam) return { fail: 'clase sin códigos', shape };
  const [wlWord, wlFirst, wlRest] = lists(it.cls, shape);
  let t = textOf(src, canon, it, k, 140);
  if (!t) return { fail: 'sin texto', shape };
  // re-render para que la letra mida ~TEXT_H px
  const s = TEXT_H / t.th;
  if (Math.abs(s - 1) > 0.15) { const t2 = textOf(src, canon, it, k, 140 * s); if (t2) t = t2; }
  const reads = [];
  const pad = Math.round(0.45 * TEXT_H);
  const o1 = await ocrMask(t.mask, t.w, t.h, pad, { psm: 7, whitelist: wlWord });
  reads.push({ text: o1.text.replace(/\s+/g, ''), conf: o1.conf });
  let snap = snapBadge(it.cls, shape, reads, known);
  if (!snap || snap.conf < 0.8) {
    // glifo a glifo (PSM 10) si el número de glifos es el esperado
    if (t.glyphs.length === fam.len) {
      const chars = []; let cmin = 100;
      for (let i = 0; i < t.glyphs.length; i++) {
        const g = t.glyphs[i]; const gh = g.y1 - g.y0 + 1, gw = g.x1 - g.x0 + 1;
        if (i > 0 && gw > 1.6 * gh && gh < 0.4 * t.th) { chars.push('-'); continue; } // guion
        const sm = subMask(t, g);
        // un carácter: PSM 8 y, si no devuelve exactamente uno, PSM 10
        let ch = '', conf = 0;
        for (const psm of [8, 10]) {
          const o = await ocrMask(sm.m, sm.w, sm.h, pad, { psm, whitelist: i === 0 ? wlFirst : wlRest });
          ch = o.text.replace(/\s+/g, ''); conf = o.conf;
          if (ch.length === 1) break;
        }
        chars.push(ch.length === 1 ? ch : '?'); cmin = Math.min(cmin, conf);
      }
      reads.push({ text: chars.join(''), conf: cmin });
    }
    const o2 = await ocrMask(t.mask, t.w, t.h, pad, { psm: 8, whitelist: wlWord });
    reads.push({ text: o2.text.replace(/\s+/g, ''), conf: o2.conf });
    snap = snapBadge(it.cls, shape, reads, known);
    if (!snap || snap.conf < 0.75) {
      // otra escala (letra ~28 px): Tesseract es sensible al tamaño
      const sm = scaleMask(t.mask, t.w, t.h, 28 / TEXT_H);
      const o3 = await ocrMask(sm.m, sm.w, sm.h, Math.round(0.45 * 28), { psm: 7, whitelist: wlWord });
      reads.push({ text: o3.text.replace(/\s+/g, ''), conf: o3.conf });
      snap = snapBadge(it.cls, shape, reads, known);
    }
  }
  const prints = glyphPrints(t);
  if (!snap && t.ink > 0.19) {
    // trazos demasiado gruesos (ruido, poca luz): otra binarización más fina
    const t3 = textOf(src, canon, it, k, 140 * TEXT_H / t.th, { inkMax: 0.17 });
    if (t3) {
      for (const psm of [7, 8]) {
        const o = await ocrMask(t3.mask, t3.w, t3.h, pad, { psm, whitelist: wlWord });
        reads.push({ text: o.text.replace(/\s+/g, ''), conf: o.conf });
      }
      snap = snapBadge(it.cls, shape, reads, known);
    }
  }
  if (!snap) return { fail: 'ilegible', reads, shape, prints };
  if (digitWidthVeto(snap.code, t.glyphs)) return { fail: 'ancho de dígito', reads, shape, prints };
  return { ...snap, reads, shape, prints };
}
