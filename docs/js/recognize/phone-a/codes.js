// Ajuste del texto OCR de una insignia a un código, restringido por la clase de color.
import { C_Y, C_G, C_B, C_M, C_P, C_R } from './img.js';

export const DEFAULT_CODES = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];

// Patrones válidos por clase (códigos nuevos solo si encajan)
const PATTERNS = {
  [C_Y]: [/^F\d$/],
  [C_G]: [/^S\d$/],
  [C_B]: [/^N\d$/, /^TS$/],
  [C_P]: [/^Z\d$/, /^W-$/],
  [C_M]: [/^[FSNZ]\d\d$/],
  [C_R]: [/^[FSNZ]\d\d$/, /^S\d$/],
};
export const fitsClass = (code, cls) => (PATTERNS[cls] || []).some((re) => re.test(code));

// Clase de color esperada de un código conocido
const DEFAULT_CLASS = { S31: C_R, TS: C_B, 'W-': C_P };
export function codeClass(code) {
  if (DEFAULT_CLASS[code] !== undefined) return DEFAULT_CLASS[code];
  if (/^F\d$/.test(code)) return C_Y;
  if (/^S\d$/.test(code)) return C_G;
  if (/^N\d$/.test(code)) return C_B;
  if (/^Z\d$/.test(code)) return C_P;
  if (/^[FSNZ]\d\d$/.test(code)) return C_M;
  return -1;
}
// Lista blanca de OCR por clase (la 1ª letra puede leerse como dígito)
export const WHITELIST = { [C_Y]: 'F0123456789', [C_G]: 'S0123456789', [C_B]: 'NTS0123456789', [C_P]: 'ZW0123456789-', [C_M]: 'FSNZ0123456789', [C_R]: 'FSNZ0123456789' };

const CONF = [['5', 'S'], ['2', 'Z'], ['1', 'I'], ['1', 'L'], ['1', 'T'], ['7', 'T'], ['1', '7'], ['0', 'O'], ['0', 'D'], ['8', 'B'], ['8', '3'], ['6', '5'], ['6', 'G'], ['3', '5'], ['8', '6'], ['8', '0'], ['F', 'E'], ['F', 'P'], ['N', 'H'], ['W', 'V'], ['-', '_'], ['Z', '7'], ['S', '8']];
const confusable = (a, b) => CONF.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const subCost = (a, b) => (a === b ? 0 : confusable(a, b) ? 0.45 : 1);

export function codeCost(s, code) {
  const m = s.length, n = code.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i * 0.8]);
  for (let j = 1; j <= n; j++) d[0][j] = j * 0.8;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 0.8, d[i][j - 1] + 0.8, d[i - 1][j - 1] + subCost(s[i - 1], code[j - 1]));
  }
  return d[m][n];
}

// Normaliza el texto OCR según la forma esperada (letra + dígitos)
export function normalizeFor(cls, raw) {
  let s = (raw || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (!s) return s;
  if (cls === C_P && /^[WV]/.test(s)) return 'W-';
  if (cls === C_B && /^[T7][S5]$/.test(s)) return 'TS';
  const toLetter = { 5: 'S', 8: 'S', 2: 'Z', 0: 'O', 7: 'T', 1: 'I' };
  const toDigit = { S: '5', Z: '2', O: '0', D: '0', B: '8', I: '1', L: '1', T: '7', G: '6' };
  const head = toLetter[s[0]] || s[0];
  const tail = s.slice(1).split('').map((ch) => toDigit[ch] || ch).join('');
  return head + tail;
}

// Decide el código de una insignia. ocrs: lecturas [{text, conf}]; shape: {tag}
// Devuelve {code, conf, why} o {code:null}
export function snapCode(cls, ocrs, known, shape = {}) {
  const cands = known.filter((k) => codeClass(k) === cls);
  // forma decisiva para rosa: etiqueta → W-, círculo → Z*
  let pool = cands;
  if (cls === C_P && shape.tag !== undefined) pool = shape.tag ? cands.filter((k) => k === 'W-') : cands.filter((k) => k !== 'W-');
  const reads = ocrs.map((o) => ({ s: normalizeFor(cls, o.text), conf: o.conf })).filter((o) => o.s);
  // 1) votos de lecturas exactas de códigos conocidos
  const votes = new Map();
  for (const r of reads) if (pool.includes(r.s)) { const v = votes.get(r.s) || { n: 0, sum: 0, max: 0 }; v.n++; v.sum += r.conf; v.max = Math.max(v.max, r.conf); votes.set(r.s, v); }
  if (votes.size) {
    const vs = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || b[1].sum - a[1].sum);
    const [code, top] = vs[0]; const sec = vs[1] ? vs[1][1] : null;
    if (!sec) {
      if (top.max >= 40) return { code, conf: Math.min(1, 0.6 + top.max / 250), why: 'exacto' };
      if (top.n >= 2) return { code, conf: 0.55, why: 'exacto2' };
    } else if (top.n >= 2 * sec.n && top.max >= 50 && top.max > sec.max) return { code, conf: 0.5, why: 'mayoría' };
    else return { code: null, conf: 0, why: 'conflicto' };
  }
  // 2) código nuevo: debe encajar con la clase, lectura segura y repetida
  //    y no confundible con un código conocido del mismo color (F33 ≈ F53 → mejor no decidir)
  const newReads = reads.filter((r) => fitsClass(r.s, cls) && !known.includes(r.s) && r.conf >= 75);
  if (newReads.length >= 2 && newReads.every((r) => r.s === newReads[0].s)) {
    const close = pool.some((k) => codeCost(newReads[0].s, k) <= 0.5);
    if (!close && reads.every((r) => !r.s || r.s === newReads[0].s || r.conf < 60)) return { code: newReads[0].s, conf: 0.5, why: 'nuevo' };
    return { code: null, conf: 0, why: 'dudoso' };
  }
  // 3) el más cercano entre los conocidos, si destaca claramente
  let best = null, second = null;
  for (const k of pool) {
    let c = 1e9;
    for (const r of reads) c = Math.min(c, codeCost(r.s, k) - (r.conf >= 80 ? 0.1 : 0));
    if (!best || c < best.c) { second = best; best = { k, c }; } else if (!second || c < second.c) second = { k, c };
  }
  if (best && best.c <= 0.9 && (!second || second.c - best.c >= 0.7)) return { code: best.k, conf: 0.5, why: 'aprox' };
  // 4) un único código conocido para esta forma y color: hace falta alguna lectura que se le parezca
  //    más que a cualquier otro código del mismo color; sin lecturas, solo si el color tiene un único código
  if (pool.length === 1) {
    const k0 = pool[0]; const others = cands.filter((k) => k !== k0);
    const contra = reads.some((r) => fitsClass(r.s, cls) && r.s !== k0 && r.conf >= 70);
    if (!contra) {
      if (!reads.length && cands.length === 1) return { code: k0, conf: 0.4, why: 'único' };
      const c0 = Math.min(...reads.map((r) => codeCost(r.s, k0)));
      const c1 = Math.min(99, ...reads.flatMap((r) => others.map((k) => codeCost(r.s, k))));
      if (reads.length && c0 <= 1 && c0 < c1) return { code: k0, conf: 0.45, why: 'único' };
    }
  }
  return { code: null, conf: 0, why: 'ilegible' };
}
