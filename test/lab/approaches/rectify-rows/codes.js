// Vocabulario de códigos y ajuste del OCR de una insignia según su clase de color y forma.
import { C } from './rows.js';
import { lev } from './calendar.js';

export const DEFAULT_KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];

// Color/forma de cada código conocido (los que no estén aquí se deducen por su patrón).
const FIXED = { S31: [C.RED, 'circle'], TS: [C.BLUE, 'hexagon'], 'W-': [C.PINK, 'tag'] };
export function colorOfCode(code) {
  if (FIXED[code]) return FIXED[code];
  if (/^F\d$/.test(code)) return [C.YELLOW, 'circle'];
  if (/^S\d$/.test(code)) return [C.GREEN, 'circle'];
  if (/^N\d$/.test(code)) return [C.BLUE, 'circle'];
  if (/^Z\d$/.test(code)) return [C.PINK, 'circle'];
  if (/^[FSNZ]\d\d$/.test(code)) return [C.MAGENTA, 'circle']; // letra + 2 dígitos = lugar
  return null;
}

// Familia esperada por clase/forma: patrón de códigos nuevos admisibles.
export function familyOf(cls, shape) {
  switch (cls) {
    case C.YELLOW: return { re: /^F\d$/, prefix: 'F', len: 2 };
    case C.GREEN: return { re: /^S\d$/, prefix: 'S', len: 2 };
    case C.BLUE: return shape === 'hexagon' ? { re: /^TS$/, prefix: 'T', len: 2 } : { re: /^N\d$/, prefix: 'N', len: 2, alt: /^TS$/ };
    case C.PINK: return shape === 'tag' ? { re: /^W-$/, prefix: 'W', len: 2 } : { re: /^Z\d$/, prefix: 'Z', len: 2, alt: /^W-$/ };
    case C.MAGENTA: return { re: /^[FSNZ]\d\d$/, prefix: '', len: 3 };
    case C.RED: return { re: /^[FSNZ]\d\d$/, prefix: '', len: 3, noNovel: true };
    default: return null;
  }
}

// Códigos conocidos compatibles con el color (la forma solo separa N1/TS y Z1/W-, que también lee el OCR).
function familyKnown(cls, known) { return known.filter((k) => { const c = colorOfCode(k); return c && c[0] === cls; }); }

// Normaliza una lectura según la familia (confusiones típicas letra/dígito).
function normalize(t, fam) {
  t = String(t || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!t) return '';
  t = t.replace(/^2(?=\d$)/, 'Z');
  if (fam.prefix && /^\d$/.test(t)) t = fam.prefix + t; // solo el dígito
  // familias de una sola letra: un primer carácter dígito es la letra mal leída (8→S, 0→N…)
  if (fam.prefix && t.length === fam.len && /^\d\d$/.test(t) && fam.prefix !== 'W' && fam.prefix !== 'T') t = fam.prefix + t.slice(1);
  if (!fam.prefix && t.length === 3) {
    if (/^[85]\d\d$/.test(t)) t = 'S' + t.slice(1); // S leída como 8/5
    if (/^[A-Z]/.test(t)) t = t[0] + t.slice(1).replace(/S/g, '5').replace(/Z/g, '2'); // dígitos leídos como letras
  }
  return t;
}

