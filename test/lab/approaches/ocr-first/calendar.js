// Calendario y emparejamiento difuso de textos alemanes (meses, días de la semana).

export const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
// Lunes = 0 … domingo = 6 (como en la app).
export const WEEKDAYS = ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'];

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// Día de la semana (0 = lunes) de y-m-d.
export const weekdayOf = (y, m, d) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

// Confusiones típicas del OCR (coste reducido al sustituir).
const CONFUSE = [
  ['o', '0'], ['o', 'c'], ['o', 'e'], ['o', 'a'], ['i', 'l'], ['i', '1'], ['i', 'j'], ['i', 't'], ['l', '1'], ['l', 't'],
  ['s', '5'], ['s', 'e'], ['a', 'e'], ['a', 'o'], ['n', 'm'], ['n', 'h'], ['n', 'r'], ['r', 'n'], ['u', 'v'], ['u', 'n'], ['b', 'h'],
  ['d', 'o'], ['m', 'rn'], ['f', 't'], ['e', 'c'], ['ä', 'a'],
];
const confSet = new Set(CONFUSE.map(([a, b]) => a + '|' + b).concat(CONFUSE.map(([a, b]) => b + '|' + a)));
const subCost = (a, b) => (a === b ? 0 : confSet.has(a + '|' + b) ? 0.5 : 1);

// Distancia de edición ponderada.
export function editDistance(a, b) {
  const n = a.length, m = b.length; const d = Array.from({ length: n + 1 }, (_, i) => [i]);
  for (let j = 1; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + subCost(a[i - 1], b[j - 1]));
    }
  }
  return d[n][m];
}

const clean = (s) => String(s || '').toLowerCase().replace(/[^a-zäöü0-9]/g, '');

// Mes alemán más parecido: { month: 1..12, score: 0..1 } o null.
export function matchMonth(text) {
  const t = clean(text); if (t.length < 3 || t.length > 11) return null;
  let best = null;
  for (let i = 0; i < 12; i++) {
    const name = MONTHS[i]; const alt = name.replace('ä', 'a');
    const dist = Math.min(editDistance(t, name), editDistance(t, alt));
    const score = 1 - dist / Math.max(name.length, 3);
    if (!best || score > best.score) best = { month: i + 1, score };
  }
  // Exigir parecido alto (los nombres cortos como "mai" son peligrosos).
  const need = t.length <= 4 ? 0.74 : 0.6;
  return best && best.score >= need ? best : null;
}

// Día de la semana: { wd: 0..6, score } o null. Acepta confusiones típicas (D1, Ml, S0, 5a…).
export function matchWeekday(text) {
  const raw = String(text || '').replace(/[.,:;'"`´]/g, '');
  if (raw.length < 2 || raw.length > 3) return null;
  const t = raw.toLowerCase();
  let best = null; const sc = [];
  for (let i = 0; i < 7; i++) {
    const dist = editDistance(t, WEEKDAYS[i]);
    const score = 1 - dist / 2; sc.push(score);
    if (!best || score > best.score) best = { wd: i, score };
  }
  if (!best || best.score < 0.75) return null;
  // La primera letra debe ser mayúscula plausible (M, D, F, S o confusión 5/0).
  if (!/^[MDFS5O0B]/.test(raw)) return null;
  // Empates (p. ej. "Se" = Sa/So): se guardan todas las opciones; ambiguous = true.
  best.alts = sc.map((v, i) => (v >= best.score - 1e-9 ? i : -1)).filter((i) => i >= 0);
  best.ambiguous = best.alts.length > 1;
  return best;
}

// Número de día 1..31 desde un texto con confusiones (O→0, l/I/|→1…).
export function parseDayNumber(text) {
  const t = String(text || '').replace(/[.,:;'"`´_\-—–]/g, '')
    .replace(/[oOQD]/g, '0').replace(/[lI|!iJ\]\[]/g, '1').replace(/[zZ]/g, '2').replace(/[B]/g, '8').replace(/[S]/g, '5').replace(/[g]/g, '9').replace(/[A]/g, '4');
  if (!/^\d{1,2}$/.test(t)) return null;
  const v = Number(t); if (v < 1 || v > 31) return null;
  const exact = /^\d{1,2}$/.test(String(text));
  return { value: v, exact, twoDigits: t.length === 2 };
}

export function parseYear(text) {
  const t = String(text || '').replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/[^0-9]/g, '');
  if (!/^20[2-4]\d$/.test(t)) return null;
  return Number(t);
}
