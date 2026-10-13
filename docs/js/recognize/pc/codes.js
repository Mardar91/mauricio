// Vocabulario de códigos y ajuste del texto OCR al código más probable según la clase de color.

export const DEFAULT_KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];

// Patrón de códigos admitidos por clase de color (también para códigos nuevos)
const CLASS_RE = {
  yellow: /^F\d$/,
  green: /^S\d$/,
  blue: /^(N\d|TS)$/,
  pink: /^(Z\d|W-)$/,
  magenta: /^[FSNZ]\d\d$/,
  red: /^S\d\d$/,
};

// Letra implícita por color (cuando solo se leen dígitos)
const CLASS_LETTER = { yellow: 'F', green: 'S', pink: 'Z', blue: 'N' };

// Confusiones letra↔dígito típicas del OCR (entre dígitos NO: son lo que distingue los códigos)
const GROUPS = ['S5$s', '1IlTi|!J', '0ODQo', '2Zz', '8B', '6Gb', 'FEPf', 'NMHn', 'WVw', '-_~—–=', 'Uu'];
const groupOf = new Map(); GROUPS.forEach((g, i) => { for (const ch of g) groupOf.set(ch, i); });
const subCost = (a, b) => (a === b ? 0 : groupOf.has(a) && groupOf.get(a) === groupOf.get(b) ? 0.3 : 1);

// Distancia de edición ponderada
function dist(a, b) {
  const m = a.length; const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j * 0.8);
  for (let i = 1; i <= m; i++) {
    const cur = [i * 0.8];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 0.8, cur[j - 1] + 0.8, prev[j - 1] + subCost(a[i - 1], b[j - 1]));
    prev = cur;
  }
  return prev[n];
}

// Color de los códigos conocidos (los patrones se solapan: S31 es rojo, S51 magenta)
const KNOWN_COLOR = {
  F1: 'yellow', F2: 'yellow', F3: 'yellow', F6: 'yellow', F8: 'yellow', S1: 'green', N1: 'blue', TS: 'blue', Z1: 'pink', 'W-': 'pink',
  F51: 'magenta', F52: 'magenta', F53: 'magenta', S51: 'magenta', S52: 'magenta', N51: 'magenta', S31: 'red',
};

// Candidatos válidos para una clase: conocidos de ese color (o, si no se conoce su color, que encajan con el patrón)
export function classCandidates(cls, known) {
  const re = CLASS_RE[cls]; if (!re) return [];
  return (known || DEFAULT_KNOWN).filter((c) => (KNOWN_COLOR[c] ? KNOWN_COLOR[c] === cls : re.test(c)));
}

// Normaliza un texto OCR para una clase (letra implícita, confusiones evidentes)
export function normalizeRead(text, cls) {
  let t = String(text || '').replace(/\s/g, '');
  const L = CLASS_LETTER[cls];
  if (L && /^\d$/.test(t)) t = L + t;
  // primera letra confundida con un carácter de su grupo (p. ej. "52" en verde → "S2")
  else if (L && t.length === 2 && /\d$/.test(t) && t[0] !== L && groupOf.has(t[0]) && groupOf.get(t[0]) === groupOf.get(L)) t = L + t[1];
  return t;
}

// Similitud (0..1) entre una lectura OCR y un código
export function similarity(read, code) {
  if (!read) return 0;
  return Math.max(0, 1 - dist(read, code) / Math.max(read.length, code.length));
}

// Código nuevo (no conocido) leído exactamente con el patrón de la clase
export function exactNewCode(read, cls, known) {
  const re = CLASS_RE[cls]; if (!re) return null;
  const t = read.toUpperCase();
  return re.test(t) && !(known || DEFAULT_KNOWN).includes(t) && !KNOWN_COLOR[t] ? t : null;
}