// reads: [{text, conf}] (varias lecturas OCR de la misma insignia). Devuelve {code, conf, why} o null.
export function snapBadge(cls, shape, reads, known) {
  const fam = familyOf(cls, shape); if (!fam) return null;
  const cands = familyKnown(cls, known);
  const votes = new Map(); const norm = []; let contra = 0;
  for (const r of reads) {
    const t = normalize(r.text, fam); norm.push(t);
    if (!t) continue;
    const c = Math.max(0, Math.min(100, r.conf || 0)) / 100;
    // letra que contradice el color (p. ej. "S1" en una insignia "amarilla"): color mal clasificado
    if (fam.prefix && /^[A-Z]/.test(t) && t[0] !== fam.prefix && !(fam.alt && fam.alt.test(t))) { contra += 0.35 + c; continue; }
    if (cands.includes(t)) { add(votes, t, 0.35 + c); continue; }
    // código nuevo solo si no es un código conocido de otro color (eso sería una mala lectura)
    if (!fam.noNovel && !known.includes(t) && (fam.re.test(t) || (fam.alt && fam.alt.test(t)))) { add(votes, t, 0.6 * c, true); continue; }
    // más cercano de la familia con distancia 1 y único (sin cambiar la letra si se leyó una)
    let best = null, n = 0;
    for (const k of cands) {
      if (/^[A-Z]/.test(t) && k[0] !== t[0]) continue;
      const d = lev(t, k); if (!best || d < best.d) { best = { k, d }; n = 1; } else if (d === best.d) n++;
    }
    if (best && best.d === 1 && n === 1 && t.length >= 2) add(votes, best.k, 0.4 * c);
  }
  if (!votes.size) {
    if (contra > 0) return null;
    // sin lectura útil: color + forma inequívocos y un único código conocido en la familia
    if (cands.length === 1 && (cls === C.GREEN || (cls === C.PINK && shape === 'tag') || (cls === C.BLUE && shape === 'hexagon'))) return { code: cands[0], conf: 0.45, why: 'color+forma' };
    return null;
  }
  const arr = [...votes.entries()].sort((a, b) => b[1].s - a[1].s);
  const [code, v] = arr[0];
  if (contra >= 0.5 * v.s) return null; // lecturas contradictorias con el color
  const second = arr[1] ? arr[1][1].s : 0;
  if (v.s - second < 0.3) return null; // empate entre lecturas distintas
  if (v.s < 0.85) return null; // apoyo insuficiente (p. ej. una sola lectura con confianza nula)
  if (v.novel) {
    // código nuevo (F4, S2, F54…): ≥ 3 lecturas, todas iguales, con confianza alta (máx ≥ 85, media ≥ 55)
    const confs = reads.map((r) => r.conf || 0);
    const unanimous = norm.every((t) => t === code);
    const mean = confs.reduce((a, b) => a + b, 0) / confs.length;
    if (reads.length < 3 || !unanimous || Math.max(...confs) < 85 || mean < 55) return null;
    // a un dígito "confundible" de un código conocido del mismo color (F33 ↔ F53): probable mala lectura
    if (cands.some((k) => confusableWith(code, k))) return null;
    return { code, conf: 0.6, why: 'nuevo' };
  }
  return { code, conf: Math.min(1, 0.45 + v.s / 3), why: 'ocr' };
}

// Veto por anchura del último dígito: en la fuente de la app el "1" es estrecho.
export function digitWidthVeto(code, glyphs) {
  if (!glyphs || glyphs.length !== code.length || glyphs.some((g) => g.split)) return false;
  const last = code[code.length - 1]; const g = glyphs[glyphs.length - 1];
  if (!/\d/.test(last)) return false;
  const a = (g.x1 - g.x0 + 1) / (g.y1 - g.y0 + 1);
  return last === '1' ? a > 0.85 : a < 0.33; // solo errores groseros (la anchura depende de la fuente)
}

// Pares de dígitos que el OCR confunde con facilidad.
const CONFUSABLE = ['17', '35', '38', '56', '68', '08', '27'];
function confusableWith(a, b) {
  if (a.length !== b.length) return false;
  const diff = [...a].map((c, i) => (c === b[i] ? null : [c, b[i]])).filter(Boolean);
  return diff.length === 1 && CONFUSABLE.some((p) => p.includes(diff[0][0]) && p.includes(diff[0][1]) && diff[0][0] !== diff[0][1]);
}

function add(m, k, s, novel = false) { const v = m.get(k) || { s: 0, novel }; v.s += s; v.novel = v.novel && novel; m.set(k, v); }
