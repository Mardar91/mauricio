// Calendario: nombres de meses, días de la semana y alineación de filas con fechas reales.

const MONTHS = [
  ['januar', 'jänner', 'enero', 'january', 'janvier'],
  ['februar', 'febrero', 'february'],
  ['märz', 'maerz', 'marz', 'marzo', 'march'],
  ['april', 'abril'],
  ['mai', 'mayo', 'may'],
  ['juni', 'junio', 'june'],
  ['juli', 'julio', 'july'],
  ['august', 'agosto'],
  ['september', 'septiembre', 'setiembre'],
  ['oktober', 'octubre', 'october'],
  ['november', 'noviembre'],
  ['dezember', 'diciembre', 'december'],
];
export const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// 0 = lunes … 6 = domingo
export const weekdayOf = (y, m, d) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

export function lev(a, b) {
  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Busca "<mes> <año>" en el texto OCR de la cabecera → candidatos [{month, year, score}]
export function parseMonthYear(text, plausibleYears = null) {
  const out = [];
  const norm = text.toLowerCase().replace(/[0o](?=[a-zäöü])/g, 'o');
  const tokens = norm.split(/[^a-zäöü0-9]+/).filter(Boolean);
  const years = [];
  for (const m of norm.matchAll(/(2[0o][0-9oils]{2})/g)) {
    const y = Number(m[1].replace(/o/g, '0').replace(/[il]/g, '1').replace(/s/g, '5'));
    if (y >= 2020 && y <= 2045) years.push({ y, idx: m.index });
    else if (plausibleYears) {
      // año mal leído (p. ej. "2076"): vale si difiere en un dígito de un único año plausible
      const near = plausibleYears.filter((py) => [...String(py)].filter((ch, i) => ch !== String(y)[i]).length === 1);
      if (near.length === 1) years.push({ y: near[0], idx: m.index, fuzzy: true });
    }
  }
  for (let ti = 0; ti < tokens.length; ti++) {
    const t = tokens[ti].replace(/[0-9]/g, '');
    if (t.length < 3) continue;
    // distancia por mes (prefijos de 3+ letras cuentan como casi exactos: "jul", "okt")
    const pos = norm.indexOf(tokens[ti]);
    // año más cercano después del mes
    let year = null, yd = 1e9;
    for (const y of years) { const dd = y.idx - pos; if (dd > 0 && dd < 40 && dd < yd) { yd = dd; year = y.y; } }
    // variantes por confusiones típicas del OCR ("li"→"h", "m"→"rn")
    const vars = [...new Set([t, t.replace(/h/g, 'li'), t.replace(/m$/, 'ni'), t.replace(/rn/g, 'm'), t.replace(/ii/g, 'u'), t.replace(/vv/g, 'w')])];
    const dist = new Array(12).fill(99);
    for (let mi = 0; mi < 12; mi++) for (const name of MONTHS[mi]) for (const v of vars) {
      let d = lev(v, name);
      if (name.startsWith(v) && v.length >= 3) d = Math.min(d, 0.5);
      // con un año detrás, el token casi seguro es un mes: un error más de margen
      const tol = (name.length <= 6 ? 1 : 2) + (year && yd < 12 ? 1 : 0);
      if (d <= tol) dist[mi] = Math.min(dist[mi], d);
    }
    const dmin = Math.min(...dist);
    if (dmin > 3) continue;
    // empates (p. ej. "juh" → juni/juli): todos como candidatos; decide el calendario
    const ties = dist.map((d, i) => [d, i]).filter(([d]) => d === dmin);
    for (const [d, mi] of ties) out.push({ month: mi + 1, year, score: 6 - 2 * d - (ties.length > 1 ? 1 : 0) + (year ? 2 : 0) });
  }
  if (!out.length && years.length) out.push({ month: null, year: years[0].y, score: 1 });
  return out.sort((a, b) => b.score - a.score);
}

// Asigna un día de la semana a un texto OCR → {wd, q} (q: calidad 0-1)
export function matchWeekday(s) {
  const t = (s || '').replace(/[^A-Za-z]/g, '');
  if (!t) return null;
  let best = null;
  for (let i = 0; i < 7; i++) {
    const n = WEEKDAYS[i];
    let d = lev(t.toLowerCase(), n.toLowerCase());
    if (t === n) d = -0.5;
    if (!best || d < best.d) best = { wd: i, d };
  }
  if (best.d > 1) return null;
  return { wd: best.wd, q: best.d <= 0 ? 1 : 0.4 };
}

// Puntuación de una fila para un día candidato
function rowScore(r, d, y, m, dim) {
  if (d < 1 || d > dim) return -3;
  let s = 0;
  const want = String(d).padStart(2, '0');
  if (r.num) {
    const t = r.num.text, c = r.num.q;
    if (t === want) s += 4 * c;
    else if (t.length === 2 && (t[0] === want[0] || t[1] === want[1])) s += 0.3 * c - 0.8 * c;
    else if (t.length === 1 && (t === want[1])) s += 0.5 * c;
    else if (t.length >= 1) s -= 2 * c;
  }
  if (y && m) {
    const wd = weekdayOf(y, m, d);
    if (r.wd) s += r.wd.wd === wd ? 2 * r.wd.q : -1.5 * r.wd.q;
    if (r.red !== null && r.red !== undefined) {
      const we = wd >= 5;
      s += r.red ? (we ? 1 : -0.7) : (we ? -1 : 0.2);
    }
  }
  return s;
}

// Mejor día inicial para filas consecutivas con índices k (k[0] = 0)
export function alignRows(rows, ks, y, m) {
  const dim = y && m ? daysInMonth(y, m) : 31;
  const res = [];
  const kmax = ks[ks.length - 1];
  for (let s = 1 - kmax; s <= dim; s++) {
    let sc = 0, hits = 0;
    for (let i = 0; i < rows.length; i++) {
      const d = s + ks[i];
      sc += rowScore(rows[i], d, y, m, dim);
      if (rows[i].num && rows[i].num.text === String(d).padStart(2, '0')) hits++;
    }
    res.push({ s, score: sc, hits });
  }
  res.sort((a, b) => b.score - a.score);
  return { best: res[0], second: res[1] || { score: -1e9 }, all: res };
}
