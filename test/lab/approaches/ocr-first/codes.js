// Decodificación de códigos de turno a partir de lecturas de OCR + clase de color.

export const DEFAULT_KNOWN = ['F1', 'F2', 'F3', 'F6', 'F8', 'S1', 'N1', 'Z1', 'F51', 'F52', 'F53', 'S51', 'S52', 'N51', 'S31', 'TS', 'W-', 'U', '-'];

// Por clase: lista blanca para el OCR, patrón válido y código por defecto (si la clase es inequívoca).
export const CLASS_INFO = {
  yellow: { whitelist: 'F0123456789', pattern: /^F\d$/ },
  green: { whitelist: 'S0123456789', pattern: /^S\d$/ },
  blue: { whitelist: 'NTS0123456789', pattern: /^(N\d|TS)$/ },
  magenta: { whitelist: 'FSN0123456789', pattern: /^[FSN]\d\d$/ },
  red: { whitelist: 'FSN0123456789', pattern: /^[FSN]\d\d$/ },
  pink: { whitelist: 'ZW0123456789-', pattern: /^(Z\d|W-)$/ },
};

// Códigos conocidos compatibles con la clase de color (y forma).
export function classCodes(cls, shape, known) {
  const p = CLASS_INFO[cls]?.pattern; if (!p) return [];
  let list = known.filter((k) => p.test(k));
  if (cls === 'pink') list = list.filter((k) => (shape === 'tag' ? k === 'W-' : k !== 'W-'));
  if (cls === 'blue' && shape === 'badge') list = list.filter((k) => k !== 'TS' || true);
  return list;
}

const TO_DIGIT = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', i: '1', '!': '1', J: '1', ']': '1', '[': '1', T: '7', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', b: '6', g: '9', q: '9', A: '4', '?': '7' };
const TO_LETTER = { 5: 'S', 2: 'Z', 0: 'O', 1: 'I', 7: 'T', 8: 'B', 6: 'G', E: 'F', P: 'F', R: 'F', H: 'N', M: 'N', V: 'W' };

// Coste de sustitución entre carácter leído y esperado.
function sub(a, b) {
  if (a === b) return 0;
  if (/\d/.test(b) && TO_DIGIT[a] === b) return 0.35;
  if (/[A-Z]/.test(b) && TO_LETTER[a] === b) return 0.35;
  if (a.toUpperCase() === b) return 0.1;
  return 1;
}
function dist(a, b) {
  const n = a.length, m = b.length; const d = Array.from({ length: n + 1 }, (_, i) => [i]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 0.8, d[i][j - 1] + 1, d[i - 1][j - 1] + sub(a[i - 1], b[j - 1]));
  return d[n][m];
}

// Normaliza una lectura al patrón de la clase (posición a posición). Devuelve null si no encaja.
export function normalizeReading(text, cls) {
  let t = String(text || '').replace(/[\s()\[\]{}.,:;'"`´_~»«©®@|]/g, (c) => (c === '|' ? 'I' : '')).replace(/[—–]/g, '-');
  if (!t) return null;
  const fix = (s, kinds) => {
    if (s.length !== kinds.length) return null;
    let o = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], k = kinds[i];
      if (k === 'd') { const v = /\d/.test(ch) ? ch : TO_DIGIT[ch]; if (!v) return null; o += v; }
      else if (k === '-') { if (ch !== '-') return null; o += ch; }
      else { const v = /[A-Z]/.test(ch) ? ch : TO_LETTER[ch] || (/[a-z]/.test(ch) ? ch.toUpperCase() : null); if (!v || !k.includes(v)) return null; o += v; }
    }
    return o;
  };
  const tries = {
    yellow: [['F', 'd']], green: [['S', 'd']], blue: [['N', 'd'], ['T', 'S']], magenta: [['FSN', 'd', 'd']], red: [['FSN', 'd', 'd']], pink: [['Z', 'd'], ['W', '-']],
  }[cls] || [];
  for (const k of tries) { const r = fix(t, k); if (r) return r; }
  return null;
}

// Vota entre lecturas. readings: [{ text, conf (0..100), syms?, weight }].
// Cada lectura suma a los códigos conocidos de la clase según su parecido (con confusiones típicas);
// un código nuevo solo gana si varias lecturas nítidas lo repiten.
export function decodeBadge(cls, shape, readings, known) {
  const cands = classCodes(cls, shape, known);
  const scores = new Map(cands.map((k) => [k, 0])); const fresh = new Map();
  for (const r of readings) {
    const raw = String(r.text || '').trim().replace(/\s+/g, ''); if (!raw) continue;
    const wt = (r.weight || 1) * Math.max(0.15, Math.min(1, (r.conf ?? 50) / 100));
    for (const k of cands) {
      const sim = 1 - dist(raw, k) / Math.max(k.length, raw.length);
      if (sim >= 0.5) scores.set(k, scores.get(k) + wt * sim ** 4);
    }
    const norm = normalizeReading(raw, cls);
    if (norm && !cands.includes(norm)) {
      const minSym = r.syms && r.syms.length ? Math.min(...r.syms.map((s) => s.conf)) : r.conf;
      const f = fresh.get(norm) || { n: 0, wt: 0, minSym: 100 };
      f.n++; f.wt += wt; f.minSym = Math.min(f.minSym, minSym); fresh.set(norm, f);
    }
  }
  const list = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [bk, bs] = list[0] || [null, 0]; const ss = list[1] ? list[1][1] : 0;
  // Código nuevo (p. ej. F4): lecturas repetidas y nítidas, y mejor que cualquier conocido.
  const nf = [...fresh.entries()].sort((a, b) => b[1].wt - a[1].wt)[0];
  if (nf && nf[1].n >= 3 && nf[1].minSym >= 75 && nf[1].wt > 1.5 * bs && CLASS_INFO[cls]?.pattern.test(nf[0])) {
    return { code: nf[0], conf: 0.6, alts: list.slice(0, 3), isNew: true };
  }
  if (bk && bs >= 0.6 && bs - ss >= 0.35 * bs) return { code: bk, conf: Math.min(1, 0.45 + 0.55 * (bs - ss) / bs * Math.min(1, bs / 2)), alts: list.slice(0, 3) };
  // Sin lectura útil: si la clase solo admite un código conocido, se usa (confianza baja).
  // (exige algo de apoyo del OCR: una mancha de color sin texto legible no basta).
  if (cands.length === 1 && bs >= 0.1 && !(nf && nf[1].n >= 2 && nf[1].minSym >= 70)) return { code: cands[0], conf: 0.5, alts: list.slice(0, 3), fallback: true };
  return { code: null, conf: 0, alts: list.slice(0, 3) };
}
